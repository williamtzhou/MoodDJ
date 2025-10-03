import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

/** MediaPipe FaceMesh version and allowlist for proxied assets. */
const MP_VERSION = '0.4.1646424915';
const MP_ALLOW = new Set([
    'face_mesh.js',
    'face_mesh_solution_packed_assets_loader.js',
    'face_mesh_solution_simd_wasm_bin.js',
    'face_mesh_solution_simd_wasm_bin.wasm',
]);

/** Core configuration. */
const {
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    REDIRECT_URI,
    FRONTEND_URL = 'http://localhost:5173',
    CORS_ORIGINS,
    PORT = 3001,
} = process.env;

const ORIGINS = (CORS_ORIGINS || FRONTEND_URL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

/** CORS for API endpoints. */
app.use(cors({ origin: ORIGINS, credentials: true }));
app.options('*', cors({ origin: ORIGINS, credentials: true }));

/**
 * Lightweight CDN proxy for MediaPipe assets (helps with CORP/CORS and immutability caching).
 */
app.use('/mp', (_req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/mp/ping', (_req, res) => res.json({ ok: true }));

app.get('/mp/:file(*)', async (req, res) => {
    try {
        const file = req.params.file;
        if (!MP_ALLOW.has(file)) return res.status(404).end();

        const upstream = `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@${MP_VERSION}/${file}`;
        const r = await fetch(upstream);

        if (!r.ok) {
            const text = await r.text().catch(() => '');
            return res.status(r.status).send(text);
        }

        const type = file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript';
        res.type(type);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        r.body.pipe(res);
    } catch {
        res.status(500).send('mp proxy error');
    }
});

/**
 * Parses bearer/refresh tokens and expiry from request headers.
 */
function readTokensFromHeaders(req) {
    const auth = req.headers.authorization || '';
    const access = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const refresh = req.headers['x-refresh-token'] ? String(req.headers['x-refresh-token']) : '';
    const expiresAt = Number(req.headers['x-expires-at'] || 0);
    return { access, refresh, expiresAt };
}

/**
 * Performs Spotify refresh_token grant and returns new access token and expiry.
 */
async function refreshWithSpotify(refreshToken) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: SPOTIFY_CLIENT_ID,
        client_secret: SPOTIFY_CLIENT_SECRET,
    });
    const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const data = await r.json();
    if (!r.ok) throw new Error('Refresh failed: ' + JSON.stringify(data));
    return {
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000 - 10_000,
    };
}

/**
 * Calls Spotify Web API with automatic refresh/retry and propagates new access tokens via headers.
 */
