import { useCallback, useEffect, useRef, useState } from 'react';
import { useEmotion, Mood } from './hooks/useEmotion';

const BACKEND = import.meta.env.VITE_BACKEND_URL ?? `${window.location.protocol}//${window.location.hostname}:3001`;

// Number input helper (smooth typing/backspace; clamp on blur/enter/arrow)
function useNumberField(opts: {
    value: number;
    setValue: (n: number) => void;
    min: number;
    max: number;
    step?: number;
}) {
    const { value, setValue, min, max, step = 1 } = opts;
    const [text, setText] = useState(String(value));
    useEffect(() => { setText(String(value)); }, [value]);

    const commit = () => {
        const n = Number(text);
        if (Number.isFinite(n)) setValue(Math.max(min, Math.min(max, Math.round(n))));
        else setText(String(value));
    };
    const onChange = (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value);
    const onBlur = () => commit();
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const cur = Number.isFinite(Number(text)) ? Number(text) : value;
            const next = e.key === 'ArrowUp' ? cur + step : cur - step;
            const clamped = Math.max(min, Math.min(max, Math.round(next)));
            setValue(clamped); setText(String(clamped));
        }
        if (e.key === 'Enter') commit();
    };
    return { text, onChange, onBlur, onKeyDown };
}

export default function App() {
    const [showPreview, setShowPreview] = useState(true);
    const [cameraOn, setCameraOn] = useState(false);

    const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
    const videoRef = useCallback((el: HTMLVideoElement | null) => { setVideoEl(el); }, []);

    const [stream, setStream] = useState<MediaStream | null>(null);

    const [linked, setLinked] = useState(false);
    const [size, setSize] = useState(25);
    const [intervalMs, setIntervalMs] = useState(180_000);
    const [perTick, setPerTick] = useState(1);

    const sizeField = useNumberField({ value: size, setValue: setSize, min: 1, max: 100 });
    const intervalField = useNumberField({
        value: Math.round(intervalMs / 1000),
        setValue: (secs) => setIntervalMs(secs * 1000),
        min: 5, max: 3600, step: 5
    });
    const perTickField = useNumberField({ value: perTick, setValue: setPerTick, min: 1, max: 5 });

    const [playlist, setPlaylist] = useState<{ id: string; url: string | null; uri: string; name: string } | null>(null);

    const [mood, setMood] = useState<Mood>('neutral');
    const moodRef = useRef<Mood>('neutral');
    useEffect(() => { moodRef.current = mood; }, [mood]);

    const intervalRef = useRef<number | null>(null);
    const inFlightRef = useRef(false);

    const {
        mood: detectedMood, scores, ready, running: emoRunning, tracking, faceCount, lastError,
        start: startEmotion, stop: stopEmotion, captureCalibration, clearCalibration, swapNeutralSad
    } = useEmotion(videoEl);

    useEffect(() => { if (detectedMood) setMood(detectedMood as Mood); }, [detectedMood]);

    // Attach/detach the stream and reliably (re)start detection
    useEffect(() => {
        if (!videoEl) return;

        function bind() {
            if (!videoEl || !stream) return;
            videoEl.srcObject = stream;
            // Wait for data, then start the detector and play
            const onLoaded = () => {
                startEmotion();
                videoEl.play?.().catch(() => { });
                videoEl.removeEventListener('loadeddata', onLoaded);
            };
            videoEl.addEventListener('loadeddata', onLoaded);
            videoEl.load?.();
        }

        if (stream) {
            // Full reset before binding the new stream (prevents stale frames after restart)
            videoEl.pause?.();
            videoEl.removeAttribute('src');
            (videoEl as any).srcObject = null;
            videoEl.load?.();
            // next task: bind stream, start detection on loadeddata
            setTimeout(bind, 0);
        } else {
            // Tear down stream
            videoEl.pause?.();
            videoEl.removeAttribute('src');
            (videoEl as any).srcObject = null;
            videoEl.load?.();
            stopEmotion();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoEl, stream]);

    // Spotify auth plumbing
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

    // Auto add every N seconds (uses current mood)
    useEffect(() => {
        if (intervalRef.current != null) { clearInterval(intervalRef.current); intervalRef.current = null; }
        if (!linked || !cameraOn) return;

        const tick = async () => {
            if (inFlightRef.current) return;
            inFlightRef.current = true;
            try {
                await fetch(`${BACKEND}/mood/tick`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ label: moodRef.current, keep: size, count: perTick }),
                });
            } catch { } finally { inFlightRef.current = false; }
        };

        intervalRef.current = window.setInterval(tick, intervalMs);
        return () => { if (intervalRef.current != null) { clearInterval(intervalRef.current); intervalRef.current = null; } };
    }, [linked, cameraOn, intervalMs, perTick, size]);

    // Camera controls
    const startCamera = async () => {
        if (cameraOn) return;
        try {
            const s = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            setStream(s);
            setCameraOn(true);
        } catch {
            alert('Camera permission denied or unavailable');
        }
    };
    const stopCamera = () => {
        if (!cameraOn) return;
        // Stop detection first, then kill tracks
        stopEmotion();
        stream?.getTracks().forEach(t => t.stop());
        setStream(null);
        setCameraOn(false);
    };

    // Playlist actions
    const fillPlaylist = async () => {
        if (!linked) { alert('Link Spotify first'); return; }
        await fetch(`${BACKEND}/mood`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ label: moodRef.current, size }),
        });
    };
    const addOne = async () => {
        if (!linked) { alert('Link Spotify first'); return; }
        await fetch(`${BACKEND}/mood/tick`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ label: moodRef.current, keep: size, count: 1 }),
        });
    };

    return (
        <div style={{ maxWidth: 980, margin: '2rem auto', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <h1>🎭 Mood DJ — Editorial Mode</h1>

            <section style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '1rem' }}>
                <div>
                    <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        style={{
                            width: '100%',
                            borderRadius: 12,
                            background: '#111',
                            visibility: showPreview ? 'visible' : 'hidden',
                            opacity: showPreview ? 1 : 0,
                            pointerEvents: showPreview ? 'auto' : 'none',
                            height: showPreview ? undefined : 0,
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

                    {/* Calibration controls (only when tracking) */}
                    {tracking && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                            <button onClick={() => captureCalibration('neutral')}>Set Neutral</button>
                            <button onClick={() => captureCalibration('happy')}>Set Happy</button>
                            <button onClick={() => captureCalibration('sad')}>Set Sad</button>
                            <button onClick={swapNeutralSad} title="If your neutral/sad feel swapped">Swap Neutral ↔ Sad</button>
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

                    <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <label>
                            Size:&nbsp;
                            <input
                                type="text"
                                inputMode="numeric"
                                value={sizeField.text}
                                onChange={sizeField.onChange}
                                onBlur={sizeField.onBlur}
                                onKeyDown={sizeField.onKeyDown}
                                style={{ width: 72 }}
                            />
                        </label>

                        <label>
                            Every:&nbsp;
                            <input
                                type="text"
                                inputMode="numeric"
                                value={intervalField.text}
                                onChange={intervalField.onChange}
                                onBlur={intervalField.onBlur}
                                onKeyDown={intervalField.onKeyDown}
                                style={{ width: 72 }}
                            />s
                        </label>

                        <label>
                            Add per tick:&nbsp;
                            <input
                                type="text"
                                inputMode="numeric"
                                value={perTickField.text}
                                onChange={perTickField.onChange}
                                onBlur={perTickField.onBlur}
                                onKeyDown={perTickField.onKeyDown}
                                style={{ width: 60 }}
                            />
                        </label>

                        <button onClick={fillPlaylist} disabled={!linked}>Fill / Replace Playlist</button>
                        <button onClick={addOne} disabled={!linked}>Add One</button>
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
                            {/* <li>Runtime: {runtime}</li> */}
                            <li>Video: {videoEl?.videoWidth || 0}×{videoEl?.videoHeight || 0} readyState {videoEl?.readyState}</li>
                            <li>Stream: {stream ? stream.getVideoTracks().map(t => t.readyState).join(',') : 'none'}</li>
                            <li>{lastError && <span style={{ color: 'crimson' }}>Init: {lastError}</span>}</li>

                        </ul>

                        <div style={{ marginTop: 8 }}>
                            <div>Scores:</div>
                            {(['happy', 'neutral', 'sad'] as Mood[]).map(m => (
                                <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' }}>
                                    <div style={{ width: 70, textTransform: 'capitalize' }}>{m}</div>
                                    <div style={{ flex: 1, height: 8, border: '1px solid #ddd', borderRadius: 4 }}>
                                        <div style={{ width: `${Math.round((scores as any)[m] * 100)}%`, height: '100%', borderRadius: 4, background: '#888' }} />
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