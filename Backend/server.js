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
    'playlist-read-private',
    // 'streaming', // add later when you embed Spotify Web Playback SDK
];

// --- mood targets (soft) ---
const MOOD_TARGETS = {
    happy: { target_valence: 0.8, min_energy: 0.5, max_acousticness: 0.5, min_tempo: 100, max_tempo: 170 },
    calm: { target_valence: 0.6, min_acousticness: 0.3, max_energy: 0.5, min_tempo: 60, max_tempo: 120 },
    sad: { target_valence: 0.2, max_energy: 0.5, min_acousticness: 0.2, min_tempo: 60, max_tempo: 110 },
    angry: { target_valence: 0.3, min_energy: 0.7, max_acousticness: 0.3, min_tempo: 110, max_tempo: 190 },
    surprised: { target_valence: 0.6, min_energy: 0.6, max_acousticness: 0.5, min_tempo: 100, max_tempo: 180 },
    neutral: { target_valence: 0.5,              /* mild bounds */         min_tempo: 80, max_tempo: 140 },
};

const GENRE_BY_MOOD = {
    happy: ['pop', 'dance', 'edm'],
    calm: ['chill', 'ambient', 'acoustic'],
    sad: ['sad', 'acoustic', 'singer-songwriter'],
    angry: ['metal', 'hard-rock', 'punk'],
    surprised: ['pop', 'electronic'],
    neutral: ['pop']
};

const SEARCH_QUERY_BY_MOOD = {
    happy: 'happy OR "feel good"',
    calm: 'chill OR calm OR acoustic',
    sad: 'sad OR melancholy',
    angry: 'metal OR hard rock OR punk',
    surprised: 'electronic OR upbeat',
    neutral: 'pop'
};

// Mood → editorial categories (stable IDs documented by Spotify)
const CATEGORY_BY_MOOD = {
    happy: ['mood', 'party', 'pop'],
    calm: ['chill', 'focus', 'sleep'],
    sad: ['mood', 'chill'],
    angry: ['rock', 'metal', 'workout'],
    surprised: ['mood', 'dance', 'pop'],
    neutral: ['mood', 'pop']
};

// tiny utilities
const avg = (a,b) => (typeof a==='number' && typeof b==='number') ? (a+b)/2 : undefined;
const shuffle = (arr) => arr.slice().sort(() => Math.random() - 0.5);

// optional niceties (prevent same-artist spam)
function capByArtist(tracks, maxPerArtist = 2) {
  const seen = new Map();
  const out = [];
  for (const t of tracks) {
    const key = t?.artists?.[0]?.id || t?.artists?.[0]?.name || 'unknown';
    const n = (seen.get(key) || 0) + 1;
    if (n <= maxPerArtist) { out.push(t); seen.set(key, n); }
  }
  return out;
}

// Use your existing GENRE_BY_MOOD map
async function searchTracksByGenres(genres, limit = 50) {
  const token = await ensureAccessToken();
  const q = genres.map(g => `genre:"${g}"`).join(' OR ');
  const r = await spotifyFetch(`/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`, { token }).catch(() => null);
  return r?.tracks?.items || [];
}

async function artistTopTracksByGenre(primaryGenre, limit = 50) {
  const token = await ensureAccessToken();
  const findArtists = await spotifyFetch(`/search?type=artist&limit=5&q=${encodeURIComponent(`genre:"${primaryGenre}"`)}`, { token }).catch(() => null);
  const artists = findArtists?.artists?.items || [];
  let pool = [];
  for (const a of artists) {
    try {
      // omit market to use from_token behavior
      const tt = await spotifyFetch(`/artists/${a.id}/top-tracks`, { token });
      pool = pool.concat(tt?.tracks || []);
    } catch {
      /* continue */
    }
    if (pool.length >= limit) break;
  }
  return pool.slice(0, limit);
}

