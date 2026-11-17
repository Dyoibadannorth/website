import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Camera QR scanner (phone, tablet or laptop webcam). Needs HTTPS, which the
 * live site has.
 *
 *   • Default: a pop-up that reads one code, calls onResult, and the parent
 *     closes it (the check-in desk).
 *   • continuous + inline: an always-on viewfinder for a queue (the meal and
 *     session scanner). The same code is ignored for a few seconds so one
 *     person isn't read twice, and nothing is read while `paused`.
 */
export default function QrScanner({
  onResult, onClose, continuous = false, inline = false, paused = false,
}: {
  onResult: (text: string) => void;
  onClose?: () => void;
  continuous?: boolean;
  inline?: boolean;
  paused?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");

  // latest props without restarting the camera
  const onResultRef = useRef(onResult);
  const pausedRef = useRef(paused);
  onResultRef.current = onResult;
  pausedRef.current = paused;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    let lastText = "";
    let lastAt = 0;
    let lastFrame = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = (now: number) => {
      const video = videoRef.current;
      if (done || !video || !ctx) return;
      // about 8 reads a second is plenty and spares the phone's battery
      if (!pausedRef.current && now - lastFrame > 120 && video.readyState >= 2 && video.videoWidth > 0) {
        lastFrame = now;
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          if (!continuous) {
            done = true;
            onResultRef.current(code.data);
            return;
          }
          if (code.data !== lastText || now - lastAt > 3000) {
            lastText = code.data;
            lastAt = now;
            onResultRef.current(code.data);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't use the camera here. Type the name or code instead.");
    } else {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
        .then((s) => {
          if (done) { s.getTracks().forEach((t) => t.stop()); return; }
          stream = s;
          const video = videoRef.current;
          if (!video) return;
          video.srcObject = s;
          void video.play().then(() => { raf = requestAnimationFrame(tick); });
        })
        .catch(() => setError("Couldn't open the camera. Allow camera access, or type the name or code instead."));
    }

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (inline) {
    return error
      ? <p className="text-amber-300 text-sm py-10 px-4 text-center bg-black/40 rounded-lg">{error}</p>
      : (
        <div className="relative">
          <video ref={videoRef} playsInline muted
                 className="w-full rounded-lg bg-black aspect-square object-cover" />
          <div className="pointer-events-none absolute inset-[18%] border-4 border-white/70 rounded-xl" />
          {paused && <div className="absolute inset-0 rounded-lg bg-black/40" />}
        </div>
      );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4">
      <div className="bg-white rounded-lg p-4 w-full max-w-md">
        <div className="flex justify-between items-center mb-3">
          <p className="font-semibold">Scan the member's QR code</p>
          {onClose && <button onClick={onClose} className="text-sm underline">Close</button>}
        </div>
        {error
          ? <p className="text-red-600 text-sm py-8 text-center">{error}</p>
          : <video ref={videoRef} playsInline muted className="w-full rounded bg-black aspect-square object-cover" />}
        <p className="text-xs text-gray-500 mt-2">Hold the code steady inside the picture.</p>
      </div>
    </div>
  );
}