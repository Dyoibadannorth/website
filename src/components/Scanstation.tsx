import { useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabaseClient";
import QrScanner from "./Qrscanner";

/**
 * The scanner for meals, sessions, pickups… at /scan.
 *
 * Built for a phone at the front of a queue: choose what you're scanning for,
 * tap Start, and point the camera at each person's tag (or the QR on their
 * phone). Green = go ahead, red = already scanned, amber = not checked in.
 * Each person can only be scanned once per meal/session.
 *
 * Volunteers added as scanners for a programme sign in with their normal
 * account and see only this page's programmes. Admins who run a programme
 * can scan too. Open it as /scan?programme=<id> to pre-select a programme.
 */

interface ScanPoint { key: string; label: string; needs_checkin: boolean }
interface Prog {
  id: string; title: string; starts_at: string | null; scan_points: ScanPoint[];
  assignment_fields: { key: string; label: string }[] | null;
}
interface Person {
  id: string; full_name: string; archdeaconry: string | null; photo_url: string | null;
  payment_status?: string; checked_in?: boolean; assignments?: Record<string, string> | null;
}
type Status = "ok" | "already" | "not_checked_in" | "not_found" | "ambiguous" | "error";
interface Result {
  status: Status; person: Person | null; scan_id: string | null;
  scanned_at: string | null; scanned_by: string | null; served: number | null;
  message?: string; pointLabel: string;
}
interface Stats { registered: number; checked_in: number; points: Record<string, number> }

const LAST_KEY = "dyo.scan.last";

const LOOKS: Record<Status, { bg: string; title: string; hint: (r: Result) => string }> = {
  ok:             { bg: "bg-green-600", title: "✓  OK",
                    hint: (r) => r.pointLabel },
  already:        { bg: "bg-red-700",   title: "✕  ALREADY SCANNED",
                    hint: (r) => `${r.pointLabel} · at ${time(r.scanned_at)}${r.scanned_by ? ` by ${r.scanned_by}` : ""}` },
  not_checked_in: { bg: "bg-amber-600", title: "NOT CHECKED IN",
                    hint: () => "Send them to the check-in desk first." },
  not_found:      { bg: "bg-gray-700",  title: "NOT FOUND",
                    hint: () => "This code isn't registered for this programme." },
  ambiguous:      { bg: "bg-gray-700",  title: "MORE THAN ONE MATCH",
                    hint: () => "Type their name instead." },
  error:          { bg: "bg-gray-700",  title: "COULDN'T SCAN",
                    hint: (r) => r.message ?? "Try again." },
};

function time(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit" }) : "";
}

/* ---------- sound + vibration (needs one tap first, which Start gives) ---------- */
type AudioCtor = typeof AudioContext;
let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    const Ctor: AudioCtor | undefined = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!audio && Ctor) audio = new Ctor();
    void audio?.resume();
  } catch { /* silent is fine */ }
}
function tone(freq: number, ms: number, delay = 0) {
  if (!audio) return;
  try {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.value = 0.18;
    o.connect(g);
    g.connect(audio.destination);
    const t = audio.currentTime + delay;
    o.start(t);
    o.stop(t + ms / 1000);
  } catch { /* ignore */ }
}
function feedback(status: Status) {
  if (status === "ok") { tone(880, 120); navigator.vibrate?.(60); }
  else if (status === "already") { tone(220, 380); navigator.vibrate?.([200, 80, 200]); }
  else { tone(440, 160); tone(440, 160, 0.22); navigator.vibrate?.([120, 60, 120]); }
}

