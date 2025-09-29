import { useEffect, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import '@tensorflow/tfjs-backend-wasm';
import * as faceLandmarksDetection from '@tensorflow-models/face-landmarks-detection';

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
    captureCalibration: (which: 'happy' | 'neutral' | 'sad') => void;
    clearCalibration: () => void;
    swapNeutralSad: () => void;

    start: () => void;
    stop: () => void;
};

const DETECT_W = 320;
const DETECT_H = 240;

// basic scoring; replace with tuned version if needed
function scoreFromKeypoints(_kps: any): { mood: Mood; scores: Scores } {
    return { mood: 'neutral', scores: { happy: 0.33, neutral: 0.34, sad: 0.33 } };
}

export function useEmotion(videoEl: HTMLVideoElement | null): Return {
    const [mood, setMood] = useState<Mood>('neutral');
    const [scores, setScores] = useState<Scores>({ happy: 0.33, neutral: 0.34, sad: 0.33 });

    const [running, setRunning] = useState(false);
    const [tracking, setTracking] = useState(false);
    const [runtime, setRuntime] = useState<'tfjs' | 'mediapipe' | null>(null);
    const [lastError, setLastError] = useState<string | null>(null);

    const [ready, setReady] = useState(false);
    const [faceCount, setFaceCount] = useState(0);

    const detectorRef = useRef<faceLandmarksDetection.FaceLandmarksDetector | null>(null);
    const rafRef = useRef<number | null>(null);
    const zeroFaceFramesRef = useRef(0);

    // offscreen canvas for downsampled frames
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

    // optional calibration placeholders (no-op to satisfy App.tsx; can be extended later)
    const captureCalibration = (_: 'happy' | 'neutral' | 'sad') => { /* no-op */ };
    const clearCalibration = () => { /* no-op */ };
    const swapNeutralSad = () => { /* no-op */ };

    // init offscreen canvas
    useEffect(() => {
        if (!canvasRef.current) {
            try {
                const c = document.createElement('canvas');
                c.width = DETECT_W; c.height = DETECT_H;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                if (ctx) { canvasRef.current = c; ctxRef.current = ctx; }
            } catch (e: any) {
                setLastError('canvas init failed: ' + (e?.message || String(e)));
            }
        }
    }, []);

    // init TFJS (WASM only) and detector
    useEffect(() => {
        let cancelled = false;

        async function init() {
            try {
                setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
                try { tf.env().set('WASM_HAS_SIMD_SUPPORT', false as any); } catch { }
                try { tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false as any); } catch { }
                try { tf.env().set('WASM_NUM_THREADS', 1 as any); } catch { }

                await tf.ready();
                await tf.setBackend('wasm');
                await tf.ready();
                try { await tf.removeBackend('webgl'); } catch { }
                try { await tf.removeBackend('webgpu'); } catch { }

                if (cancelled) return;

                const det = await faceLandmarksDetection.createDetector(
                    faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                    { runtime: 'tfjs', refineLandmarks: true, maxFaces: 1 }
                );
                if (cancelled) return;

                detectorRef.current = det;
                setRuntime('tfjs');
                setLastError(null);
                setReady(true);
            } catch (e: any) {
                if (cancelled) return;
                try {
                    setWasmPaths('https://unpkg.com/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
                    await tf.setBackend('wasm');
                    await tf.ready();
                    const det = await faceLandmarksDetection.createDetector(
                        faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                        { runtime: 'tfjs', refineLandmarks: true, maxFaces: 1 }
                    );
                    if (cancelled) return;
                    detectorRef.current = det;
                    setRuntime('tfjs');
                    setLastError(null);
                    setReady(true);
                } catch (e2: any) {
                    setLastError('init failed (wasm): ' + (e2?.message || String(e2)));
                    setReady(false);
                }
            }
        }

        init();
        return () => { cancelled = true; };
    }, []);

    const drawToOffscreen = (vid: HTMLVideoElement): HTMLCanvasElement | null => {
        const c = canvasRef.current, ctx = ctxRef.current;
        if (!c || !ctx) return null;
        try {
            ctx.drawImage(vid, 0, 0, c.width, c.height);
            return c;
        } catch { return null; }
    };

    function stop() {
        setRunning(false);
        setTracking(false);
        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
    }

    function start() {
        if (!videoEl || !detectorRef.current) {
            setLastError('detector/video not ready');
            return;
        }
        if (running) return;
        setRunning(true);
        zeroFaceFramesRef.current = 0;
        kickOff();
    }

    function kickOff() {
        if (!running || !videoEl || !detectorRef.current) return;
        const vw = (videoEl as HTMLVideoElement).videoWidth || 0;
        const vh = (videoEl as HTMLVideoElement).videoHeight || 0;
        if (vw === 0 || vh === 0) {
            (videoEl as HTMLVideoElement).play?.().catch(() => { });
            rafRef.current = requestAnimationFrame(kickOff);
            return;
        }
        loop();
    }

    async function loop() {
        if (!running || !videoEl || !detectorRef.current) return;

        try {
            const inputCanvas = drawToOffscreen(videoEl);
            if (!inputCanvas) {
                rafRef.current = requestAnimationFrame(loop);
                return;
            }
            const inputTensor = tf.tidy(() =>
                tf.browser.fromPixels(inputCanvas).toFloat()
            );

            let faces;
            try {
                faces = await detectorRef.current.estimateFaces(
                    inputTensor as unknown as tf.Tensor3D,
                    { flipHorizontal: false }
                );
            } finally {
                inputTensor.dispose();
            }

            const count = faces?.length || 0;
            setFaceCount(count);
            setTracking(count > 0);

            if (count > 0 && faces[0]?.keypoints?.length) {
                const r = scoreFromKeypoints(faces[0].keypoints as any);
                setMood(r.mood);
                setScores(r.scores);
                zeroFaceFramesRef.current = 0;
            } else {
                zeroFaceFramesRef.current += 1;
                if (zeroFaceFramesRef.current > 10) {
                    setMood('neutral');
                    setScores({ happy: 0.33, neutral: 0.34, sad: 0.33 });
                }
            }
        } catch (e: any) {
            if (!String(e?.message || e).includes('Aborted')) {
                setLastError('loop error: ' + (e?.message || String(e)));
            }
        }

        rafRef.current = requestAnimationFrame(loop);
    }

    // re-kick when video is ready
    useEffect(() => {
        if (!running) return;
        if (!videoEl || !detectorRef.current) return;

        const onReady = () => kickOff();
        videoEl.addEventListener('loadedmetadata', onReady);
        videoEl.addEventListener('canplay', onReady);
        if (videoEl.readyState >= 2) kickOff();
        return () => {
            videoEl.removeEventListener('loadedmetadata', onReady);
            videoEl.removeEventListener('canplay', onReady);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoEl, running, detectorRef.current]);

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
