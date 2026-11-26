import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { naira, startPayment } from "../lib/Payments";
import { ARCHDEACONRIES } from "../lib/Constants";
import { useAuth } from "./Authcontext";
import Navbar from "./Navbar";
import SiteFooter from "./Sitefooter";
import "./Programmes.css";

/**
 * Body payment page — an archdeaconry, parish or church pays for its members.
 *
 * Gated by the programme's access code, checked on the server
 * (body-payment-names.sql). Once in, the payer sees everyone from that body
 * who registered but hasn't paid — by archdeaconry, by church name, or because
 * they chose "my archdeaconry / parish / church will pay" — ticks the ones
 * they're paying for, and can add voucher codes for members who haven't
 * registered yet. The server works out the price; one payment covers both.
 *
 * Codes the voucher generator made for the body are "pay later": everyone who
 * registered with one comes first in the list, ticked, so the body pays for
 * them now. Once that payment goes through, the codes count as paid.
 *
 * Under that, everyone from the body who is in with a code that's paid for
 * (or that another body pays for), with who gave them the code. They show
 * ticked and cost nothing.
 */

type BodyType = "archdeaconry" | "parish" | "church";

interface Person {
  id: string;
  full_name: string;
  church: string | null;
  archdeaconry: string | null;
  registered_at: string;
  asked: boolean;              // chose "my … will pay" and named this body
  asked_body: string | null;   // the body they named, if any
  own_receipt: boolean;        // sent their own transfer receipt, waiting for an admin
  covered_by: string | null;   // in another body's payment whose receipt is waiting
  code?: string | null;        // registered with one of this body's pay-later codes
}

/** Already in with a voucher code — nothing to pay for them. */
interface Vouchered {
  id: string;
  full_name: string;
  church: string | null;
  archdeaconry: string | null;
  registered_at: string;
  code: string;
  gave: string;                // who gave them the code, e.g. "Bro Femi", "an anonymous sponsor"
  ours: boolean;               // one of this body's own codes
  owed?: boolean;              // another body's pay-later code: that body pays for it
}

interface MyPayment {
  id: string;
  body_type: BodyType;
  body_name: string;
  quantity: number;
  covered: number;
  codes?: number;              // codes this payment bought, and how many are used
  codes_used?: number;
  amount_naira: number;
  status: string;
  created_at: string;
  transfer: "pending" | "approved" | "rejected" | null;
}

const ERRORS: Record<string, string> = {
  sign_in: "Sign in first.",
  no_code: "This programme isn't taking archdeaconry / parish / church payments yet. Ask the programme organisers.",
  wrong: "That access code isn't right. Check it with the programme organisers.",
  too_many: "Too many wrong codes. Wait 15 minutes, then try again.",
  not_found: "This programme couldn't be found.",
  free: "This programme is free, so there's nothing to pay.",
  bad_type: "Choose archdeaconry, parish or church.",
  bad_name: "Enter the full name of your archdeaconry, parish or church.",
  stale: "Someone you ticked has just been paid for, so the list has been refreshed. Check it, then pay again.",
  nothing: "Tick at least one person, or add a voucher code.",
  too_big: "That's more than 500 places in one go. Split it into two payments.",
  short: "Type at least 3 letters of the name.",
};
const UPDATING = "This page is being updated. Please try again in a few minutes.";
const MISSING = /could not find the function|schema cache/i;

const ARCHS = ARCHDEACONRIES.filter((a) => a !== "Non-Anglican");
const MAX_CODES = 500;
const CODE_PREVIEW = 6;   // "already in with a code" rows shown before "Show all"

/** "Agodi" → "Agodi Archdeaconry"; parishes and churches as typed. */
function bodyLabel(type: BodyType, name: string) {
  const n = name.trim();
  return type === "archdeaconry" && !/archdeacon/i.test(n) ? `${n} Archdeaconry` : n;
}

