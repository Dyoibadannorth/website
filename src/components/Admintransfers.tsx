import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { naira } from "../lib/Payments";

/**
 * Admin → Bank transfers.
 *
 * Receipts people sent after paying by bank transfer. The admin checks the
 * money is in the account, then marks it paid: the database settles it
 * exactly like a card payment (registration paid, order paid and stock taken
 * off, vouchers minted…) and it shows under Receipts. Or marks it not
 * accepted, with a reason the payer sees.
 *
 * The WhatsApp message a payer sends links here with ?t=<id>, which opens
 * that receipt at the top.
 *
 * Below the list: the bank account people pay into, the WhatsApp number the
 * receipts go to, and the card (Flutterwave) switch. Only the super admin
 * can change those.
 */

type Status = "pending" | "approved" | "rejected" | "replaced";
interface Row {
  id: string; purpose: string; reference_id: string;
  programme_id: string | null; programme_title: string | null;
  reference_code: string; label: string | null; amount_naira: number;
  payer_name: string; payer_email: string | null; payer_phone: string | null; payer_note: string | null;
  bank_name: string | null; account_name: string | null; account_number: string | null;
  receipt_path: string | null; status: Status; submitted_at: string;
  reviewed_at: string | null; reviewed_by_name: string | null; reject_reason: string | null;
  earlier: number;
}
interface Settings {
  can_edit: boolean; card_enabled: boolean;
  bank_name: string | null; account_name: string | null; account_number: string | null;
  whatsapp_number: string | null; instructions: string | null; updated_at: string | null;
  programme_accounts: { programme_id: string; title: string; bank_name: string; account_name: string;
                        account_number: string; whatsapp_number: string | null }[];
}
type Note = { kind: "ok" | "error"; text: string } | null;

const TABS: [Status | "all", string][] = [
  ["pending", "Waiting"], ["approved", "Paid"], ["rejected", "Not accepted"], ["all", "All"],
];
const PILL: Record<Status, [string, string]> = {
  pending: ["a-pill--warn", "Waiting"],
  approved: ["a-pill--live", "Paid"],
  rejected: ["a-pill--alert", "Not accepted"],
  replaced: ["a-pill--draft", "Replaced by a newer receipt"],
};
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-NG", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
// "0803 123 4567" → "2348031234567", for a wa.me link to the payer
const waDigits = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  return /^0\d{10}$/.test(d) ? `234${d.slice(1)}` : d;
};
const isPdf = (p: string) => /\.pdf$/i.test(p);
const LINK = { color: "var(--maroon)", textDecoration: "underline", textUnderlineOffset: 2 } as const;
const isHeic = (p: string) => /\.hei[cf]$/i.test(p);

