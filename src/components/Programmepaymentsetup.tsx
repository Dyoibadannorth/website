import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

/**
 * In the programme editor, under the fee: which bank account people pay into
 * when they pay for THIS programme by transfer (registrations, sponsorships,
 * church/parish payments). Blank = the main account set under Admin → Bank
 * transfers. Fill it in to use another one, e.g. the archdeaconry's.
 */

interface Account { bank_name: string; account_name: string; account_number: string; whatsapp_number: string | null }

export default function ProgrammePaymentSetup({ programmeId }: { programmeId: string | null }) {
  if (!programmeId) {
    return (
      <p className="text-xs text-gray-500 mt-4">
        Save the programme first. Then you can give it its own bank account for transfers.
      </p>
    );
  }
  return <Setup key={programmeId} programmeId={programmeId} />;
}

function Setup({ programmeId }: { programmeId: string }) {
  const [main, setMain] = useState<Account | null>(null);
  const [own, setOwn] = useState<Account | null>(null);
  const [form, setForm] = useState({ bank: "", name: "", number: "", whatsapp: "" });
  const [off, setOff] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    const { data, error } = await supabase.rpc("programme_payment_get", { p_programme_id: programmeId });
    if (error) {
      setOff(/could not find the function/i.test(error.message)
        ? "Run bank-transfers.sql in Supabase to set bank accounts." : error.message);
      return;
    }
    const v = data as { own: Account | null; main: Account | null };
    setMain(v.main);
    setOwn(v.own);
    setForm({
      bank: v.own?.bank_name ?? "", name: v.own?.account_name ?? "", number: v.own?.account_number ?? "",
      whatsapp: v.own?.whatsapp_number ? `+${v.own.whatsapp_number}` : "",
    });
  }

  async function save(clear = false) {
    if (clear && !confirm("Go back to the main account for this programme?")) return;
    setBusy(true);
    setNote(null);
    const f = clear ? { bank: "", name: "", number: "", whatsapp: "" } : form;
    const { error } = await supabase.rpc("programme_payment_save", {
      p_programme_id: programmeId,
      p_bank_name: f.bank, p_account_name: f.name, p_account_number: f.number, p_whatsapp_number: f.whatsapp,
    });
    setBusy(false);
    if (error) { setNote({ kind: "error", text: error.message }); return; }
    setNote({ kind: "ok", text: clear ? "This programme now uses the main account." : "Saved. Transfers for this programme go to this account." });
    void load();
  }

  if (off) return <p className="text-xs text-gray-500 mt-4">{off}</p>;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="mt-5 border-t pt-4">
      <p className="font-medium text-sm">Bank account for transfers</p>
      <p className="text-xs text-gray-500 mb-2">
        {own
          ? <>People paying for this programme by transfer pay into <b>this programme's own account</b> below.</>
          : main
            ? <>People paying for this programme by transfer pay into the main account ({main.account_name}, {main.bank_name} {main.account_number}). To use a different account for this programme, e.g. the archdeaconry's, fill these in.</>
            : <>No main account is set yet (the super admin sets it under Bank transfers). You can give this programme its own account here.</>}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <input value={form.bank} onChange={set("bank")} placeholder="Bank, e.g. Access Bank" />
        <input value={form.name} onChange={set("name")} placeholder="Account name" />
        <input value={form.number} onChange={set("number")} placeholder="Account number (10 digits)" inputMode="numeric" />
        <input value={form.whatsapp} onChange={set("whatsapp")} inputMode="tel"
               placeholder="WhatsApp for receipts (blank: main number)" />
      </div>

      {note && (
        <p className={`text-xs mt-2 ${note.kind === "ok" ? "text-green-800" : "text-red-700"}`}>{note.text}</p>
      )}

      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className="a-btn" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save account"}
        </button>
        {own && (
          <button type="button" className="a-btn a-btn--quiet" onClick={() => void save(true)} disabled={busy}>
            Use the main account
          </button>
        )}
      </div>
    </div>
  );
}