export default function BodyPayment() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { session, profile, loading: authLoading } = useAuth();

  const [programme, setProgramme] = useState<{ id: string; slug: string; title: string; fee_naira: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState<"details" | "people">("details");
  const [bodyType, setBodyType] = useState<BodyType>("church");
  const [bodyName, setBodyName] = useState("");
  const [community, setCommunity] = useState("");
  const [code, setCode] = useState("");

  const [people, setPeople] = useState<Person[]>([]);     // matched to the body
  const [vouchered, setVouchered] = useState<Vouchered[]>([]); // already in with a code
  const [codesUnused, setCodesUnused] = useState(0);      // the body's own codes nobody has used
  const [allCodes, setAllCodes] = useState(false);         // show every "already in with a code" row
  const [added, setAdded] = useState<Person[]>([]);       // added from a name search
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState(0);                   // voucher codes for people not registered

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Person[] | null>(null);
  const [searchNote, setSearchNote] = useState("");
  const [searching, setSearching] = useState(false);

  const [mine, setMine] = useState<MyPayment[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("programmes").select("id, slug, title, fee_naira").eq("slug", slug).maybeSingle();
      setProgramme(data);
      setLoading(false);
    })();
  }, [slug]);

  // The payer's earlier payments here, to get back to a receipt and its codes.
  const programmeId = programme?.id;
  const userId = session?.user.id;
  useEffect(() => {
    if (!programmeId || !userId) { setMine([]); return; }
    let live = true;
    supabase.rpc("my_body_payments", { p_programme_id: programmeId }).then(({ data, error }) => {
      if (live) setMine(error ? [] : ((data as MyPayment[]) ?? []));
    });
    return () => { live = false; };
  }, [programmeId, userId]);

  // Start from the payer's own church (they can change it).
  useEffect(() => {
    if (profile?.church && !bodyName && bodyType === "church") setBodyName(profile.church);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.church]);

  const fee: number = programme?.fee_naira ?? 0;
  const label = bodyLabel(bodyType, bodyName);
  const listed = [...people, ...added];
  const flagged = (p: Person) => p.own_receipt || !!p.covered_by;
  const places = ticked.size + extra;
  const total = places * fee;

  /** Who from this body is waiting for payment. Returns false if it failed. */
  async function loadPeople(keepTicks: boolean): Promise<boolean> {
    if (!programme) return false;
    const { data, error } = await supabase.rpc("body_pay_people", {
      p_programme_id: programme.id, p_code: code.trim(),
      p_body_type: bodyType, p_body_name: bodyName.trim(),
    });
    if (error) {
      console.error("body_pay_people", error);
      setNotice(MISSING.test(error.message) ? UPDATING : "Couldn't load the list. Check your connection and try again.");
      return false;
    }
    if (data?.error) {
      setNotice(ERRORS[data.error] ?? "Couldn't load the list.");
      if (["wrong", "too_many", "sign_in", "no_code"].includes(data.error)) setStep("details");
      return false;
    }
    const found: Person[] = data.people ?? [];
    setPeople(found);
    setVouchered(data.vouchered ?? []);
    setCodesUnused(Number(data.codes_unused) || 0);
    setAdded((prev) => prev.filter((a) => !found.some((f) => f.id === a.id)));
    setTicked((prev) => {
      // people who used the body's pay-later codes, or asked it to pay, start ticked
      if (!keepTicks) return new Set(found.filter((p) => (p.asked || !!p.code) && !flagged(p)).map((p) => p.id));
      // after a refresh, keep ticks on people still waiting
      const still = new Set([...found.map((p) => p.id), ...added.map((a) => a.id)]);
      return new Set([...prev].filter((id) => still.has(id)));
    });
    return true;
  }

  async function unlock() {
    setNotice("");
    if (bodyName.trim().length < 2) {
      return setNotice(bodyType === "archdeaconry" ? "Choose your archdeaconry." : `Enter the full ${bodyType} name.`);
    }
    if (!code.trim()) return setNotice("Enter the access code.");
    setBusy(true);
    const ok = await loadPeople(false);
    setBusy(false);
    if (!ok) return;
    setAdded([]);
    setExtra(0);
    setQuery(""); setResults(null); setSearchNote("");
    setStep("people");
  }

  function changeBody() {
    setStep("details");
    setNotice("");
    setPeople([]); setVouchered([]); setCodesUnused(0); setAllCodes(false); setAdded([]); setTicked(new Set()); setExtra(0);
    setQuery(""); setResults(null); setSearchNote("");
  }

  function pickType(t: BodyType) {
    if (t === bodyType) return;
    // the archdeaconry is picked from a list; parishes and churches are typed
    if (t === "archdeaconry") {
      const own = ARCHS.find((a) => a.toLowerCase() === (profile?.archdeaconry ?? "").toLowerCase());
      setBodyName(own ?? "");
    } else if (bodyType === "archdeaconry") {
      setBodyName(t === "church" ? profile?.church ?? "" : "");
    }
    setBodyType(t);
    setNotice("");
  }

  const toggle = (id: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const tickable = listed.filter((p) => !flagged(p));
  const allTicked = tickable.length > 0 && tickable.every((p) => ticked.has(p.id));
  function tickAll() {
    setTicked((prev) => {
      const next = new Set(prev);
      for (const p of tickable) { if (allTicked) next.delete(p.id); else next.add(p.id); }
      return next;
    });
  }

  async function search() {
    const q = query.trim();
    if (!programme) return;
    if (q.replace(/[^a-z0-9]/gi, "").length < 3) { setResults(null); return setSearchNote(ERRORS.short); }
    setSearching(true);
    setSearchNote("");
    const { data, error } = await supabase.rpc("body_pay_search", {
      p_programme_id: programme.id, p_code: code.trim(), p_body_name: bodyName.trim(), p_query: q,
      p_body_type: bodyType,
    });
    setSearching(false);
    if (error || data?.error) {
      setResults(null);
      return setSearchNote(error ? (MISSING.test(error.message) ? UPDATING : "Search didn't work. Try again.")
                                 : ERRORS[data.error] ?? "Search didn't work.");
    }
    const found: Person[] = data.people ?? [];
    setResults(found);
    if (!found.length) setSearchNote(`Nobody called “${q}” is waiting for payment for this programme.`);
  }

  function addPerson(p: Person) {
    if (!listed.some((x) => x.id === p.id)) setAdded((prev) => [...prev, p]);
    if (!flagged(p)) setTicked((prev) => new Set(prev).add(p.id));
  }

  function setCodes(n: number) {
    setExtra(Math.min(MAX_CODES, Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))));
  }

  async function pay() {
    if (!programme) return;
    if (places < 1) return setNotice(ERRORS.nothing);
    setBusy(true);
    setNotice("");

    const { data, error } = await supabase.rpc("body_payment_start", {
      p_programme_id: programme.id,
      p_code: code.trim(),
      p_body_type: bodyType,
      p_body_name: bodyName.trim(),
      p_community: bodyType === "church" ? community.trim() || null : null,
      p_covered: [...ticked],
      p_extra: extra,
    });
    if (error) {
      console.error("body_payment_start", error);
      setBusy(false);
      return setNotice(MISSING.test(error.message) ? UPDATING : "Couldn't start the payment. Try again.");
    }
    if (data?.error) {
      if (data.error === "stale") await loadPeople(true);
      else if (["wrong", "too_many", "sign_in", "no_code"].includes(data.error)) setStep("details");
      setBusy(false);
      return setNotice(ERRORS[data.error] ?? "Couldn't start the payment.");
    }

    const result = await startPayment({
      purpose: "body_payment",
      referenceId: data.id,
      amountNaira: data.amount_naira,      // what the server worked out
      customer: { email: profile?.email ?? "", name: label, phone: profile?.phone ?? "" },
      title: `${label} · ${programme.title}`,
      description: `Paying for ${data.quantity} place${data.quantity === 1 ? "" : "s"}`,
    });

    setBusy(false);
    if (result.status === "success" || result.status === "submitted") {
      navigate(`/body-receipt/${data.id}`);
    } else if (result.status === "failed") {
      setNotice(result.message ?? "Payment didn't go through. Nothing was confirmed — you can try again.");
    } else {
      setNotice("Payment not finished. You can pay whenever you're ready.");
    }
  }

  /* ---------------- render ---------------- */

  const shell = (body: ReactNode) => (
    <div><Navbar /><div className="pg-body-pay">{body}</div><SiteFooter /></div>
  );

  if (loading || authLoading) return shell(<p className="bp-status">Loading…</p>);
  if (!programme) return shell(<p className="bp-status">Programme not found.</p>);
  if (fee <= 0) return shell(<p className="bp-status">This programme is free — no body payment needed.</p>);

  const here = `/programmes/${programme.slug}/body-payment`;

  const head = (
    <>
      <Link to={`/programmes/${programme.slug}`} className="pg-back">← {programme.title}</Link>
      <h1>{programme.title}</h1>
      <p className="pg-sub">Archdeaconry / parish / church payment · {naira(fee)} a place</p>
    </>
  );

  const myPayments = mine.length > 0 && (
    <section className="bp-mine" aria-label="Your payments for this programme">
      <h2 className="bp-title">Your payments for this programme</h2>
      {mine.map((m) => {
        const [pill, text] = m.status === "paid" ? ["paid", "Paid"]
          : m.transfer === "rejected" ? ["no", "Receipt not accepted"] : ["wait", "Waiting for admin"];
        return (
          <Link key={m.id} to={`/body-receipt/${m.id}`} className="bp-mine-row">
            <span className="bp-mine-name">{bodyLabel(m.body_type, m.body_name)}</span>
            <span className={`bp-pill bp-pill--${pill}`}>{text}</span>
            <span className="bp-mine-meta">
              {m.quantity} place{m.quantity === 1 ? "" : "s"} · {naira(m.amount_naira)} ·{" "}
              {new Date(m.created_at).toLocaleDateString("en-NG", { day: "numeric", month: "short" })}
              {(m.codes ?? 0) > 0 && ` · ${m.codes_used ?? 0} of ${m.codes} code${m.codes === 1 ? "" : "s"} used`}
            </span>
            <span className="bp-mine-open">{m.status === "paid" ? "Receipt & codes" : "Open"} →</span>
          </Link>
        );
      })}
    </section>
  );

  if (!session) {
    return shell(
      <>
        {head}
        <div className="bp-card">
          <p className="pg-note">
            Pay for your members in one go. You'll see who from your archdeaconry, parish or
            church has registered but not paid, tick the ones you're paying for, and add voucher
            codes for anyone who hasn't registered yet.
          </p>
          <p className="pg-note">Sign in first, so your receipt and voucher codes stay in your account.</p>
          <Link className="pg-button" to={`/login?next=${encodeURIComponent(here)}`}>Sign in</Link>
          <Link className="pg-button pg-button--quiet" to={`/signup?next=${encodeURIComponent(here)}`}>
            Create an account
          </Link>
        </div>
      </>,
    );
  }

  const personRow = (p: Person) => (
    <label key={p.id} className="bp-person">
      <input type="checkbox" className="bp-check" checked={ticked.has(p.id)} onChange={() => toggle(p.id)} />
      <span className="bp-person-text">
        <span className="bp-person-name">{p.full_name}</span>
        <span className="bp-person-meta">{[p.church, p.archdeaconry].filter(Boolean).join(" · ")}</span>
        {p.covered_by && (
          <span className="bp-flag">{p.covered_by} has already sent a receipt for them — waiting for an admin</span>
        )}
        {p.own_receipt && <span className="bp-flag">Sent their own transfer receipt — waiting for an admin</span>}
        {p.code && (
          <span className="bp-flag bp-flag--quiet">Used code <span className="bp-code">{p.code}</span></span>
        )}
        {!p.code && !p.asked && p.asked_body && <span className="bp-flag bp-flag--quiet">Asked {p.asked_body} to pay</span>}
      </span>
    </label>
  );

  // already in with a code: shown ticked, can't be unticked, not charged
  const voucherRow = (p: Vouchered) => (
    <div key={p.id} className="bp-person bp-person--done">
      <span className="bp-tick" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <span className="bp-person-text">
        <span className="bp-person-name">{p.full_name}</span>
        <span className="bp-person-meta">{[p.church, p.archdeaconry].filter(Boolean).join(" · ")}</span>
        <span className="bp-flag bp-flag--done">
          Code from {p.gave}{p.owed ? ", which pays for it" : p.ours ? " (one of yours)" : ""} · <span className="bp-code">{p.code}</span>
        </span>
      </span>
    </div>
  );

  if (step === "details") {
    return shell(
      <>
        {head}
        <div className="bp-card">
          <p className="pg-note">
            Pay for your members in one go: tick the ones who have registered, and add voucher
            codes for anyone who hasn't.
          </p>

          <p className="bp-label" id="bp-type">Who is paying?</p>
          <div className="pg-bodytype" role="group" aria-labelledby="bp-type">
            {(["archdeaconry", "parish", "church"] as const).map((b) => (
              <button key={b} type="button" aria-pressed={bodyType === b}
                      className={`pg-chip${bodyType === b ? " is-active" : ""}`}
                      onClick={() => pickType(b)}>{b}</button>
            ))}
          </div>

          {bodyType === "archdeaconry" ? (
            <>
              <label className="bp-label" htmlFor="bp-name">Archdeaconry</label>
              <select id="bp-name" className="pg-input bp-input" value={bodyName}
                      onChange={(e) => setBodyName(e.target.value)}>
                <option value="">Choose your archdeaconry</option>
                {ARCHS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </>
          ) : (
            <>
              <label className="bp-label" htmlFor="bp-name">
                {bodyType === "church" ? "Church name" : "Parish name"}
              </label>
              <input id="bp-name" className="pg-input bp-input" autoComplete="organization"
                     placeholder={bodyType === "church"
                       ? "e.g. St Peter's Anglican Church, Aremo"
                       : "e.g. St Peter's Parish, Aremo"}
                     value={bodyName} onChange={(e) => setBodyName(e.target.value)} />
            </>
          )}

          {bodyType === "church" && (
            <>
              <label className="bp-label" htmlFor="bp-community">Community / location</label>
              <input id="bp-community" className="pg-input bp-input" placeholder="e.g. Aremo"
                     value={community} onChange={(e) => setCommunity(e.target.value)} />
            </>
          )}

          <label className="bp-label" htmlFor="bp-code">Access code</label>
          <input id="bp-code" className="pg-input" placeholder="From the programme organisers"
                 autoComplete="off" autoCapitalize="characters" spellCheck={false}
                 value={code} onChange={(e) => setCode(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void unlock(); }} />

          {notice && <p className="pg-note pg-note--warn" role="alert">{notice}</p>}
          <button className="pg-button" onClick={unlock} disabled={busy}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </div>
        {myPayments}
      </>,
    );
  }

  const laterRows = people.filter((p) => p.code);              // used the body's pay-later codes
  const askedRows = people.filter((p) => !p.code && p.asked);
  const otherRows = people.filter((p) => !p.code && !p.asked);
  // own codes first; a long list (an archdeaconry) shows the first few until asked
  const ownCodeRows = vouchered.filter((p) => p.ours);
  const otherCodeRows = vouchered.filter((p) => !p.ours);
  const codeRows = [...ownCodeRows, ...otherCodeRows];
  const shownCodes = allCodes || codeRows.length <= CODE_PREVIEW + 2 ? codeRows : codeRows.slice(0, CODE_PREVIEW);
  const bothGroups = ownCodeRows.length > 0 && otherCodeRows.length > 0;
  const shownOwn = shownCodes.filter((p) => p.ours);
  const shownOther = shownCodes.filter((p) => !p.ours);

  return shell(
    <>
      {head}
      <div className="bp-card">
        <div className="bp-payer">
          <div>
            <p className="bp-eyebrow">Paying as</p>
            <p className="bp-payer-name">{label}{bodyType === "church" && community.trim() ? `, ${community.trim()}` : ""}</p>
          </div>
          <button type="button" className="bp-link" onClick={changeBody}>Change</button>
        </div>

        <div className="bp-section-head">
          <h2 className="bp-title">Not paid for yet ({listed.length})</h2>
          {tickable.length > 1 && (
            <button type="button" className="bp-link" onClick={tickAll}>{allTicked ? "Untick all" : "Tick all"}</button>
          )}
        </div>

        {listed.length === 0 ? (
          <p className="pg-note bp-empty">
            Nobody from {label} has registered and is waiting for payment. If someone is missing,
            search for them below, or buy voucher codes for members who haven't registered yet.
          </p>
        ) : (
          <>
            <p className="bp-hint">
              Tick the people you're paying for.
              {laterRows.length > 0 && " Everyone who registered with your codes is ticked already."}
            </p>
            <div className="bp-list">
              {laterRows.length > 0 && <p className="bp-group">Registered with {label}'s codes</p>}
              {laterRows.map(personRow)}
              {askedRows.length > 0 && <p className="bp-group">Asked {label} to pay</p>}
              {askedRows.map(personRow)}
              {otherRows.length > 0 && (
                <p className="bp-group">{laterRows.length || askedRows.length ? `Also from ${label}` : `From ${label}`}</p>
              )}
              {otherRows.map(personRow)}
              {added.length > 0 && <p className="bp-group">Added by search</p>}
              {added.map(personRow)}
            </div>
          </>
        )}

        {vouchered.length > 0 && (
          <div className="bp-block">
            <h2 className="bp-title">Already in with a voucher code ({vouchered.length})</h2>
            <p className="bp-hint">
              Whoever gave them the code pays for it, so they're ticked already and cost nothing here.
            </p>
            <div className="bp-list bp-list--done">
              {bothGroups && shownOwn.length > 0 && <p className="bp-group">With {label}'s own codes</p>}
              {shownOwn.map(voucherRow)}
              {bothGroups && shownOther.length > 0 && <p className="bp-group">With codes from others</p>}
              {shownOther.map(voucherRow)}
            </div>
            {shownCodes.length < codeRows.length && (
              <button type="button" className="bp-link bp-more" onClick={() => setAllCodes(true)}>
                Show all {codeRows.length}
              </button>
            )}
          </div>
        )}

        <div className="bp-block">
          <label className="bp-label" htmlFor="bp-search">Someone missing? Search by name</label>
          <div className="bp-search">
            <input id="bp-search" className="pg-input bp-input" placeholder="e.g. Tolu Bakare" type="search"
                   value={query} onChange={(e) => setQuery(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") void search(); }} />
            <button type="button" className="bp-small-btn" onClick={search} disabled={searching}>
              {searching ? "…" : "Search"}
            </button>
          </div>
          {searchNote && <p className="bp-hint">{searchNote}</p>}
          {results && results.length > 0 && (
            <div className="bp-results">
              {results.map((p) => {
                const on = listed.some((x) => x.id === p.id);
                return (
                  <div key={p.id} className="bp-result">
                    <span className="bp-person-text">
                      <span className="bp-person-name">{p.full_name}</span>
                      <span className="bp-person-meta">{[p.church, p.archdeaconry].filter(Boolean).join(" · ")}</span>
                      {(p.covered_by || p.own_receipt) && (
                        <span className="bp-flag">
                          {p.covered_by ? `${p.covered_by} has already sent a receipt for them` : "Sent their own transfer receipt"}
                        </span>
                      )}
                    </span>
                    <button type="button" className="bp-small-btn" disabled={on} onClick={() => addPerson(p)}>
                      {on ? "On the list" : "Add"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bp-block">
          <label className="bp-label" htmlFor="bp-extra">Voucher codes for members who haven't registered</label>
          <p className="bp-hint">Each code lets one person register free. The codes appear on your receipt.</p>
          {codesUnused > 0 && (
            <p className="bp-flag bp-flag--note">
              {label} already has {codesUnused} code{codesUnused === 1 ? "" : "s"} that nobody has used yet.
              Hand {codesUnused === 1 ? "it" : "those"} out before buying more.
            </p>
          )}
          <div className="bp-stepper">
            <button type="button" aria-label="One fewer code" onClick={() => setCodes(extra - 1)} disabled={extra <= 0}>−</button>
            <input id="bp-extra" className="pg-input" type="number" inputMode="numeric" min={0} max={MAX_CODES}
                   value={extra} onChange={(e) => setCodes(Number(e.target.value))} />
            <button type="button" aria-label="One more code" onClick={() => setCodes(extra + 1)} disabled={extra >= MAX_CODES}>+</button>
          </div>
        </div>

        <div className="pg-summary">
          <div><span>People ticked</span><span>{ticked.size} × {naira(fee)}</span></div>
          <div><span>Voucher codes</span><span>{extra} × {naira(fee)}</span></div>
          <div className="pg-summary-total"><span>Total</span><span>{naira(total)}</span></div>
        </div>

        {notice && <p className="pg-note pg-note--warn" role="alert">{notice}</p>}
        <button className="pg-button" onClick={pay} disabled={busy || places < 1}>
          {busy ? "Starting…" : places < 1 ? "Tick someone or add a code" : `Pay ${naira(total)}`}
        </button>
      </div>
      {myPayments}
    </>,
  );
}