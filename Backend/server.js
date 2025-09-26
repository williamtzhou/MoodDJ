import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use(
    cors({
        origin: ['http://127.0.0.1:5173', 'http://localhost:5173'],
        credentials: true,
    })
);

const {
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    REDIRECT_URI, // e.g. http://127.0.0.1:3001/callback  (MUST match your Spotify app)
    FRONTEND_URL, // e.g. http://localhost:5173
    PORT = 3001,
} = process.env;

if (!FRONTEND_URL) {
    console.warn('⚠️ FRONTEND_URL missing in .env (e.g., http://localhost:5173)');
}

/** ----------------------------------------------------------------
 * Mood → Spotify editorial playlist IDs (from your links)
 * ---------------------------------------------------------------- */
const MOOD_SOURCE = {
    happy: '6QfDUw2zL7VwN3MPU7crYl', // <- your public Happy playlist
};
const ALLOWED_MOODS = new Set(['happy']);


/** ----------------------------------------------------------------
 * Minimal auth/token plumbing
 * ---------------------------------------------------------------- */
const stateStore = new Map();
let tokenStore = { access_token: null, refresh_token: null, expires_at: 0 };

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


app.get('/', (_req, res) => res.send('OK: try /login'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/login', (req, res) => {
    const state = Math.random().toString(36).slice(2);
    const raw = Array.isArray(req.query.return_to) ? req.query.return_to[0] : req.query.return_to;
    const return_to = raw ? decodeURIComponent(String(raw)) : String(FRONTEND_URL || 'http://localhost:5173');
    stateStore.set(state, return_to);

    const url = new URL('https://accounts.spotify.com/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);
    url.searchParams.set('show_dialog', 'true');

    res.redirect(302, url.toString());
});

app.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');
    const return_to = stateStore.get(state);
    if (!return_to) return res.status(400).send('Invalid state');
    stateStore.delete(state);

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
    if (!r.ok) return res.status(400).json(data);

    tokenStore.access_token = data.access_token;
    tokenStore.refresh_token = data.refresh_token ?? tokenStore.refresh_token;
    tokenStore.expires_at = Date.now() + (data.expires_in * 1000 - 10_000);

    const redirect = new URL(return_to);
    redirect.searchParams.set('linked', '1');
    res.redirect(redirect.toString());
});

async function ensureAccessToken() {
    if (tokenStore.access_token && Date.now() < tokenStore.expires_at) {
        return tokenStore.access_token;
    }
    if (!tokenStore.refresh_token) throw new Error('Not authorized');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenStore.refresh_token,
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
    tokenStore.access_token = data.access_token;
    tokenStore.expires_at = Date.now() + (data.expires_in * 1000 - 10_000);
    return tokenStore.access_token;
}

async function spotifyFetch(path, { method = 'GET', token, body } = {}) {
    const base = 'https://api.spotify.com/v1';
    const isAbsolute = /^https?:\/\//i.test(path);
    const url = isAbsolute ? path : `${base}${path}`;
    const r = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token || (await ensureAccessToken())}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch { }
    if (!r.ok) {
        console.warn('Spotify API error:', method, url, r.status, data || null);
        throw new Error(`${method} ${url} failed: ${r.status}`);
    }
    return data;
}

/** ----------------------------------------------------------------
 * Very small helpers to manage your target playlist
 * ---------------------------------------------------------------- */
let userCache = { id: null };
let playlistCache = { id: null, url: null, uri: null, name: null };

async function getCurrentUserId() {
    if (userCache.id) return userCache.id;
    const me = await spotifyFetch('/me');
    userCache.id = me.id;
    return userCache.id;
}

async function ensurePlaylistByName(name = 'MoodDJ') {
    if (playlistCache.id) return playlistCache;
    let next = '/me/playlists?limit=50';
    while (next) {
        const page = await spotifyFetch(next);
        const found = page.items.find(p => p.name === name);
        if (found) {
            playlistCache = {
                id: found.id,
                url: found.external_urls?.spotify ?? null,
                uri: found.uri,
                name: found.name,
            };
            return playlistCache;
        }
        next = page.next;
    }
    const userId = await getCurrentUserId();
    const created = await spotifyFetch(`/users/${encodeURIComponent(userId)}/playlists`, {
        method: 'POST',
        body: { name, public: true, description: 'Auto-created by MoodDJ' },
    });
    playlistCache = {
        id: created.id,
        url: created.external_urls?.spotify ?? null,
        uri: created.uri,
        name: created.name,
    };
    return playlistCache;
}

async function getPlaylistUrisOrdered(playlistId) {
    const uris = [];
    let next = `/playlists/${playlistId}/tracks?fields=items(track(uri,is_local)),next&limit=100`;
    while (next) {
        const page = await spotifyFetch(next);
        const items = page?.items?.filter(Boolean) ?? [];
        for (const it of items) {
            const t = it.track;
            if (t?.uri && !t.is_local) uris.push(t.uri);
        }
        next = page?.next || null;
    }
    return uris;
}

