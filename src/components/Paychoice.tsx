import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { naira } from "../lib/Payments";
import type { PayArgs, PayResult, TransferDetails } from "../lib/Payments";
import "./Paychoice.css";

/**
 * "How would you like to pay?" — opened by startPayment() for every payment.
 *
 *   1. choose   card (Flutterwave, off unless switched on) or bank transfer,
 *               which they must accept first
 *   2. account  the account to pay into, the exact amount and the reference
 *               to write in the narration, each with a Copy button
 *   3. upload   the receipt (photo, screenshot or PDF) and how to reach them
 *   4. sent     WhatsApp opens with everything filled in for the admin; the
 *               admin ticks it paid on Admin → Bank transfers
 *
 * Styled by Paychoice.css (plain class names), because the site's global
 * button/input rules would override Tailwind classes here.
 */

type Step = "choose" | "account" | "upload" | "sent";

interface Sent {
  id: string; reference_code: string; label: string; amount_naira: number;
  payer_name: string; payer_email: string | null; payer_phone: string | null; payer_note: string | null;
  bank_name: string; account_name: string; account_number: string; whatsapp_number: string | null;
}

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf";
const MAX_BYTES = 10 * 1024 * 1024;
const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
};
// the stand-in email DonationPage uses for anonymous gifts — not theirs, so don't show it
const STAND_IN_EMAIL = /@dyoibadannorth\.org$/i;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function typeOf(f: File): string {
  if (f.type) return f.type.toLowerCase();
  return BY_EXTENSION[f.name.toLowerCase().split(".").pop() ?? ""] ?? "";
}

const safeName = (n: string) =>
  n.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "receipt";

/** Big phone photos → about 2000px JPEG, so they upload quickly on mobile data. */
async function shrink(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(typeOf(file)) || file.size <= 1.5 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff";                       // transparent screenshots stay readable
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;                                  // can't read it here: send it as it is
  }
}

function friendly(message: string): string {
  if (/exceeded the maximum allowed size|payload too large/i.test(message)) return "That file is too big. The limit is 10 MB.";
  if (/mime type|not supported/i.test(message)) return "Upload a photo or screenshot (JPG or PNG) or a PDF.";
  if (/row-level security|unauthorized|403/i.test(message)) return "The receipt couldn't be uploaded. Please try again.";
  if (/failed to fetch|network/i.test(message)) return "No connection. Check your data and try again.";
  return message;
}

function whatsappLink(s: Sent): string | null {
  if (!s.whatsapp_number) return null;
  const lines = ["Hello, I've paid by bank transfer. Here are my details:", ""];
  lines.push(`Name: ${s.payer_name}`);
  if (s.payer_phone) lines.push(`Phone: ${s.payer_phone}`);
  if (s.payer_email) lines.push(`Email: ${s.payer_email}`);
  lines.push(`For: ${s.label}`);
  lines.push(`Amount: ${naira(s.amount_naira)}`);
  lines.push(`Reference: ${s.reference_code}`);
  lines.push(`Paid to: ${s.account_name}, ${s.bank_name} ${s.account_number}`);
  if (s.payer_note) lines.push(`Note: ${s.payer_note}`);
  lines.push("", `My receipt (for the admin): ${window.location.origin}/admin/transfers?t=${s.id}`);
  return `https://wa.me/${s.whatsapp_number}?text=${encodeURIComponent(lines.join("\n"))}`;
}