// rank candidates against your MOOD_TARGETS using audio-features (chunked <=100)
async function rankCandidatesByFeatures(candidates, featuresTarget, take = 60) {
  if (!candidates.length) return [];
  // get features in chunks (you already have a good getAudioFeaturesFor)
  const ids = candidates.map(t => t.id).filter(Boolean);
  const featsMap = await getAudioFeaturesFor(ids);

  // convert your MOOD_TARGETS ranges to centers
  const target = {
    target_valence:      featuresTarget.target_valence ?? avg(featuresTarget.min_valence, featuresTarget.max_valence) ?? 0.5,
    target_energy:       featuresTarget.target_energy ?? avg(featuresTarget.min_energy, featuresTarget.max_energy) ?? 0.5,
    target_danceability: featuresTarget.target_danceability ?? avg(featuresTarget.min_danceability, featuresTarget.max_danceability) ?? 0.5,
    target_acousticness: featuresTarget.target_acousticness ?? avg(featuresTarget.min_acousticness, featuresTarget.max_acousticness) ?? 0.3,
    target_tempo:        featuresTarget.target_tempo ?? avg(featuresTarget.min_tempo, featuresTarget.max_tempo) ?? 120,
  };

  const scored = candidates
    .map(t => ({ t, f: featsMap.get(t.id) }))
    .map(({ t, f }) => {
      // simple weighted L1 (stable)
      const v  = f?.valence ?? 0.5;
      const en = f?.energy ?? 0.5;
      const da = f?.danceability ?? 0.5;
      const te = f?.tempo ?? 0;
      const score =
        -(Math.abs(v  - (target.target_valence ?? 0.5)) * 0.40 +
          Math.abs(en - (target.target_energy  ?? 0.5)) * 0.40 +
          Math.abs(da - (featuresTarget.target_danceability ?? 0.5)) * 0.15 +
          (featuresTarget.min_tempo ? Math.max(0, (featuresTarget.min_tempo - te)) / 200 : 0) * 0.05);
      return { t, score, hasFeat: !!f };
    });

  // if we got very few features (edge), gracefully fall back to unranked sample
  const withFeat = scored.filter(x => x.hasFeat);
  if (withFeat.length < Math.min(60, Math.floor(scored.length * 0.3))) {
    const sample = shuffle(candidates).slice(0, take * 2);
    return capByArtist(sample, 2).slice(0, take).map(t => t.uri ? t : ({ ...t, uri: `spotify:track:${t.id}` }));
  }

  return capByArtist(
    scored.sort((a,b) => b.score - a.score).map(x => x.t),
    2
  )
  .slice(0, take)
  .map(t => t.uri ? t : ({ ...t, uri: `spotify:track:${t.id}` }));
}

// Main pool builder used by /mood
async function buildMoodUris(label, features, want = 60) {
  const genres = GENRE_BY_MOOD[label] || ['pop'];

  // Step 1: try genre search
  let pool = await searchTracksByGenres(genres, Math.max(80, want * 2));

  // Step 2: if thin, augment with artist top tracks from first genre
  if (pool.length < want) {
    const more = await artistTopTracksByGenre(genres[0], Math.max(80, want));
    pool = pool.concat(more);
  }

  // De-dupe by id, light shuffle
  const seen = new Set();
  pool = shuffle(pool.filter(t => t?.id && !seen.has(t.id) && seen.add(t.id)));

  if (!pool.length) return []; // hard stop

  // Step 3: rank by audio features (with graceful fallback inside)
  const ranked = await rankCandidatesByFeatures(pool, features, want);

  // Convert to URIs
  return ranked.map(x => x.uri || `spotify:track:${x.id}`);
}


// Pull a few playlists from those categories
// async function getEditorialPlaylistsForMood(label, perCategory = 5) {
//     const token = await ensureAccessToken();
//     const cats = CATEGORY_BY_MOOD[label] || ['mood'];
//     const picked = [];
//     for (const c of cats) {
//         // country param helps stability; drop it if you prefer global
//         const page = await spotifyFetch(`/browse/categories/${encodeURIComponent(c)}/playlists?limit=${perCategory}&country=US`, { token })
//             .catch(() => null);
//         const items = page?.playlists?.items?.filter(Boolean) ?? [];
//         picked.push(...items.map(p => ({ id: p.id, name: p.name })));
//     }
//     // de-dupe by id
//     const seen = new Set();
//     return picked.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
// }

