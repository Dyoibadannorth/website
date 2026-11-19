import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { uploadPublicFile } from "../lib/Storage";
import { MAX_TAG_ROWS, buildTagHtml } from "../lib/Tagprint";

/**
 * "Check-in & scanning" — sits inside the programme editor (and the desk).
 *
 *   • Assign at check-in: Hostel, Bible study class, Unit, or anything else,
 *     each with its choices and whether it prints on the tag.
 *   • Scan points: meals, sessions, pickups… (each person once per point),
 *     with a one-click "meals for every day".
 *   • Scanners: volunteers added by email who can use the scanner page for
 *     this programme and nothing else.
 *   • Tag design: an optional image that prints behind each tag, with a
 *     live preview of a sample tag.
 *   • Medics: added by email; they keep medical records on the medic page.
 *     Admins here can add or remove medics but can't read the records.
 *
 * Saves itself as you go, so it doesn't depend on the editor's own Save.
 *
 *   <ProgrammeCheckinSetup programmeId={editing} />
 */

export interface AssignmentField { key: string; label: string; options: string[]; on_tag: boolean }
export interface ScanPoint { key: string; label: string; needs_checkin: boolean }
interface Scanner { user_id: string; full_name: string | null; email: string | null }
type Medic = Scanner;

type FieldDraft = AssignmentField & { optionsText: string };

const PRESETS = ["Hostel", "Bible study class", "Unit", "Team", "Room", "Bus"];
const MEALS = ["Breakfast", "Lunch", "Dinner"];
const MAX_ON_TAG = 5;

// Keys come from the name ("Bible study class" → bible_study_class), so a
// removed-and-re-added item finds its earlier values again. A key never
// changes when the item is renamed.
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
function makeKey(label: string, taken: Set<string>) {
  const base = slug(label) || "item";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  taken.add(key);
  return key;
}
const parseOptions = (text: string) =>
  Array.from(new Set(text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)));

function dayCount(start?: string | null, end?: string | null) {
  if (!start) return 1;
  const a = new Date(start);
  const b = end ? new Date(end) : a;
  const days = Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
     Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000) + 1;
  return Math.min(14, Math.max(1, Number.isFinite(days) ? days : 1));
}

export default function ProgrammeCheckinSetup({ programmeId, onSaved }: {
  programmeId: string | null;
  onSaved?: () => void;
}) {
  if (!programmeId) {
    return (
      <div className="border rounded p-4 mt-6 bg-gray-50 text-sm text-gray-600">
        <p className="font-medium text-gray-800 mb-1">Check-in &amp; scanning</p>
        Create the programme first. Then click <b>Edit</b> on it to set up hostels,
        classes, units, meals and scanners.
      </div>
    );
  }
  return <Setup key={programmeId} programmeId={programmeId} onSaved={onSaved} />;
}

