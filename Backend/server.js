import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs';

const app = express();
app.use(express.json());

const CORS_ORIGINS = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const MP_VERSION = '0.4.1646424915';
const ALLOW = new Set([
    'face_mesh.js',
    'face_mesh_solution_packed_assets_loader.js',
    'face_mesh_solution_simd_wasm_bin.js',
    'face_mesh_solution_simd_wasm_bin.wasm',
]);

app.set('trust proxy', 1);

app.use('/mp', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/mp/ping', (_req, res) => res.json({ ok: true }));

app.get('/mp/:file(*)', async (req, res) => {
    try {
        const file = req.params.file;
        if (!ALLOW.has(file)) {
            console.warn('MP proxy 404 (not allowed):', file);
            return res.status(404).end();
        }

        const upstream = `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@${MP_VERSION}/${file}`;
        const r = await fetch(upstream);

        if (!r.ok) {
            const text = await r.text().catch(() => '');
            console.warn('MP upstream error', r.status, upstream);
            return res.status(r.status).send(text);
        }

        const type = file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript';
        res.type(type);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');

        r.body.pipe(res);
    } catch (e) {
        console.error('MP proxy error', e);
        res.status(500).send('mp proxy error');
    }
});

const {
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    REDIRECT_URI, // e.g. http://127.0.0.1:3001/callback  (MUST match your Spotify app)
} = process.env;

const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

if (!FRONTEND_URL) {
    console.warn('⚠️ FRONTEND_URL missing in .env (e.g., http://localhost:5173)');
}

/** ----------------------------------------------------------------
 * Mood → Spotify editorial playlist IDs (from your links)
 * ---------------------------------------------------------------- */
const MOOD_SOURCE = {
    happy: '6QfDUw2zL7VwN3MPU7crYl', // your Happy (already working)
    sad: '6XNevehk5YztKwjOpcqv2l', // NEW: Sad
    neutral: '3PBcfhjKPx7z4KcFQEiMia', // NEW: Chill/Neutral
};

// Keep ALLOWED_MOODS in sync:
const ALLOWED_MOODS = new Set(Object.keys(MOOD_SOURCE));

/** ----------------------------------------------------------------
 * Minimal auth/token plumbing
 * ---------------------------------------------------------------- */
const stateStore = new Map();
// const tokenStore = loadTokens();

const scopes = [
    'user-read-email',
    'user-read-private',
    'playlist-modify-public',
    'playlist-modify-private',
    'playlist-read-private',
];

// Tracks we’ve already used per mood (in-memory; resets on restart)
const SEEN_PER_MOOD = new Map(); // mood -> Set<string>
function getSeenSet(label) {
    if (!SEEN_PER_MOOD.has(label)) SEEN_PER_MOOD.set(label, new Set());
    return SEEN_PER_MOOD.get(label);
}

function hostOf(u) {
    try { return new URL(u).hostname; } catch { return ''; }
}
function patHost(p) {
    // allow both "*.vercel.app" and "https://*.vercel.app"
    try { return new URL(p).hostname; } catch { return p.replace(/^https?:\/\//, ''); }
}
function originAllowed(reqOrigin) {
    if (!reqOrigin) return true; // non-browser clients
    const host = hostOf(reqOrigin);
    return CORS_ORIGINS.some(pat => {
        const ph = patHost(pat); // e.g. "*.vercel.app" or "mood-dj.vercel.app"
        if (!ph) return false;
        if (ph === '*') return true;
        if (ph.startsWith('*.')) {
            const base = ph.slice(2); // "vercel.app"
            return host === base || host.endsWith('.' + base);
        }
        return host === ph;
    });
}

function readTokensFromHeaders(req) {
    const auth = req.headers.authorization || '';
    const access = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const refresh = req.headers['x-refresh-token'] ? String(req.headers['x-refresh-token']) : '';
    const expiresAt = Number(req.headers['x-expires-at'] || 0);
    return { access, refresh, expiresAt };
}

async function refreshWithSpotify(refreshToken) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
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
        expires_at: Date.now() + (data.expires_in * 1000) - 10_000,
    };
}

async function spotify(req, res, path, { method = 'GET', body } = {}) {
    const base = 'https://api.spotify.com/v1';
    const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`;

    let { access, refresh, expiresAt } = readTokensFromHeaders(req);
    if (!access && !refresh) throw new Error('Not authorized');

    const doFetch = async (token) => {
        const r = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        return r;
    };

    let token = access;
    if (!token || (expiresAt && Date.now() >= expiresAt)) {
        if (!refresh) throw new Error('Not authorized');
        const fresh = await refreshWithSpotify(refresh);
        token = fresh.access_token;
        // Tell client to update its stored tokens
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
    try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

    if (!r.ok) {
        throw new Error(`${method} ${url} failed: ${r.status} ${text?.slice(0, 200) || ''}`);
    }
    return json;
}

const corsMiddleware = cors({
    credentials: true,
    origin: (origin, cb) => {
        if (originAllowed(origin)) return cb(null, true);
        console.warn('CORS blocked origin:', origin, 'allowed:', CORS_ORIGINS);
        return cb(new Error('Not allowed by CORS'));
    },
});

const ORIGINS = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: ORIGINS, credentials: true }));
app.options('*', cors({ origin: ORIGINS, credentials: true }));

app.get('/', (_req, res) => {
    res.json({ ok: true, tip: 'try /login' });
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'mood-dj-backend' }));

app.get('/login', (req, res) => {
    const return_to = req.query.return_to || process.env.FRONTEND_URL;
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.SPOTIFY_CLIENT_ID,
        scope: 'user-read-email playlist-modify-public playlist-modify-private',
        redirect_uri: process.env.REDIRECT_URI, // e.g. https://mooddj.onrender.com/callback
        state: Math.random().toString(36).slice(2),
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
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
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000) - 10_000,
    };

    const return_to = (req.query.return_to || process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const sp = encodeURIComponent(JSON.stringify(payload));
    res.redirect(`${return_to}/#sp=${sp}`);
});


