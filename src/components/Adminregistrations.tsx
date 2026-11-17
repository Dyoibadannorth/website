import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { supabase } from "./../lib/supabaseClient";
import { naira } from "./../lib/Payments";
import AdminCheckin from "./AdminCheckin";

/**
 * Replaces the three hard-coded tabs in the old AdminDashboard. One screen that
 * works for any programme the office creates, including ones that don't exist yet.
 *
 * Two tabs on the same records:
 *   • Registrations — the list, filters, Excel export (with what each person
 *     was assigned and when they were scanned at each meal / session)
 *   • Check-in desk & tags — scan / search, assign hostel / class / unit…,
 *     print the tag
 */

interface Field { key: string; label: string }
interface Point { key: string; label: string }
export default function AdminRegistrations() {
  const { id } = useParams<{ id: string }>();
  const [programme, setProgramme] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "paid" | "unpaid" | "checked_in">("all");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"list" | "desk">("list");

  useEffect(() => { void load(); }, [id]);

  // quiet = refresh the numbers without blanking the page (the desk uses this)
  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    const [{ data: p }, { data: r }] = await Promise.all([
      supabase.from("programmes").select("*").eq("id", id).single(),
      supabase.from("programme_registrations").select("*")
        .eq("programme_id", id).order("created_at", { ascending: false }),
    ]);
    setProgramme(p);
    setRows(r ?? []);
    setLoading(false);
  }

  const shown = useMemo(() => {
    const q = search.toLowerCase();
    return rows
      .filter((r) =>
        filter === "all" ||
        (filter === "paid" && r.payment_status === "paid") ||
        (filter === "unpaid" && r.payment_status === "pending") ||
        (filter === "checked_in" && r.checked_in_at))
      .filter((r) =>
        !q ||
        r.full_name?.toLowerCase().includes(q) ||
        r.church?.toLowerCase().includes(q) ||
        r.archdeaconry?.toLowerCase().includes(q) ||
        r.phone?.includes(q));
  }, [rows, search, filter]);

  const fields: Field[] = programme?.assignment_fields ?? [];
  const points: Point[] = programme?.scan_points ?? [];
  const assigned = (r: any) =>
    fields.map((f) => r.assignments?.[f.key]).filter(Boolean).join(" · ");

  const paid = rows.filter((r) => r.payment_status === "paid").length;
  const checkedIn = rows.filter((r) => r.checked_in_at).length;
  const revenue = rows
    .filter((r) => r.payment_status === "paid")
    .reduce((s, r) => s + r.amount_naira, 0);

  async function toggleCheckIn(row: any) {
    await supabase.from("programme_registrations")
      .update({ checked_in_at: row.checked_in_at ? null : new Date().toISOString() })
      .eq("id", row.id);
    void load();
  }

  async function markPaid(row: any) {
    // Admins can override — useful for cash paid at the desk.
    await supabase.from("programme_registrations")
      .update({ payment_status: "paid" }).eq("id", row.id);
    void load();
  }

  /** Remove one person's registration. Hard delete — it's a single row. */
  async function remove(row: any) {
    if (!confirm(`Remove ${row.full_name}'s registration? This cannot be undone.`)) return;
    const { error } = await supabase
      .from("programme_registrations").delete().eq("id", row.id);
    if (error) { alert("Couldn't remove that registration."); return; }
    void load();
  }

  /** When each person was scanned at each meal / session (page by page: the API returns 1000 at a time). */
  async function loadScans() {
    const byPerson = new Map<string, Record<string, string>>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("programme_scans")
        .select("registration_id, point_key, scanned_at")
        .eq("programme_id", id).order("scanned_at").range(from, from + 999);
      if (error || !data?.length) break;
      for (const s of data) {
        const m = byPerson.get(s.registration_id) ?? {};
        m[s.point_key] = s.scanned_at;
        byPerson.set(s.registration_id, m);
      }
      if (data.length < 1000) break;
    }
    return byPerson;
  }

  async function exportSheet() {
    const extraKeys = Array.from(
      new Set(shown.flatMap((r) => Object.keys(r.answers ?? {}))),
    );
    const scans = points.length ? await loadScans() : new Map<string, Record<string, string>>();

    const data = shown.map((r) => {
      const row: Record<string, unknown> = {
        Name: r.full_name, Gender: r.gender, Phone: r.phone, Email: r.email,
        Archdeaconry: r.archdeaconry, Church: r.church,
        Payment: r.payment_status, Amount: r.amount_naira,
        "Checked in": r.checked_in_at ? new Date(r.checked_in_at).toLocaleString("en-NG") : "",
        "Tag printed": r.tag_print_count > 0 ? "Yes" : "",
        Registered: new Date(r.created_at).toLocaleString("en-NG"),
      };
      // a column per thing assigned, then per meal / session scanned
      for (const f of fields) {
        row[f.label in row ? `${f.label} (assigned)` : f.label] = r.assignments?.[f.key] ?? "";
      }
      for (const p of points) {
        const at = scans.get(r.id)?.[p.key];
        row[p.label in row ? `${p.label} (scanned)` : p.label] = at ? new Date(at).toLocaleString("en-NG") : "";
      }
      for (const k of extraKeys) row[k] = r.answers?.[k] ?? "";
      return row;
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Registrations");
    XLSX.writeFile(wb, `${programme?.slug ?? "programme"}-registrations.xlsx`);
  }

  if (loading) return <p className="p-6">Loading…</p>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link to="/admin/programmes" className="underline text-sm">← All programmes</Link>

      <div className="flex flex-wrap justify-between items-end gap-3 mt-2 mb-5">
        <div>
          <h1 className="text-2xl font-bold">{programme?.title}</h1>
          <p className="text-gray-600 text-sm">
            {rows.length} registered · {paid} paid · {checkedIn} checked in · {naira(revenue)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {points.length > 0 && (
            <a href={`/scan?programme=${id}`} target="_blank" rel="noopener"
               className="bg-gray-800 text-white px-4 py-2 rounded">
              Open scanner
            </a>
          )}
          <button onClick={() => void exportSheet()} className="bg-green-700 text-white px-4 py-2 rounded">
            Export to Excel
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-5 border-b pb-3">
        <button onClick={() => setTab("list")}
                className={`px-4 py-2 rounded text-sm ${
                  tab === "list" ? "bg-[#800000] text-white" : "bg-gray-200"}`}>
          Registrations
        </button>
        <button onClick={() => setTab("desk")}
                className={`px-4 py-2 rounded text-sm ${
                  tab === "desk" ? "bg-[#800000] text-white" : "bg-gray-200"}`}>
          Check-in desk &amp; tags
        </button>
      </div>

      {tab === "desk" && id && (
        <AdminCheckin programmeId={id} onChanged={() => void load(true)} />
      )}

      {tab === "list" && (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            {(["all", "paid", "unpaid", "checked_in"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                      className={`px-3 py-1 rounded text-sm ${
                        filter === f ? "bg-[#800000] text-white" : "bg-gray-200"}`}>
                {f === "checked_in" ? "Checked in" : f}
              </button>
            ))}
          </div>

          <input className="border px-3 py-2 rounded w-full mb-5"
                 placeholder="Search by name, church, archdeaconry or phone"
                 value={search} onChange={(e) => setSearch(e.target.value)} />

          <div className="overflow-x-auto">
            <table className="w-full border text-sm">
              <thead>
                <tr className="bg-gray-100">
                  <th className="border px-2 py-1">Photo</th>
                  <th className="border px-2 py-1">Name</th>
                  <th className="border px-2 py-1">Archdeaconry</th>
                  <th className="border px-2 py-1">Church</th>
                  <th className="border px-2 py-1">Phone</th>
                  <th className="border px-2 py-1">Payment</th>
                  <th className="border px-2 py-1">Check-in</th>
                  <th className="border px-2 py-1">Assigned</th>
                  <th className="border px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="text-center">
                    <td className="border px-2 py-1">
                      {r.photo_url
                        ? <img src={r.photo_url} alt="" className="w-10 h-10 rounded-full mx-auto object-cover" />
                        : "—"}
                    </td>
                    <td className="border px-2 py-1 text-left">{r.full_name}</td>
                    <td className="border px-2 py-1">{r.archdeaconry}</td>
                    <td className="border px-2 py-1">{r.church}</td>
                    <td className="border px-2 py-1">{r.phone}</td>
                    <td className="border px-2 py-1">
                      {r.payment_status === "paid" ? (
                        <span className="bg-green-600 text-white px-2 py-1 rounded text-xs">PAID</span>
                      ) : r.payment_status === "not_required" ? (
                        <span className="text-gray-500 text-xs">Free</span>
                      ) : (
                        <button onClick={() => markPaid(r)}
                                className="bg-red-600 text-white px-2 py-1 rounded text-xs">
                          Mark paid
                        </button>
                      )}
                    </td>
                    <td className="border px-2 py-1">
                      <button onClick={() => toggleCheckIn(r)}
                              className={`px-2 py-1 rounded text-xs ${
                                r.checked_in_at ? "bg-blue-600 text-white" : "bg-gray-200"}`}>
                        {r.checked_in_at ? "In" : "Check in"}
                      </button>
                    </td>
                    <td className="border px-2 py-1 text-xs text-gray-600">
                      {assigned(r) || "—"}
                    </td>
                    <td className="border px-2 py-1">
                      <button onClick={() => remove(r)} className="text-red-600 text-xs underline">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}