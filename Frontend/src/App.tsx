import { useCallback, useEffect, useRef, useState } from 'react';
import { useEmotion, Mood } from './hooks/useEmotion';

const BACKEND = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '');

type SpTokens = { access_token: string; refresh_token: string; expires_at: number };
const TOK_KEY = 'sp_tokens';

/**
 * Numeric text field helper with debounced commit and key handling.
 * Clamps to [min, max], rounds to nearest integer, supports ArrowUp/Down steps.
 */
function useNumberField(opts: {
    value: number;
    setValue: (n: number) => void;
    min: number;
    max: number;
    step?: number;
}) {
    const { value, setValue, min, max, step = 1 } = opts;
    const [text, setText] = useState(String(value));

    useEffect(() => {
        setText(String(value));
    }, [value]);

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
            setValue(clamped);
            setText(String(clamped));
        }
        if (e.key === 'Enter') commit();
    };

    return { text, onChange, onBlur, onKeyDown };
}

/**
 * Extracts Spotify tokens from location hash and persists to localStorage.
 * Clears hash from the URL after capture.
 */
(function captureSpotifyTokensFromHash() {
    const m = /[#&]sp=([^&]+)/.exec(window.location.hash);
    if (!m) return;
    try {
        const payload = JSON.parse(decodeURIComponent(m[1])) as SpTokens;
        localStorage.setItem(TOK_KEY, JSON.stringify(payload));
    } catch { }
    const url = new URL(window.location.href);
    url.hash = '';
    window.history.replaceState({}, '', url.toString());
})();

/** Retrieves stored Spotify tokens from localStorage. */
function getStoredTokens(): SpTokens | null {
    try {
        return JSON.parse(localStorage.getItem(TOK_KEY) || 'null');
    } catch {
        return null;
    }
}

/** Persists Spotify tokens to localStorage. */
function setStoredTokens(t: SpTokens) {
    localStorage.setItem(TOK_KEY, JSON.stringify(t));
}

/** Builds authorization/refresh headers for backend requests. */
function authHeaders() {
    const t = getStoredTokens();
    if (!t) return {};
    return {
        Authorization: `Bearer ${t.access_token}`,
        'x-refresh-token': t.refresh_token,
        'x-expires-at': String(t.expires_at),
    } as Record<string, string>;
}

/** Updates stored access token from backend response headers, if provided. */
function maybeUpdateTokensFromResponse(r: Response) {
    const newAccess = r.headers.get('x-new-access-token');
    const newExp = r.headers.get('x-new-expires-at');
    if (newAccess && newExp) {
        const t = getStoredTokens();
        if (t) {
            t.access_token = newAccess;
            t.expires_at = Number(newExp);
            setStoredTokens(t);
        }
    }
}

export default function App() {
    const [showPreview, setShowPreview] = useState(true);
    const [cameraOn, setCameraOn] = useState(false);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [linked, setLinked] = useState(false);
    const [size, setSize] = useState(25);
    const [intervalMs, setIntervalMs] = useState(180_000);
    const [perTick, setPerTick] = useState(1);
    const [playlist, setPlaylist] = useState<{ id: string; url: string | null; uri: string; name: string } | null>(null);
    const [mood, setMood] = useState<Mood>('neutral');

    const [showStatus, setShowStatus] = useState(true);

    const moodRef = useRef<Mood>('neutral');
    useEffect(() => {
        moodRef.current = mood;
    }, [mood]);

    const intervalRef = useRef<number | null>(null);
    const inFlightRef = useRef(false);

    const sizeField = useNumberField({ value: size, setValue: setSize, min: 1, max: 100 });
    const intervalField = useNumberField({
        value: Math.round(intervalMs / 1000),
        setValue: secs => setIntervalMs(secs * 1000),
        min: 5,
        max: 3600,
        step: 5,
    });
    const perTickField = useNumberField({ value: perTick, setValue: setPerTick, min: 1, max: 5 });

    const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
    const videoRef = useCallback((el: HTMLVideoElement | null) => {
        setVideoEl(el);
    }, []);

    const {
        mood: detectedMood,
        scores,
        ready,
        running: emoRunning,
        tracking,
        faceCount,
        lastError,
        start: startEmotion,
        stop: stopEmotion,
        captureCalibration,
        clearCalibration,
    } = useEmotion(videoEl);

    useEffect(() => {
        if (detectedMood) setMood(detectedMood as Mood);
    }, [detectedMood]);

    useEffect(() => {
        if (!videoEl) return;

        function bind() {
            if (!videoEl || !stream) return;
            (videoEl as any).srcObject = stream;
            const onLoaded = () => {
                startEmotion();
                videoEl.play?.().catch(() => { });
                videoEl.removeEventListener('loadeddata', onLoaded);
            };
            videoEl.addEventListener('loadeddata', onLoaded);
            videoEl.load?.();
        }

        if (stream) {
            videoEl.pause?.();
            videoEl.removeAttribute('src');
            (videoEl as any).srcObject = null;
            videoEl.load?.();
            setTimeout(bind, 0);
        } else {
            videoEl.pause?.();
            videoEl.removeAttribute('src');
            (videoEl as any).srcObject = null;
            videoEl.load?.();
            stopEmotion();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoEl, stream]);

    const linkSpotify = () => {
        if (!BACKEND) {
            alert('Backend URL is not configured. Set VITE_BACKEND_URL.');
            return;
        }
        const returnTo = encodeURIComponent(window.location.origin);
        window.location.href = `${BACKEND}/login?return_to=${returnTo}`;
    };

    useEffect(() => {
        const check = async () => {
            try {
                const r = await fetch(`${BACKEND}/me`, { headers: authHeaders() });
                maybeUpdateTokensFromResponse(r);
                setLinked(r.ok);
            } catch {
                setLinked(false);
            }
        };
        check();

        if (new URLSearchParams(window.location.search).get('linked') === '1') {
            check();
            const url = new URL(window.location.href);
            url.searchParams.delete('linked');
            window.history.replaceState({}, '', url.toString());
        }

        const onVis = () => {
            if (document.visibilityState === 'visible') check();
        };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    useEffect(() => {
        const load = async () => {
            try {
                const me = await fetch(`${BACKEND}/me`, { headers: authHeaders() });
                maybeUpdateTokensFromResponse(me);
                if (!me.ok) return;
                const r = await fetch(`${BACKEND}/playlist`, { headers: authHeaders() });
                maybeUpdateTokensFromResponse(r);
                if (r.ok) setPlaylist(await r.json());
            } catch { }
        };
        load();
        if (new URLSearchParams(window.location.search).get('linked') === '1') load();
    }, [linked]);

    useEffect(() => {
        if (intervalRef.current != null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        if (!linked || !cameraOn) return;

        const tick = async () => {
            if (inFlightRef.current) return;
            inFlightRef.current = true;
            try {
                const r = await fetch(`${BACKEND}/mood/tick`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ label: moodRef.current, keep: size, count: perTick }),
                });
                maybeUpdateTokensFromResponse(r);
            } catch {
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
    }, [linked, cameraOn, intervalMs, perTick, size]);

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
        stopEmotion();
        stream?.getTracks().forEach(t => t.stop());
        setStream(null);
        setCameraOn(false);
    };

    const fillPlaylist = async () => {
        if (!linked) {
            alert('Link Spotify first');
            return;
        }
        await fetch(`${BACKEND}/mood`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ label: moodRef.current, size }),
        });
    };

    const addOne = async () => {
        if (!linked) {
            alert('Link Spotify first');
            return;
        }
        await fetch(`${BACKEND}/mood/tick`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ label: moodRef.current, keep: size, count: 1 }),
        });
    };

    const disconnectSpotify = async () => {
        try {
            await fetch(`${BACKEND}/disconnect`, { method: 'POST' });
        } catch { }

        localStorage.removeItem(TOK_KEY);
        setLinked(false);
        setPlaylist(null);

        const url = new URL(window.location.href);
        url.hash = '';
        url.searchParams.delete('linked');
        window.history.replaceState({}, '', url.toString());
    };


    // ====== Dark theme tokens & globals ======
    const colors = {
        bg: '#0b0b0f',
        card: '#121219',
        border: '#2a2a30',
        text: '#e5e7eb',
        textMuted: '#a1a1aa',
        btn: '#1f2937',
        btnBorder: '#374151',
        btnHover: '#263244',
        barTrack: '#2a2a32',
        happy: '#fe5251',
        neutral: '#9ca3af',
        sad: '#3c8bd5',
    };

    // Global page background & margin fix
    useEffect(() => {
        const html = document.documentElement;
        const body = document.body;
        const prevHtmlBg = html.style.background;
        const prevBodyBg = body.style.background;
        const prevBodyMargin = body.style.margin;
        html.style.background = colors.bg;
        body.style.background = colors.bg;
        body.style.margin = '0';
        return () => {
            html.style.background = prevHtmlBg;
            body.style.background = prevBodyBg;
            body.style.margin = prevBodyMargin;
        };
    }, []);

    const BUTTON_MIN_WIDTH = 160;
    const buttonStyle: React.CSSProperties = {
        padding: '8px 12px',
        borderRadius: 8,
        border: `1px solid ${colors.btnBorder}`,
        background: colors.btn,
        color: colors.text,
        cursor: 'pointer',
        minWidth: BUTTON_MIN_WIDTH,
        textAlign: 'center',
        display: 'inline-block',
        lineHeight: 1.2,
        fontSize: 14,
    };

    // Smaller button variant used inside the calibration grid (no minWidth; fills grid cell)
    const smallButtonStyle: React.CSSProperties = {
        ...buttonStyle,
        minWidth: 0,
        width: '100%',
    };

    return (
        <div style={{ minHeight: '100vh', background: colors.bg, color: colors.text }}>
            <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 16px', fontFamily: 'Inter, system-ui, sans-serif' }}>
                {/* Title */}
                <div style={{ textAlign: 'center', marginBottom: 18 }}>
                    <h1
                        style={{
                            margin: 0,
                            fontSize: 45,
                            lineHeight: 1,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 12,
                        }}
                    >
                        <span>Mood DJ</span>
                        <img
                            src="/MoodDJ_Banner.png"
                            alt="Mood DJ Banner"
                            style={{ height: '1.5em', width: 'auto', transform: 'translateY(2px)' }}
                        />
                    </h1>
                    <div style={{ marginTop: 6, color: colors.textMuted, fontSize: 18 }}>by William Zhou</div>
                </div>


                <section style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '16px' }}>
                    {/* Left column */}
                    <div>
                        <video
                            ref={videoRef}
                            autoPlay
                            playsInline
                            muted
                            style={{
                                width: '100%',
                                borderRadius: 12,
                                background: '#0b0b0b',
                                visibility: showPreview ? 'visible' : 'hidden',
                                opacity: showPreview ? 1 : 0,
                                pointerEvents: showPreview ? 'auto' : 'none',
                                height: showPreview ? undefined : 0,
                            }}
                        />
                        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {!cameraOn ? (
                                <button style={buttonStyle} onClick={startCamera}>Start Camera</button>
                            ) : (
                                <button style={buttonStyle} onClick={stopCamera}>Stop Camera</button>
                            )}
                            <button style={buttonStyle} onClick={() => setShowPreview(v => !v)}>
                                {showPreview ? 'Hide Preview' : 'Show Preview'}
                            </button>
                        </div>

                        {/* Mood + Scores */}
                        <div
                            style={{
                                marginTop: 16,
                                padding: 12,
                                border: `1px solid ${colors.border}`,
                                borderRadius: 8,
                                background: colors.card,
                            }}
                        >
                            <div style={{ textAlign: 'center', marginBottom: 8, fontWeight: 700, fontSize: 18 }}>
                                Mood: <span style={{ textTransform: 'lowercase' }}>{mood}</span>
                            </div>
                            {(['happy', 'neutral', 'sad'] as Mood[]).map(m => {
                                const pct = Math.round((scores as any)[m] * 100);
                                const fill = m === 'happy' ? colors.happy : m === 'neutral' ? colors.neutral : colors.sad;
                                const label = m === 'neutral' ? 'Chill' : m.charAt(0).toUpperCase() + m.slice(1);
                                return (
                                    <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 14 }}>
                                        <div style={{ width: 70 }}>{label}</div>
                                        <div style={{ flex: 1, height: 10, borderRadius: 6, background: colors.barTrack, overflow: 'hidden' }}>
                                            <div style={{ width: `${pct}%`, height: '100%', background: fill }} />
                                        </div>
                                        <div style={{ width: 40, textAlign: 'right', color: colors.textMuted }}>{pct}%</div>
                                    </div>
                                );
                            })}

                            {/* Calibration */}
                            {tracking && (
                                <>
                                    {/* Mood Buttons */}
                                    <div
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(3, 1fr)',
                                            gap: 8,
                                            marginTop: 10,
                                        }}
                                    >
                                        <button style={smallButtonStyle} onClick={() => captureCalibration('happy')}>Set Happy</button>
                                        <button style={smallButtonStyle} onClick={() => captureCalibration('neutral')}>Set Neutral</button>
                                        <button style={smallButtonStyle} onClick={() => captureCalibration('sad')}>Set Sad</button>
                                    </div>
                                    <div style={{ marginTop: 8 }}>
                                        <button style={{ ...buttonStyle, width: '100%' }} onClick={clearCalibration}>
                                            Clear Calibration
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Right column */}
                    <div>
                        {/* Controls row */}
                        <div style={{ marginTop: 6, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    flexWrap: 'nowrap',
                                    whiteSpace: 'nowrap',
                                    flexShrink: 0,
                                }}
                            >
                                <label style={{ whiteSpace: 'nowrap' }}>
                                    Size:&nbsp;
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={sizeField.text}
                                        onChange={sizeField.onChange}
                                        onBlur={sizeField.onBlur}
                                        onKeyDown={sizeField.onKeyDown}
                                        style={{
                                            width: 64,
                                            background: colors.card,
                                            color: colors.text,
                                            border: `1px solid ${colors.border}`,
                                            borderRadius: 6,
                                            padding: '6px 8px',
                                        }}
                                    />
                                </label>

                                <label style={{ whiteSpace: 'nowrap' }}>
                                    Every:&nbsp;
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={intervalField.text}
                                        onChange={intervalField.onChange}
                                        onBlur={intervalField.onBlur}
                                        onKeyDown={intervalField.onKeyDown}
                                        style={{
                                            width: 64,
                                            background: colors.card,
                                            color: colors.text,
                                            border: `1px solid ${colors.border}`,
                                            borderRadius: 6,
                                            padding: '6px 8px',
                                        }}
                                    />
                                    <span>&nbsp;s</span>
                                </label>

                                <label style={{ whiteSpace: 'nowrap' }}>
                                    Add per tick:&nbsp;
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={perTickField.text}
                                        onChange={perTickField.onChange}
                                        onBlur={perTickField.onBlur}
                                        onKeyDown={perTickField.onKeyDown}
                                        style={{
                                            width: 56,
                                            background: colors.card,
                                            color: colors.text,
                                            border: `1px solid ${colors.border}`,
                                            borderRadius: 6,
                                            padding: '6px 8px',
                                        }}
                                    />
                                </label>
                            </div>

                            <button style={buttonStyle} onClick={fillPlaylist} disabled={!linked}>
                                Fill / Replace Playlist
                            </button>
                            <button style={buttonStyle} onClick={addOne} disabled={!linked}>
                                Add One
                            </button>
                            <button
                                style={{ ...buttonStyle, opacity: linked ? 0.85 : 1 }}
                                onClick={linkSpotify}
                                disabled={linked}
                                title={linked ? 'Already linked' : ''}
                            >
                                {linked ? 'Link Spotify ✔' : 'Link Spotify'}
                            </button>
                            <button
                                style={buttonStyle}
                                onClick={disconnectSpotify}
                                disabled={!linked}
                                title={!linked ? 'Not linked' : 'Clear saved Spotify tokens'}
                            >
                                Disconnect Spotify
                            </button>
                            {playlist?.url && (
                                <a
                                    href={playlist.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ ...buttonStyle, textDecoration: 'none' }}
                                >
                                    Open MoodDJ on Spotify
                                </a>
                            )}
                        </div>

                        {/* Collapsible Status */}
                        <div
                            style={{
                                marginTop: 16,
                                padding: 12,
                                border: `1px solid ${colors.border}`,
                                borderRadius: 8,
                                background: colors.card,
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <strong>Status</strong>
                                <button style={buttonStyle} onClick={() => setShowStatus(s => !s)}>
                                    {showStatus ? 'Hide Status' : 'Show Status'}
                                </button>
                            </div>

                            {showStatus && (
                                <ul style={{ marginTop: 8, paddingLeft: 18 }}>
                                    <li>Camera: {cameraOn ? 'on' : 'off'}</li>
                                    <li>Spotify: {linked ? 'linked' : 'not linked'}</li>
                                    <li>
                                        Detector: {ready ? 'ready' : 'loading'} {emoRunning ? '(running)' : ''}
                                    </li>
                                    <li>Tracking face: {tracking ? `yes (${faceCount})` : 'no'}</li>
                                    {lastError && <li style={{ color: '#f87171' }}>Init: {lastError}</li>}
                                </ul>
                            )}
                        </div>
                    </div>
                </section>

                {/* Bottom-left "Documentation" button */}
                <a
                    href="https://github.com/williamtzhou/MoodDJ"
                    target="_blank"
                    rel="noreferrer"
                    style={{
                        position: 'fixed',
                        left: 16,
                        bottom: 16,
                        ...buttonStyle,
                        textDecoration: 'none',
                    }}
                >
                    Documentation
                </a>
            </div>
        </div>
    );
}
