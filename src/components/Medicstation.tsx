import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabaseClient";
import QrScanner from "./Qrscanner";

/**
 * The medic page, at /medic.
 *
 * For medics on duty at a programme: find a participant (scan their tag,
 * or type the code under the QR or their name), see their medical record
 * (allergies and conditions pinned at the top, then every visit), and add
 * to it. A wrong entry is marked "entered in error" by whoever wrote it;
 * nothing is ever edited or deleted one at a time.
 *
 * Only the programme's medics and the super admin can read records; only
 * medics can add. The super admin can delete a programme's records with one
 * button once they're no longer needed. Anything on screen closes by itself
 * after 5 minutes without activity, so a phone left on a table doesn't show
 * anyone's record. Nothing is kept on the phone except the programme chosen.
 */

interface Prog {
  id: string; title: string; starts_at: string | null; ends_at: string | null;
  can_write: boolean; records: number; is_super_admin: boolean;
}
interface Found {
  id: string; full_name: string | null; archdeaconry: string | null; church: string | null;
  photo_url: string | null; checked_in: boolean; alerts: number; visits: number;
}
interface Person {
  id: string; full_name: string | null; gender: string | null; age: number | null; phone: string | null;
  church: string | null; archdeaconry: string | null; photo_url: string | null;
  checked_in: boolean; assignments: Record<string, string> | null;
}
interface Field { key: string; label: string }
interface Entry {
  id: string; kind: "visit" | "alert"; complaint: string | null; treatment: string | null;
  outcome: string | null; temperature: number | string | null; blood_pressure: string | null;
  pulse: number | null; notes: string | null; follow_up: boolean; created_at: string;
  created_by_name: string | null; mine: boolean;
  voided_at: string | null; void_reason: string | null; voided_by_name: string | null;
}
interface Recent {
  entry_id: string; registration_id: string; full_name: string | null; photo_url: string | null;
  kind: "visit" | "alert"; complaint: string | null; outcome: string | null;
  follow_up: boolean; created_at: string; created_by_name: string | null;
}
interface Form {
  kind: "visit" | "alert"; complaint: string; temp: string; bp: string; pulse: string;
  treatment: string; outcome: string; notes: string; follow: boolean;
}
type Note = { kind: "ok" | "error"; text: string } | null;

