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
    REDIRECT_URI,       // e.g. http://127.0.0.1:3001/callback (MUST match Spotify dashboard)
    FRONTEND_URL,       // e.g. http://localhost:5173
    PORT = 3001,
} = process.env;

if (!FRONTEND_URL) {
    console.warn('⚠️  FRONTEND_URL missing in .env (e.g., http://localhost:5173)');
}



// --- simple memory stores (swap for DB/sessions later) ---
const stateStore = new Map();
let tokenStore = {
    access_token: null,
    refresh_token: null,
    expires_at: 0, // ms epoch
};

const scopes = [
    'user-read-email',
    'user-read-private',
    'user-top-read',
    'user-library-read',
    'playlist-modify-public',
    'playlist-modify-private',
    // 'streaming', // add later when you embed Spotify Web Playback SDK
];

app.get('/', (_req, res) => res.send('OK: try /login'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/login', (req, res) => {
    const state = Math.random().toString(36).slice(2);

    // Accept ?return_to=http://localhost:5173 (or 127.0.0.1:5173). Fallback to FRONTEND_URL.
    const raw = Array.isArray(req.query.return_to) ? req.query.return_to[0] : req.query.return_to;
    const return_to = raw
        ? decodeURIComponent(String(raw))
        : String(FRONTEND_URL || 'http://localhost:5173');

    stateStore.set(state, return_to);

    const url = new URL('https://accounts.spotify.com/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);

    res.redirect(302, url.toString());
});

app.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const return_to = stateStore.get(state);
    if (!return_to) return res.status(400).send('Invalid state');
    stateStore.delete(state);

    // --- your existing token exchange ---
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

    // --- redirect back to the exact origin (includes :5173) ---
    const redirect = new URL(return_to);
    redirect.searchParams.set('linked', '1');
    console.log('Redirecting back to:', redirect.toString());
    res.redirect(redirect.toString());
});

// Utility: make sure we have a fresh access token
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

// Used by the frontend to decide if “linked”
app.get('/me', async (_req, res) => {
    try {
        const token = await ensureAccessToken();
        const r = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = await r.json();
        if (!r.ok) return res.status(r.status).json(data);
        res.json({ id: data.id, display_name: data.display_name });
    } catch (e) {
        res.status(401).json({ error: String(e) });
    }
});

// Stubs (keep for now)
app.post('/mood', (_req, res) => res.json({ ok: true, note: 'stub — add playlist logic later' }));
app.get('/playlist', (_req, res) => res.json({ playlistId: 'stub' }));

app.listen(PORT, () => {
    console.log(`Backend on http://127.0.0.1:${PORT} and http://localhost:${PORT}`);
});
