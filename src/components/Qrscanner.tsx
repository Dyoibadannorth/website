import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Camera QR scanner for the check-in desk (phone, tablet or laptop webcam).
 * Calls onResult with the code's text, once, then the parent closes it.
 * Needs HTTPS, which the live site has.
 */
export default function QrScanner({ onResult, onClose }: {
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      const video = videoRef.current;
      if (done || !video || !ctx) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        // scan a reduced frame: plenty for a QR code and much faster
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          done = true;
          onResult(code.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't use the camera here. Type the name instead.");
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
        .catch(() => setError("Couldn't open the camera. Allow camera access, or type the name instead."));
    }

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4">
      <div className="bg-white rounded-lg p-4 w-full max-w-md">
        <div className="flex justify-between items-center mb-3">
          <p className="font-semibold">Scan the member's QR code</p>
          <button onClick={onClose} className="text-sm underline">Close</button>
        </div>
        {error
          ? <p className="text-red-600 text-sm py-8 text-center">{error}</p>
          : <video ref={videoRef} playsInline muted className="w-full rounded bg-black aspect-square object-cover" />}
        <p className="text-xs text-gray-500 mt-2">Hold the code steady inside the picture.</p>
      </div>
    </div>
  );
}