const OUTCOMES: [string, string][] = [
  ["returned", "Back to the programme"],
  ["observation", "Under observation"],
  ["referred", "Referred to hospital"],
  ["sent_home", "Sent home"],
];
const outcomeLabel = (o: string | null) => OUTCOMES.find(([k]) => k === o)?.[1] ?? "";
const EMPTY_FORM: Form = {
  kind: "visit", complaint: "", temp: "", bp: "", pulse: "", treatment: "", outcome: "", notes: "", follow: false,
};
const LAST_KEY = "dyo.medic.last";
const IDLE_MS = 5 * 60_000;
// a scanned tag (DYO:<id>), a full id, or the 8-character code under the QR
const CODE_RE = /^(DYO:)?[0-9a-f]{8}(-[0-9a-f-]{27})?$/i;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-NG", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default function MedicStation() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const [progs, setProgs] = useState<Prog[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [programmeId, setProgrammeId] = useState("");
  const prog = progs?.find((p) => p.id === programmeId) ?? null;
  const [note, setNote] = useState<Note>(null);

  const [tab, setTab] = useState<"find" | "recent">("find");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [scanning, setScanning] = useState(false);

  const [person, setPerson] = useState<Person | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [opening, setOpening] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null);

  const [recent, setRecent] = useState<Recent[] | null>(null);
  const [followOnly, setFollowOnly] = useState(false);

  const [showDelete, setShowDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  /* ---------- sign-in ---------- */
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setAuth(data.session ? "in" : "out"));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setAuth(session ? "in" : "out"));
    return () => data.subscription.unsubscribe();
  }, []);

  /* ---------- programmes I can open ---------- */
  async function loadProgs(keep = "") {
    const { data, error } = await supabase.rpc("medic_programmes");
    if (error) {
      setLoadError(/could not find the function/i.test(error.message)
        ? "The medic page isn't set up in the database yet (onsite-medical.sql)." : error.message);
      setProgs([]);
      return;
    }
    const list = (data ?? []) as Prog[];
    setProgs(list);
    let last = "";
    try { last = localStorage.getItem(LAST_KEY) ?? ""; } catch { /* private mode */ }
    const wanted = keep || new URLSearchParams(window.location.search).get("programme") || last;
    setProgrammeId((list.find((p) => p.id === wanted) ?? list[0])?.id ?? "");
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (auth === "in") void loadProgs(); }, [auth]);

  useEffect(() => {
    if (!programmeId) return;
    try { localStorage.setItem(LAST_KEY, programmeId); } catch { /* fine */ }
    closeRecord();
    setFound(null); setQuery(""); setRecent(null); setTab("find");
    setShowDelete(false); setConfirmText("");
  }, [programmeId]);

  /* ---------- privacy: clear the screen after 5 idle minutes ---------- */
  const showing = !!person || !!found?.length || !!recent?.length;
  useEffect(() => {
    if (!showing) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const check = () => { if (Date.now() - last >= IDLE_MS) idle(); };
    const events = ["pointerdown", "keydown", "wheel", "scroll"] as const;
    events.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    document.addEventListener("visibilitychange", check);   // phone unlocked after a while
    const timer = window.setInterval(check, 10_000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, bump));
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
    function idle() {
      closeRecord();
      setFound(null); setQuery(""); setRecent(null); setTab("find");
      setNote({ kind: "ok", text: "Closed after 5 minutes without activity, to keep records private." });
    }
  }, [showing]);

  /* ---------- finding someone ---------- */
  async function find(term = query) {
    const q = term.trim();
    if (!programmeId || q.length < 2) return;
    setSearching(true); setNote(null);
    const { data, error } = await supabase.rpc("medic_find", { p_programme_id: programmeId, p_q: q });
    setSearching(false);
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    const list = (data ?? []) as Found[];
    setFound(list);
    if (list.length === 1 && CODE_RE.test(q)) void open(list[0].id);   // a scan or code goes straight in
  }

  async function open(registrationId: string) {
    setOpening(true); setNote(null);
    const { data, error } = await supabase.rpc("medic_record", {
      p_programme_id: programmeId, p_registration_id: registrationId,
    });
    setOpening(false);
    if (error || !data) { setNote({ kind: "error", text: error?.message ?? "Couldn't open the record." }); return; }
    setPerson(data.person as Person);
    setFields(Array.isArray(data.fields) ? (data.fields as Field[]) : []);
    setEntries((data.entries ?? []) as Entry[]);
    setForm(EMPTY_FORM);
    setVoiding(null);
    window.scrollTo({ top: 0 });
  }

  function closeRecord() {
    setPerson(null); setEntries([]); setFields([]); setForm(EMPTY_FORM); setVoiding(null);
  }
  function backToList() {
    closeRecord();
    setNote(null);
    if (tab === "recent") void loadRecent();
  }

  /* ---------- adding to a record ---------- */
  async function save() {
    if (!person || !prog?.can_write) return;
    const visit = form.kind === "visit";
    const temp = visit && form.temp.trim() ? Number(form.temp.trim().replace(",", ".")) : null;
    const pulse = visit && form.pulse.trim() ? Number(form.pulse.trim()) : null;
    if (temp !== null && Number.isNaN(temp)) { setNote({ kind: "error", text: "Temperature must be a number, e.g. 37.5" }); return; }
    if (pulse !== null && !Number.isInteger(pulse)) { setNote({ kind: "error", text: "Pulse must be a whole number, e.g. 88" }); return; }
    setSaving(true); setNote(null);
    const { error } = await supabase.rpc("medic_add_entry", {
      p_programme_id: programmeId,
      p_registration_id: person.id,
      p_kind: form.kind,
      p_complaint: form.complaint,
      p_treatment: visit ? form.treatment || null : null,
      p_outcome: visit ? form.outcome || null : null,
      p_temperature: temp,
      p_blood_pressure: visit ? form.bp || null : null,
      p_pulse: pulse,
      p_notes: form.notes || null,
      p_follow_up: visit && form.follow,
    });
    setSaving(false);
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    await open(person.id);
    setNote({ kind: "ok", text: visit ? "Visit saved." : "Allergy / condition saved." });
    void loadProgs(programmeId);   // the record count
  }

  async function markError() {
    if (!voiding || !voiding.reason.trim()) return;
    const { error } = await supabase.rpc("medic_void_entry", { p_entry_id: voiding.id, p_reason: voiding.reason });
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    if (person) await open(person.id);
    setNote({ kind: "ok", text: "Marked as entered in error." });
  }

  /* ---------- recent entries & follow-ups ---------- */
  async function loadRecent(only = followOnly) {
    const { data, error } = await supabase.rpc("medic_recent", {
      p_programme_id: programmeId, p_follow_up_only: only,
    });
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    setRecent((data ?? []) as Recent[]);
  }
  useEffect(() => {
    if (tab === "recent" && programmeId) void loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, followOnly, programmeId]);

  /* ---------- super admin: delete after the event ---------- */
  async function deleteAll() {
    if (!prog) return;
    setDeleting(true);
    const { data, error } = await supabase.rpc("medical_delete_programme", {
      p_programme_id: prog.id, p_confirm: confirmText.trim(),
    });
    setDeleting(false);
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    const n = Number(data) || 0;
    closeRecord(); setFound(null); setRecent(null); setTab("find");
    setShowDelete(false); setConfirmText("");
    setNote({ kind: "ok", text: `Deleted ${n} medical record${n === 1 ? "" : "s"} for ${prog.title}.` });
    void loadProgs(prog.id);
  }

  /* ---------- view ---------- */
  const shell = (body: ReactNode) => (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* the site-wide lucky-draw pop-up would cover the page on a phone */}
      <style>{".ld-widget{display:none !important}"}</style>
      <header className="bg-[#800000] text-white">
        <div className="max-w-2xl mx-auto px-4 py-3 flex justify-between items-center gap-3">
          <span className="font-bold tracking-wide">DYO medics</span>
          {prog && <span className="text-sm opacity-90 truncate">{prog.title}</span>}
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-4">
        {note && (
          <p role="status" className={`text-sm mb-3 px-3 py-2 rounded ${note.kind === "ok" ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}>
            {note.text}
          </p>
        )}
        {body}
      </main>
    </div>
  );

  if (auth === "checking") return shell(<p className="text-gray-500">Loading…</p>);

  if (auth === "out") {
    const next = encodeURIComponent(`/medic${window.location.search}`);
    return shell(
      <div className="bg-white border rounded-lg p-5">
        <p className="text-lg font-semibold mb-2">Sign in to open medical records</p>
        <p className="text-gray-600 text-sm mb-4">Use the account the programme admin added as a medic.</p>
        <a href={`/login?next=${next}`} className="inline-block bg-[#800000] text-white font-semibold px-5 py-3 rounded">
          Sign in
        </a>
      </div>,
    );
  }

  if (progs === null) return shell(<p className="text-gray-500">Loading…</p>);

  if (!progs.length) {
    return shell(
      <div className="bg-white border rounded-lg p-5 text-sm text-gray-700">
        {loadError || <>You're not a medic for any programme. Ask the programme's admin to add your email
          under <b>Medics</b> in the programme's Check-in &amp; scanning section, then open this page again.</>}
      </div>,
    );
  }

  const ended = !!prog?.ends_at && new Date(prog.ends_at).getTime() < Date.now();
  const records = Number(prog?.records ?? 0);
  const alerts = entries.filter((e) => e.kind === "alert" && !e.voided_at);
  const placed = person?.assignments
    ? fields.filter((f) => person.assignments?.[f.key]).map((f) => `${f.label}: ${person.assignments?.[f.key]}`)
    : [];
  const name = person?.full_name || "Name not given";

  return shell(
    <>
      {progs.length > 1 && (
        <select className="w-full border rounded px-3 py-2 mb-3 bg-white" value={programmeId}
                aria-label="Programme" onChange={(e) => setProgrammeId(e.target.value)}>
          {progs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      )}

      {prog && !prog.can_write && (
        <p className="text-sm bg-blue-50 text-blue-900 rounded px-3 py-2 mb-3">
          Read only: you can read records here but not add to them. Only the programme's medics can add.
        </p>
      )}

      {/* super admin: delete once the records are no longer needed */}
      {prog?.is_super_admin && records > 0 && (
        <div className={`rounded px-3 py-2 mb-3 text-sm ${ended ? "bg-amber-50 text-amber-900 border border-amber-200" : "bg-gray-100 text-gray-700"}`}>
          {ended
            ? <>This programme has ended and still has {records} medical record{records === 1 ? "" : "s"}. Delete them once they're no longer needed. </>
            : <>{records} medical record{records === 1 ? "" : "s"} for this programme. </>}
          {!showDelete
            ? <button className="underline font-semibold" onClick={() => setShowDelete(true)}>Delete all medical records…</button>
            : (
              <span className="flex flex-wrap gap-2 items-center mt-2">
                <span>Type <b>DELETE</b> to remove all {records} for good:</span>
                <input className="border rounded px-2 py-1 w-28 bg-white" value={confirmText} autoComplete="off"
                       onChange={(e) => setConfirmText(e.target.value)} aria-label="Type DELETE to confirm" />
                <button className="bg-red-700 text-white px-3 py-1 rounded disabled:opacity-50"
                        disabled={confirmText.trim() !== "DELETE" || deleting} onClick={() => void deleteAll()}>
                  {deleting ? "Deleting…" : "Delete"}
                </button>
                <button className="underline" onClick={() => { setShowDelete(false); setConfirmText(""); }}>Cancel</button>
              </span>
            )}
        </div>
      )}

      {!person && (
        <div className="flex gap-2 mb-4">
          {(["find", "recent"] as const).map((t) => (
            <button key={t} onClick={() => { setTab(t); setNote(null); }}
                    className={`px-4 py-2 rounded text-sm ${tab === t ? "bg-[#800000] text-white" : "bg-white border"}`}>
              {t === "find" ? "Find a person" : "Recent"}
            </button>
          ))}
        </div>
      )}

      {/* ---------------- find ---------------- */}
      {!person && tab === "find" && (
        <>
          <form className="grid gap-2 mb-3" onSubmit={(e) => { e.preventDefault(); void find(); }}>
            <input className="border rounded px-3 py-3 w-full bg-white"
                   placeholder="Name, or the code under the QR" autoComplete="off"
                   value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="flex gap-2">
              <button type="submit" disabled={searching} className="flex-1 bg-[#800000] text-white px-4 py-3 rounded">
                {searching ? "Searching…" : "Search"}
              </button>
              <button type="button" onClick={() => setScanning(true)} className="flex-1 bg-gray-800 text-white px-4 py-3 rounded">
                Scan tag
              </button>
            </div>
          </form>
          {opening && <p className="text-sm text-gray-500 mb-2">Opening record…</p>}
          {found && found.length === 0 && (
            <p className="text-gray-500 text-center py-6">No one by that name or code in this programme.</p>
          )}
          {found && found.length > 0 && (
            <div className="grid gap-2">
              {found.map((f) => (
                <button key={f.id} onClick={() => void open(f.id)}
                        className="border rounded-lg p-3 flex items-center gap-3 text-left bg-white hover:bg-gray-50">
                  {f.photo_url
                    ? <img src={f.photo_url} alt="" className="w-12 h-12 rounded object-cover" />
                    : <div className="w-12 h-12 rounded bg-gray-200" />}
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold truncate">{f.full_name || "Name not given"}</span>
                    <span className="block text-sm text-gray-500 truncate">
                      {[f.church, f.archdeaconry].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {Number(f.alerts) > 0 && <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">⚠ {f.alerts}</span>}
                  {Number(f.visits) > 0 && (
                    <span className="text-xs bg-gray-200 px-2 py-1 rounded">{f.visits} visit{Number(f.visits) === 1 ? "" : "s"}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---------------- recent ---------------- */}
      {!person && tab === "recent" && (
        <>
          <label className="flex items-center gap-2 text-sm mb-3">
            <input type="checkbox" checked={followOnly} onChange={(e) => setFollowOnly(e.target.checked)} />
            Needs follow-up only
          </label>
          {recent === null && <p className="text-gray-500">Loading…</p>}
          {recent && recent.length === 0 && (
            <p className="text-gray-500 text-center py-6">{followOnly ? "No one needs follow-up." : "Nothing recorded yet."}</p>
          )}
          <div className="grid gap-2">
            {recent?.map((r) => (
              <button key={r.entry_id} onClick={() => void open(r.registration_id)}
                      className="border rounded-lg p-3 text-left bg-white hover:bg-gray-50">
                <span className="flex justify-between gap-2">
                  <b className="truncate">{r.full_name || "Name not given"}</b>
                  <span className="text-xs text-gray-500 whitespace-nowrap">{when(r.created_at)}</span>
                </span>
                <span className="block text-sm text-gray-700 truncate">
                  {r.kind === "alert" ? "⚠ " : ""}{r.complaint}
                </span>
                <span className="flex flex-wrap gap-2 mt-1 text-xs">
                  {r.outcome && <span className="bg-gray-100 px-2 py-0.5 rounded">{outcomeLabel(r.outcome)}</span>}
                  {r.follow_up && <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded">Follow up</span>}
                  {r.created_by_name && <span className="text-gray-500">by {r.created_by_name}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* ---------------- one person's record ---------------- */}
      {person && (
        <div className="grid gap-4">
          <div className="bg-white border rounded-lg p-4 flex gap-3 items-start">
            {person.photo_url
              ? <img src={person.photo_url} alt="" className="w-20 h-20 rounded object-cover" />
              : (
                <div className="w-20 h-20 rounded bg-gray-200 flex items-center justify-center text-2xl font-bold text-gray-500">
                  {name.charAt(0)}
                </div>
              )}
            <div className="flex-1 min-w-0">
              <p className="text-lg font-bold leading-tight">{name}</p>
              <p className="text-sm text-gray-700">
                {[person.age !== null ? `${person.age} yrs` : null, person.gender].filter(Boolean).join(" · ") || "Age not given"}
              </p>
              <p className="text-sm text-gray-600">{[person.church, person.archdeaconry].filter(Boolean).join(" · ")}</p>
              {placed.length > 0 && <p className="text-sm text-gray-600">{placed.join(" · ")}</p>}
              {person.phone && (
                <a className="text-sm underline" href={`tel:${person.phone.replace(/[^\d+]/g, "")}`}>{person.phone}</a>
              )}
              {!person.checked_in && <p className="text-xs text-amber-800 mt-1">Not checked in at the desk.</p>}
            </div>
            <button onClick={backToList} className="text-sm underline">Close</button>
          </div>

          {alerts.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-red-800 mb-1">Allergies &amp; conditions</p>
              <ul className="text-sm text-red-900 grid gap-1">
                {alerts.map((a) => (
                  <li key={a.id}>⚠ <b>{a.complaint}</b>{a.notes ? ` — ${a.notes}` : ""}</li>
                ))}
              </ul>
            </div>
          )}

          {prog?.can_write && (
            <div className="bg-white border rounded-lg p-4">
              <div className="flex gap-2 mb-3">
                {(["visit", "alert"] as const).map((k) => (
                  <button key={k} onClick={() => setForm((f) => ({ ...f, kind: k }))}
                          className={`px-3 py-1.5 rounded text-sm ${form.kind === k ? "bg-[#800000] text-white" : "bg-gray-100"}`}>
                    {k === "visit" ? "New visit" : "Allergy / condition"}
                  </button>
                ))}
              </div>

              {form.kind === "visit" ? (
                <div className="grid gap-3">
                  <label className="text-sm">What they came with
                    <textarea rows={2} className="border rounded px-3 py-2 w-full mt-1"
                              placeholder="e.g. Headache and fever since morning"
                              value={form.complaint} onChange={(e) => setForm((f) => ({ ...f, complaint: e.target.value }))} />
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="text-sm">Temp °C
                      <input inputMode="decimal" className="border rounded px-2 py-2 w-full mt-1" placeholder="37.5"
                             value={form.temp} onChange={(e) => setForm((f) => ({ ...f, temp: e.target.value }))} />
                    </label>
                    <label className="text-sm">BP
                      <input className="border rounded px-2 py-2 w-full mt-1" placeholder="120/80"
                             value={form.bp} onChange={(e) => setForm((f) => ({ ...f, bp: e.target.value }))} />
                    </label>
                    <label className="text-sm">Pulse
                      <input inputMode="numeric" className="border rounded px-2 py-2 w-full mt-1" placeholder="88"
                             value={form.pulse} onChange={(e) => setForm((f) => ({ ...f, pulse: e.target.value }))} />
                    </label>
                  </div>
                  <label className="text-sm">Treatment &amp; medication given
                    <textarea rows={2} className="border rounded px-3 py-2 w-full mt-1"
                              placeholder="e.g. Paracetamol 1g by mouth, rest"
                              value={form.treatment} onChange={(e) => setForm((f) => ({ ...f, treatment: e.target.value }))} />
                  </label>
                  <label className="text-sm">Outcome
                    <select className="border rounded px-3 py-2 w-full mt-1 bg-white" value={form.outcome}
                            onChange={(e) => setForm((f) => ({ ...f, outcome: e.target.value }))}>
                      <option value="">Choose…</option>
                      {OUTCOMES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">Notes
                    <textarea rows={2} className="border rounded px-3 py-2 w-full mt-1"
                              value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
                  </label>
                  <label className="text-sm flex items-center gap-2">
                    <input type="checkbox" checked={form.follow}
                           onChange={(e) => setForm((f) => ({ ...f, follow: e.target.checked }))} />
                    Needs follow-up
                  </label>
                </div>
              ) : (
                <div className="grid gap-3">
                  <label className="text-sm">Allergy or condition
                    <input className="border rounded px-3 py-2 w-full mt-1"
                           placeholder="e.g. Allergic to penicillin · Asthma, has an inhaler"
                           value={form.complaint} onChange={(e) => setForm((f) => ({ ...f, complaint: e.target.value }))} />
                  </label>
                  <label className="text-sm">Notes
                    <textarea rows={2} className="border rounded px-3 py-2 w-full mt-1"
                              value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
                  </label>
                  <p className="text-xs text-gray-500">This shows at the top of their record every time it's opened.</p>
                </div>
              )}

              <button onClick={() => void save()} disabled={saving || !form.complaint.trim()}
                      className="mt-4 bg-[#800000] text-white px-5 py-2.5 rounded font-semibold disabled:opacity-50">
                {saving ? "Saving…" : form.kind === "visit" ? "Save visit" : "Save allergy / condition"}
              </button>
            </div>
          )}

          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">
              History {entries.length === 0 && "— nothing recorded yet"}
            </p>
            <div className="grid gap-2">
              {entries.map((e) => (
                <div key={e.id} className={`bg-white border rounded-lg p-3 text-sm ${e.voided_at ? "opacity-60" : ""}`}>
                  <div className="flex justify-between gap-2 mb-1">
                    <span className={`text-xs px-2 py-0.5 rounded ${e.kind === "alert" ? "bg-red-100 text-red-800" : "bg-gray-100"}`}>
                      {e.kind === "alert" ? "Allergy / condition" : "Visit"}
                    </span>
                    <span className="text-xs text-gray-500 text-right">
                      {when(e.created_at)}{e.created_by_name ? ` · ${e.created_by_name}` : ""}
                    </span>
                  </div>
                  <div className={e.voided_at ? "line-through" : ""}>
                    <p className="font-semibold">{e.complaint}</p>
                    {(e.temperature !== null || e.blood_pressure || e.pulse !== null) && (
                      <p className="text-gray-700">
                        {[e.temperature !== null ? `Temp ${e.temperature}°C` : null,
                          e.blood_pressure ? `BP ${e.blood_pressure}` : null,
                          e.pulse !== null ? `Pulse ${e.pulse}` : null].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    {e.treatment && <p><span className="text-gray-500">Treatment:</span> {e.treatment}</p>}
                    {e.outcome && <p><span className="text-gray-500">Outcome:</span> {outcomeLabel(e.outcome)}</p>}
                    {e.notes && <p className="text-gray-700">{e.notes}</p>}
                  </div>
                  {e.follow_up && !e.voided_at && (
                    <span className="inline-block mt-1 text-xs bg-amber-100 text-amber-900 px-2 py-0.5 rounded">Follow up</span>
                  )}
                  {e.voided_at ? (
                    <p className="text-xs text-red-800 mt-1">
                      Entered in error: {e.void_reason}{e.voided_by_name ? ` (${e.voided_by_name}, ${when(e.voided_at)})` : ""}
                    </p>
                  ) : e.mine && prog?.can_write && (
                    voiding?.id === e.id ? (
                      <div className="flex flex-wrap gap-2 items-center mt-2">
                        <input className="border rounded px-2 py-1 flex-1 min-w-[180px]" autoFocus
                               placeholder="Why? e.g. wrong person, wrong dose written"
                               value={voiding.reason} onChange={(ev) => setVoiding({ id: e.id, reason: ev.target.value })} />
                        <button className="bg-red-700 text-white text-xs px-3 py-1.5 rounded disabled:opacity-50"
                                disabled={!voiding.reason.trim()} onClick={() => void markError()}>
                          Mark as error
                        </button>
                        <button className="text-xs underline" onClick={() => setVoiding(null)}>Cancel</button>
                      </div>
                    ) : (
                      <button className="block text-xs underline text-gray-600 mt-2" onClick={() => setVoiding({ id: e.id, reason: "" })}>
                        Entered in error?
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {scanning && (
        <QrScanner
          onClose={() => setScanning(false)}
          onResult={(text) => { setScanning(false); setQuery(text); void find(text); }}
        />
      )}
    </>,
  );
}