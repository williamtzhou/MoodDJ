import { useEffect, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import * as faceLandmarksDetection from '@tensorflow-models/face-landmarks-detection';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import '@tensorflow/tfjs-backend-wasm';

export type Mood = 'happy' | 'neutral' | 'sad';
type KP = { x: number; y: number; z?: number };
type Scores = { happy: number; neutral: number; sad: number };

// Per-frame features
type Features = {
    mw: number;   // mouth width / face width
    mh: number;   // mouth height / face width
    eye: number;  // average eye openness / face width
    corner: number; // mouth-corner lift (+ up / - down) / face width
};

// Saved calibration
type Calib = {
    neutral?: Features;
    happy?: Features;
    sad?: Features;
};

const CALIB_KEY = 'mooddj_calib_v2';

setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');

// @ts-ignore internal flags are allowed
tf.env().set('WASM_HAS_SIMD_SUPPORT', false);
// @ts-ignore
tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
// @ts-ignore
tf.env().set('WASM_NUM_THREADS', 1);

const DETECT_W = 320;
const DETECT_H = 240;
const off = document.createElement('canvas');
off.width = DETECT_W; off.height = DETECT_H;
const offCtx = off.getContext('2d', { willReadFrequently: true })!;
function getDetectorInput(videoEl: HTMLVideoElement) {
    offCtx.drawImage(videoEl, 0, 0, off.width, off.height);
    return off; // pass this to estimateFaces()
}

export function useEmotion(videoEl: HTMLVideoElement | null) {
    const [mood, setMood] = useState<Mood>('neutral');
    const [scores, setScores] = useState<Scores>({ happy: 0.33, neutral: 0.34, sad: 0.33 });

    const [ready, setReady] = useState(false);
    const [running, setRunning] = useState(false);
    const [tracking, setTracking] = useState(false);
    const [faceCount, setFaceCount] = useState(0);
    const [lastError, setLastError] = useState<string | null>(null);
    const [runtime, setRuntime] = useState<'tfjs' | 'mediapipe'>('tfjs');

    const detectorRef = useRef<faceLandmarksDetection.FaceLandmarksDetector | null>(null);
    const rafRef = useRef<number | null>(null);
    const zeroFaceFramesRef = useRef(0);
    const restartEpochRef = useRef(0); // bumps each (re)start to re-arm listeners

    // Calibration + smoothing
    const calibRef = useRef<Calib>({});
    const emaRef = useRef<Features>({ mw: 0.33, mh: 0.03, eye: 0.06, corner: 0 });
    const ALPHA = 0.35; // smoothing factor

    // Load calibration from localStorage
    useEffect(() => {
        try {
            const raw = localStorage.getItem(CALIB_KEY);
            if (raw) calibRef.current = JSON.parse(raw);
        } catch { }
    }, []);

    // Init detector with TFJS WASM
    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                await tf.ready();
                await tf.setBackend('wasm');      // force WASM (no WebGL/WebGPU)
                await tf.ready();
                try { await tf.removeBackend('webgl'); } catch { }
                try { await tf.removeBackend('webgpu'); } catch { }

                const det = await faceLandmarksDetection.createDetector(
                    faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                    { runtime: 'tfjs', refineLandmarks: true, maxFaces: 1 }
                );
                if (cancelled) return;
                detectorRef.current = det;
                setRuntime?.('tfjs');
                setReady?.(true);
                setLastError?.(null);
                zeroFaceFramesRef.current = 0;
            } catch (e: any) {
                // fallback CDN if needed (jsDelivr blocked)
                try {
                    setWasmPaths('https://unpkg.com/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
                    await tf.setBackend('wasm');
                    await tf.ready();
                    const det = await faceLandmarksDetection.createDetector(
                        faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                        { runtime: 'tfjs', refineLandmarks: true, maxFaces: 1 }
                    );
                    if (!cancelled) {
                        detectorRef.current = det;
                        setRuntime?.('tfjs');
                        setReady?.(true);
                        setLastError?.(null);
                        zeroFaceFramesRef.current = 0;
                    }
                } catch (e2: any) {
                    if (!cancelled) setLastError?.('init failed (wasm): ' + (e2?.message || String(e2)));
                }
            }
        })();

        return () => { cancelled = true; stop(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);




    // Start loop when the <video> can play (also when restartEpoch bumps)
    useEffect(() => {
        if (!running || !videoEl) return;
        const onReady = () => kickOff();
        videoEl.addEventListener('loadedmetadata', onReady);
        videoEl.addEventListener('canplay', onReady);
        // edge case: already ready
        if (videoEl.readyState >= 2) kickOff();
        return () => {
            videoEl.removeEventListener('loadedmetadata', onReady);
            videoEl.removeEventListener('canplay', onReady);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoEl, running, ready]);


    function hasLiveStream(el: HTMLVideoElement | null) {
        const ms = (el?.srcObject as MediaStream | null) || null;
        return !!ms && ms.getTracks().some(t => t.readyState === 'live' && t.enabled);
    }

    // Called by App when (re)starting camera
    function start() {
        zeroFaceFramesRef.current = 0;
        setLastError(null);
        setRunning(true);
        restartEpochRef.current++; // retrigger canplay listener after rebind
    }

    // Called by App when stopping camera
    function stop() {
        setRunning(false);
        setTracking(false);
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        setScores({ happy: 0.33, neutral: 0.34, sad: 0.33 });
        setMood('neutral');
        setFaceCount(0);
        setLastError(null);
    }

    function kickOff() {
        if (!running || !videoEl || !detectorRef.current) return;
        const vw = videoEl.videoWidth || 0, vh = videoEl.videoHeight || 0;
        if (vw === 0 || vh === 0) {
            // nudge the element so metadata populates on some browsers
            videoEl.play?.().catch(() => { });
            rafRef.current = requestAnimationFrame(kickOff);
            return;
        }
        loop();
    }



    const loop = async () => {
        if (!running) return;
        const detector = detectorRef.current;
        if (!videoEl || !detector) { rafRef.current = requestAnimationFrame(loop); return; }

        try {
            if (!hasLiveStream(videoEl)) {
                setTracking(false);
                setFaceCount(0);
            } else {
                const input = getDetectorInput(videoEl);
                const faces = await detectorRef.current!.estimateFaces(input, { flipHorizontal: false });
                const count = faces?.length || 0;
                setFaceCount(count);

                if (count > 0 && faces[0]?.keypoints?.length) {
                    const f = extractFeatures(faces[0].keypoints as any);
                    // EMA smoothing
                    emaRef.current = {
                        mw: emaRef.current.mw + ALPHA * (f.mw - emaRef.current.mw),
                        mh: emaRef.current.mh + ALPHA * (f.mh - emaRef.current.mh),
                        eye: emaRef.current.eye + ALPHA * (f.eye - emaRef.current.eye),
                        corner: emaRef.current.corner + ALPHA * (f.corner - emaRef.current.corner),
                    };
                    const { mood: m, scores: s } = scoreWithCalibration(emaRef.current, calibRef.current);
                    setMood(m);
                    setScores(s);
                    setTracking(true);
                    setLastError(null);
                    zeroFaceFramesRef.current = 0;
                } else {
                    setTracking(false);
                    zeroFaceFramesRef.current += 1;
                }

                // Fast runtime fallback if TFJS fails to see faces after restart
                if (runtime === 'tfjs' && zeroFaceFramesRef.current > 30) {
                    zeroFaceFramesRef.current = 0;
                    try { detector.dispose(); } catch { }
                    detectorRef.current = null; setReady(false);
                    setTimeout(async () => {
                        try {
                            const mp = await faceLandmarksDetection.createDetector(
                                faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                                { runtime: 'mediapipe', refineLandmarks: true, maxFaces: 1, solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh' }
                            );
                            detectorRef.current = mp;
                            setRuntime('mediapipe');
                            setReady(true);
                            kickOff();
                        } catch { }
                    }, 0);
                }
            }
        } catch {
            // swallow transient WASM aborts when stream is torn down
        }

        rafRef.current = requestAnimationFrame(loop);
    };

    // ---- Calibration API (persisted) ----
    async function captureCalibration(kind: 'neutral' | 'happy' | 'sad') {
        calibRef.current = { ...calibRef.current, [kind]: { ...emaRef.current } };
        try { localStorage.setItem(CALIB_KEY, JSON.stringify(calibRef.current)); } catch { }
    }
    function clearCalibration() {
        calibRef.current = {};
        try { localStorage.removeItem(CALIB_KEY); } catch { }
    }
    function swapNeutralSad() {
        const c = calibRef.current;
        const next: Calib = { ...c, neutral: c.sad, sad: c.neutral };
        calibRef.current = next;
        try { localStorage.setItem(CALIB_KEY, JSON.stringify(next)); } catch { }
    }

    return { mood, scores, ready, running, tracking, faceCount, lastError, start, stop, captureCalibration, clearCalibration, swapNeutralSad };
}

/* ====================== features + calibrated scoring ====================== */
function d(a: KP, b: KP) { const dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function softmaxTemp(vals: number[], tau: number) {
    const exps = vals.map(v => Math.exp(v / tau));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    return exps.map(e => e / sum);
}

// FaceMesh indices
const L_EYE_TOP = 159, L_EYE_BOT = 145, R_EYE_TOP = 386, R_EYE_BOT = 374;
const MOUTH_L = 291, MOUTH_R = 61, MOUTH_TOP = 13, MOUTH_BOT = 14;
const CHEEK_L = 454, CHEEK_R = 234;

function extractFeatures(kps: KP[]): Features {
    const faceW = Math.max(1e-6, d(kps[CHEEK_R], kps[CHEEK_L]));
    const eyeL = Math.abs(kps[L_EYE_TOP].y - kps[L_EYE_BOT].y) / faceW;
    const eyeR = Math.abs(kps[R_EYE_TOP].y - kps[R_EYE_BOT].y) / faceW;
    const eye = (eyeL + eyeR) / 2;

    const mw = d(kps[MOUTH_R], kps[MOUTH_L]) / faceW;
    const mh = Math.abs(kps[MOUTH_TOP].y - kps[MOUTH_BOT].y) / faceW;

    const centerY = (kps[MOUTH_TOP].y + kps[MOUTH_BOT].y) / 2;
    const corner = ((centerY - kps[MOUTH_R].y) + (centerY - kps[MOUTH_L].y)) / 2 / faceW;

    return { mw, mh, eye, corner };
}

function rel01(value: number, a: number, b: number, invert = false): number {
    const t = clamp01((value - a) / (b - a));
    return invert ? 1 - t : t;
}

function scoreWithCalibration(f: Features, calib: Calib): { mood: Mood; scores: Scores } {
    // Use flipped neutral↔sad if that worked better for you
    const H = calib.happy;
    const N = calib.sad ?? calib.neutral;     // treat saved "sad" as neutral if present
    const S = calib.neutral ?? calib.sad;     // treat saved "neutral" as sad if present

    // HAPPY components (corners up, width, open, squint)
    const happyCorner = (N && H) ? rel01(f.corner, N.corner, H.corner) : rel01(f.corner, -0.02, 0.06);
    const happyWidth = (N && H) ? rel01(f.mw, N.mw, H.mw) : rel01(f.mw, 0.20, 0.56);
    const happyOpen = (N && H) ? rel01(f.mh, N.mh, H.mh) : rel01(f.mh, 0.012, 0.12);
    const happySquint = (N && H) ? rel01(f.eye, N.eye, H.eye, true) : clamp01((0.08 - f.eye) / 0.06);

    // SAD components (corners down, narrower, more closed, narrower eyes)
    const sadCorner = (N && S) ? rel01(f.corner, N.corner, S.corner, true) : rel01(f.corner, 0.02, -0.06, true);
    const sadNarrow = (N && S) ? rel01(f.mw, N.mw, S.mw, true) : rel01(f.mw, 0.40, 0.20, true);
    const sadClosed = (N && S) ? rel01(f.mh, N.mh, S.mh, true) : rel01(f.mh, 0.06, 0.015, true);
    const sadEyes = (N && S) ? rel01(f.eye, N.eye, S.eye, true) : rel01(f.eye, 0.07, 0.04, true);

    let happyRaw = 0.55 * happyCorner + 0.25 * happyWidth + 0.12 * happyOpen + 0.08 * happySquint;
    let sadRaw = 0.50 * sadCorner + 0.20 * sadNarrow + 0.18 * sadClosed + 0.12 * sadEyes;
    let neutralRaw = 0.90 * (1 - Math.max(happyRaw, sadRaw)) + 0.10 * (1 - Math.abs(happyWidth - 0.33));

    if (Math.max(happyRaw, sadRaw) < 0.45) {
        neutralRaw = 0.95; happyRaw *= 0.5; sadRaw *= 0.5;
    }

    const [Hsc, Nsc, Ssc] = softmaxTemp([happyRaw, neutralRaw, sadRaw], 0.8);
    const scores: Scores = { happy: Hsc, neutral: Nsc, sad: Ssc };
    const label: Mood = (Hsc >= Nsc && Hsc >= Ssc) ? 'happy' : (Ssc >= Hsc && Ssc >= Nsc) ? 'sad' : 'neutral';
    return { mood: label, scores };
}