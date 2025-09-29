import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs';

const TOKENS_PATH = process.env.TOKENS_PATH || './tokens.json';

const app = express();
app.use(express.json());

const CORS_ORIGINS = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const {
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    REDIRECT_URI, // e.g. http://127.0.0.1:3001/callback  (MUST match your Spotify app)
} = process.env;

const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
app.use(cors({ origin: [FRONTEND_URL], credentials: true }));

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
const tokenStore = loadTokens();

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

const corsMiddleware = cors({
  credentials: true,
  origin: (origin, cb) => {
    if (originAllowed(origin)) return cb(null, true);
    console.warn('CORS blocked origin:', origin, 'allowed:', CORS_ORIGINS);
    return cb(new Error('Not allowed by CORS'));
  },
});

// Apply to all routes + preflight
app.use(corsMiddleware);
app.options('*', corsMiddleware);

function loadTokens() {
    try { return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch { return {}; }
}
function saveTokens(obj) {
    try { fs.writeFileSync(TOKENS_PATH, JSON.stringify(obj, null, 2)); } catch { }
}

async function setTokens({ access_token, refresh_token, expires_at }) {
    tokenStore.access_token = access_token;
    if (refresh_token) tokenStore.refresh_token = refresh_token;
    tokenStore.expires_at = expires_at;
    saveTokens(tokenStore);
}

app.use(cors({
    credentials: true,
    origin: (origin, cb) => {
        if (originAllowed(origin)) return cb(null, true);
        // Log once in case you deploy to a new preview domain
        console.warn('CORS blocked origin:', origin, 'allowed:', CORS_ORIGINS);
        return cb(new Error('Not allowed by CORS'));
    },
}));

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

    const expires_at = Date.now() + (data.expires_in * 1000) - 10_000;
    await setTokens({
        access_token: data.access_token,
        refresh_token: data.refresh_token, // may be undefined on re-consent; setTokens keeps old
        expires_at,
    });

    const return_to = (req.query.return_to || process.env.FRONTEND_URL || '').replace(/\/$/, '');
    res.redirect(`${return_to}/?linked=1`);
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
    await setTokens({
        access_token: data.access_token,
        refresh_token: tokenStore.refresh_token, // keep existing unless Spotify returns a new one
        expires_at: Date.now() + (data.expires_in * 1000) - 10_000,
    });
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
        const label = String(req.body?.label || 'happy');
        const keep = Math.max(1, Math.min(100, Number(req.body?.keep || 25)));
        const count = Math.max(1, Math.min(5, Number(req.body?.count || 1)));
        if (!ALLOWED_MOODS.has(label)) return res.status(400).json({ ok: false, error: 'unsupported mood' });

        const sourceId = MOOD_SOURCE[label];
        const sourceUris = await getTrackUrisFromPlaylist(sourceId, 800);
        if (!sourceUris.length) throw new Error('No tracks in source playlist');

        const { id: targetId } = await ensurePlaylistByName('MoodDJ');
        const current = await getPlaylistUrisOrdered(targetId);
        const seen = getSeenSet(label);
        for (const u of current) seen.add(u);

        const pool = sourceUris.slice().sort(() => Math.random() - 0.5);
        const inPlaylist = new Set(current);
        const picks = [];

        // Select up to N novel tracks; recycle only after a full pass
        for (let i = 0; i < count; i++) {
            let chosen = null;

            for (const uri of pool) {
                if (!seen.has(uri) && !inPlaylist.has(uri)) { chosen = uri; break; }
            }

            if (!chosen) {
                // exhausted → recycle: reset seen and try again once
                if (seen.size >= sourceUris.length) seen.clear();
                for (const uri of pool) {
                    if (!seen.has(uri) && !inPlaylist.has(uri)) { chosen = uri; break; }
                }
            }

            if (chosen) {
                picks.push(chosen);
                seen.add(chosen);
                inPlaylist.add(chosen);
            } else {
                break; // nothing else to add
            }
        }

        if (picks.length === 0) {
            return res.json({ ok: true, playlistId: targetId, keep, added: 0, reason: 'no-picks' });
        }

        let next = current.concat(picks);
        if (next.length > keep) next = next.slice(next.length - keep);
        await replacePlaylistWithUris(targetId, next);

        res.json({ ok: true, playlistId: targetId, keep, added: picks.length, picks });
    } catch (e) {
        console.error('POST /mood/tick error:', e);
        res.status(500).json({ ok: false, error: String(e) });
    }
});



app.listen(PORT, () => {
    console.log(`Backend on http://127.0.0.1:${PORT} and http://localhost:${PORT}`);
});