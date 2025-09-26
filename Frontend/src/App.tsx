import { useEffect, useRef, useState } from 'react';


const BACKEND = `http://${window.location.hostname}:3001`;


type Mood = 'happy' | 'sad' | 'angry' | 'calm' | 'surprised' | 'neutral';


export default function App() {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [cameraOn, setCameraOn] = useState(false);
    const [mood, setMood] = useState<Mood>('neutral');
    const [linked, setLinked] = useState(false);


    // Start/stop camera
    const toggleCamera = async () => {
        if (!cameraOn) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                if (videoRef.current) videoRef.current.srcObject = stream;
                setCameraOn(true);
            } catch (e) {
                alert('Camera permission denied or unavailable');
            }
        } else {
            if (videoRef.current && videoRef.current.srcObject) {
                (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
                videoRef.current.srcObject = null;
            }
            setCameraOn(false);
        }
    };


    const linkSpotify = () => {
        const returnTo = encodeURIComponent(window.location.origin); // e.g. http://127.0.0.1:5173
        window.location.assign(`${BACKEND}/login?return_to=${returnTo}`);
    };


    // Re-check when page is (re)loaded or becomes visible, and if ?linked=1 is present
    useEffect(() => {
        const check = () => {
            fetch(`${BACKEND}/me`).then(r => {
                if (r.ok) setLinked(true);
            }).catch(() => { });
        };

        check(); // initial
        if (new URLSearchParams(window.location.search).get('linked') === '1') {
            check();
            // optional: clean the URL
            const url = new URL(window.location.href);
            url.searchParams.delete('linked');
            window.history.replaceState({}, '', url.toString());
        }

        const onVis = () => { if (document.visibilityState === 'visible') check(); };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);


    const sendMood = async () => {
        await fetch(`${BACKEND}/mood`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: mood, confidence: 0.9 })
        });
    };


    return (
        <div style={{ maxWidth: 900, margin: '2rem auto', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <h1>🎭 Mood DJ — Skeleton</h1>


            <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                    <video ref={videoRef} autoPlay playsInline style={{ width: '100%', borderRadius: 12, background: '#111' }} />
                    <div style={{ marginTop: 12 }}>
                        <button onClick={toggleCamera}>{cameraOn ? 'Stop Camera' : 'Start Camera'}</button>
                    </div>
                </div>
                <div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {(['happy', 'sad', 'angry', 'calm', 'surprised', 'neutral'] as Mood[]).map(m => (
                            <button key={m} onClick={() => setMood(m)} style={{
                                padding: '8px 12px', borderRadius: 8, border: '1px solid #ccc',
                                background: mood === m ? '#e5e7eb' : 'white'
                            }}>{m}</button>
                        ))}
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                        <button onClick={sendMood}>Send Mood to Backend</button>
                        <button onClick={linkSpotify} disabled={linked} title={linked ? 'Already linked' : ''}>
                            {linked ? 'Spotify Linked ✔' : 'Link Spotify'}
                        </button>
                    </div>


                    <div style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
                        <strong>Status</strong>
                        <ul>
                            <li>Camera: {cameraOn ? 'on' : 'off'}</li>
                            <li>Current mood: {mood}</li>
                            <li>Spotify: {linked ? 'linked' : 'not linked'}</li>
                        </ul>
                    </div>


                    <div style={{ marginTop: 16, opacity: 0.8 }}>
                        <em>Next steps:</em>
                        <ol>
                            <li>Add TF.js/face-api.js to detect expressions → setMood().</li>
                            <li>Implement playlist upsert logic on backend `/mood`.</li>
                            <li>Return a real `playlistId` from `/playlist` and embed the Web Playback SDK.</li>
                        </ol>
                    </div>
                </div>
            </section>
        </div>
    );
}