async function spotify(req, res, path, { method = 'GET', body } = {}) {
    const base = 'https://api.spotify.com/v1';
    const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`;

    let { access, refresh, expiresAt } = readTokensFromHeaders(req);
    if (!access && !refresh) throw new Error('Not authorized');

    const doFetch = async token => {
        return fetch(url, {
            method,
            headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
    };

    let token = access;
    if (!token || (expiresAt && Date.now() >= expiresAt)) {
        if (!refresh) throw new Error('Not authorized');
        const fresh = await refreshWithSpotify(refresh);
        token = fresh.access_token;
        res.set('x-new-access-token', token);
        res.set('x-new-expires-at', String(fresh.expires_at));
    }

    let r = await doFetch(token);
    if (r.status === 401 && refresh) {
        const fresh = await refreshWithSpotify(refresh);
        token = fresh.access_token;
        res.set('x-new-access-token', token);
        res.set('x-new-expires-at', String(fresh.expires_at));
        r = await doFetch(token);
    }

    const text = await r.text().catch(() => '');
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch { }

    if (!r.ok) throw new Error(`${method} ${url} failed: ${r.status} ${text?.slice(0, 200) || ''}`);
    return json;
}

/** Editorial source playlist IDs by mood. */
const MOOD_SOURCE = {
    happy: '6QfDUw2zL7VwN3MPU7crYl',
    sad: '6XNevehk5YztKwjOpcqv2l',
    neutral: '3PBcfhjKPx7z4KcFQEiMia',
};

const ALLOWED_MOODS = new Set(Object.keys(MOOD_SOURCE));

/** Health root. */
app.get('/', (_req, res) => {
    res.json({ ok: true, tip: 'try /login' });
});

/** Health endpoint. */
app.get('/health', (_req, res) => res.json({ ok: true, service: 'mood-dj-backend' }));

/**
 * Starts Spotify OAuth authorization code flow.
 * Query: return_to (optional) final frontend origin.
 */
app.get('/login', (req, res) => {
    // Capture where to return after auth; default to configured FRONTEND_URL
    const returnTo = String(req.query.return_to || FRONTEND_URL || '').replace(/\/$/, '');

    // Encode state to carry return_to through Spotify to /callback
    const statePayload = {
        csrf: Math.random().toString(36).slice(2),
        return_to: returnTo,
    };
    const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: SPOTIFY_CLIENT_ID,
        scope: 'user-read-email playlist-modify-public playlist-modify-private',
        redirect_uri: REDIRECT_URI,
        state,
        // Force consent screen so Spotify re-issues a refresh_token if the user had granted before.
        show_dialog: 'true',
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

/**
 * OAuth redirect handler. Exchanges code for tokens and forwards to frontend via hash.
 */
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');

    // Recover return_to from state (if present), otherwise fall back to FRONTEND_URL
    let return_to = (FRONTEND_URL || '').replace(/\/$/, '');
    try {
        const rawState = String(req.query.state || '');
        if (rawState) {
            const parsed = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8'));
            if (parsed?.return_to) return_to = String(parsed.return_to).replace(/\/$/, '');
        }
    } catch {
        // ignore malformed state; use FRONTEND_URL
    }

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: SPOTIFY_CLIENT_ID,
        client_secret: SPOTIFY_CLIENT_SECRET,
    });

    const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json(data);

    const payload = {
        access_token: data.access_token,
        refresh_token: data.refresh_token, // may be undefined if Spotify decides not to return; show_dialog=true helps
        expires_at: Date.now() + data.expires_in * 1000 - 10_000,
    };

    const sp = encodeURIComponent(JSON.stringify(payload));
    res.redirect(`${return_to}/#sp=${sp}`);
});

/**
 * Ensures a user-owned playlist named "MoodDJ" exists; creates if missing.
 * Returns { id, url, uri, name }.
 */
async function ensureUserPlaylist(req, res, name = 'MoodDJ') {
    let next = '/me/playlists?limit=50';
    while (next) {
        const page = await spotify(req, res, next);
        const found = page.items.find(p => p.name === name);
        if (found) {
            return { id: found.id, url: found.external_urls?.spotify ?? null, uri: found.uri, name: found.name };
        }
        next = page.next;
    }
    const me = await spotify(req, res, '/me');
    const created = await spotify(req, res, `/users/${encodeURIComponent(me.id)}/playlists`, {
        method: 'POST',
        body: { name, public: true, description: 'Auto-created by MoodDJ' },
    });
    return { id: created.id, url: created.external_urls?.spotify ?? null, uri: created.uri, name: created.name };
}

/**
 * Retrieves ordered track URIs from a playlist (non-local only).
 */
async function getPlaylistUrisOrdered(req, res, playlistId) {
    const uris = [];
    let next = `/playlists/${playlistId}/tracks?fields=items(track(uri,is_local)),next&limit=100`;
    while (next) {
        const page = await spotify(req, res, next);
        for (const it of page?.items ?? []) {
            const t = it.track;
            if (t?.uri && !t.is_local) uris.push(t.uri);
        }
        next = page?.next || null;
    }
    return uris;
}

/**
 * Replaces playlist contents with the given URIs.
 */
async function replacePlaylistWithUris(req, res, playlistId, uris) {
    await spotify(req, res, `/playlists/${playlistId}/tracks`, { method: 'PUT', body: { uris } });
}

/**
 * Retrieves distinct track URIs from a source playlist, up to a max, using market=from_token.
 */
