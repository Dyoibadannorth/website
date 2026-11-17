import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { LABEL_SIZES, buildTagHtml, printHtml } from "../lib/Tagprint";
import QrScanner from "./Qrscanner";

/**
 * Check-in desk.
 *
 * Find a person (scan their QR, or type a name, phone or voucher code),
 * set their hostel / bible study class / unit, and print their tag on the
 * thermal label printer. Printing also checks them in.
 *
 * A USB barcode scanner works too: click the search box and scan. The
 * scanner "types" the code and presses Enter.
 */

interface Person {
  id: string; full_name: string; gender: string | null; phone: string | null;
  archdeaconry: string | null; church: string | null; photo_url: string | null;
  payment_status: string; checked_in: boolean; checked_in_at: string | null;
  hostel: string | null; bible_study_class: string | null; unit: string | null;
  tag_print_count: number; voucher_code: string | null;
}

interface Programme {
  id: string; title: string;
  hostel_options: string[] | null; class_options: string[] | null; unit_options: string[] | null;
}

const SIZE_KEY = "dyo.checkin.labelSize";
const toList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * Used inside the programme's Registrations page (programmeId fixed), so the
 * desk and the list work on the same records. onChanged lets the list refresh.
 */
export default function AdminCheckin({ programmeId: fixedProgrammeId, onChanged }: {
  programmeId?: string;
  onChanged?: () => void;
} = {}) {
  const embedded = !!fixedProgrammeId;
  const [programmes, setProgrammes] = useState<Programme[]>([]);
  const [programmeId, setProgrammeId] = useState(fixedProgrammeId ?? "");
  const programme = programmes.find((p) => p.id === programmeId);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const [person, setPerson] = useState<Person | null>(null);
  const [hostel, setHostel] = useState("");
  const [cls, setCls] = useState("");
  const [unit, setUnit] = useState("");

  const [sizeKey, setSizeKey] = useState(() => {
    try { return localStorage.getItem(SIZE_KEY) ?? LABEL_SIZES[0].key; } catch { return LABEL_SIZES[0].key; }
  });
  const size = LABEL_SIZES.find((s) => s.key === sizeKey) ?? LABEL_SIZES[0];

  const [stats, setStats] = useState({ registered: 0, checked_in: 0, printed: 0 });
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [preview, setPreview] = useState("");

  const [showLists, setShowLists] = useState(false);
  const [lists, setLists] = useState({ hostels: "", classes: "", units: "" });

  const searchRef = useRef<HTMLInputElement>(null);

  /* ---------- load ---------- */
  useEffect(() => { void loadProgrammes(); }, []);

  async function loadProgrammes() {
    const { data, error } = await supabase
      .from("programmes")
      .select("id, title, hostel_options, class_options, unit_options")
      .order("starts_at", { ascending: false });
    if (error) {
      setMessage({ kind: "error", text: `${error.message} (has onsite-checkin.sql been run?)` });
      return;
    }
    setProgrammes((data ?? []) as Programme[]);
    setProgrammeId((cur) => cur || data?.[0]?.id || "");
  }

  useEffect(() => {
    if (!programmeId) return;
    setResults([]); setPerson(null); setQuery(""); setSearched(false);
    void loadStats(programmeId);
  }, [programmeId]);

  useEffect(() => {
    setLists({
      hostels: (programme?.hostel_options ?? []).join(", "),
      classes: (programme?.class_options ?? []).join(", "),
      units: (programme?.unit_options ?? []).join(", "),
    });
  }, [programme?.id, programme?.hostel_options, programme?.class_options, programme?.unit_options]);

  async function loadStats(pid: string) {
    const { data } = await supabase.rpc("checkin_stats", { p_programme_id: pid });
    const row = Array.isArray(data) ? data[0] : data;
    if (row) setStats({
      registered: Number(row.registered) || 0,
      checked_in: Number(row.checked_in) || 0,
      printed: Number(row.printed) || 0,
    });
  }

  /* ---------- search ---------- */
  async function search(term = query) {
    const q = term.trim();
    if (!programmeId || q.length < 2) return;
    setSearching(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("checkin_search", {
      p_programme_id: programmeId, p_q: q,
    });
    setSearching(false);
    setSearched(true);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    const rows = (data ?? []) as Person[];
    setResults(rows);
    if (rows.length === 1) pick(rows[0]);   // a scan or exact match goes straight in
    else setPerson(null);
  }

  function pick(p: Person) {
    setPerson(p);
    setHostel(p.hostel ?? "");
    setCls(p.bible_study_class ?? "");
    setUnit(p.unit ?? "");
  }

  function reset() {
    setPerson(null); setResults([]); setQuery(""); setSearched(false);
    searchRef.current?.focus();
  }

  /* ---------- tag preview ---------- */
  const tagData = useMemo(() => person && ({
    id: person.id, full_name: person.full_name, archdeaconry: person.archdeaconry,
    photo_url: person.photo_url, hostel, bible_study_class: cls, unit,
  }), [person, hostel, cls, unit]);

  useEffect(() => {
    if (!tagData) { setPreview(""); return; }
    let live = true;
    void buildTagHtml([tagData], size, programme?.title ?? "").then((html) => { if (live) setPreview(html); });
    return () => { live = false; };
  }, [tagData, size.w, size.h, programme?.title]);

  /* ---------- actions ---------- */
  async function save(print: boolean) {
    if (!person || !tagData) return;
    if (person.payment_status === "pending" &&
        !confirm(`${person.full_name} has NOT paid yet. Continue anyway?`)) return;

    setBusy(true);
    setMessage(null);
    try {
      if (print) {
        const html = await buildTagHtml([tagData], size, programme?.title ?? "");
        await printHtml(html);
      }
      const { error } = await supabase.rpc("checkin_save", {
        p_registration_id: person.id,
        p_hostel: hostel, p_class: cls, p_unit: unit, p_printed: print,
      });
      if (error) throw new Error(error.message);

      setMessage({
        kind: "ok",
        text: print ? `Tag sent to the printer for ${person.full_name}. Checked in.`
                    : `${person.full_name} checked in.`,
      });
      void loadStats(programmeId);
      onChanged?.();
      reset();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    }
    setBusy(false);
  }

  async function saveLists() {
    if (!programmeId) return;
    const payload = {
      p_programme_id: programmeId,
      p_hostels: toList(lists.hostels),
      p_classes: toList(lists.classes),
      p_units: toList(lists.units),
    };
    const { error } = await supabase.rpc("checkin_set_options", payload);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    setMessage({ kind: "ok", text: "Lists saved." });
    setShowLists(false);
    void loadProgrammes();
  }

  function chooseSize(key: string) {
    setSizeKey(key);
    try { localStorage.setItem(SIZE_KEY, key); } catch { /* fine without it */ }
  }

  const payBadge = (s: string) =>
    s === "paid" ? ["Paid", "bg-green-100 text-green-800"]
    : s === "pending" ? ["Not paid", "bg-red-100 text-red-800"]
    : ["Free", "bg-gray-200 text-gray-800"];

  /* ---------- view ---------- */
  return (
    <div className={embedded ? "" : "p-6 max-w-6xl mx-auto"}>
      <div className="flex flex-wrap justify-between items-end gap-3 mb-4">
        <div>
          {!embedded && <h1 className="text-2xl font-bold">Check-in &amp; tag printing</h1>}
          <p className="text-gray-600 text-sm">
            Scan a QR code, or search by name, phone or voucher code. Then print the tag.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!embedded && (
            <select className="border px-3 py-2 rounded" value={programmeId}
                    onChange={(e) => setProgrammeId(e.target.value)}>
              {programmes.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          )}
          <select className="border px-3 py-2 rounded" value={sizeKey}
                  onChange={(e) => chooseSize(e.target.value)} title="Label size">
            {LABEL_SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-6 text-sm mb-4 border rounded p-3 bg-white">
        <span><b>{stats.registered}</b> registered</span>
        <span><b>{stats.checked_in}</b> checked in</span>
        <span><b>{stats.printed}</b> tags printed</span>
        <button className="underline ml-auto" onClick={() => setShowLists((v) => !v)}>
          {showLists ? "Hide" : "Edit"} hostels, classes &amp; units
        </button>
      </div>

      {showLists && (
        <div className="border rounded p-4 mb-4 bg-white">
          <p className="text-sm text-gray-600 mb-3">
            Separate each one with a comma. These become the choices at the desk
            (you can still type something else).
          </p>
          <div className="grid md:grid-cols-3 gap-3">
            {([["hostels", "Hostels"], ["classes", "Bible study classes"], ["units", "Units"]] as const)
              .map(([key, label]) => (
                <label key={key} className="text-sm">{label}
                  <textarea className="border rounded px-2 py-1 w-full mt-1" rows={3}
                            value={lists[key]}
                            onChange={(e) => setLists((l) => ({ ...l, [key]: e.target.value }))} />
                </label>
              ))}
          </div>
          <button onClick={saveLists} className="bg-[#800000] text-white px-4 py-2 rounded mt-3">
            Save lists
          </button>
        </div>
      )}

      {/* search */}
      <form className="flex flex-wrap gap-2 mb-3"
            onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input ref={searchRef} autoFocus
               className="border rounded px-3 py-3 flex-1 min-w-[220px] text-lg"
               placeholder="Name, phone, voucher code, or scan here"
               value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" disabled={searching}
                className="bg-[#800000] text-white px-5 py-3 rounded">
          {searching ? "Searching…" : "Search"}
        </button>
        <button type="button" onClick={() => setScanning(true)}
                className="bg-gray-800 text-white px-5 py-3 rounded">
          Scan with camera
        </button>
      </form>

      {message && (
        <p className={`text-sm mb-3 px-3 py-2 rounded ${
          message.kind === "ok" ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}>
          {message.text}
        </p>
      )}

      {/* results */}
      {!person && searched && results.length === 0 && !searching && (
        <p className="text-gray-500 py-8 text-center">
          No one found for that in this programme. Check the spelling, or confirm they registered.
        </p>
      )}

      {!person && results.length > 1 && (
        <div className="grid gap-2">
          {results.map((r) => {
            const [label, cls2] = payBadge(r.payment_status);
            return (
              <button key={r.id} onClick={() => pick(r)}
                      className="border rounded p-3 flex items-center gap-3 text-left bg-white hover:bg-gray-50">
                {r.photo_url
                  ? <img src={r.photo_url} alt="" className="w-12 h-12 rounded object-cover" />
                  : <div className="w-12 h-12 rounded bg-gray-200" />}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate">{r.full_name}</p>
                  <p className="text-sm text-gray-500 truncate">
                    {[r.archdeaconry, r.church, r.phone].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <span className={`text-xs px-2 py-1 rounded ${cls2}`}>{label}</span>
                {r.checked_in && <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800">Checked in</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* the person */}
      {person && (
        <div className="grid md:grid-cols-2 gap-6 border rounded p-5 bg-white">
          <div>
            <div className="flex gap-4 items-start mb-4">
              {person.photo_url
                ? <img src={person.photo_url} alt="" className="w-24 h-24 rounded object-cover" />
                : <div className="w-24 h-24 rounded bg-gray-200" />}
              <div className="min-w-0">
                <p className="text-xl font-bold">{person.full_name}</p>
                <p className="text-sm text-gray-600">
                  {[person.archdeaconry, person.church].filter(Boolean).join(" · ")}
                </p>
                <p className="text-sm text-gray-600">{person.phone}</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className={`text-xs px-2 py-1 rounded ${payBadge(person.payment_status)[1]}`}>
                    {payBadge(person.payment_status)[0]}
                  </span>
                  {person.voucher_code &&
                    <span className="text-xs px-2 py-1 rounded bg-gray-200">Voucher {person.voucher_code}</span>}
                  {person.checked_in &&
                    <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800">Already checked in</span>}
                  {person.tag_print_count > 0 &&
                    <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900">
                      Tag printed {person.tag_print_count}×
                    </span>}
                </div>
              </div>
            </div>

            {!person.photo_url && (
              <p className="text-sm text-amber-800 bg-amber-50 rounded px-3 py-2 mb-3">
                No photo on this account. The tag will print with their initial instead.
              </p>
            )}

            <div className="grid gap-3">
              {([
                ["Hostel", hostel, setHostel, programme?.hostel_options, "hostel-list"],
                ["Bible study class", cls, setCls, programme?.class_options, "class-list"],
                ["Unit", unit, setUnit, programme?.unit_options, "unit-list"],
              ] as const).map(([label, value, setter, options, listId]) => (
                <label key={listId} className="text-sm text-gray-700">{label}
                  <input className="border rounded px-3 py-2 w-full mt-1" list={listId}
                         value={value} onChange={(e) => setter(e.target.value)} />
                  <datalist id={listId}>
                    {(options ?? []).map((o) => <option key={o} value={o} />)}
                  </datalist>
                </label>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 mt-5">
              <button onClick={() => save(true)} disabled={busy}
                      className="bg-[#800000] text-white px-5 py-3 rounded font-semibold">
                {busy ? "Working…" : person.tag_print_count > 0 ? "Reprint tag" : "Check in & print tag"}
              </button>
              <button onClick={() => save(false)} disabled={busy}
                      className="px-5 py-3 rounded border">
                Save without printing
              </button>
              <button onClick={reset} disabled={busy} className="px-5 py-3 underline text-sm">
                Cancel
              </button>
            </div>
          </div>

          <div>
            <p className="text-sm text-gray-600 mb-2">Tag preview ({size.w} × {size.h} mm)</p>
            {preview && (
              <iframe title="Tag preview" srcDoc={preview}
                      style={{ width: `${size.w}mm`, height: `${size.h}mm`, border: "1px solid #d6c7bd",
                               background: "#fff", maxWidth: "100%" }} />
            )}
          </div>
        </div>
      )}

      {scanning && (
        <QrScanner
          onClose={() => setScanning(false)}
          onResult={(text) => { setScanning(false); setQuery(text); void search(text); }}
        />
      )}
    </div>
  );
}