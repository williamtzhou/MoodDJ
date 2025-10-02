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

const MP_BASE = '/mediapipe';

let mpScriptPromise: Promise<void> | null = null;

/**
 * Dynamically loads a script once per URL. Subsequent calls are deduplicated.
 * @param src Absolute or relative script URL.
 * @returns Promise that resolves when the script loads.
 */
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

/**
 * Ensures MediaPipe FaceMesh is available on the window and configured to
 * resolve asset files from MP_BASE.
 * @returns FaceMesh constructor from MediaPipe.
 */
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

/** 2D point used by facial landmark calculations. */
type Pt = { x: number; y: number; z?: number };

/**
 * Euclidean distance in 2D.
 * @param a First point.
 * @param b Second point.
 * @returns Distance between points.
 */
function d(a: Pt, b: Pt) {
    const dx = a.x - b.x,
        dy = a.y - b.y;
    return Math.hypot(dx, dy);
}

/**
 * Arithmetic mean of two points.
 * @param a First point.
 * @param b Second point.
 * @returns Midpoint.
 */
function avg2(a: Pt, b: Pt): Pt {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * FaceMesh landmark indices used for mouth and eye features.
 */
const IDX = {
    mouthL: 61,
    mouthR: 291,
    lipUp: 13,
    lipLo: 14,
    lEyeUp: 159,
    lEyeLo: 145,
    rEyeUp: 386,
    rEyeLo: 374,
    lEyeOuter: 33,
    lEyeInner: 133,
    rEyeOuter: 263,
    rEyeInner: 362,
};

/** Calibration parameters for neutral baseline and optional neutral/sad swap. */
type Calib = {
    base:
    | {
        eyeGap: number;
        mouthOpen: number;
        smileUp: number;
        mouthWidth: number;
    }
    | null;
    swapNS: boolean;
};

/**
 * Default calibration with no baseline and no neutral/sad swap.
 * @returns Fresh calibration object.
 */
function defaultCalib(): Calib {
    return { base: null, swapNS: false };
}

/**
 * Extracts normalized facial metrics from 468-point landmarks.
 * Normalization uses interocular distance.
 * @param pts Landmark array.
 * @returns Derived metrics and scale.
 */
function extractMetrics(pts: Pt[]) {
    const p = (i: number) => pts[i];

    const leftEyeCtr = avg2(p(IDX.lEyeOuter), p(IDX.lEyeInner));
    const rightEyeCtr = avg2(p(IDX.rEyeOuter), p(IDX.rEyeInner));
    const eyeDist = d(leftEyeCtr, rightEyeCtr) || 1;

    const mouthL = p(IDX.mouthL),
        mouthR = p(IDX.mouthR);
    const lipUp = p(IDX.lipUp),
        lipLo = p(IDX.lipLo);

    const mouthCenter = avg2(lipUp, lipLo);
    const cornerY = (mouthL.y + mouthR.y) / 2;

    const mouthWidth = d(mouthL, mouthR) / eyeDist;
    const mouthOpen = d(lipUp, lipLo) / eyeDist;
    const eyeOpen =
        (d(p(IDX.lEyeUp), p(IDX.lEyeLo)) + d(p(IDX.rEyeUp), p(IDX.rEyeLo))) / (2 * eyeDist);

    const smileUp = (mouthCenter.y - cornerY) / eyeDist;

    return { mouthWidth, mouthOpen, eyeOpen, smileUp, scale: eyeDist };
}

/**
 * Three-way softmax with temperature.
 * @param a First logit.
 * @param b Second logit.
 * @param c Third logit.
 * @param T Softmax temperature.
 * @returns Normalized probabilities.
 */
function softmax3(a: number, b: number, c: number, T = 1.8) {
    const ex = (x: number) => Math.exp(x / T);
    const ea = ex(a),
        eb = ex(b),
        ec = ex(c);
    const s = ea + eb + ec || 1;
    return { a: ea / s, b: eb / s, c: ec / s };
}

/**
 * Converts facial metrics into mood scores using a calibrated baseline and
 * a temperature-softmax. Includes optional neutral/sad swap and EMA performed upstream.
 * @param metrics Extracted facial metrics.
 * @param calib Calibration parameters.
 * @returns Scores for happy, neutral, and sad.
 */
function toScores(metrics: ReturnType<typeof extractMetrics>, calib: Calib): Scores {
    const { mouthWidth, mouthOpen, eyeOpen, smileUp } = metrics;

    const base =
        calib.base ?? {
            eyeGap: 0.055,
            mouthOpen: 0.025,
            smileUp: 0.0,
            mouthWidth: 0.48,
        };

    const dSmile = smileUp - base.smileUp;
    const dOpen = mouthOpen - base.mouthOpen;
    const dEye = eyeOpen - base.eyeGap;

    const TH_SMILE = 0.018;
    const TH_OPEN = 0.018;
    const inNeutralBand = Math.abs(dSmile) < TH_SMILE && Math.abs(dOpen) < TH_OPEN;

    const zSmile = dSmile / TH_SMILE;
    const zOpen = dOpen / TH_OPEN;
    let neutralRaw = Math.exp(-0.5 * (zSmile * zSmile * 0.6 + zOpen * zOpen * 0.6));
    if (inNeutralBand) neutralRaw *= 1.4;

    const S1 = 28;
    const S2 = 18;
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

    const happyRaw =
        0.75 * sigmoid(dSmile * S1) +
        0.25 * sigmoid(dOpen * S2) +
        0.05 * sigmoid((-(dEye)) * 60);

    const sadRaw =
        0.7 * sigmoid(-dSmile * S1) +
        0.2 * sigmoid((-(dOpen) + 0.003) * S2) +
        0.1 * sigmoid((-(dEye) + 0.002) * 90);

    let h = happyRaw,
        n = neutralRaw,
        s = sadRaw;
    if (calib.swapNS) {
        const t = n;
        n = s;
        s = t;
    }

    const { a: H, b: N, c: S } = softmax3(h, n, s, 1.9);

    const minNeutral = 0.1;
    const adjN = Math.max(N, minNeutral);
    const renorm = H + adjN + S || 1;

    return {
        happy: H / renorm,
        neutral: adjN / renorm,
        sad: S / renorm,
    };
}

/**
 * React hook for MediaPipe FaceMesh-based emotion estimation from a HTMLVideoElement.
 * Provides smoothed scores, a dominant mood label, runtime state, and calibration controls.
 * @param videoEl Attached video element receiving a user media stream.
 * @returns Hook state and control methods.
 */
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

    const calibRef = useRef<Calib>(defaultCalib());
    const emaRef = useRef<Scores>({ happy: 0.33, neutral: 0.34, sad: 0.33 });
    const ALPHA = 0.2;

    /**
     * Captures a neutral baseline calibration from the most recent landmarks.
     * Other labels are accepted for extensibility but do not alter baseline geometry.
     * @param w Target label for calibration capture.
     */
    const captureCalibration = (w: 'happy' | 'neutral' | 'sad') => {
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

    /** Resets calibration to defaults. */
    const clearCalibration = () => {
        calibRef.current = defaultCalib();
    };

    /** Toggles neutral/sad interpretation swap. */
    const swapNeutralSad = () => {
        calibRef.current.swapNS = !calibRef.current.swapNS;
    };

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
                        (fm as any)._lastPts = pts;

                        const m = extractMetrics(pts);
                        const raw = toScores(m, calibRef.current);

                        const prev = emaRef.current;
                        const smoothed: Scores = {
                            happy: prev.happy + ALPHA * (raw.happy - prev.happy),
                            neutral: prev.neutral + ALPHA * (raw.neutral - prev.neutral),
                            sad: prev.sad + ALPHA * (raw.sad - prev.sad),
                        };
                        emaRef.current = smoothed;
                        setScores(smoothed);

                        const label: Mood =
                            smoothed.happy >= smoothed.neutral && smoothed.happy >= smoothed.sad
                                ? 'happy'
                                : smoothed.sad >= smoothed.neutral
                                    ? 'sad'
                                    : 'neutral';
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
            try {
                mpRef.current?.close?.();
            } catch { }
            mpRef.current = null;
        };
    }, []);

    /**
     * Stops the processing loop and resets tracking state.
     */
    function stop() {
        setRunning(false);
        setTracking(false);
        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
    }

    /**
     * Starts the processing loop if the video and detector are ready.
     * Sets an initial miss counter and kicks off the frame loop.
     */
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

    /**
     * Waits for the video element to have measurable dimensions before looping.
     */
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

    /**
     * Sends frames to the MediaPipe pipeline and schedules the next iteration.
     * Errors are captured, surfaced, and the pipeline is closed on failure.
     */
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
