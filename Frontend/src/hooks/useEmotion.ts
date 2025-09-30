import { useEffect, useRef, useState } from 'react';

export type Mood = 'happy' | 'neutral' | 'sad';
type Scores = { happy: number; neutral: number; sad: number };

type Return = {
    mood: Mood;
    scores: Scores;
    running: boolean;
    tracking: boolean;
    runtime: 'tfjs' | 'mediapipe' | null;
    lastError: string | null;

    ready: boolean;
    faceCount: number;
    captureCalibration: (w: 'happy' | 'neutral' | 'sad') => void;
    clearCalibration: () => void;
    swapNeutralSad: () => void;

    start: () => void;
    stop: () => void;
};

const BACKEND =
    (import.meta as any).env?.VITE_BACKEND_URL ??
    `${location.protocol}//${location.hostname}:3001`;

const MP_BASE = '/mediapipe';

let mpScriptPromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
        const s = document.createElement('script');
        s.async = true;
        s.src = src;
        s.dataset.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

async function ensureMediaPipe(): Promise<any> {
    if ((window as any).FaceMesh) return (window as any).FaceMesh;

    (window as any).Module = (window as any).Module || {};
    (window as any).Module.locateFile = (f: string) => `${MP_BASE}/${f}`;

    if (!mpScriptPromise) {
        const v = 'v1';
        mpScriptPromise = loadScript(`${MP_BASE}/face_mesh.js?${v}`);
    }
    await mpScriptPromise;

    const FaceMeshCtor = (window as any).FaceMesh;
    if (!FaceMeshCtor) throw new Error('FaceMesh global not loaded');
    return FaceMeshCtor;
}

/* ----------------------- landmark helpers ----------------------- */

type Pt = { x: number; y: number; z?: number };

