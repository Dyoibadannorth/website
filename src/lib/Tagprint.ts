import QRCode from "qrcode";

/** One line on the tag, e.g. { label: "Hostel", value: "Hall B" }. */
export interface TagRow { label: string; value?: string | null }

/** What goes on a printed tag. */
export interface TagData {
  id: string;                 // registration id (goes in the QR)
  full_name: string;
  archdeaconry?: string | null;
  photo_url?: string | null;
  rows?: TagRow[];            // whatever the programme assigns and prints (up to 5)
}

export interface LabelSize { key: string; label: string; w: number; h: number }

/** Common thermal label sizes, in millimetres (portrait). */
export const LABEL_SIZES: LabelSize[] = [
  { key: "62x100",  label: "62 × 100 mm (Brother QL 62mm roll)", w: 62,  h: 100 },
  { key: "76x102",  label: "76 × 102 mm (3 × 4 in)",             w: 76,  h: 102 },
  { key: "100x150", label: "100 × 150 mm (4 × 6 in, Zebra / Xprinter)", w: 100, h: 150 },
  { key: "80x120",  label: "80 × 120 mm",                         w: 80,  h: 120 },
];

/** The most lines a tag can carry and still fit the smallest label. */
export const MAX_TAG_ROWS = 5;

/** The text a member's QR code carries. The desk and the scanner understand it. */
export const qrPayload = (registrationId: string) => `DYO:${registrationId}`;

/** The short code members see as "Confirmed · 1A2B3C4D", printed under the QR. */
export const shortCode = (registrationId: string) => registrationId.slice(0, 8).toUpperCase();

export const makeQr = (registrationId: string, px = 480) =>
  QRCode.toDataURL(qrPayload(registrationId), { margin: 1, width: px, errorCorrectionLevel: "M" });

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/**
 * Builds a complete HTML page holding one tag per person, sized exactly to
 * the label, so the thermal printer feeds one label per tag.
 * Everything is sized against a 62 × 100 mm design and scaled to the label;
 * the photo and QR shrink a little when there are more lines to fit.
 */
export async function buildTagHtml(
  people: TagData[], size: { w: number; h: number }, programmeTitle: string,
): Promise<string> {
  const { w, h } = size;
  const u = Math.min(w / 62, h / 100);
  const mm = (n: number) => `${(n * u).toFixed(2)}mm`;

  const tags = await Promise.all(people.map(async (p) => {
    const qr = await makeQr(p.id);
    const name = (p.full_name || "").trim();
    const rows = (p.rows ?? []).slice(0, MAX_TAG_ROWS);
    const n = rows.length;

    // long names shrink so they stay on two lines
    const nameSize = name.length > 26 ? 5.2 : name.length > 18 ? 6.2 : 7.4;
    const photo = n <= 2 ? 29 : n === 3 ? 26 : n === 4 ? 22 : 19;
    const qrSize = n <= 3 ? 21 : 18;
    const rowFont = n <= 3 ? 3.5 : 3.1;
    const rowPad = n <= 3 ? 0.9 : 0.55;

    const rowHtml = rows.map((r) => `
      <div class="row" style="font-size:${mm(rowFont)};padding:${mm(rowPad)} 0">
        <span class="k">${esc(r.label)}</span><span class="v">${esc(r.value?.trim() || "—")}</span>
      </div>`).join("");

    return `
      <section class="tag">
        <div class="event">${esc(programmeTitle)}</div>
        ${p.photo_url
          ? `<img class="photo" style="height:${mm(photo)}" src="${esc(p.photo_url)}" alt="" />`
          : `<div class="photo photo--none" style="height:${mm(photo)};font-size:${mm(photo * 0.45)}">${esc(name.charAt(0).toUpperCase())}</div>`}
        <div class="name" style="font-size:${mm(nameSize)}">${esc(name)}</div>
        <div class="arch">${esc(p.archdeaconry?.trim() || "")}</div>
        ${n ? `<div class="rows">${rowHtml}</div>` : ""}
        <div class="foot">
          <img class="qr" style="width:${mm(qrSize)};height:${mm(qrSize)}" src="${qr}" alt="" />
          <div class="code">${shortCode(p.id)}</div>
        </div>
      </section>`;
  }));

  return `<!doctype html><html><head><meta charset="utf-8"><title>Tags</title><style>
    @page { size: ${w}mm ${h}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
    .tag {
      width: ${w}mm; height: ${h}mm; padding: ${mm(3)};
      display: flex; flex-direction: column; align-items: center; text-align: center;
      overflow: hidden; page-break-after: always; break-after: page;
    }
    .tag:last-child { page-break-after: auto; break-after: auto; }
    .tag > * { flex-shrink: 0; }
    .event {
      font-size: ${mm(2.7)}; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
      width: 100%; padding-bottom: ${mm(1.2)}; border-bottom: ${mm(0.5)} solid #000;
      line-height: 1.15; max-height: 2.3em; overflow: hidden;
    }
    /* The photo is the one thing that gives way: on a crowded tag (long
       title, long name, five lines) it shrinks so the QR always fits. */
    .photo {
      flex: 0 1 auto; aspect-ratio: 1 / 1; width: auto; min-height: ${mm(14)};
      margin-top: ${mm(2)};
      object-fit: cover; object-position: center 20%;
      border: ${mm(0.5)} solid #000; border-radius: ${mm(2)};
      filter: grayscale(1) contrast(1.25);   /* thermal printers are black only */
    }
    .photo--none { display: flex; align-items: center; justify-content: center; font-weight: 700; filter: none; }
    .name { font-weight: 800; line-height: 1.08; margin-top: ${mm(1.8)}; max-height: 2.2em; overflow: hidden; }
    .arch { font-size: ${mm(3.4)}; margin-top: ${mm(0.6)}; font-weight: 600; line-height: 1.15; }
    .rows { width: 100%; margin-top: ${mm(1.6)}; border-top: ${mm(0.35)} solid #000; }
    .row {
      display: flex; justify-content: space-between; align-items: baseline; gap: ${mm(2)};
      border-bottom: ${mm(0.35)} solid #000; line-height: 1.15;
    }
    .k { font-weight: 400; text-transform: uppercase; font-size: .75em; letter-spacing: .05em; white-space: nowrap; }
    .v { font-weight: 800; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .foot { margin-top: auto; display: flex; flex-direction: column; align-items: center; padding-top: ${mm(1.2)}; }
    .qr { image-rendering: pixelated; display: block; }
    .code { font-family: "Courier New", monospace; font-weight: 700; font-size: ${mm(2.6)}; letter-spacing: .12em; margin-top: ${mm(0.4)}; }
  </style></head><body>${tags.join("")}</body></html>`;
}

/**
 * Sends the tag page to the printer through a hidden frame.
 * Resolves once the print dialog has been opened.
 */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    Object.assign(frame.style, {
      position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0",
    });
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    const doc = win?.document;
    if (!win || !doc) { frame.remove(); return reject(new Error("Couldn't open the print frame.")); }

    doc.open(); doc.write(html); doc.close();

    // Wait for photos and QR codes, or the labels come out blank.
    const imgs = Array.from(doc.images);
    const waits = imgs.map((img) =>
      img.complete ? Promise.resolve() :
        new Promise<void>((done) => { img.onload = () => done(); img.onerror = () => done(); }));
    const timeout = new Promise<void>((done) => setTimeout(done, 6000));

    void Promise.race([Promise.all(waits), timeout]).then(() => {
      win.focus();
      win.print();
      setTimeout(() => frame.remove(), 60_000);
      resolve();
    });
  });
}