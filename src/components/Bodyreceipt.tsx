import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import html2canvas from "html2canvas";
import { supabase } from "../lib/supabaseClient";
import { naira, transferStatus } from "../lib/Payments";
import Navbar from "./Navbar";
import SiteFooter from "./Sitefooter";
import logo from "../assets/LOGO.jpeg";
import "./Receipt.css";

/**
 * Body payment receipt — for an archdeaconry/parish/church that paid for its
 * members. Shows who was paid for, how many, and the voucher codes minted for
 * members who haven't registered yet, with who has used each one
 * (body_payment_names in body-payment-names.sql). Polls until settlement mints
 * the codes; a bank transfer says it's waiting for an admin.
 */

interface Code { code: string; used: boolean; used_by: string | null }
interface Covered { full_name: string; church: string | null; archdeaconry: string | null }

export default function BodyReceipt() {
  const { id } = useParams<{ id: string }>();
  const cardRef = useRef<HTMLDivElement>(null);

  const [bp, setBp] = useState<any>(null);
  const [programme, setProgramme] = useState<any>(null);
  const [codes, setCodes] = useState<Code[]>([]);
  const [covered, setCovered] = useState<Covered[]>([]);
  const [knowsUse, setKnowsUse] = useState(false);   // false until the names SQL is in
  const [transfer, setTransfer] = useState<Awaited<ReturnType<typeof transferStatus>>>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { void load(); }, [id]);

  async function load() {
    const { data } = await supabase.from("body_payments").select("*").eq("id", id).maybeSingle();
    setBp(data);
    if (data) {
      const [{ data: prog }, names, last] = await Promise.all([
        supabase.from("programmes").select("title, slug").eq("id", data.programme_id).maybeSingle(),
        supabase.rpc("body_payment_names", { p_body_payment_id: data.id }),
        data.status === "paid" ? Promise.resolve(null) : transferStatus("body_payment", data.id),
      ]);
      setProgramme(prog);
      setTransfer(last);
      if (!names.error && Array.isArray(names.data?.codes)) {
        setCovered(names.data.covered ?? []);
        setCodes(names.data.codes);
        setKnowsUse(true);
      } else {
        // body-payment-names.sql not run yet: just the codes, as before
        const { data: vs } = await supabase.from("vouchers").select("code").eq("body_ref", data.id).order("created_at");
        setCovered([]);
        setCodes((vs ?? []).map((v: { code: string }) => ({ code: v.code, used: false, used_by: null })));
        setKnowsUse(false);
      }
    }
    setLoading(false);
  }

  const coveredCount = bp ? (bp.covered_ids?.length ?? 0) : 0;
  const expectedCodes = bp ? Math.max(bp.quantity - coveredCount, 0) : 0;

  useEffect(() => {
    if (!bp || bp.status === "paid") return;
    const started = Date.now();
    const t = setInterval(async () => {
      if (Date.now() - started > 90_000) return clearInterval(t);
      const { data } = await supabase.from("body_payments").select("status").eq("id", id).maybeSingle();
      if (data?.status === "paid") {
        void load();
        clearInterval(t);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [bp, id]);

  async function download() {
    if (!cardRef.current) return;
    const canvas = await html2canvas(cardRef.current, { scale: 3, backgroundColor: "#fff", useCORS: true });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `body-payment-${(id ?? "").slice(0, 8)}.png`;
    a.click();
  }

  if (loading) return <div className="rcpt"><Navbar /><p className="rcpt-status">Loading…</p><SiteFooter /></div>;
  if (!bp) return <div className="rcpt"><Navbar /><div className="rcpt-status"><h2>Not found</h2><Link to="/programmes" className="rcpt-btn">Back</Link></div><SiteFooter /></div>;

  const settled = bp.status === "paid";
  const waiting = !settled && transfer?.status === "pending";      // bank transfer, receipt with an admin
  const refused = !settled && transfer?.status === "rejected";
  const used = codes.filter((c) => c.used).length;

  const [eyebrow, title, sub] = settled
    ? ["Payment received", "Thank you", `${bp.body_name} has covered ${bp.quantity} ${bp.quantity === 1 ? "place" : "places"}.`]
    : waiting
      ? ["Receipt sent", "Waiting for an admin",
         "We have your transfer receipt. Once an admin confirms it, the people you ticked are confirmed and your voucher codes appear here."]
      : refused
        ? ["Not accepted", "Your transfer receipt wasn't accepted",
           `${transfer?.reject_reason ? `${transfer.reject_reason}. ` : ""}Nothing was confirmed — you can pay again from the payment page.`]
        : ["Confirming payment", "Almost there…", "Your receipt updates the moment payment settles."];

  return (
    <div className="rcpt">
      <Navbar />
      <div className="rcpt-head">
        <p className="rcpt-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="rcpt-sub">{sub}</p>
      </div>

      <div className="rcpt-card-wrap">
        <div className="rcpt-card" ref={cardRef}>
          <div className="rcpt-card-top">
            <img src={logo} alt="" className="rcpt-logo" />
            <div>
              <p className="rcpt-org">Diocesan Youth Organization</p>
              <p className="rcpt-org-sub">Ibadan North</p>
            </div>
          </div>

          <div className="rcpt-card-body">
            <p className="rcpt-label">{bp.body_type} payment</p>
            <p className="rcpt-amount">{naira(Number(bp.amount_naira))}</p>

            <dl className="rcpt-lines">
              <div><dt className="rcpt-cap">{bp.body_type}</dt><dd>{bp.body_name}</dd></div>
              {bp.community && <div><dt>Community</dt><dd>{bp.community}</dd></div>}
              <div><dt>Programme</dt><dd>{programme?.title ?? "—"}</dd></div>
              <div><dt>Total places</dt><dd>{bp.quantity}</dd></div>
              <div><dt>Existing members covered</dt><dd>{coveredCount}</dd></div>
            </dl>

            {covered.length > 0 && (
              <div className="rcpt-codes">
                <p className="rcpt-codes-title">{settled ? "Paid for" : "Paying for"} ({covered.length})</p>
                <ul className="rcpt-names">
                  {covered.map((p, i) => (
                    <li key={i}>
                      <span>{p.full_name}</span>
                      {p.church && <span className="rcpt-names-sub">{p.church}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {expectedCodes > 0 && (
              <div className="rcpt-codes">
                <p className="rcpt-codes-title">
                  Voucher codes ({expectedCodes}){knowsUse && settled && codes.length > 0 ? ` · ${used} used` : ""}
                </p>
                {settled && codes.length ? (
                  <div className="rcpt-code-grid">
                    {codes.map((c) => (
                      <span key={c.code} className={`rcpt-code${knowsUse && c.used ? " is-used" : ""}`}>
                        {c.code}
                        {knowsUse && (
                          <small>{c.used ? (c.used_by ? `Used by ${c.used_by}` : "Used") : "Not used yet"}</small>
                        )}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="rcpt-codes-wait">
                    {waiting ? "The codes appear once an admin confirms the transfer."
                      : refused ? "No codes — the payment wasn't confirmed." : "Generating codes…"}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="rcpt-card-foot">
            <p className="rcpt-thanks">
              {settled
                ? "Covered members are confirmed. Give each voucher code to a member who hasn't registered yet — each registers one person free."
                : "Once the payment is confirmed, the people listed are confirmed, and each voucher code registers one person free."}
            </p>
          </div>
        </div>
      </div>

      <div className="rcpt-actions">
        <button className="rcpt-btn" onClick={download} disabled={!settled}>Download receipt</button>
        {programme?.slug && (refused || settled) ? (
          <Link to={`/programmes/${programme.slug}/body-payment`} className="rcpt-btn rcpt-btn--quiet">
            {refused ? "Pay again" : "Back to the payment page"}
          </Link>
        ) : (
          <Link to="/programmes" className="rcpt-btn rcpt-btn--quiet">Back to programmes</Link>
        )}
      </div>
      <SiteFooter />
    </div>
  );
}