async function ensureAccessToken(req, res) {
    const t = getTokensFromReq(req);
    if (t.access_token && Date.now() < t.expires_at) return t.access_token;
    if (!t.refresh_token) throw new Error('Not authorized');

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
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

    const next = {
        access_token: data.access_token,
        refresh_token: t.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000) - 10_000,
    };
    setTokensCookie(res, next);
    return next.access_token;
}

async function getCurrentUserId() {
    if (userCache.id) return userCache.id;
    const me = await spotify('/me');
    userCache.id = me.id;
    return userCache.id;
}

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

async function getPlaylistUrisOrdered(req, res, playlistId) {
    const uris = [];
    let next = `/playlists/${playlistId}/tracks?fields=items(track(uri,is_local)),next&limit=100`;
    while (next) {
        const page = await spotify(req, res, next);
        for (const it of (page?.items ?? [])) {
            const t = it.track; if (t?.uri && !t.is_local) uris.push(t.uri);
        }
        next = page?.next || null;
    }
    return uris;
}

async function replacePlaylistWithUris(req, res, playlistId, uris) {
    await spotify(req, res, `/playlists/${playlistId}/tracks`, { method: 'PUT', body: { uris } });
}

/** ----------------------------------------------------------------
 * NEW: Pull from fixed editorial playlists (no generation)
 * ---------------------------------------------------------------- */
function shuffle(arr) {
    return arr.slice().sort(() => Math.random() - 0.5);
}

async function getTrackUrisFromPlaylist(req, res, playlistId, max = 500) {
    const uris = [];
    // keep market=from_token to help with relinking availability
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
    // de-dupe
    const seen = new Set();
    return uris.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
}



/** ----------------------------------------------------------------
 * Public endpoints used by the frontend
 * ---------------------------------------------------------------- */
app.get('/me', async (req, res) => {
    try { const me = await spotify(req, res, '/me'); res.json({ id: me.id, display_name: me.display_name }); }
    catch (e) { res.status(401).json({ error: String(e) }); }
});

app.get('/playlist', async (req, res) => {
    try { const pl = await ensureUserPlaylist(req, res, 'MoodDJ'); res.json(pl); }
    catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/mood', async (req, res) => {
    try {
        const label = String(req.body?.label || 'neutral');
        const size = Math.max(1, Math.min(100, Number(req.body?.size || 25)));
        if (!ALLOWED_MOODS.has(label)) return res.status(400).json({ ok: false, error: 'unsupported mood' });

        const sourceId = MOOD_SOURCE[label];
        const sourceUris = shuffle(await getTrackUrisFromPlaylist(req, res, sourceId, 800));
        const pick = sourceUris.slice(0, size);

        const { id: targetId } = await ensureUserPlaylist(req, res, 'MoodDJ');
        await replacePlaylistWithUris(req, res, targetId, pick);

        res.json({ ok: true, playlistId: targetId, label, size, replaced: pick.length });
    } catch (e) {
        console.error('POST /mood error:', e);
        res.status(500).json({ ok: false, error: String(e) });
    }
});

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
            picks.push(choice); seen.add(choice);
        }

        if (!picks.length) return res.json({ ok: true, playlistId: targetId, keep, added: 0, reason: 'no-picks' });

        let next = current.concat(picks);
        if (next.length > keep) next = next.slice(next.length - keep);
        await replacePlaylistWithUris(req, res, targetId, next);

        res.json({ ok: true, playlistId: targetId, keep, added: picks.length, picks });
    } catch (e) {
        console.error('POST /mood/tick error:', e);
        res.status(500).json({ ok: false, error: String(e) });
    }
});



app.listen(PORT, () => {
    console.log(`Backend on http://127.0.0.1:${PORT} and http://localhost:${PORT}`);
});