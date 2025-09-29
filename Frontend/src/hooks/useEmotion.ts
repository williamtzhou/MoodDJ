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

const MP_BASE = `${import.meta.env.BASE_URL || '/'}mediapipe`;

function scoreFromLandmarks(_pts: any): { mood: Mood; scores: Scores } {
    return { mood: 'neutral', scores: { happy: 0.33, neutral: 0.34, sad: 0.33 } };
}

function loadScriptOnce(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ex = document.querySelector<HTMLScriptElement>(`script[data-src="${src}"]`);
        if (ex && (ex as any)._loaded) return resolve();
        const s = document.createElement('script');
        s.src = src;
        s.async = false; s.defer = false; // preserve order
        s.setAttribute('data-src', src);
        s.onload = () => { (s as any)._loaded = true; resolve(); };
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

async function ensureMediaPipe(): Promise<any> {
    if ((window as any).FaceMesh) return (window as any).FaceMesh;
    await loadScriptOnce(`${MP_BASE}/face_mesh.js`);
    await loadScriptOnce(`${MP_BASE}/face_mesh_solution_packed_assets_loader.js`);
    await loadScriptOnce(`${MP_BASE}/face_mesh_solution_simd_wasm_bin.js`);
    const FaceMeshCtor = (window as any).FaceMesh;
    if (!FaceMeshCtor) throw new Error('FaceMesh global not loaded after scripts');
    return FaceMeshCtor;
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

    const mpRef = useRef<any | null>(null);
    const rafRef = useRef<number | null>(null);
    const missFramesRef = useRef(0);

    const captureCalibration = (_: 'happy' | 'neutral' | 'sad') => { };
    const clearCalibration = () => { };
    const swapNeutralSad = () => { };

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
                    const faces = res.multiFaceLandmarks || [];
                    setFaceCount(faces.length);

                    const has = faces.length > 0 && faces[0]?.length;
                    setTracking(Boolean(has));

                    if (has) {
                        const r = scoreFromLandmarks(faces[0]);
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
            setLastError('loop error: ' + (e?.message || String(e)));
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