async function getTrackUrisFromPlaylists(playlistIds, maxUris = 300) {
    const token = await ensureAccessToken();
    const uris = [];
    for (const pid of playlistIds) {
        let next = `/playlists/${pid}/tracks?fields=items(track(uri,is_local)),next&limit=100`;
        while (next && uris.length < maxUris) {
            const page = await spotifyFetch(next, { token }).catch(() => null);
            const items = page?.items?.filter(Boolean) ?? [];
            for (const it of items) {
                const t = it.track;
                if (t?.uri && !t.is_local) uris.push(t.uri);
                if (uris.length >= maxUris) break;
            }
            next = page?.next || null;
        }
        if (uris.length >= maxUris) break;
    }
    // simple de-dupe while preserving order
    const seen = new Set();
    return uris.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
}


// 1) Search a few large, verified playlists by query words
async function searchMoodPlaylists(label, limit = 3) {
    const token = await ensureAccessToken();
    const q = encodeURIComponent(SEARCH_QUERY_BY_MOOD[label] || 'pop');

    // ask for more than we need; we’ll filter & sort
    const res = await spotifyFetch(`/search?type=playlist&q=${q}&limit=${limit * 4}`, { token }).catch(() => null);
    const items = res?.playlists?.items?.filter(Boolean) ?? [];

    if (!items.length) return [];

    // Optionally hydrate a few to get reliable follower counts for sorting
    const take = items.slice(0, Math.min(items.length, limit * 4));
    const enriched = await Promise.all(take.map(async (p) => {
        const full = await spotifyFetch(`/playlists/${p.id}?fields=id,name,external_urls,followers.total`, { token }).catch(() => null);
        return {
            id: p.id,
            name: full?.name ?? p.name,
            external_urls: full?.external_urls ?? p.external_urls,
            followers_total: full?.followers?.total ?? 0
        };
    }));

    // sort by followers_total desc, fall back to original order
    enriched.sort((a, b) => (b.followers_total - a.followers_total));
    return enriched.slice(0, limit);
}

// 2) Pull up to N track IDs from those playlists
async function collectTracksFromPlaylists(playlistIds, maxTracks = 150) {
    const token = await ensureAccessToken();
    const ids = new Set();

    for (const pid of playlistIds) {
        let next = `/playlists/${pid}/tracks?fields=items(track(id,uri,is_local)),next&limit=100`;
        while (next && ids.size < maxTracks) {
            const page = await spotifyFetch(next, { token }).catch(() => null);
            const items = page?.items?.filter(Boolean) ?? [];
            for (const it of items) {
                const t = it.track;
                if (t && !t.is_local && t.id) ids.add(t.id);
                if (ids.size >= maxTracks) break;
            }
            next = page?.next || null;
        }
        if (ids.size >= maxTracks) break;
    }
    return Array.from(ids);
}


// 3) Score tracks by audio features vs your target features
function scoreTrack(features, target) {
    if (!features) return Infinity;
    // Simple weighted L2 on relevant dims
    const dims = [
        ['valence', 'target_valence', 1.2],
        ['energy', 'target_energy', 1.0],
        ['danceability', 'target_danceability', 0.8],
        ['acousticness', 'target_acousticness', 0.7],
        ['tempo', 'target_tempo', 0.6]
    ];
    let s = 0;
    for (const [fKey, tKey, w] of dims) {
        if (tKey in target && fKey in features) {
            const fv = fKey === 'tempo' ? (features[fKey] || 0) : (features[fKey] ?? 0);
            const tv = target[tKey] ?? 0;
            s += w * (fv - tv) * (fv - tv);
        }
    }
    return s;
}

