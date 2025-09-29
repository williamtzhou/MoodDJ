import { useEffect, useRef, useState } from 'react';
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
    captureCalibration: (w: 'happy' | 'neutral' | 'sad') => void;
    clearCalibration: () => void;
    swapNeutralSad: () => void;

    start: () => void;
    stop: () => void;
};

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
    const missFramesRef = useRef(0);

    const captureCalibration = (_: 'happy' | 'neutral' | 'sad') => { };
    const clearCalibration = () => { };
    const swapNeutralSad = () => { };

    // Create MediaPipe detector (no TFJS/WASM)
    useEffect(() => {
        let cancelled = false;

        async function init() {
            try {
                const det = await faceLandmarksDetection.createDetector(
                    faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
                    {
                        runtime: 'mediapipe',
                        refineLandmarks: true,
                        maxFaces: 1,
                        // stable, widely-used FaceMesh assets
                        solutionPath:
                            'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619',
                    }
                );
                if (cancelled) return;
                detectorRef.current = det;
                setRuntime('mediapipe');
                setReady(true);
                setLastError(null);
            } catch (e: any) {
                if (!cancelled) {
                    setLastError('init failed (mediapipe): ' + (e?.message || String(e)));
                    setReady(false);
                }
            }
        }

        init();
        return () => {
            cancelled = true;
            // best-effort dispose
            try { detectorRef.current?.dispose?.(); } catch { }
            detectorRef.current = null;
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
        if (!videoEl || !detectorRef.current) {
            setLastError('detector/video not ready');
            return;
        }
        if (running) return;
        setRunning(true);
        missFramesRef.current = 0;
        kickOff();
    }

    function kickOff() {
        if (!running || !videoEl || !detectorRef.current) return;
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
        if (!running || !videoEl || !detectorRef.current) return;

        try {
            // pass the raw video element; do not flip in the model
            const faces = await detectorRef.current.estimateFaces(videoEl, {
                flipHorizontal: false,
            });

            const count = faces?.length || 0;
            setFaceCount(count);
            setTracking(count > 0);

            if (count > 0 && faces[0]?.keypoints?.length) {
                const r = scoreFromKeypoints(faces[0].keypoints as any);
                setMood(r.mood);
                setScores(r.scores);
                missFramesRef.current = 0;
            } else {
                missFramesRef.current += 1;
                if (missFramesRef.current > 10) {
                    setMood('neutral');
                    setScores({ happy: 0.33, neutral: 0.34, sad: 0.33 });
                }
            }
        } catch (e: any) {
            setLastError('loop error: ' + (e?.message || String(e)));
        }

        rafRef.current = requestAnimationFrame(loop);
    }

    // re-kick when video is playable
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
