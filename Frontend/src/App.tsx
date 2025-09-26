import { useEffect, useCallback, useState } from 'react';
import { useEmotion, Mood } from './hooks/useEmotion';

const BACKEND = `http://${window.location.hostname}:3001`;

// type Mood = 'happy' | 'neutral' | 'sad';

export default function App() {
    const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
    const videoRef = useCallback((el: HTMLVideoElement | null) => { setVideoEl(el); }, []);
    const [cameraOn, setCameraOn] = useState(false);
    const [mood, setMood] = useState<Mood>('neutral');
    const [linked, setLinked] = useState(false);
    const [size, setSize] = useState(25);
    const [playlist, setPlaylist] = useState<{ id: string; url: string | null; uri: string; name: string } | null>(null);
    const { mood: detectedMood, scores, ready, running: emoRunning, tracking, faceCount, lastError, start: startEmotion, stop: stopEmotion } =
        useEmotion(videoEl);
    const toggleCamera = async () => {
        if (!cameraOn) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                if (videoEl) {
                    videoEl.srcObject = stream;
                    // wait a tick so the <video> gets metadata
                    setTimeout(() => startEmotion(), 100);
                }
                setCameraOn(true);
            } catch {
                alert('Camera permission denied or unavailable');
            }
        } else {
            if (videoEl?.srcObject) {
                (videoEl.srcObject as MediaStream).getTracks().forEach(t => t.stop());
                videoEl.srcObject = null;
            }
            setCameraOn(false);
            stopEmotion();
        }
    };

    const linkSpotify = () => {
        const returnTo = encodeURIComponent(window.location.origin);
        window.location.assign(`${BACKEND}/login?return_to=${returnTo}`);
    };

    useEffect(() => {
        const check = () => {
            fetch(`${BACKEND}/me`).then(r => {
                if (r.ok) setLinked(true);
            }).catch(() => { });
        };
        check();
        if (new URLSearchParams(window.location.search).get('linked') === '1') {
            check();
            const url = new URL(window.location.href);
            url.searchParams.delete('linked');
            window.history.replaceState({}, '', url.toString());
        }
        const onVis = () => { if (document.visibilityState === 'visible') check(); };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    useEffect(() => {
        const load = async () => {
            try {
                const me = await fetch(`${BACKEND}/me`);
                if (!me.ok) return;
                const r = await fetch(`${BACKEND}/playlist`);
                if (r.ok) setPlaylist(await r.json());
            } catch { }
        };
        load();
        if (new URLSearchParams(window.location.search).get('linked') === '1') {
            load();
        }
    }, [linked]);

    useEffect(() => {
        if (!detectedMood) return;
        // simple debounce / noise guard could go here if needed
        setMood(detectedMood as Mood);
    }, [detectedMood]);

    // Fill the playlist to `size` from the fixed Spotify playlist for the chosen mood
    const fillPlaylist = async () => {
        if (mood !== 'happy') {
            alert(`Only the Happy playlist is wired up right now. Detected: ${mood}`);
            return;
        }
        await fetch(`${BACKEND}/mood`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: mood, size }),
        });
    };

    const addOne = async () => {
        if (mood !== 'happy') {
            alert(`Only the Happy playlist is wired up right now. Detected: ${mood}`);
            return;
        }
        await fetch(`${BACKEND}/mood/tick`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: mood, keep: size }),
        });
    };


    return (
        <div style={{ maxWidth: 900, margin: '2rem auto', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <h1>🎭 Mood DJ — Editorial Mode</h1>

            <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                    <video ref={videoRef} autoPlay playsInline style={{ width: '100%', borderRadius: 12, background: '#111' }} />
                    <li>Detector: {ready ? 'ready' : 'loading'} {emoRunning ? '(running)' : ''}</li>
                    <li>Tracking face: {tracking ? `yes (${faceCount})` : 'no'}</li>
                    <li>Faces seen: {faceCount}</li>
                    {lastError && <li style={{ color: 'crimson' }}>Err: {lastError}</li>}

                    <div style={{ marginTop: 12 }}>
                        <button onClick={toggleCamera}>{cameraOn ? 'Stop Camera' : 'Start Camera'}</button>
                    </div>
                </div>

                <div>
                    <div style={{ display: 'inline-flex', gap: 8 }}>
                        <span style={{
                            padding: '8px 12px',
                            borderRadius: 8,
                            border: '1px solid #ccc',
                            background: '#e5e7eb',
                        }}>
                            happy
                        </span>
                    </div>

                    <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <label>
                            Size:&nbsp;
                            <input
                                type="number"
                                min={1}
                                max={100}
                                value={size}
                                onChange={e => setSize(Math.max(1, Math.min(100, Number(e.target.value) || 25)))}
                                style={{ width: 72 }}
                            />
                        </label>
                        <button onClick={fillPlaylist}>Fill / Replace Playlist</button>
                        <button onClick={addOne}>Add One</button>
                        <button onClick={linkSpotify} disabled={linked} title={linked ? 'Already linked' : ''}>
                            {linked ? 'Spotify Linked ✔' : 'Link Spotify'}
                        </button>
                    </div>

                    <div style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
                        <strong>Status</strong>
                        <ul>
                            <li>Camera: {cameraOn ? 'on' : 'off'}</li>
                            <li>Detected mood (camera): {detectedMood}</li>
                            <li>Current mood (used by app): {mood}</li>
                            <li>Spotify: {linked ? 'linked' : 'not linked'}</li>
                            <li>Playlist size target: {size}</li>
                        </ul>

                    </div>

                    <div style={{ marginTop: 12 }}>
                        {playlist?.url && (
                            <a
                                href={playlist.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ccc', textDecoration: 'none' }}
                            >
                                Open MoodDJ on Spotify
                            </a>
                        )}
                    </div>
                    <div style={{ marginTop: 8 }}>
                        <div>Scores:</div>
                        {(['happy', 'neutral', 'sad'] as Mood[]).map(m => (
                            <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' }}>
                                <div style={{ width: 70, textTransform: 'capitalize' }}>{m}</div>
                                <div style={{ flex: 1, height: 8, border: '1px solid #ddd', borderRadius: 4 }}>
                                    <div style={{
                                        width: `${Math.round((scores as any)[m] * 100)}%`,
                                        height: '100%', borderRadius: 4, background: '#888'
                                    }} />
                                </div>
                                <div style={{ width: 48, textAlign: 'right' }}>{((scores as any)[m] * 100).toFixed(0)}%</div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            <p style={{ marginTop: 16, opacity: 0.8 }}>
                (Later, swap the manual mood buttons for real facial-expression detection that calls <code>setMood()</code>.)
            </p>
        </div>
    );
}
