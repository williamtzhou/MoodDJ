import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch'; // if you're on Node <18, otherwise built-in fetch is fine

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
  REDIRECT_URI,          // e.g., http://127.0.0.1:3001/callback
  PORT = 3001,
} = process.env;

// simple memory store (swap for DB later)
const stateStore = new Set();

const scopes = [
  'user-read-email',
  'user-read-private',
  'user-top-read',
  'user-library-read',
  'playlist-modify-public',
  'playlist-modify-private',
];

app.get('/', (_req, res) => res.send('OK: try /login'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/login', (_req, res) => {
  const state = Math.random().toString(36).slice(2);
  stateStore.add(state);

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
  if (!state || !stateStore.has(state)) return res.status(400).send('Invalid state');
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

  // TODO: persist tokens for your user; for now just confirm
  res.send('<h3>Linked!</h3>');
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://127.0.0.1:${PORT} (also http://localhost:${PORT})`);
});