export default function AdminTransfers() {
  const [tab, setTab] = useState<Status | "all">("pending");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [linked, setLinked] = useState<Row | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [off, setOff] = useState("");
  const [note, setNote] = useState<Note>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const [linkedId] = useState(() => new URLSearchParams(window.location.search).get("t"));

  useEffect(() => { void load(); }, [tab]);

  async function signedUrls(list: Row[]) {
    const paths = list.map((r) => r.receipt_path).filter((p): p is string => !!p && !urls[p]);
    if (!paths.length) return;
    const { data } = await supabase.storage.from("transfer-receipts").createSignedUrls(paths, 60 * 30);
    const next: Record<string, string> = {};
    (data ?? []).forEach((d) => { if (d.path && d.signedUrl) next[d.path] = d.signedUrl; });
    setUrls((u) => ({ ...u, ...next }));
  }

  async function load() {
    const { data, error } = await supabase.rpc("transfer_list", { p_status: tab });
    if (error) {
      setOff(/could not find the function/i.test(error.message)
        ? "Run bank-transfers.sql in Supabase to turn this page on." : error.message);
      setRows([]);
      return;
    }
    setOff("");
    let list = (data ?? []) as Row[];
    let one: Row | null = null;
    if (linkedId) {
      const { data: found } = await supabase.rpc("transfer_list", { p_status: "all", p_id: linkedId });
      one = ((found ?? []) as Row[])[0] ?? null;
      if (one) list = list.filter((r) => r.id !== one!.id);
    }
    setLinked(one);
    setRows(list);
    void signedUrls(one ? [one, ...list] : list);
  }

  async function approve(r: Row) {
    if (!confirm(
      `Mark ${naira(r.amount_naira)} from ${r.payer_name} as paid?\n\n` +
      `Only do this once you've seen the money in ${r.account_name ?? "the account"}` +
      `${r.bank_name ? ` (${r.bank_name} ${r.account_number ?? ""})` : ""}.`,
    )) return;
    setBusyId(r.id);
    setNote(null);
    const { error } = await supabase.rpc("transfer_approve", { p_transfer_id: r.id });
    setBusyId(null);
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    setNote({ kind: "ok", text: `Marked paid: ${r.payer_name}, ${naira(r.amount_naira)} (${r.reference_code}).` });
    void load();
  }

  async function reject() {
    if (!rejecting) return;
    const r = [linked, ...(rows ?? [])].find((x) => x?.id === rejecting.id);
    setBusyId(rejecting.id);
    setNote(null);
    const { error } = await supabase.rpc("transfer_reject", { p_transfer_id: rejecting.id, p_reason: rejecting.reason });
    setBusyId(null);
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    setRejecting(null);
    setNote({ kind: "ok", text: `Not accepted: ${r?.payer_name ?? "receipt"}. Let them know on WhatsApp what to fix.` });
    void load();
  }

  // a plain function, not a component: a component defined in here would be
  // remounted on every keystroke and the reason box would lose focus
  function card(r: Row, highlight = false) {
    const url = r.receipt_path ? urls[r.receipt_path] : undefined;
    const [pill, pillText] = PILL[r.status];
    const busy = busyId === r.id;
    const canDecide = r.status === "pending" || r.status === "rejected";
    return (
      <div key={r.id} className="a-card" style={{
        display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start",
        ...(highlight ? { borderColor: "var(--gold-aged)", boxShadow: "0 0 0 2px #f1e3b8" } : {}),
      }}>
        {/* the receipt */}
        <a href={url} target="_blank" rel="noopener noreferrer"
           style={{ flex: "0 0 150px", display: "block", textDecoration: "none", color: "inherit" }}
           title="Open the receipt">
          {url && r.receipt_path && !isPdf(r.receipt_path) && !isHeic(r.receipt_path) ? (
            <img src={url} alt={`Receipt from ${r.payer_name}`}
                 style={{ width: 150, height: 190, objectFit: "cover", objectPosition: "top",
                          borderRadius: 8, border: "1px solid var(--line)", background: "#faf7f5" }} />
          ) : (
            <span style={{ display: "grid", placeItems: "center", width: 150, height: 190, borderRadius: 8,
                           border: "1px solid var(--line)", background: "#faf7f5", color: "var(--muted)",
                           fontSize: "0.85rem", textAlign: "center", padding: 10 }}>
              {!url ? "Loading receipt…" : r.receipt_path && isPdf(r.receipt_path) ? "PDF receipt — tap to open" : "Photo — tap to open"}
            </span>
          )}
        </a>

        {/* who, what, how much */}
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`a-pill ${pill}`}>{pillText}</span>
            {highlight && <span className="a-pill a-pill--draft">Opened from WhatsApp</span>}
            <span style={{ color: "var(--muted)", fontSize: "0.82rem" }}>Sent {when(r.submitted_at)}</span>
          </div>
          <p style={{ margin: "8px 0 2px", fontFamily: "Newsreader, Georgia, serif", fontSize: "1.25rem", fontWeight: 600 }}>
            {naira(r.amount_naira)} <span style={{ fontWeight: 400 }}>from</span> {r.payer_name}
          </p>
          <p style={{ margin: 0 }}>{r.label}</p>
          <p style={{ margin: "4px 0 0", fontSize: "0.88rem" }}>
            Reference <b style={{ letterSpacing: "0.04em" }}>{r.reference_code}</b>
            {r.account_name && (
              <span style={{ color: "var(--muted)" }}>
                {" "}· paid into {r.account_name}, {r.bank_name} {r.account_number}
              </span>
            )}
          </p>
          <p style={{ margin: "6px 0 0", fontSize: "0.88rem", display: "flex", gap: 14, flexWrap: "wrap" }}>
            {r.payer_phone && <a style={LINK} href={`tel:${r.payer_phone.replace(/[^\d+]/g, "")}`}>{r.payer_phone}</a>}
            {r.payer_phone && (
              <a style={LINK} href={`https://wa.me/${waDigits(r.payer_phone)}`} target="_blank" rel="noopener noreferrer">WhatsApp them</a>
            )}
            {r.payer_email && <a style={LINK} href={`mailto:${r.payer_email}`}>{r.payer_email}</a>}
          </p>
          {r.payer_note && (
            <p style={{ margin: "8px 0 0", padding: "8px 10px", background: "#faf7f5", borderRadius: 8, fontSize: "0.9rem" }}>
              “{r.payer_note}”
            </p>
          )}
          {r.earlier > 0 && (
            <p style={{ margin: "6px 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
              {r.earlier} other receipt{r.earlier === 1 ? "" : "s"} sent for this.
            </p>
          )}
          {r.status === "approved" && r.reviewed_at && (
            <p style={{ margin: "8px 0 0", fontSize: "0.85rem", color: "var(--green)" }}>
              Marked paid by {r.reviewed_by_name ?? "an admin"}, {when(r.reviewed_at)}.
            </p>
          )}
          {r.status === "rejected" && (
            <p style={{ margin: "8px 0 0", fontSize: "0.85rem", color: "var(--red)" }}>
              Not accepted{r.reviewed_by_name ? ` by ${r.reviewed_by_name}` : ""}: {r.reject_reason}
            </p>
          )}

          {canDecide && (
            rejecting?.id === r.id ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
                <input autoFocus style={{ flex: "1 1 220px" }} maxLength={300}
                       placeholder="Why? The payer sees this, e.g. Amount is ₦3,000, fee is ₦5,000"
                       value={rejecting.reason}
                       onChange={(e) => setRejecting({ id: r.id, reason: e.target.value })} />
                <button className="a-btn" style={{ background: "var(--red)" }}
                        disabled={busy || !rejecting.reason.trim()} onClick={() => void reject()}>
                  {busy ? "Saving…" : "Not accepted"}
                </button>
                <button className="a-btn a-btn--ghost" onClick={() => setRejecting(null)}>Cancel</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                <button className="a-btn" disabled={busy} onClick={() => void approve(r)}>
                  {busy ? "Saving…" : "Mark paid"}
                </button>
                {r.status === "pending" && (
                  <button className="a-btn a-btn--quiet" disabled={busy}
                          onClick={() => setRejecting({ id: r.id, reason: "" })}>
                    Not accepted…
                  </button>
                )}
              </div>
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="a-head">
        <div>
          <p className="a-eyebrow">Payments</p>
          <h1>Bank transfers</h1>
          <p>
            Receipts people sent after paying by transfer. Check the money is in the account, then
            mark it paid: it's settled just like a card payment and shows under Receipts.
          </p>
        </div>
      </div>

      {off ? (
        <div className="a-card"><p style={{ margin: 0 }}>{off}</p></div>
      ) : (
        <>
          {note && (
            <p className={`a-pill ${note.kind === "ok" ? "a-pill--live" : "a-pill--alert"}`}
               role="status" style={{ display: "block", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: "0.88rem" }}>
              {note.text}
            </p>
          )}

          {linked && (
            <div style={{ marginBottom: 22 }}>
              {card(linked, true)}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {TABS.map(([key, label]) => (
              <button key={key} className={`a-btn${tab === key ? "" : " a-btn--quiet"}`}
                      style={{ minHeight: 36, padding: "6px 14px" }}
                      onClick={() => { setRows(null); setTab(key); }}>
                {label}
              </button>
            ))}
          </div>

          {rows === null ? (
            <p style={{ color: "var(--muted)" }}>Loading…</p>
          ) : rows.length === 0 ? (
            <div className="a-empty">
              <h3>{tab === "pending" ? "Nothing waiting" : "Nothing here"}</h3>
              <p>{tab === "pending" ? "New receipts appear here as people send them." : "Try another tab."}</p>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {rows.map((r) => card(r))}
            </div>
          )}

          <PaymentSettings />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  The account people pay into, where receipts go, and the card switch */
/* ------------------------------------------------------------------ */
function PaymentSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [form, setForm] = useState({ bank: "", name: "", number: "", whatsapp: "", instructions: "", card: false });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    const { data, error } = await supabase.rpc("payment_settings_get");
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    const v = data as Settings;
    setS(v);
    setForm({
      bank: v.bank_name ?? "", name: v.account_name ?? "", number: v.account_number ?? "",
      whatsapp: v.whatsapp_number ? `+${v.whatsapp_number}` : "", instructions: v.instructions ?? "",
      card: v.card_enabled,
    });
  }

  async function save() {
    setBusy(true);
    setNote(null);
    const { error } = await supabase.rpc("payment_settings_save", {
      p_card_enabled: form.card,
      p_bank_name: form.bank,
      p_account_name: form.name,
      p_account_number: form.number,
      p_whatsapp_number: form.whatsapp,
      p_instructions: form.instructions,
    });
    setBusy(false);
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    setNote({ kind: "ok", text: "Saved. New payments use these details straight away." });
    void load();
  }

  if (!s) return note ? <p style={{ marginTop: 30, color: "var(--red)" }}>{note.text}</p> : null;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const field = (label: string, k: "bank" | "name" | "number" | "whatsapp", placeholder: string) => (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <input value={form[k]} onChange={set(k)} placeholder={placeholder} disabled={!s.can_edit}
             inputMode={k === "number" || k === "whatsapp" ? "tel" : undefined} />
    </label>
  );

  return (
    <>
      <h2 className="a-section-title" id="payment-settings">Where people pay</h2>
      {!s.account_number && (
        <p className="a-pill a-pill--warn" style={{ display: "block", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
          No bank account yet, so nobody can pay by transfer.
          {s.can_edit ? " Fill it in below." : " Ask the super admin to add it."}
        </p>
      )}
      <div className="a-card">
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {field("Bank", "bank", "e.g. Guaranty Trust Bank")}
          {field("Account name", "name", "e.g. Diocesan Youth Organization")}
          {field("Account number", "number", "10 digits")}
          {field("WhatsApp number for receipts", "whatsapp", "e.g. 0803 123 4567")}
        </div>
        <label style={{ display: "grid", gap: 4, marginTop: 12 }}>
          <span style={{ fontWeight: 600 }}>Extra instructions <span style={{ fontWeight: 400, color: "var(--muted)" }}>(optional, shown with the account)</span></span>
          <textarea rows={2} value={form.instructions} onChange={set("instructions")} disabled={!s.can_edit}
                    placeholder="e.g. Transfers are checked every evening." />
        </label>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14 }}>
          <input type="checkbox" checked={form.card} disabled={!s.can_edit}
                 onChange={(e) => setForm({ ...form, card: e.target.checked })}
                 style={{ width: 18, height: 18, marginTop: 2 }} />
          <span>
            <b>Allow card payments (Flutterwave)</b><br />
            <span style={{ color: "var(--muted)" }}>
              Off: the card option shows as "Not available at the moment" and everyone pays by transfer.
            </span>
          </span>
        </label>
        {note && (
          <p style={{ margin: "12px 0 0", fontSize: "0.88rem", color: note.kind === "ok" ? "var(--green)" : "var(--red)" }}>
            {note.text}
          </p>
        )}
        {s.can_edit ? (
          <button className="a-btn" style={{ marginTop: 14 }} onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        ) : (
          <p style={{ margin: "12px 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
            Only the super admin can change these.
          </p>
        )}
      </div>

      {s.programme_accounts.length > 0 && (
        <div className="a-card">
          <p className="a-eyebrow" style={{ marginTop: 0 }}>Programmes with their own account</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {s.programme_accounts.map((a) => (
              <li key={a.programme_id} style={{ marginTop: 4 }}>
                <b>{a.title}</b>: {a.account_name}, {a.bank_name} {a.account_number}
                {a.whatsapp_number ? ` · receipts to +${a.whatsapp_number}` : ""}
              </li>
            ))}
          </ul>
          <p style={{ margin: "8px 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
            Set in each programme's editor, under the fee.
          </p>
        </div>
      )}
    </>
  );
}