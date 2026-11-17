import { useEffect, useState } from "react";
import { makeQr } from "../lib/Tagprint";

/**
 * The member's check-in QR code. Show it wherever a member sees their own
 * registration, e.g. in ProgrammeDetail:
 *
 *   {registration && <CheckinQR registrationId={registration.id} />}
 */
export default function CheckinQR({ registrationId }: { registrationId: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let live = true;
    void makeQr(registrationId, 320).then((url) => { if (live) setSrc(url); });
    return () => { live = false; };
  }, [registrationId]);

  if (!src) return null;

  return (
    <div style={{ textAlign: "center", margin: "16px 0" }}>
      <img src={src} alt="Your check-in QR code"
           style={{ width: 180, height: 180, background: "#fff", padding: 8, borderRadius: 8 }} />
      <p style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>
        Show this code at the check-in desk to collect your tag.
      </p>
    </div>
  );
}