function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* nothing else to try */ }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }
  return (
    <button type="button" className={`pc-copy${copied ? " is-done" : ""}`} onClick={copy} aria-label={`Copy ${what}`}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function PayChoice({ args, details, onDone }: {
  args: PayArgs;
  details: TransferDetails;
  onDone: (result: PayResult | "card") => void;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [agreed, setAgreed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState(args.customer.name ?? "");
  const [phone, setPhone] = useState(args.customer.phone ?? "");
  const [email, setEmail] = useState(STAND_IN_EMAIL.test(args.customer.email ?? "") ? "" : (args.customer.email ?? ""));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // after the upload worked: a retry only needs to re-send, not re-upload
  const [uploaded, setUploaded] = useState<{ id: string; path: string } | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [openedWhatsapp, setOpenedWhatsapp] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const account = details.account;
  const last = details.last;

  useEffect(() => { boxRef.current?.focus(); boxRef.current?.scrollTo?.({ top: 0 }); }, [step]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function close() {
    if (busy) return;
    onDone(step === "sent" ? { status: "submitted" } : { status: "closed" });
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const changed = <T,>(set: (v: T) => void) => (v: T) => { set(v); setUploaded(null); setError(""); };

  function pick(f: File | undefined) {
    setError("");
    setUploaded(null);
    if (!f) return;
    const type = typeOf(f);
    if (!ACCEPT.split(",").includes(type)) {
      setError("Upload a photo or screenshot (JPG or PNG) or a PDF of the receipt.");
      return;
    }
    if (f.size > MAX_BYTES * 3) {   // anything this big won't shrink under the limit
      setError("That file is too big. The limit is 10 MB.");
      return;
    }
    setFile(f);
    setPreview(/^image\/(jpeg|png|webp)$/.test(type) ? URL.createObjectURL(f) : null);
  }

  async function send() {
    if (!file) { setError("Choose the receipt first."); return; }
    if (!name.trim()) { setError("Enter your name."); return; }
    setBusy(true);
    setError("");
    try {
      let target = uploaded;
      if (!target) {
        const ready = await shrink(file);
        if (ready.size > MAX_BYTES) throw new Error("That file is too big. The limit is 10 MB.");
        const { data: id, error: startError } = await supabase.rpc("transfer_start", {
          p_purpose: args.purpose,
          p_reference_id: args.referenceId,
          p_payer_name: name.trim(),
          p_payer_email: email.trim() || null,
          p_payer_phone: phone.trim() || null,
          p_note: note.trim() || null,
        });
        if (startError || !id) throw new Error(startError?.message ?? "Couldn't start. Try again.");
        const path = `${id}/${Date.now()}-${safeName(ready.name)}`;
        const { error: upError } = await supabase.storage.from("transfer-receipts")
          .upload(path, ready, { upsert: false, contentType: typeOf(ready), cacheControl: "3600" });
        if (upError) throw new Error(upError.message);
        target = { id: id as string, path };
        setUploaded(target);
      }
      const { data, error: sendError } = await supabase.rpc("transfer_submit", {
        p_transfer_id: target.id,
        p_receipt_path: target.path,
      });
      if (sendError || !data) throw new Error(sendError?.message ?? "Couldn't send. Try again.");
      setSent(data as Sent);
      setStep("sent");
    } catch (e) {
      setError(friendly((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const link = sent ? whatsappLink(sent) : null;

  return (
    <div className="pc-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="pc-box" role="dialog" aria-modal="true" aria-labelledby="pc-title" tabIndex={-1} ref={boxRef}>
        <div className="pc-head">
          <h2 id="pc-title">
            {step === "choose" ? "How would you like to pay?"
              : step === "account" ? "Pay by bank transfer"
              : step === "upload" ? "Send your receipt"
              : "Receipt received"}
          </h2>
          <button type="button" className="pc-close" onClick={close} aria-label="Close" disabled={busy}>×</button>
        </div>

        {step !== "sent" && (
          <div className="pc-amount">
            <span>{details.label}</span>
            <strong>{naira(details.amount_naira)}</strong>
          </div>
        )}

        {/* ------------------------------ 1. choose ------------------------------ */}
        {step === "choose" && (details.paid ? (
          <>
            <p className="pc-note pc-note--ok">This has already been paid. Thank you!</p>
            <button type="button" className="pc-btn" onClick={close}>Close</button>
          </>
        ) : (
          <>
            {last?.status === "pending" && (
              <p className="pc-note">
                We already have your transfer receipt for this (sent {when(last.submitted_at)}). An admin will
                confirm it, so you don't need to pay again. Sent the wrong receipt? Send the right one below.
              </p>
            )}
            {last?.status === "rejected" && (
              <p className="pc-note pc-note--warn">
                Your last receipt wasn't accepted{last.reject_reason ? `: ${last.reject_reason}` : "."} Please check
                it and send it again, or contact the admin.
              </p>
            )}

            <div className={`pc-option${details.card_enabled ? "" : " is-off"}`}>
              <div className="pc-option-head">
                <span className="pc-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 10h19M6.5 15h4" /></svg>
                </span>
                <div>
                  <p className="pc-option-title">Pay with card</p>
                  <p className="pc-option-text">
                    {details.card_enabled ? "Card, USSD or bank app, through Flutterwave." : "Not available at the moment."}
                  </p>
                </div>
              </div>
              {details.card_enabled && (
                <button type="button" className="pc-btn pc-btn--quiet" onClick={() => onDone("card")}>
                  Pay with card
                </button>
              )}
            </div>

            <div className="pc-option">
              <div className="pc-option-head">
                <span className="pc-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M3 9.5 12 4l9 5.5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" /></svg>
                </span>
                <div>
                  <p className="pc-option-title">Pay by bank transfer</p>
                  <p className="pc-option-text">
                    Transfer to our account, then send us your receipt. An admin confirms your payment
                    after checking the account.
                  </p>
                </div>
              </div>
              {account ? (
                <>
                  <label className="pc-check">
                    <input type="checkbox" className="pc-checkbox" checked={agreed}
                           onChange={(e) => setAgreed(e.target.checked)} />
                    <span>I understand my payment is confirmed only after an admin checks my receipt.</span>
                  </label>
                  <button type="button" className="pc-btn" disabled={!agreed} onClick={() => setStep("account")}>
                    Continue to bank transfer
                  </button>
                </>
              ) : (
                <p className="pc-note pc-note--warn">Bank transfer isn't set up yet. Please contact the youth office.</p>
              )}
            </div>
          </>
        ))}

        {/* ------------------------------ 2. account ------------------------------ */}
        {step === "account" && account && (
          <>
            <p className="pc-lede">Transfer exactly <b>{naira(details.amount_naira)}</b> to:</p>
            <dl className="pc-details">
              <div><dt>Bank</dt><dd>{account.bank_name}</dd></div>
              <div><dt>Account name</dt><dd>{account.account_name}</dd></div>
              <div>
                <dt>Account number</dt>
                <dd className="pc-mono">{account.account_number}<CopyButton text={account.account_number} what="account number" /></dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd className="pc-mono">{naira(details.amount_naira)}<CopyButton text={String(details.amount_naira)} what="amount" /></dd>
              </div>
              <div>
                <dt>Narration / description</dt>
                <dd className="pc-mono">{details.reference_code}<CopyButton text={details.reference_code} what="reference" /></dd>
              </div>
            </dl>
            <p className="pc-small">Write the narration in your transfer so we can find your payment.</p>
            {account.instructions && <p className="pc-note">{account.instructions}</p>}
            <button type="button" className="pc-btn" onClick={() => setStep("upload")}>
              Transfer done? Contact admin
            </button>
            <p className="pc-small pc-center">Next: upload your receipt and send it to the admin on WhatsApp.</p>
            <button type="button" className="pc-btn pc-btn--quiet" onClick={() => setStep("choose")}>Back</button>
          </>
        )}

        {/* ------------------------------ 3. upload ------------------------------ */}
        {step === "upload" && (
          <>
            <label className={`pc-drop${file ? " has-file" : ""}`}>
              <input type="file" className="pc-file-input" accept={ACCEPT}
                     onChange={(e) => pick(e.target.files?.[0])} />
              {preview ? (
                <img src={preview} alt="Your receipt" className="pc-preview" />
              ) : (
                <span className="pc-drop-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
                </span>
              )}
              <span className="pc-drop-text">
                {file ? <><b>{file.name}</b><br />Tap to choose a different file</>
                  : <><b>Choose your receipt</b><br />A screenshot or photo of it, or a PDF</>}
              </span>
            </label>

            <label className="pc-field">
              <span>Your name</span>
              <input className="pc-input" value={name} autoComplete="name"
                     onChange={(e) => changed(setName)(e.target.value)} />
            </label>
            <label className="pc-field">
              <span>Phone / WhatsApp number</span>
              <input className="pc-input" value={phone} inputMode="tel" autoComplete="tel" placeholder="0803 123 4567"
                     onChange={(e) => changed(setPhone)(e.target.value)} />
            </label>
            <label className="pc-field">
              <span>Email <em>(optional)</em></span>
              <input className="pc-input" type="email" value={email} autoComplete="email"
                     onChange={(e) => changed(setEmail)(e.target.value)} />
            </label>
            <label className="pc-field">
              <span>Note for the admin <em>(optional)</em></span>
              <textarea className="pc-input" rows={2} value={note} maxLength={500}
                        placeholder="e.g. Paid from my father's account (Adewale Adeyemi)"
                        onChange={(e) => changed(setNote)(e.target.value)} />
            </label>

            {error && <p className="pc-error" role="alert">{error}</p>}
            <button type="button" className="pc-btn" onClick={() => void send()} disabled={busy}>
              {busy ? "Sending…" : "Send receipt"}
            </button>
            <button type="button" className="pc-btn pc-btn--quiet" onClick={() => setStep("account")} disabled={busy}>
              Back
            </button>
          </>
        )}

        {/* ------------------------------ 4. sent ------------------------------ */}
        {step === "sent" && sent && (
          <>
            <div className="pc-done" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </div>
            {link ? (
              <>
                <p className="pc-lede pc-center">
                  Now send it to the admin on WhatsApp so they can confirm your payment.
                </p>
                <a className="pc-btn pc-btn--whatsapp" href={link} target="_blank" rel="noopener noreferrer"
                   onClick={() => setOpenedWhatsapp(true)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z" /></svg>
                  {openedWhatsapp ? "Open WhatsApp again" : "Send on WhatsApp"}
                </a>
              </>
            ) : (
              <p className="pc-lede pc-center">The admin will check your receipt and confirm your payment.</p>
            )}
            <p className="pc-small pc-center">
              Your payment shows as confirmed once an admin has checked it. You don't need to pay again.
              Reference: <b>{sent.reference_code}</b>
            </p>
            <button type="button" className={`pc-btn${link && !openedWhatsapp ? " pc-btn--quiet" : ""}`} onClick={close}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}