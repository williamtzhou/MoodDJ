import { useEffect, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import * as faceLandmarksDetection from '@tensorflow-models/face-landmarks-detection';

export type Mood = 'happy' | 'neutral' | 'sad';
type KP = { x: number; y: number; z?: number };
type Scores = { happy: number; neutral: number; sad: number };

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

    // ----------- detector init with fallback -----------
    useEffect(() => {
        let cancelled = false;

        async function initDetector(desired: 'tfjs' | 'mediapipe') {
            try {
                if (desired === 'tfjs') {
                    await tf.ready();
                    try { await tf.setBackend('webgl'); } catch { }
                }
                const detector = await faceLandmarksDetection.createDetector(
                    faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                    desired === 'tfjs'
                        ? { runtime: 'tfjs', refineLandmarks: true, maxFaces: 1 }
                        : {
                            runtime: 'mediapipe',
                            refineLandmarks: true,
                            maxFaces: 1,
                            // Load MediaPipe assets from CDN (no local files needed)
                            solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh',
                        }
                );
                if (cancelled) return;
                detectorRef.current = detector;
                setRuntime(desired);
                setReady(true);
                setLastError(null);
                zeroFaceFramesRef.current = 0;
            } catch (e: any) {
                if (cancelled) return;
                setLastError(`init(${desired}): ${String(e?.message || e)}`);
                // If TFJS init failed, try mediapipe right away
                if (desired === 'tfjs') initDetector('mediapipe');
            }
        }

        initDetector('tfjs'); // try TFJS first; we’ll auto-fallback if it sees no faces

        return () => { cancelled = true; stop(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ----------- attach to video readiness -----------
    useEffect(() => {
        if (!running || !videoEl) return;
        const onCanPlay = () => { if (videoEl.readyState >= 2) kickOff(); };
        videoEl.addEventListener('canplay', onCanPlay);
        if (videoEl.readyState >= 2) kickOff();
        return () => videoEl.removeEventListener('canplay', onCanPlay);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoEl, running, ready]);

    function start() {
        setRunning(true);
    }

    function stop() {
        setRunning(false);
        setTracking(false);
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    }

    function kickOff() {
        if (!running) return;
        if (!videoEl || !detectorRef.current || !ready) return;
        if (!(videoEl as HTMLVideoElement).videoWidth || !(videoEl as HTMLVideoElement).videoHeight) {
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
            const faces = await detector.estimateFaces(videoEl, { flipHorizontal: true });
            const count = faces?.length || 0;
            setFaceCount(count);

            if (count > 0 && faces[0]?.keypoints?.length) {
                const { mood: m, scores: s } = scoreFromLandmarks(faces[0].keypoints as any);
                setMood(m);
                setScores(s);
                setTracking(true);
                setLastError(null);
                zeroFaceFramesRef.current = 0;
            } else {
                setTracking(false);
                setScores({ happy: 0.33, neutral: 0.34, sad: 0.33 });
                setMood('neutral');
                zeroFaceFramesRef.current += 1;
            }

            // Auto-fallback: if TFJS is running but we saw 0 faces for ~45 frames, re-init with MediaPipe
            if (runtime === 'tfjs' && zeroFaceFramesRef.current > 45) {
                zeroFaceFramesRef.current = 0;
                try { detector.dispose(); } catch { }
                detectorRef.current = null;
                setReady(false);
                // re-init on next tick with mediapipe
                setTimeout(async () => {
                    try {
                        const mp = await faceLandmarksDetection.createDetector(
                            faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                            {
                                runtime: 'mediapipe',
                                refineLandmarks: true,
                                maxFaces: 1,
                                solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh',
                            }
                        );
                        detectorRef.current = mp;
                        setRuntime('mediapipe');
                        setReady(true);
                    } catch (e: any) {
                        setLastError(`fallback init(mediapipe): ${String(e?.message || e)}`);
                    }
                }, 0);
            }
        } catch (e: any) {
            setLastError(`loop(${runtime}): ${String(e?.message || e)}`);
        }

        rafRef.current = requestAnimationFrame(loop);
    };

    return { mood, scores, ready, running, tracking, faceCount, lastError, start, stop };
}

/* ---------- scoring (unchanged) ---------- */
function d(a: KP, b: KP) { const dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function softmax(vals: number[]) {
    const m = Math.max(...vals);
    const exps = vals.map(v => Math.exp(v - m));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(e => e / (sum || 1));
}

function scoreFromLandmarks(kps: KP[]): { mood: Mood; scores: { happy: number; neutral: number; sad: number } } {
    const RIGHT_MOUTH = 61, LEFT_MOUTH = 291, MOUTH_TOP = 13, MOUTH_BOTTOM = 14;
    const RIGHT_CHEEK = 234, LEFT_CHEEK = 454;
    const RIGHT_BROW = 70, LEFT_BROW = 300, RIGHT_EYE = 33, LEFT_EYE = 263;

    const faceWidth = Math.max(1e-6, d(kps[RIGHT_CHEEK], kps[LEFT_CHEEK]));
    const mouthWidth = d(kps[RIGHT_MOUTH], kps[LEFT_MOUTH]) / faceWidth;
    const mouthHeight = d(kps[MOUTH_TOP], kps[MOUTH_BOTTOM]) / faceWidth;
    const browRaise = ((kps[RIGHT_EYE].y - kps[RIGHT_BROW].y) + (kps[LEFT_EYE].y - kps[LEFT_BROW].y)) / 2 / faceWidth;

    const mw = clamp01((mouthWidth - 0.22) / (0.55 - 0.22));
    const mh = clamp01((mouthHeight - 0.015) / (0.14 - 0.015));
    const br = clamp01((browRaise - 0.00) / (0.04 - 0.00));

    let happy = 0.65 * mw + 0.35 * mh;
    let sad = 0.70 * br + 0.30 * (1 - mw);
    let neutral = 0.80 * (1 - Math.max(happy, sad)) + 0.20 * (1 - Math.abs(mw - 0.33));

    const [H, N, S] = softmax([happy, neutral, sad]);
    const scores = { happy: H, neutral: N, sad: S };
    const mood: Mood = (H >= N && H >= S) ? 'happy' : (S >= H && S >= N) ? 'sad' : 'neutral';
    return { mood, scores };
}