// 4) Fetch audio features for many ids (batching)
async function getAudioFeaturesFor(ids) {
    const token = await ensureAccessToken();
    const out = new Map();

    // De-dupe and cap total to avoid huge URL strings
    const uniq = Array.from(new Set(ids)).slice(0, 800); // plenty for ranking

    for (let i = 0; i < uniq.length; i += 100) {
        const chunk = uniq.slice(i, i + 100); // <= 100 per spec
        const path = `/audio-features?ids=${chunk.join(',')}`;
        try {
            const af = await spotifyFetch(path, { token });
            for (const row of af?.audio_features || []) {
                if (row?.id) out.set(row.id, row);
            }
        } catch (e) {
            console.warn('audio-features chunk failed (continuing):', String(e).slice(0, 160));
            // keep going with next chunk
        }
    }
    return out;
}




async function getTopSeeds() {
    const token = await ensureAccessToken();
    // try both; fall back gracefully
    const topTracks = await spotifyFetch('/me/top/tracks?limit=5', { token }).catch(() => ({ items: [] }));
    const topArtists = await spotifyFetch('/me/top/artists?limit=5', { token }).catch(() => ({ items: [] }));
    const trackSeeds = topTracks.items.slice(0, 2).map(t => t.id);
    const artistSeeds = topArtists.items.slice(0, 2).map(a => a.id);
    // if nothing, use some broad popular tracks as seeds via search
    if (trackSeeds.length === 0) {
        const pop = await spotifyFetch('/search?q=genre%3Apop&type=track&limit=5', { token }).catch(() => ({ tracks: { items: [] } }));
        pop.tracks.items.slice(0, 2).forEach(t => trackSeeds.push(t.id));
    }
    return { trackSeeds, artistSeeds };
}

async function getPlaylistTrackIds(playlistId) {
    const token = await ensureAccessToken();
    let ids = [];
    let next = `/playlists/${playlistId}/tracks?fields=items(track(id,uri)),next&limit=100`;

    while (next) {
        const page = await spotifyFetch(next, { token }); // spotifyFetch can accept absolute or relative
        ids = ids.concat(page.items.map(i => i.track?.id).filter(Boolean));
        next = page.next || null; // can be absolute; spotifyFetch handles it
    }
    return ids;
}


async function addTracks(playlistId, uris) {
    if (!uris.length) return;
    const token = await ensureAccessToken();
    // Spotify allows 100 per request
    for (let i = 0; i < uris.length; i += 100) {
        await spotifyFetch(`/playlists/${playlistId}/tracks`, {
            method: 'POST', token, body: { uris: uris.slice(i, i + 100) }
        });
    }
}

async function trimPlaylistTo(playlistId, keepN) {
    const token = await ensureAccessToken();
    const firstPage = await spotifyFetch(
        `/playlists/${playlistId}/tracks?fields=items(track(uri)),total&limit=100`,
        { token }
    );
    const uris = Array.isArray(firstPage?.items)
        ? firstPage.items.map(i => i.track?.uri).filter(Boolean)
        : [];
    if (uris.length <= keepN) return;
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
        method: 'PUT',
        token,
        body: { uris: uris.slice(0, keepN) },
    });
}

// function buildRecommendationsPath({
//     limit = 50,
//     seedTracks = [],
//     seedArtists = [],
//     seedGenres = [],
//     targets = {}
// } = {}) {
//     // build in parts to keep literal commas in seed params
//     const parts = [`limit=${limit}`];

//     if (seedTracks.length) parts.push(`seed_tracks=${seedTracks.slice(0, 5).join(',')}`);
//     if (seedArtists.length) parts.push(`seed_artists=${seedArtists.slice(0, 5).join(',')}`);
//     if (seedGenres.length) parts.push(`seed_genres=${seedGenres.slice(0, 5).join(',')}`);

//     for (const [k, v] of Object.entries(targets)) {
//         // encode value but don't touch commas in seeds above
//         parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
//     }
//     return `/recommendations?${parts.join('&')}`;
// }



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
    url.searchParams.set('show_dialog', 'true');

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