function Setup({ programmeId, onSaved }: { programmeId: string; onSaved?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [dates, setDates] = useState<{ starts_at?: string | null; ends_at?: string | null }>({});

  const [fields, setFields] = useState<FieldDraft[]>([]);
  const [points, setPoints] = useState<ScanPoint[]>([]);
  const [scanners, setScanners] = useState<Scanner[]>([]);

  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");

  const [customField, setCustomField] = useState("");
  const [customPoint, setCustomPoint] = useState("");
  const [meals, setMeals] = useState<string[]>(MEALS);
  const [days, setDays] = useState(1);

  const [scannerEmail, setScannerEmail] = useState("");
  const [scannerBusy, setScannerBusy] = useState(false);
  const [scannerMsg, setScannerMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const [title, setTitle] = useState("");
  const [design, setDesign] = useState<string | null>(null);
  const [designBusy, setDesignBusy] = useState(false);
  const [designMsg, setDesignMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [sample, setSample] = useState("");

  /* ---------- load ---------- */
  useEffect(() => {
    let live = true;
    (async () => {
      const { data, error } = await supabase.rpc("checkin_setup_get", { p_programme_id: programmeId });
      if (!live) return;
      if (error || !data) {
        setLoadError(/could not find the function/i.test(error?.message ?? "")
          ? "Run onsite-checkin.sql in Supabase first."
          : error?.message ?? "Couldn't load the check-in setup.");
        setLoading(false);
        return;
      }
      setDates({ starts_at: data.starts_at, ends_at: data.ends_at });
      setTitle(data.title ?? "");
      setDesign(data.tag_template_url ?? null);
      setDays(dayCount(data.starts_at, data.ends_at));
      setFields(((data.assignment_fields ?? []) as AssignmentField[]).map((f) => ({
        key: f.key, label: f.label, options: f.options ?? [], on_tag: f.on_tag !== false,
        optionsText: (f.options ?? []).join(", "),
      })));
      setPoints(((data.scan_points ?? []) as ScanPoint[]).map((p) => ({
        key: p.key, label: p.label, needs_checkin: p.needs_checkin !== false,
      })));
      setScanners((data.scanners ?? []) as Scanner[]);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [programmeId]);

  /* ---------- autosave ---------- */
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const latest = useRef<{ f: AssignmentField[]; p: ScanPoint[] } | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  async function flush() {
    timer.current = null;
    const payload = latest.current;
    if (!payload) return;
    latest.current = null;
    const mine = ++seq.current;
    const { error } = await supabase.rpc("checkin_setup_save", {
      p_programme_id: programmeId,
      p_assignment_fields: payload.f,
      p_scan_points: payload.p,
    });
    if (!mounted.current || mine !== seq.current) return;
    if (error) { setSaveState("error"); setSaveError(error.message); }
    else { setSaveState("saved"); setSaveError(""); onSavedRef.current?.(); }
  }

  useEffect(() => {
    if (!dirty.current) return;
    // only named items are saved; a row you've just added waits for its name
    latest.current = {
      f: fields.filter((x) => x.label.trim()).map((x) => ({
        key: x.key, label: x.label.trim(), options: parseOptions(x.optionsText), on_tag: x.on_tag,
      })),
      p: points.filter((x) => x.label.trim()).map((x) => ({
        key: x.key, label: x.label.trim(), needs_checkin: x.needs_checkin,
      })),
    };
    setSaveState("saving");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, points]);

  // leaving the editor with a change still waiting: save it now
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) { window.clearTimeout(timer.current); void flush(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeFields = (fn: (f: FieldDraft[]) => FieldDraft[]) => { dirty.current = true; setFields(fn); };
  const changePoints = (fn: (p: ScanPoint[]) => ScanPoint[]) => { dirty.current = true; setPoints(fn); };

  /* ---------- assignment fields ---------- */
  const hasField = (label: string) =>
    fields.some((f) => f.label.trim().toLowerCase() === label.trim().toLowerCase());

  function addField(label: string) {
    const name = label.trim();
    if (!name || hasField(name)) return;
    changeFields((f) => [...f, {
      key: makeKey(name, new Set(f.map((x) => x.key))), label: name, options: [], optionsText: "",
      on_tag: f.filter((x) => x.on_tag).length < MAX_ON_TAG,
    }]);
  }
  const updateField = (i: number, patch: Partial<FieldDraft>) =>
    changeFields((f) => f.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeField = (i: number) => {
    if (!confirm(`Remove "${fields[i].label || "this item"}"? Values already given at the desk are kept but won't show.`)) return;
    changeFields((f) => f.filter((_, idx) => idx !== i));
  };
  const moveField = (i: number, by: -1 | 1) =>
    changeFields((f) => {
      const j = i + by;
      if (j < 0 || j >= f.length) return f;
      const next = [...f];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  /* ---------- scan points ---------- */
  const hasPoint = (label: string) =>
    points.some((p) => p.label.trim().toLowerCase() === label.trim().toLowerCase());

  function addPoint(label: string) {
    const name = label.trim();
    if (!name || hasPoint(name)) return;
    changePoints((p) => [...p, { key: makeKey(name, new Set(p.map((x) => x.key))), label: name, needs_checkin: true }]);
  }
  function addMeals() {
    const labels: string[] = [];
    for (let d = 1; d <= days; d++) for (const m of MEALS) {
      if (meals.includes(m)) labels.push(days === 1 ? m : `Day ${d} ${m}`);
    }
    const fresh = labels.filter((l) => !hasPoint(l));
    if (!fresh.length) return;
    changePoints((p) => {
      const taken = new Set(p.map((x) => x.key));
      return [...p, ...fresh.map((l) => ({ key: makeKey(l, taken), label: l, needs_checkin: true }))];
    });
  }
  const updatePoint = (i: number, patch: Partial<ScanPoint>) =>
    changePoints((p) => p.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removePoint = (i: number) => {
    if (!confirm(`Remove "${points[i].label || "this scan point"}"? Scans already made are kept but won't show.`)) return;
    changePoints((p) => p.filter((_, idx) => idx !== i));
  };

  /* ---------- scanners ---------- */
  /* ---------- tag design ---------- */
  async function saveDesign(url: string | null) {
    const { error } = await supabase.rpc("checkin_set_tag_design", { p_programme_id: programmeId, p_url: url });
    if (error) {
      setDesignMsg({ kind: "error", text: /could not find the function/i.test(error.message)
        ? "Run onsite-checkin-tag-design.sql in Supabase first." : error.message });
      return;
    }
    setDesign(url);
    setDesignMsg({ kind: "ok", text: url ? "Design saved. Tags printed from now on use it." : "Design removed." });
    onSavedRef.current?.();
  }
  async function uploadDesign(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setDesignMsg({ kind: "error", text: "Choose an image (PNG or JPG)." });
      return;
    }
    setDesignBusy(true);
    setDesignMsg(null);
    try {
      const url = await uploadPublicFile("programme-media", file, `tags/${programmeId}`);
      await saveDesign(url);
    } catch (err) {
      setDesignMsg({ kind: "error", text: (err as Error).message });
    }
    setDesignBusy(false);
  }

  // a sample tag with this programme's fields and design, so you can see the result
  useEffect(() => {
    let live = true;
    const rows = fields.filter((f) => f.on_tag && f.label.trim()).slice(0, MAX_TAG_ROWS)
      .map((f) => ({ label: f.label.trim(), value: parseOptions(f.optionsText)[0] ?? "—" }));
    void buildTagHtml([{
      id: "0a1b2c3d-0000-4000-8000-000000000000", full_name: "Sample Name",
      church: "St. Peter's Anglican Church", archdeaconry: "Archdeaconry", photo_url: null, rows,
    }], { w: 62, h: 100 }, title, { style: "colour", design }).then((html) => { if (live) setSample(html); });
    return () => { live = false; };
  }, [fields, title, design]);

  async function reloadScanners() {
    const { data } = await supabase.rpc("checkin_setup_get", { p_programme_id: programmeId });
    if (mounted.current && data) setScanners((data.scanners ?? []) as Scanner[]);
  }
  async function addScanner() {
    const email = scannerEmail.trim();
    if (!email) return;
    setScannerBusy(true);
    setScannerMsg(null);
    const { error } = await supabase.rpc("scanner_add", { p_programme_id: programmeId, p_email: email });
    setScannerBusy(false);
    if (error) { setScannerMsg({ kind: "error", text: error.message }); return; }
    setScannerEmail("");
    setScannerMsg({ kind: "ok", text: `${email} can now scan for this programme.` });
    void reloadScanners();
  }
  async function removeScanner(s: Scanner) {
    if (!confirm(`Stop ${s.full_name || s.email} scanning for this programme?`)) return;
    const { error } = await supabase.rpc("scanner_remove", { p_programme_id: programmeId, p_user_id: s.user_id });
    if (error) { setScannerMsg({ kind: "error", text: error.message }); return; }
    void reloadScanners();
  }

  /* ---------- medics (they keep medical records; admins only manage the list) ---------- */
  const [medics, setMedics] = useState<Medic[]>([]);
  const [medicsOff, setMedicsOff] = useState("");
  const [medicEmail, setMedicEmail] = useState("");
  const [medicBusy, setMedicBusy] = useState(false);
  const [medicMsg, setMedicMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [medicRecords, setMedicRecords] = useState<{ count: number; ended: boolean } | null>(null);

  async function reloadMedics() {
    const { data, error } = await supabase.rpc("medic_list", { p_programme_id: programmeId });
    if (!mounted.current) return;
    if (error) {
      setMedicsOff(/could not find the function/i.test(error.message)
        ? "Run onsite-medical.sql in Supabase to turn on the medic page." : error.message);
      return;
    }
    setMedicsOff("");
    setMedics((data ?? []) as Medic[]);
  }
  // only the super admin gets a row here: how many records, and a reminder once the programme is over
  async function loadMedicRecords() {
    const { data } = await supabase.rpc("medic_programmes");
    const row = ((data ?? []) as { id: string; ends_at: string | null; records: number; is_super_admin: boolean }[])
      .find((p) => p.id === programmeId && p.is_super_admin);
    if (!mounted.current) return;
    setMedicRecords(row && Number(row.records) > 0
      ? { count: Number(row.records), ended: !!row.ends_at && new Date(row.ends_at).getTime() < Date.now() }
      : null);
  }
  useEffect(() => {
    void reloadMedics();
    void loadMedicRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programmeId]);

  async function addMedic() {
    const email = medicEmail.trim();
    if (!email) return;
    setMedicBusy(true);
    setMedicMsg(null);
    const { error } = await supabase.rpc("medic_add", { p_programme_id: programmeId, p_email: email });
    setMedicBusy(false);
    if (error) { setMedicMsg({ kind: "error", text: error.message }); return; }
    setMedicEmail("");
    setMedicMsg({ kind: "ok", text: `${email} is now a medic for this programme.` });
    void reloadMedics();
  }
  async function removeMedic(m: Medic) {
    if (!confirm(`Remove ${m.full_name || m.email} as a medic? They won't be able to open medical records for this programme any more.`)) return;
    const { error } = await supabase.rpc("medic_remove", { p_programme_id: programmeId, p_user_id: m.user_id });
    if (error) { setMedicMsg({ kind: "error", text: error.message }); return; }
    setMedicMsg(null);
    void reloadMedics();
  }

  /* ---------- view ---------- */
  if (loading) return <div className="border rounded p-4 mt-6 text-sm text-gray-500">Loading check-in setup…</div>;
  if (loadError) {
    return (
      <div className="border rounded p-4 mt-6 text-sm">
        <p className="font-medium mb-1">Check-in &amp; scanning</p>
        <p className="text-red-700">{loadError}</p>
      </div>
    );
  }

  const onTagCount = fields.filter((f) => f.on_tag && f.label.trim()).length;
  const scanUrl = `/scan?programme=${programmeId}`;
  const medicUrl = `/medic?programme=${programmeId}`;

  return (
    <div className="border rounded p-4 mt-6 bg-white">
      <div className="flex flex-wrap justify-between items-baseline gap-2 mb-1">
        <p className="font-semibold">Check-in &amp; scanning</p>
        <span className={`text-xs ${saveState === "error" ? "text-red-700" : "text-gray-500"}`}>
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved"
            : saveState === "error" ? `Not saved: ${saveError}` : ""}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Changes here save by themselves. Dates for the meal button come from the programme's start and end.
      </p>

      {/* ---- assign at check-in ---- */}
      <p className="font-medium text-sm">Assign at check-in</p>
      <p className="text-xs text-gray-500 mb-2">
        What the desk gives each person. Choices are optional; the desk can still type something else.
      </p>

      {fields.length === 0 && <p className="text-sm text-gray-500 mb-2">Nothing yet. Add one below.</p>}

      {fields.map((f, i) => (
        <div key={f.key} className="flex flex-wrap gap-2 mb-2 items-center border rounded p-2">
          <input className="border rounded px-2 py-1 w-44" placeholder="Name, e.g. Hostel"
                 value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} />
          <input className="border rounded px-2 py-1 flex-1 min-w-[200px]"
                 placeholder="Choices, separated by commas (optional)"
                 value={f.optionsText} onChange={(e) => updateField(i, { optionsText: e.target.value })} />
          <label className="text-xs flex items-center gap-1">
            <input type="checkbox" checked={f.on_tag}
                   onChange={(e) => updateField(i, { on_tag: e.target.checked })} />
            Print on tag
          </label>
          <span className="flex gap-1">
            <button type="button" className="text-xs px-1" title="Move up" onClick={() => moveField(i, -1)}>↑</button>
            <button type="button" className="text-xs px-1" title="Move down" onClick={() => moveField(i, 1)}>↓</button>
            <button type="button" className="text-red-600 text-xs" onClick={() => removeField(i)}>Remove</button>
          </span>
        </div>
      ))}
      {onTagCount > MAX_ON_TAG && (
        <p className="text-xs text-amber-800 mb-2">
          Only the first {MAX_ON_TAG} ticked for the tag will fit on it.
        </p>
      )}

      <div className="flex flex-wrap gap-2 items-center mb-6">
        {PRESETS.filter((p) => !hasField(p)).map((p) => (
          <button key={p} type="button" onClick={() => addField(p)}
                  className="text-xs border rounded-full px-3 py-1 hover:bg-gray-50">+ {p}</button>
        ))}
        <input className="border rounded px-2 py-1 text-sm" placeholder="Something else…"
               value={customField} onChange={(e) => setCustomField(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addField(customField); setCustomField(""); } }} />
        <button type="button" className="text-xs underline"
                onClick={() => { addField(customField); setCustomField(""); }}>Add</button>
      </div>

      {/* ---- tag design ---- */}
      <p className="font-medium text-sm">Tag design (optional)</p>
      <p className="text-xs text-gray-500 mb-2">
        An image the same shape as your tag (for 62 × 100 mm labels, about 620 × 1000 pixels).
        Put your logo and event name in the top fifth: the person's details print on a white
        panel over the rest. Without a design, tags use the DYO colours.
      </p>
      <div className="flex flex-wrap gap-4 items-start mb-6">
        {sample && (
          <iframe title="Sample tag" srcDoc={sample}
                  style={{ width: "62mm", height: "100mm", border: "1px solid #d6c7bd", background: "#fff", flex: "0 0 auto" }} />
        )}
        <div className="flex flex-col gap-2 text-sm">
          <label className={`border rounded px-3 py-1 text-xs w-fit ${designBusy ? "opacity-60" : "cursor-pointer hover:bg-gray-50"}`}>
            {designBusy ? "Uploading…" : design ? "Replace design" : "Upload design"}
            <input type="file" accept="image/*" className="hidden" disabled={designBusy}
                   onChange={(e) => { void uploadDesign(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {design && (
            <button type="button" className="text-red-600 text-xs w-fit" onClick={() => void saveDesign(null)}>
              Remove design
            </button>
          )}
          <span className="text-xs text-gray-500">The sample shows the first choice of each field.</span>
          {designMsg && (
            <span className={`text-xs ${designMsg.kind === "ok" ? "text-green-800" : "text-red-700"}`}>{designMsg.text}</span>
          )}
        </div>
      </div>

      {/* ---- scan points ---- */}
      <p className="font-medium text-sm">Scan points (meals, sessions…)</p>
      <p className="text-xs text-gray-500 mb-2">
        Each person can be scanned once at each point. Untick "Must be checked in" for things
        open to anyone registered.
      </p>

      {points.length === 0 && <p className="text-sm text-gray-500 mb-2">No scan points yet.</p>}

      <div className="grid gap-2 mb-3">
        {points.map((p, i) => (
          <div key={p.key} className="flex flex-wrap gap-2 items-center">
            <input className="border rounded px-2 py-1 flex-1 min-w-[180px]" placeholder="e.g. Day 1 Lunch"
                   value={p.label} onChange={(e) => updatePoint(i, { label: e.target.value })} />
            <label className="text-xs flex items-center gap-1">
              <input type="checkbox" checked={p.needs_checkin}
                     onChange={(e) => updatePoint(i, { needs_checkin: e.target.checked })} />
              Must be checked in
            </label>
            <button type="button" className="text-red-600 text-xs" onClick={() => removePoint(i)}>Remove</button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center border rounded p-2 mb-2 bg-gray-50 text-sm">
        <span>Meals:</span>
        {MEALS.map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input type="checkbox" checked={meals.includes(m)}
                   onChange={(e) => setMeals((cur) => e.target.checked ? [...cur, m] : cur.filter((x) => x !== m))} />
            {m}
          </label>
        ))}
        <label className="flex items-center gap-1">
          for
          <input type="number" min={1} max={14} className="border rounded px-1 py-0.5 w-14"
                 value={days} onChange={(e) => setDays(Math.min(14, Math.max(1, Number(e.target.value) || 1)))} />
          day{days === 1 ? "" : "s"}
        </label>
        <button type="button" onClick={addMeals} disabled={!meals.length}
                className="bg-[#800000] text-white px-3 py-1 rounded text-xs">
          Add meals
        </button>
        {dates.starts_at && (
          <span className="text-xs text-gray-500">
            from {new Date(dates.starts_at).toLocaleDateString("en-NG", { weekday: "short", day: "numeric", month: "short" })}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 items-center mb-6">
        <input className="border rounded px-2 py-1 text-sm flex-1 min-w-[200px]"
               placeholder="Another scan point, e.g. Opening session, T-shirt pickup"
               value={customPoint} onChange={(e) => setCustomPoint(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPoint(customPoint); setCustomPoint(""); } }} />
        <button type="button" className="text-xs underline"
                onClick={() => { addPoint(customPoint); setCustomPoint(""); }}>Add</button>
      </div>

      {/* ---- scanners ---- */}
      <p className="font-medium text-sm">Scanners</p>
      <p className="text-xs text-gray-500 mb-2">
        Volunteers who scan at meals and sessions. They sign in with their normal account and
        only get the scanner for this programme. Admins who run this programme can scan too.
      </p>

      {scanners.length > 0 && (
        <ul className="text-sm mb-2 divide-y border rounded">
          {scanners.map((s) => (
            <li key={s.user_id} className="flex justify-between items-center px-2 py-1">
              <span>{s.full_name || "—"} <span className="text-gray-500">{s.email}</span></span>
              <button type="button" className="text-red-600 text-xs" onClick={() => removeScanner(s)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <input type="email" className="border rounded px-2 py-1 text-sm flex-1 min-w-[200px]"
               placeholder="Volunteer's email (they must have an account)"
               value={scannerEmail} onChange={(e) => setScannerEmail(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addScanner(); } }} />
        <button type="button" onClick={addScanner} disabled={scannerBusy}
                className="bg-gray-800 text-white px-3 py-1 rounded text-xs">
          {scannerBusy ? "Adding…" : "Add scanner"}
        </button>
      </div>
      {scannerMsg && (
        <p className={`text-xs mt-1 ${scannerMsg.kind === "ok" ? "text-green-800" : "text-red-700"}`}>
          {scannerMsg.text}
        </p>
      )}

      <p className="text-xs text-gray-600 mt-4">
        Scanner page: <a className="underline" href={scanUrl} target="_blank" rel="noopener">{window.location.origin}{scanUrl}</a>
        {" "}(share it with the scanners; they can bookmark it on their phones).
      </p>

      {/* ---- medics ---- */}
      <p className="font-medium text-sm mt-6">Medics</p>
      <p className="text-xs text-gray-500 mb-2">
        Medics on duty keep participants' medical records on the medic page: they scan a tag or type a name,
        read the record and add to it. Only these medics and the super admin can read the records. Admins can
        add or remove medics here but can't open the records.
      </p>

      {medicsOff ? (
        <p className="text-xs text-red-700">{medicsOff}</p>
      ) : (
        <>
          {medics.length > 0 && (
            <ul className="text-sm mb-2 divide-y border rounded">
              {medics.map((m) => (
                <li key={m.user_id} className="flex justify-between items-center px-2 py-1">
                  <span>{m.full_name || "—"} <span className="text-gray-500">{m.email}</span></span>
                  <button type="button" className="text-red-600 text-xs" onClick={() => removeMedic(m)}>Remove</button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2 items-center">
            <input type="email" className="border rounded px-2 py-1 text-sm flex-1 min-w-[200px]"
                   placeholder="Medic's email (they must have an account)"
                   value={medicEmail} onChange={(e) => setMedicEmail(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addMedic(); } }} />
            <button type="button" onClick={addMedic} disabled={medicBusy}
                    className="bg-gray-800 text-white px-3 py-1 rounded text-xs">
              {medicBusy ? "Adding…" : "Add medic"}
            </button>
          </div>
          {medicMsg && (
            <p className={`text-xs mt-1 ${medicMsg.kind === "ok" ? "text-green-800" : "text-red-700"}`}>
              {medicMsg.text}
            </p>
          )}

          {medicRecords && (
            <p className={`text-xs mt-3 rounded px-2 py-1 ${medicRecords.ended ? "bg-amber-50 text-amber-900" : "text-gray-600"}`}>
              {medicRecords.count} medical record{medicRecords.count === 1 ? "" : "s"} for this programme.
              {medicRecords.ended
                ? " The programme has ended: delete them on the medic page once they're no longer needed."
                : " After the programme, you can delete them all on the medic page."}
            </p>
          )}

          <p className="text-xs text-gray-600 mt-3">
            Medic page: <a className="underline" href={medicUrl} target="_blank" rel="noopener">{window.location.origin}{medicUrl}</a>
            {" "}(share it with the medics only).
          </p>
        </>
      )}
    </div>
  );
}