function d(a: Pt, b: Pt) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
}
function avg2(a: Pt, b: Pt): Pt { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function norm(v: number, a: number, b: number) { return clamp01((v - a) / (b - a)); }
function sigmoid(x: number) { return 1 / (1 + Math.exp(-x)); }

/**
 * Indices in MediaPipe FaceMesh (468 pts). These cover eyes and mouth.
 * Using stable, commonly referenced points:
 * - Mouth corners: 61 (L), 291 (R)
 * - Upper/Lower inner lips: 13 (upper), 14 (lower)
 * - Eye lids: left 159 (upper), 145 (lower); right 386 (upper), 374 (lower)
 * - Eye corners: left 33 (outer), 133 (inner); right 263 (outer), 362 (inner)
 */
const IDX = {
    mouthL: 61, mouthR: 291, lipUp: 13, lipLo: 14,
    lEyeUp: 159, lEyeLo: 145, rEyeUp: 386, rEyeLo: 374,
    lEyeOuter: 33, lEyeInner: 133, rEyeOuter: 263, rEyeInner: 362,
};

/* ------------------- calibration + scoring ---------------------- */

type Calib = {
    // Baseline (neutral) measurements, normalized by interocular distance.
    base: {
        eyeGap: number;      // average eye openness
        mouthOpen: number;   // lip gap
        smileUp: number;     // mouth-corner lift vs mouth center
        mouthWidth: number;  // corner-to-corner width
    } | null;
    swapNS: boolean;        // when user feels neutral/sad are flipped
};

function defaultCalib(): Calib {
    return { base: null, swapNS: false };
}

function extractMetrics(pts: Pt[]) {
    const p = (i: number) => pts[i];

    // Interocular scale for normalization
    const leftEyeCtr = avg2(p(IDX.lEyeOuter), p(IDX.lEyeInner));
    const rightEyeCtr = avg2(p(IDX.rEyeOuter), p(IDX.rEyeInner));
    const eyeDist = d(leftEyeCtr, rightEyeCtr) || 1;

    const mouthL = p(IDX.mouthL), mouthR = p(IDX.mouthR);
    const lipUp = p(IDX.lipUp), lipLo = p(IDX.lipLo);

    const mouthCenter = avg2(lipUp, lipLo);
    const cornerY = (mouthL.y + mouthR.y) / 2;

    const mouthWidth = d(mouthL, mouthR) / eyeDist;
    const mouthOpen = d(lipUp, lipLo) / eyeDist;
    const eyeOpen =
        (d(p(IDX.lEyeUp), p(IDX.lEyeLo)) + d(p(IDX.rEyeUp), p(IDX.rEyeLo))) /
        (2 * eyeDist);

    // Positive when corners are above mouth center (smile upturn).
    const smileUp = (mouthCenter.y - cornerY) / eyeDist;

    return { mouthWidth, mouthOpen, eyeOpen, smileUp, scale: eyeDist };
}

function toScores(metrics: ReturnType<typeof extractMetrics>, calib: Calib): Scores {
    const { mouthWidth, mouthOpen, eyeOpen, smileUp } = metrics;

    // If no calibration yet, use gentle defaults taken from typical normalized values.
    const base = calib.base ?? {
        eyeGap: 0.055,
        mouthOpen: 0.025,
        smileUp: 0.00,
        mouthWidth: 0.48,
    };

    // Features relative to baseline.
    const dSmile = smileUp - base.smileUp;
    const dOpen = mouthOpen - base.mouthOpen;

    // Happy: mouth corners lifted (dSmile↑) and slightly open (dOpen mildly ↑).
    const happyRaw =
        0.75 * sigmoid(dSmile * 60) +
        0.25 * sigmoid((dOpen) * 60);

    // Sad: corners down (dSmile↓) and closed mouth/eyes (dOpen↓, eyeOpen↓).
    const sadRaw =
        0.7 * sigmoid((-dSmile) * 60) +
        0.2 * sigmoid((base.mouthOpen - mouthOpen) * 60) +
        0.1 * sigmoid((base.eyeGap - eyeOpen) * 80);

    // Neutral favors being near baseline on both mouth open and smile.
    const neutralRaw = clamp01(
        1 - 0.6 * Math.min(1, Math.abs(dSmile) * 120)
        - 0.4 * Math.min(1, Math.abs(dOpen) * 120)
    );

    let happy = happyRaw, sad = sadRaw, neutral = neutralRaw;

    // Optional flip if the user reports neutral/sad feel swapped.
    if (calib.swapNS) {
        const t = neutral;
        neutral = sad;
        sad = t;
    }

    // Normalize to sum 1 and clamp.
    const sum = happy + neutral + sad || 1;
    return {
        happy: clamp01(happy / sum),
        neutral: clamp01(neutral / sum),
        sad: clamp01(sad / sum),
    };
}

/* --------------------------- hook ------------------------------- */

export function useEmotion(videoEl: HTMLVideoElement | null): Return {
    const [mood, setMood] = useState<Mood>('neutral');
    const [scores, setScores] = useState<Scores>({ happy: 0.33, neutral: 0.34, sad: 0.33 });
    const [running, setRunning] = useState(false);
    const [tracking, setTracking] = useState(false);
    const [runtime, setRuntime] = useState<'tfjs' | 'mediapipe' | null>(null);
    const [lastError, setLastError] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const [faceCount, setFaceCount] = useState(0);

    const mpRef = useRef<any | null>(null);
    const rafRef = useRef<number | null>(null);
    const missFramesRef = useRef(0);

    // Calibration stored in-memory; can be swapped to localStorage if desired.
    const calibRef = useRef<Calib>(defaultCalib());

    // Exponential moving average for stable bars.
    const emaRef = useRef<Scores>({ happy: 0.33, neutral: 0.34, sad: 0.33 });
    const ALPHA = 0.2;

    const captureCalibration = (w: 'happy' | 'neutral' | 'sad') => {
        // Only neutral baseline is recorded for geometry; happy/sad buttons exist
        // to allow the UI to save that "this looks neutral/happy/sad" if extended later.
        if (w !== 'neutral') return;
        const last = (mpRef.current as any)?._lastPts as Pt[] | undefined;
        if (!last || last.length < 400) return;
        const m = extractMetrics(last);
        calibRef.current.base = {
            eyeGap: m.eyeOpen,
            mouthOpen: m.mouthOpen,
            smileUp: m.smileUp,
            mouthWidth: m.mouthWidth,
        };
    };
    const clearCalibration = () => { calibRef.current = defaultCalib(); };
    const swapNeutralSad = () => { calibRef.current.swapNS = !calibRef.current.swapNS; };

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const FaceMeshCtor = await ensureMediaPipe();

                const fm = new FaceMeshCtor({
                    locateFile: (f: string) => `${MP_BASE}/${f}`,
                });

                fm.setOptions({
                    maxNumFaces: 1,
                    refineLandmarks: true,
                    minDetectionConfidence: 0.5,
                    minTrackingConfidence: 0.5,
                });

                fm.onResults((res: any) => {
                    const faces: Pt[][] = res.multiFaceLandmarks || [];
                    setFaceCount(faces.length);

                    const has = faces.length > 0 && faces[0]?.length;
                    setTracking(Boolean(has));

                    if (has) {
                        const pts = faces[0];
                        (fm as any)._lastPts = pts; // cached for calibration capture

                        const m = extractMetrics(pts);
                        const raw = toScores(m, calibRef.current);

                        // EMA smoothing
                        const prev = emaRef.current;
                        const smoothed: Scores = {
                            happy: prev.happy + ALPHA * (raw.happy - prev.happy),
                            neutral: prev.neutral + ALPHA * (raw.neutral - prev.neutral),
                            sad: prev.sad + ALPHA * (raw.sad - prev.sad),
                        };
                        emaRef.current = smoothed;
                        setScores(smoothed);

                        // Winning label
                        const label: Mood =
                            smoothed.happy >= smoothed.neutral && smoothed.happy >= smoothed.sad ? 'happy' :
                                smoothed.sad >= smoothed.neutral ? 'sad' : 'neutral';
                        setMood(label);

                        missFramesRef.current = 0;
                    } else {
                        missFramesRef.current += 1;
                        if (missFramesRef.current > 10) {
                            emaRef.current = { happy: 0.33, neutral: 0.34, sad: 0.33 };
                            setScores(emaRef.current);
                            setMood('neutral');
                        }
                    }
                });

                if (cancelled) return;
                mpRef.current = fm;
                setRuntime('mediapipe');
                setReady(true);
                setLastError(null);
            } catch (e: any) {
                if (!cancelled) {
                    setLastError(`init failed (mediapipe direct): ${e?.message || String(e)}`);
                    setReady(false);
                }
            }
        })();

        return () => {
            cancelled = true;
            try { mpRef.current?.close?.(); } catch { }
            mpRef.current = null;
        };
    }, []);

    function stop() {
        setRunning(false);
        setTracking(false);
        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
    }

    function start() {
        if (!videoEl || !mpRef.current) {
            setLastError('detector/video not ready');
            return;
        }
        if (running) return;
        setRunning(true);
        missFramesRef.current = 0;
        kickOff();
    }

    function kickOff() {
        if (!running || !videoEl || !mpRef.current) return;
        const vw = videoEl.videoWidth || 0;
        const vh = videoEl.videoHeight || 0;
        if (vw === 0 || vh === 0) {
            videoEl.play?.().catch(() => { });
            rafRef.current = requestAnimationFrame(kickOff);
            return;
        }
        loop();
    }

    async function loop() {
        if (!running || !videoEl || !mpRef.current) return;
        try {
            await mpRef.current.send({ image: videoEl });
        } catch (e: any) {
            setLastError(`loop error: ${(e as Error).message || e}`);
            setRunning(false);
            await mpRef.current?.close?.().catch(() => { });
            mpRef.current = null;
            return;
        }
        rafRef.current = requestAnimationFrame(loop);
    }

    useEffect(() => {
        if (!running) return;
        if (!videoEl || !mpRef.current) return;
        const onReady = () => kickOff();
        videoEl.addEventListener('loadedmetadata', onReady);
        videoEl.addEventListener('canplay', onReady);
        if (videoEl.readyState >= 2) kickOff();
        return () => {
            videoEl.removeEventListener('loadedmetadata', onReady);
            videoEl.removeEventListener('canplay', onReady);
        };
    }, [videoEl, running, mpRef.current]);

    return {
        mood,
        scores,
        running,
        tracking,
        runtime,
        lastError,
        ready,
        faceCount,
        captureCalibration,
        clearCalibration,
        swapNeutralSad,
        start,
        stop,
    };
}