function normalizeSpotifyPath(path) {
    if (path.startsWith('http')) return path;
    // ensure exactly one /v1 prefix
    let p = path.startsWith('/v1/') ? path.slice(3) : path; // remove leading /v1 if present
    if (!p.startsWith('/')) p = '/' + p;
    return 'https://api.spotify.com/v1' + p;
}

async function spotifyFetch(path, { method = 'GET', token, body } = {}) {
    const url = normalizeSpotifyPath(path);
    const r = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const raw = await r.text(); // may be empty
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

    if (!r.ok) {
        console.error('Spotify API error:', method, url, r.status, data);
        throw new Error(`${method} ${url} failed: ${r.status} ${raw ?? ''}`);
    }
    return data ?? {};
}




// cache some per-run values (OK for dev)
let userCache = { id: null };
let playlistCache = { id: null, url: null, uri: null, name: null };

async function getCurrentUserId() {
    if (userCache.id) return userCache.id;
    const token = await ensureAccessToken();
    const me = await spotifyFetch('/me', { token });
    userCache.id = me.id;
    return userCache.id;
}

// Find existing playlist by exact name (case-sensitive), else create it
async function ensurePlaylistByName(name = 'MoodDJ') {
    if (playlistCache.id) return playlistCache;

    const token = await ensureAccessToken();
    // 1) try to find it in /me/playlists (paginated)
    let next = '/me/playlists?limit=50';
    while (next) {
        const page = await spotifyFetch(next.replace('https://api.spotify.com/v1', ''), { token });
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

    // 2) create it under the user
    const userId = await getCurrentUserId();
    const created = await spotifyFetch(`/users/${encodeURIComponent(userId)}/playlists`, {
        method: 'POST',
        token,
        body: {
            name,
            public: true,                        // set false if you want private
            description: 'Auto-created by MoodDJ',
        },
    });

    playlistCache = {
        id: created.id,
        url: created.external_urls?.spotify ?? null,
        uri: created.uri,
        name: created.name,
    };
    return playlistCache;
}

// let cachedGenreSeeds = null;
// async function getAvailableGenreSeeds() {
//     if (cachedGenreSeeds) return cachedGenreSeeds;
//     const token = await ensureAccessToken();
//     const r = await spotifyFetch('/recommendations/available-genre-seeds', { token });
//     cachedGenreSeeds = new Set(r.genres || []);
//     return cachedGenreSeeds;
// }


// Route the frontend can call
app.get('/playlist', async (_req, res) => {
    try {
        const pl = await ensurePlaylistByName('MoodDJ'); // change name if you like
        res.json(pl); // { id, url, uri, name }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});



app.post('/mood', async (req, res) => {
  try {
    const { label = 'neutral', size = 25 } = req.body || {};
    const features = MOOD_TARGETS[label] || MOOD_TARGETS.neutral;
    const { id: playlistId } = await ensurePlaylistByName('MoodDJ');

    const candidateUris = await buildMoodUris(label, features, Math.max(60, size * 2));
    if (!candidateUris.length) throw new Error('No candidate URIs for mood');

    // Upsert into playlist
    const existingIds = await getPlaylistTrackIds(playlistId);
    const existingSet = new Set(existingIds.map(id => `spotify:track:${id}`));
    const need = Math.max(0, size - existingIds.length);
    const newUris = candidateUris.filter(u => !existingSet.has(u)).slice(0, need);

    await addTracks(playlistId, newUris);
    await trimPlaylistTo(playlistId, size);

    console.log('Mood upsert:', { label, requestedSize: size, added: newUris.length, strategy: 'search+features' });
    res.json({ ok: true, playlistId, requestedSize: size, added: newUris.length });
  } catch (e) {
    console.error('POST /mood error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});






app.listen(PORT, () => {
    console.log(`Backend on http://127.0.0.1:${PORT} and http://localhost:${PORT}`);
});
