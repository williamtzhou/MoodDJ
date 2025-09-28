import { useCallback, useEffect, useState, useRef } from 'react';
import { useEmotion, Mood } from './hooks/useEmotion';

const BACKEND = `http://${window.location.hostname}:3001`;

export default function App() {
    // Always mount the processing <video>; just hide it when preview is off.
    const [showPreview, setShowPreview] = useState(true);
    const [cameraOn, setCameraOn] = useState(false);

    const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
    const videoRef = useCallback((el: HTMLVideoElement | null) => { setVideoEl(el); }, []);

    const [stream, setStream] = useState<MediaStream | null>(null);

    const [linked, setLinked] = useState(false);
    const [size, setSize] = useState(25);
    const [playlist, setPlaylist] = useState<{ id: string; url: string | null; uri: string; name: string } | null>(null);

    const [mood, setMood] = useState<Mood>('neutral');
    const lastSentMoodRef = useRef<Mood | null>(null);
    const [intervalMs, setIntervalMs] = useState(30_000); // 30s default
    const [perTick, setPerTick] = useState(1);            // songs to add each tick
    const intervalRef = useRef<number | null>(null);

    const moodRef = useRef<Mood>('neutral');
    const inFlightRef = useRef(false); // prevent overlap if a slow request is still running



    const {
        mood: detectedMood, scores, ready, running: emoRunning, tracking, faceCount, lastError, start: startEmotion, stop: stopEmotion, captureCalibration,
        clearCalibration
    } = useEmotion(videoEl);

    useEffect(() => { if (detectedMood) setMood(detectedMood as Mood); }, [detectedMood]);
    useEffect(() => { moodRef.current = mood; }, [mood]);

    // Attach/detach stream whenever element or stream changes
    useEffect(() => {
        if (videoEl && stream) {
            videoEl.srcObject = stream;
            videoEl.play?.();
            // give the element a tick to bind, then start detection if user enabled camera
            if (cameraOn) setTimeout(() => startEmotion(), 50);
        }
        if (videoEl && !stream) {
            videoEl.srcObject = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoEl, stream]);

    // -------- Spotify plumbing (unchanged) --------
    const linkSpotify = () => {
        const returnTo = encodeURIComponent(window.location.origin);
        window.location.assign(`${BACKEND}/login?return_to=${returnTo}`);
    };
    useEffect(() => {
        const check = () => { fetch(`${BACKEND}/me`).then(r => { if (r.ok) setLinked(true); }).catch(() => { }); };
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
                const me = await fetch(`${BACKEND}/me`); if (!me.ok) return;
                const r = await fetch(`${BACKEND}/playlist`); if (r.ok) setPlaylist(await r.json());
            } catch { }
        };
        load();
        if (new URLSearchParams(window.location.search).get('linked') === '1') load();
    }, [linked]);

    useEffect(() => {
        // Clear any prior timer
        if (intervalRef.current != null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }

        // Only run when Spotify is linked and camera is on
        if (!linked || !cameraOn) return;

        const tick = async () => {
            if (inFlightRef.current) return; // skip if previous still running
            inFlightRef.current = true;

            try {
                const m = moodRef.current;

                // For now we only support 'happy' on the backend; remove this guard once you add other moods
                if (m === 'happy') {
                    await fetch(`${BACKEND}/mood/tick`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ label: 'happy', keep: size, count: perTick }), // <= EXACTLY perTick
                    });
                }
                // No auto-replace here. Manual "Fill / Replace Playlist" is the only way to replace.
            } catch {
                // ignore errors
            } finally {
                inFlightRef.current = false;
            }
        };

        intervalRef.current = window.setInterval(tick, intervalMs);

        return () => {
            if (intervalRef.current != null) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [linked, cameraOn, intervalMs, perTick, size]); // <-- notice: NOT dependent on `mood`



    // -------- Camera controls --------
    const startCamera = async () => {
        if (cameraOn) return;
        try {
            const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            setStream(s);
            setCameraOn(true);
            // startEmotion will be called by the effect when stream binds
        } catch {
            alert('Camera permission denied or unavailable');
        }
    };
    const stopCamera = () => {
        if (!cameraOn) return;
        stopEmotion();               // pause detection loop cleanly
        stream?.getTracks().forEach(t => t.stop());
        setStream(null);
        setCameraOn(false);
    };

    // -------- Playlist actions (happy only for now) --------
    const fillPlaylist = async () => {
        if (mood !== 'happy') { alert(`Only the Happy playlist is wired right now. Detected: ${mood}`); return; }
        await fetch(`${BACKEND}/mood`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'happy', size }) });
    };
    const addOne = async () => {
        if (mood !== 'happy') { alert(`Only the Happy playlist is wired right now. Detected: ${mood}`); return; }
        await fetch(`${BACKEND}/mood/tick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'happy', keep: size }) });
    };

    return (
        <div style={{ maxWidth: 980, margin: '2rem auto', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <h1>🎭 Mood DJ — Editorial Mode</h1>

            <section style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '1rem' }}>
                <div>
                    {/* Always mounted processing video; hidden when preview is off */}
                    <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        style={{
                            width: '100%',
                            borderRadius: 12,
                            background: '#111',
                            display: showPreview ? 'block' : 'none'
                        }}
                    />
                    <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {!cameraOn
                            ? <button onClick={startCamera}>Start Camera</button>
                            : <button onClick={stopCamera}>Stop Camera</button>}
                        <button onClick={() => setShowPreview(v => !v)}>
                            {showPreview ? 'Hide Preview' : 'Show Preview'}
                        </button>
                    </div>

                    {tracking && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                            <button onClick={() => captureCalibration('neutral')}>Set Neutral</button>
                            <button onClick={() => captureCalibration('happy')}>Set Happy</button>
                            <button onClick={() => captureCalibration('sad')}>Set Sad</button>
                            <button onClick={clearCalibration} style={{ opacity: 0.7 }}>Clear Calib</button>
                        </div>
                    )}

                    <ul style={{ marginTop: 10 }}>
                        <li>Detector: {ready ? 'ready' : 'loading'} {emoRunning ? '(running)' : ''}</li>
                        <li>Tracking face: {tracking ? `yes (${faceCount})` : 'no'}</li>
                        {lastError && <li style={{ color: 'crimson' }}>Err: {lastError}</li>}
                    </ul>
                </div>

                <div>
                    <div style={{ display: 'inline-flex', gap: 8 }}>
                        <span style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ccc', background: '#e5e7eb' }}>
                            {mood}
                        </span>
                    </div>

                    <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
                        <label>
                            Every:&nbsp;
                            <input
                                type="number"
                                min={5}
                                step={5}
                                value={Math.round(intervalMs / 1000)}
                                onChange={e => setIntervalMs(Math.max(5, Number(e.target.value) || 30) * 1000)}
                                style={{ width: 72 }}
                            />s
                        </label>

                        <label>
                            Add per tick:&nbsp;
                            <input
                                type="number"
                                min={1}
                                max={5}
                                value={perTick}
                                onChange={e => setPerTick(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                                style={{ width: 60 }}
                            />
                        </label>

                        <button onClick={fillPlaylist} disabled={mood !== 'happy'}>Fill / Replace Playlist</button>
                        <button onClick={addOne} disabled={mood !== 'happy'}>Add One</button>
                        <button onClick={linkSpotify} disabled={linked} title={linked ? 'Already linked' : ''}>
                            {linked ? 'Link Spotify ✔' : 'Link Spotify'}
                        </button>

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

                    <div style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
                        <strong>Status</strong>
                        <ul>
                            <li>Camera: {cameraOn ? 'on' : 'off'}</li>
                            <li>Detected mood (camera): {detectedMood}</li>
                            <li>Current mood (used by app): {mood}</li>
                            <li>Spotify: {linked ? 'linked' : 'not linked'}</li>
                            <li>Playlist size target: {size}</li>
                        </ul>

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
                </div>
            </section>

            <p style={{ marginTop: 16, opacity: 0.8 }}>
                (Preview can be hidden; detection still runs while camera is on. When camera is off, detection pauses.)
            </p>
        </div>
    );
}