export default function ScanStation() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const [progs, setProgs] = useState<Prog[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const [programmeId, setProgrammeId] = useState("");
  const [pointKey, setPointKey] = useState("");
  const prog = progs?.find((p) => p.id === programmeId) ?? null;
  const point = prog?.scan_points.find((p) => p.key === pointKey) ?? null;

  const [stats, setStats] = useState<Stats | null>(null);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [result, setResult] = useState<Result | null>(null);
  const [recent, setRecent] = useState<{ name: string; status: Status; at: number }[]>([]);
  const [note, setNote] = useState("");

  const [manual, setManual] = useState("");
  const [matches, setMatches] = useState<Person[] | null>(null);

  /* ---------- sign-in ---------- */
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setAuth(data.session ? "in" : "out"));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setAuth(session ? "in" : "out"));
    return () => data.subscription.unsubscribe();
  }, []);

  /* ---------- programmes I can scan for ---------- */
  useEffect(() => {
    if (auth !== "in") return;
    void (async () => {
      const { data, error } = await supabase.rpc("scan_programmes");
      if (error) {
        setLoadError(/could not find the function/i.test(error.message)
          ? "The scanner isn't set up in the database yet (onsite-checkin.sql)."
          : error.message);
        setProgs([]);
        return;
      }
      const list = (data ?? []) as Prog[];
      setProgs(list);

      let last: { p?: string; k?: string } = {};
      try { last = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}"); } catch { /* none */ }
      const wanted = new URLSearchParams(window.location.search).get("programme") ?? last.p;
      const chosen = list.find((p) => p.id === wanted) ?? list[0];
      if (chosen) {
        setProgrammeId(chosen.id);
        // only reuse the last scan point for the same programme; otherwise make them choose
        setPointKey(chosen.id === last.p && chosen.scan_points.some((x) => x.key === last.k) ? last.k! : "");
      }
    })();
  }, [auth]);

  useEffect(() => {
    if (!programmeId) return;
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ p: programmeId, k: pointKey })); } catch { /* fine */ }
  }, [programmeId, pointKey]);

  /* ---------- counts ---------- */
  async function loadStats(pid = programmeId) {
    if (!pid) return;
    const { data } = await supabase.rpc("scan_stats", { p_programme_id: pid });
    if (data) setStats(data as Stats);
  }
  useEffect(() => {
    if (!programmeId) return;
    void loadStats(programmeId);
    const t = window.setInterval(() => void loadStats(programmeId), 30_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programmeId]);

  /* ---------- scanning ---------- */
  async function record(args: { code?: string; registrationId?: string }) {
    if (!programmeId || !point || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    const { data, error } = await supabase.rpc("scan_record", {
      p_programme_id: programmeId,
      p_point_key: point.key,
      p_code: args.code ?? null,
      p_registration_id: args.registrationId ?? null,
    });
    busyRef.current = false;
    setBusy(false);

    const r: Result = error
      ? { status: "error", person: null, scan_id: null, scanned_at: null, scanned_by: null,
          served: null, message: error.message, pointLabel: point.label }
      : { ...(data as Omit<Result, "pointLabel">), pointLabel: point.label };
    setResult(r);
    feedback(r.status);
    setRecent((cur) => [{ name: r.person?.full_name ?? "—", status: r.status, at: Date.now() }, ...cur].slice(0, 6));
    if (r.served != null) {
      setStats((s) => s ? { ...s, points: { ...s.points, [point.key]: r.served as number } } : s);
    }
  }

  async function undo() {
    if (!result?.scan_id) return;
    const { error } = await supabase.rpc("scan_undo", { p_scan_id: result.scan_id });
    if (error) { setNote(error.message); return; }
    setResult(null);
    setRecent((cur) => cur.slice(1));
    setNote("Last scan undone.");
    void loadStats();
  }

  async function submitManual() {
    const q = manual.trim();
    if (q.length < 2 || !point) return;
    const term = q.replace(/^DYO:/i, "");
    if (/^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(term)) {
      setMatches(null);
      setManual("");
      await record({ code: q });
      return;
    }
    const { data, error } = await supabase.rpc("scan_lookup", { p_programme_id: programmeId, p_q: q });
    if (error) { setNote(error.message); return; }
    setMatches((data ?? []) as Person[]);
  }

  function start() {
    unlockAudio();
    setStarted(true);
  }

  /* ---------- view ---------- */
  const shell = (body: ReactNode) => (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-md mx-auto px-4 py-4">
        <p className="text-xs uppercase tracking-widest text-gray-400 mb-3">DYO scanner</p>
        {body}
      </div>
    </div>
  );

  if (auth === "checking") return shell(<p className="text-gray-300">Loading…</p>);

  if (auth === "out") {
    const next = encodeURIComponent(`/scan${window.location.search}`);
    return shell(
      <div className="bg-gray-900 rounded-lg p-5">
        <p className="text-lg font-semibold mb-2">Sign in to scan</p>
        <p className="text-gray-300 text-sm mb-4">Use the account the programme admin added as a scanner.</p>
        <a href={`/login?next=${next}`} className="inline-block bg-white text-gray-900 font-semibold px-5 py-3 rounded">
          Sign in
        </a>
      </div>,
    );
  }

  if (progs === null) return shell(<p className="text-gray-300">Loading…</p>);

  if (!progs.length) {
    return shell(
      <div className="bg-gray-900 rounded-lg p-5 text-sm text-gray-200">
        {loadError || (
          <>Nothing for you to scan yet. Ask the programme admin to add you as a scanner and to add
            scan points (meals, sessions…) to the programme.</>
        )}
      </div>,
    );
  }

  const served = point && stats ? stats.points[point.key] ?? 0 : null;
  const look = result ? LOOKS[result.status] : null;
  const shown = result?.person;
  // what they were assigned (hostel, unit…), in the programme's order
  const extras = shown?.assignments
    ? (prog?.assignment_fields?.length
        ? prog.assignment_fields.map((f) => shown.assignments?.[f.key])
        : Object.values(shown.assignments)
      ).filter(Boolean).join(" · ")
    : "";

  return shell(
    <>
      {/* what are we scanning for */}
      {progs.length > 1 && (
        <select className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 mb-2"
                value={programmeId}
                onChange={(e) => { setProgrammeId(e.target.value); setPointKey(""); setResult(null); setStats(null); }}>
          {progs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      )}
      {progs.length === 1 && <p className="font-semibold mb-2">{prog?.title}</p>}

      <select className={`w-full rounded px-3 py-3 text-lg font-semibold mb-3 ${
                point ? "bg-gray-900 border border-gray-700" : "bg-amber-500 text-gray-950"}`}
              value={pointKey}
              onChange={(e) => { setPointKey(e.target.value); setResult(null); setMatches(null); }}>
        <option value="">Choose what you're scanning for…</option>
        {prog?.scan_points.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>

      {point && stats && (
        <p className="text-sm text-gray-300 mb-3">
          <b className="text-white text-base">{served}</b> scanned for {point.label}
          {" · "}{stats.checked_in} checked in{" · "}{stats.registered} registered
        </p>
      )}

      {/* camera */}
      {!started ? (
        <button onClick={start} disabled={!point}
                className={`w-full rounded-lg py-6 text-xl font-bold mb-3 ${
                  point ? "bg-white text-gray-950" : "bg-gray-800 text-gray-500"}`}>
          {point ? "Start scanning" : "Choose a meal or session first"}
        </button>
      ) : (
        <div className="mb-3">
          <QrScanner inline continuous paused={busy || !point}
                     onResult={(text) => void record({ code: text })} />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>{busy ? "Checking…" : point ? "Point the camera at the QR code" : "Choose a meal or session"}</span>
            <button className="underline" onClick={() => setStarted(false)}>Stop camera</button>
          </div>
        </div>
      )}

      {/* result */}
      {result && look && (
        <div className={`${look.bg} rounded-lg p-4 mb-3`}>
          <p className="text-2xl font-extrabold tracking-wide">{look.title}</p>
          <p className="text-sm opacity-90 mb-2">{look.hint(result)}</p>
          {shown && (
            <div className="flex gap-3 items-center bg-black/20 rounded p-2">
              {shown.photo_url
                ? <img src={shown.photo_url} alt="" className="w-20 h-20 rounded object-cover bg-black/30" />
                : <div className="w-20 h-20 rounded bg-black/30 flex items-center justify-center text-3xl font-bold">
                    {shown.full_name?.charAt(0)}
                  </div>}
              <div className="min-w-0">
                <p className="text-lg font-bold leading-tight">{shown.full_name}</p>
                <p className="text-sm opacity-90">{shown.archdeaconry}</p>
                {extras && <p className="text-sm opacity-90">{extras}</p>}
                {shown.payment_status === "pending" &&
                  <span className="inline-block mt-1 text-xs bg-white text-red-800 font-semibold px-2 py-0.5 rounded">Not paid</span>}
              </div>
            </div>
          )}
          {result.status === "ok" && result.scan_id && (
            <button onClick={undo} className="mt-3 text-sm underline">Undo this scan</button>
          )}
        </div>
      )}
      {note && <p className="text-sm text-gray-300 mb-3">{note}</p>}

      {/* typed fallback */}
      <form className="flex gap-2 mb-2" onSubmit={(e) => { e.preventDefault(); void submitManual(); }}>
        <input className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2"
               placeholder="Code under the QR, or a name"
               value={manual} onChange={(e) => setManual(e.target.value)} disabled={!point} />
        <button type="submit" disabled={!point || busy}
                className="bg-gray-700 px-4 py-2 rounded font-semibold">Go</button>
      </form>
      {matches && (
        <div className="bg-gray-900 rounded mb-3 divide-y divide-gray-800">
          {matches.length === 0 && <p className="p-3 text-sm text-gray-300">No one by that name in this programme.</p>}
          {matches.map((m) => (
            <button key={m.id} className="w-full text-left p-3 flex gap-3 items-center"
                    onClick={() => { setMatches(null); setManual(""); void record({ registrationId: m.id }); }}>
              {m.photo_url
                ? <img src={m.photo_url} alt="" className="w-10 h-10 rounded object-cover" />
                : <div className="w-10 h-10 rounded bg-gray-800" />}
              <span className="flex-1 min-w-0">
                <span className="block font-semibold truncate">{m.full_name}</span>
                <span className="block text-xs text-gray-400">
                  {m.archdeaconry}{m.checked_in ? "" : " · not checked in"}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* recent */}
      {recent.length > 0 && (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">Recent</p>
          <ul className="text-sm divide-y divide-gray-800">
            {recent.map((r) => (
              <li key={r.at} className="flex justify-between py-1">
                <span className="truncate">{r.name}</span>
                <span className={r.status === "ok" ? "text-green-400" : r.status === "already" ? "text-red-400" : "text-amber-300"}>
                  {r.status === "ok" ? "OK" : r.status === "already" ? "Already" : r.status === "not_checked_in" ? "Not checked in" : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>,
  );
}