async function replacePlaylistWithUris(playlistId, uris) {
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
        method: 'PUT',
        body: { uris },
    });
}

/** ----------------------------------------------------------------
 * NEW: Pull from fixed editorial playlists (no generation)
 * ---------------------------------------------------------------- */
function shuffle(arr) {
    return arr.slice().sort(() => Math.random() - 0.5);
}

async function getTrackUrisFromPlaylist(playlistId, max = 500) {
    const uris = [];
    // keep market=from_token to help with relinking availability
    let next = `/playlists/${playlistId}/tracks?fields=items(track(uri,is_local)),next&limit=100&market=from_token`;
    while (next && uris.length < max) {
        const page = await spotifyFetch(next);
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
app.get('/me', async (_req, res) => {
    try {
        const r = await spotifyFetch('/me');
        res.json({ id: r.id, display_name: r.display_name });
    } catch (e) {
        res.status(401).json({ error: String(e) });
    }
});

app.get('/playlist', async (_req, res) => {
    try {
        const pl = await ensurePlaylistByName('MoodDJ');
        res.json(pl); // { id, url, uri, name }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * POST /mood
 * Body: { label: 'happy'|'sad'|'neutral', size?: number }
 * Replaces the target playlist with N tracks pulled ONLY from the fixed source playlist.
 */
app.post('/mood', async (req, res) => {
    try {
        const label = String(req.body?.label || 'neutral');
        const size = Math.max(1, Math.min(100, Number(req.body?.size || 25)));
        if (!ALLOWED_MOODS.has(label)) return res.status(400).json({ ok: false, error: 'unsupported mood' });

        const sourceId = MOOD_SOURCE[label];
        const sourceUris = shuffle(await getTrackUrisFromPlaylist(sourceId, 800));
        if (!sourceUris.length) throw new Error('No tracks in source playlist');

        const pick = sourceUris.slice(0, size);
        const { id: targetId } = await ensurePlaylistByName('MoodDJ');
        await replacePlaylistWithUris(targetId, pick);

        const seen = getSeenSet(label);
        pick.forEach(u => seen.add(u));


        res.json({ ok: true, playlistId: targetId, label, size, replaced: pick.length });
    } catch (e) {
        console.error('POST /mood error:', e);
        res.status(500).json({ ok: false, error: String(e) });
    }
});

/**
 * POST /mood/tick
 * Body: { label: 'happy'|'sad'|'neutral', keep?: number }
 * Appends ONE novel track from the fixed source playlist and trims to `keep`.
 */
app.post('/mood/tick', async (req, res) => {
    try {
        const label = String(req.body?.label || 'happy'); // locked to happy right now
        const keep = Math.max(1, Math.min(100, Number(req.body?.keep || 25)));
        if (!ALLOWED_MOODS.has(label)) return res.status(400).json({ ok: false, error: 'unsupported mood' });

        // Pull the full source once
        const sourceId = MOOD_SOURCE[label];
        const sourceUris = await getTrackUrisFromPlaylist(sourceId, 800);
        if (!sourceUris.length) throw new Error('No tracks in source playlist');

        const { id: targetId } = await ensurePlaylistByName('MoodDJ');
        const current = await getPlaylistUrisOrdered(targetId);
        const seen = getSeenSet(label);

        // Seed "seen" with whatever is already in the playlist
        for (const u of current) seen.add(u);

        // Try to find a novel URI
        let chosen = null;
        const pool = sourceUris.slice().sort(() => Math.random() - 0.5);
        for (const uri of pool) {
            if (!seen.has(uri)) { chosen = uri; break; }
        }

        let recycled = false;
        if (!chosen) {
            // We have exhausted the entire source set at least once -> allow recycling
            if (seen.size >= sourceUris.length) {
                seen.clear(); // reset and start a fresh pass
                recycled = true;
                // pick any (now all are novel relative to the cleared "seen")
                chosen = pool[0];
            } else {
                // If we land here something’s off; bail gracefully
                return res.json({ ok: true, playlistId: targetId, keep, added: 0, reason: 'no-novel' });
            }
        }

        // Add chosen to the end and trim to keep
        let next = current.concat(chosen);
        if (next.length > keep) next = next.slice(next.length - keep);
        await replacePlaylistWithUris(targetId, next);

        // Mark as seen after adding
        seen.add(chosen);

        res.json({ ok: true, playlistId: targetId, keep, added: 1, chosen, recycled });
    } catch (e) {
        console.error('POST /mood/tick error:', e);
        res.status(500).json({ ok: false, error: String(e) });
    }
});


app.listen(PORT, () => {
    console.log(`Backend on http://127.0.0.1:${PORT} and http://localhost:${PORT}`);
});
