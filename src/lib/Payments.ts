import { createElement } from "react";
import { supabase } from "./supabaseClient";
import type { FlutterwaveResponse } from "../types/flutterwave";

const FLW_SCRIPT = "https://checkout.flutterwave.com/v3.js";

// The Window.FlutterwaveCheckout type lives in src/types/flutterwave.ts.
// Declaring it here as well is what caused TS2717.

/** Loads the Flutterwave script once, no matter how many pages ask for it. */
let scriptPromise: Promise<void> | null = null;
export function loadFlutterwave(): Promise<void> {
  if (typeof window.FlutterwaveCheckout === "function") return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = FLW_SCRIPT;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptPromise = null;
      reject(new Error("Couldn't reach Flutterwave. Check your connection and try again."));
    };
    document.body.appendChild(el);
  });
  return scriptPromise;
}

export type PaymentPurpose = "order" | "registration" | "donation" | "sponsorship"|"body_payment"|"item_sponsorship";

export interface PayArgs {
  purpose: PaymentPurpose;
  referenceId: string;        // orders.id | programme_registrations.id | donations.id
  amountNaira: number;
  customer: { email: string; name: string; phone?: string };
  title: string;              // shown in the Flutterwave modal
  description: string;
  logo?: string;
}

export interface PayResult {
  // "submitted": paid by bank transfer and sent the receipt; it's confirmed
  // once an admin checks it, so treat it like a pending payment.
  status: "success" | "failed" | "closed" | "submitted";
  message?: string;
}

/** What the "How would you like to pay?" box shows. The database works it out. */
export interface TransferDetails {
  amount_naira: number;
  reference_code: string;            // what they write in the transfer narration
  label: string;                     // "Registration · Grace Adeyemi · Youth Convention 2026"
  paid: boolean;
  card_enabled: boolean;             // Flutterwave, switched on in Admin → Bank transfers
  account: {
    bank_name: string; account_name: string; account_number: string;
    whatsapp_number: string | null; instructions: string | null;
  } | null;                          // null: no account set up yet
  last: {                            // the latest receipt they sent for this, if any
    status: "pending" | "approved" | "rejected";
    submitted_at: string;
    reject_reason: string | null;
  } | null;
}

/**
 * One entry point for every payment on the site.
 *
 * Asks how they'd like to pay:
 *   • Card (Flutterwave) — only when switched on in Admin → Bank transfers.
 *   • Bank transfer — they transfer, upload the receipt and send it to the
 *     admin on WhatsApp; an admin ticks it paid (see Paychoice.tsx).
 *
 * The amount always comes from the database, never from the browser.
 * If bank-transfers.sql hasn't been run yet, it's card only, as before.
 */
export async function startPayment(args: PayArgs): Promise<PayResult> {
  const { data, error } = await supabase.rpc("transfer_details", {
    p_purpose: args.purpose,
    p_reference_id: args.referenceId,
  });
  if (error) {
    if (/could not find the function|schema cache/i.test(error.message)) return payByCard(args);
    return { status: "failed", message: error.message };
  }
  const choice = await askHowToPay(args, data as TransferDetails);
  return choice === "card" ? payByCard(args) : choice;
}

/** Opens the "How would you like to pay?" box and waits for it to finish. */
async function askHowToPay(args: PayArgs, details: TransferDetails): Promise<PayResult | "card"> {
  const [{ createRoot }, { default: PayChoice }] = await Promise.all([
    import("react-dom/client"),
    import("../components/Paychoice"),
  ]);
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onDone = (result: PayResult | "card") => {
      document.body.style.overflow = overflow;
      resolve(result);
      // unmount after the click that closed it has finished
      setTimeout(() => { root.unmount(); host.remove(); }, 0);
    };
    root.render(createElement(PayChoice, { args, details, onDone }));
  });
}

/** The latest bank-transfer receipt for something, for pages that show status. */
export async function transferStatus(purpose: PaymentPurpose, referenceId: string): Promise<TransferDetails["last"]> {
  const { data, error } = await supabase.rpc("transfer_details", {
    p_purpose: purpose,
    p_reference_id: referenceId,
  });
  return error ? null : (data as TransferDetails).last;
}

/**
 * Card payment through Flutterwave.
 *
 * 1. Writes a `payments` row holding the amount WE expect. The browser never
 *    gets to decide what was owed.
 * 2. Opens Flutterwave.
 * 3. Hands the transaction to the verify-payment Edge Function, which asks
 *    Flutterwave directly and is the only thing that can mark anything paid.
 */
async function payByCard(args: PayArgs): Promise<PayResult> {
  const publicKey = import.meta.env.VITE_FLW_PUBLIC_KEY as string | undefined;
  if (!publicKey) {
    return { status: "failed", message: "Payment isn't configured yet. Contact the youth office." };
  }

  await loadFlutterwave();

  const txRef = `DYO-${args.purpose.toUpperCase()}-${args.referenceId.slice(0, 8)}-${Date.now()}`;

  // The RPC re-reads the real amount from the order/registration row, so a
  // tampered price in the browser is simply ignored.
  const { error: intentError } = await supabase.rpc("create_payment_intent", {
    p_purpose: args.purpose,
    p_reference_id: args.referenceId,
    p_tx_ref: txRef,
    p_amount_naira: args.amountNaira,
    p_payer_email: args.customer.email,
  });

  if (intentError) {
    return { status: "failed", message: "Couldn't start the payment. Try again." };
  }

  return new Promise<PayResult>((resolve) => {
    window.FlutterwaveCheckout({
      public_key: publicKey,
      tx_ref: txRef,
      amount: args.amountNaira,
      currency: "NGN",
      payment_options: "card,ussd,banktransfer",
      customer: {
        email: args.customer.email,
        name: args.customer.name,
        phone_number: args.customer.phone ?? "",
      },
      customizations: {
        title: args.title,
        description: args.description,
        logo: args.logo ?? "",
      },
      callback: async (payment: FlutterwaveResponse) => {
        try {
          const { data, error } = await supabase.functions.invoke("verify-payment", {
            body: { transaction_id: payment.transaction_id, tx_ref: txRef },
          });
          if (error || (data?.status !== "success" && data?.status !== "already_verified")) {
            resolve({ status: "failed", message: "We couldn't confirm that payment. If you were debited, send your receipt to the youth office and it will be applied." });
          } else {
            resolve({ status: "success" });
          }
        } catch {
          resolve({ status: "failed", message: "We couldn't confirm that payment yet. Check back in a few minutes." });
        }
      },
      onclose: () => resolve({ status: "closed" }),
    });
  });
}

export const naira = (amount: number) =>
  `₦${Number(amount || 0).toLocaleString("en-NG")}`;