async function getTrackUrisFromPlaylist(req, res, playlistId, max = 500) {
    const uris = [];
    let next = `/playlists/${playlistId}/tracks?fields=items(track(uri,is_local)),next&limit=100&market=from_token`;
    while (next && uris.length < max) {
        const page = await spotify(req, res, next);
        const items = page?.items?.filter(Boolean) ?? [];
        for (const it of items) {
            const t = it.track;
            if (t?.uri && !t.is_local) uris.push(t.uri);
            if (uris.length >= max) break;
        }
        next = page?.next || null;
    }
    const seen = new Set();
    return uris.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
}

/** Returns current user identity. */
app.get('/api/me', async (req, res) => {
    try {
        const me = await spotify(req, res, '/me');
        res.json({ id: me.id, display_name: me.display_name });
    } catch (e) {
        res.status(401).json({ error: String(e) });
    }
});

/** Returns the user's MoodDJ playlist info, creating it if needed. */
app.get('/playlist', async (req, res) => {
    try {
        const pl = await ensureUserPlaylist(req, res, 'MoodDJ');
        res.json(pl);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * Replaces playlist with a fresh selection for the provided mood and size.
 * Body: { label: 'happy'|'neutral'|'sad', size: number }
 */
app.post('/mood', async (req, res) => {
    try {
        const label = String(req.body?.label || 'neutral');
        const size = Math.max(1, Math.min(100, Number(req.body?.size || 25)));
        if (!ALLOWED_MOODS.has(label)) return res.status(400).json({ ok: false, error: 'unsupported mood' });

        const sourceId = MOOD_SOURCE[label];
        const sourceUris = await getTrackUrisFromPlaylist(req, res, sourceId, 800);
        const shuffled = sourceUris.slice().sort(() => Math.random() - 0.5);
        const pick = shuffled.slice(0, size);

        const { id: targetId } = await ensureUserPlaylist(req, res, 'MoodDJ');
        await replacePlaylistWithUris(req, res, targetId, pick);

        res.json({ ok: true, playlistId: targetId, label, size, replaced: pick.length });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

/**
 * Adds up to {count} new tracks for the mood while keeping the last {keep} tracks.
 * Body: { label: 'happy'|'neutral'|'sad', keep: number, count: number }
 */
app.post('/mood/tick', async (req, res) => {
    try {
        const label = String(req.body?.label || 'happy');
        const keep = Math.max(1, Math.min(100, Number(req.body?.keep || 25)));
        const count = Math.max(1, Math.min(5, Number(req.body?.count || 1)));
        if (!ALLOWED_MOODS.has(label)) return res.status(400).json({ ok: false, error: 'unsupported mood' });

        const sourceId = MOOD_SOURCE[label];
        const sourceUris = await getTrackUrisFromPlaylist(req, res, sourceId, 800);

        const { id: targetId } = await ensureUserPlaylist(req, res, 'MoodDJ');
        const current = await getPlaylistUrisOrdered(req, res, targetId);

        const seen = new Set(current);
        const pool = sourceUris.slice().sort(() => Math.random() - 0.5);
        const picks = [];

        for (let i = 0; i < count; i++) {
            const choice = pool.find(u => !seen.has(u));
            if (!choice) break;
            picks.push(choice);
            seen.add(choice);
        }

        if (!picks.length) return res.json({ ok: true, playlistId: targetId, keep, added: 0, reason: 'no-picks' });

        let next = current.concat(picks);
        if (next.length > keep) next = next.slice(next.length - keep);
        await replacePlaylistWithUris(req, res, targetId, next);

        res.json({ ok: true, playlistId: targetId, keep, added: picks.length, picks });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

/** Optional convenience: frontends can call this before clearing local storage. */
app.post('/disconnect', (_req, res) => {
    res.json({ ok: true });
});

/** Starts HTTP server. */
app.listen(PORT, () => {
    console.log(`Backend on http://127.0.0.1:${PORT} and http://localhost:${PORT}`);
});
