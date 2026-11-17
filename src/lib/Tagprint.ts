import QRCode from "qrcode";

/** What goes on a printed tag. */
export interface TagData {
  id: string;                 // registration id (goes in the QR)
  full_name: string;
  archdeaconry?: string | null;
  photo_url?: string | null;
  hostel?: string | null;
  bible_study_class?: string | null;
  unit?: string | null;
}

export interface LabelSize { key: string; label: string; w: number; h: number }

/** Common thermal label sizes, in millimetres (portrait). */
export const LABEL_SIZES: LabelSize[] = [
  { key: "62x100",  label: "62 × 100 mm (Brother QL 62mm roll)", w: 62,  h: 100 },
  { key: "76x102",  label: "76 × 102 mm (3 × 4 in)",             w: 76,  h: 102 },
  { key: "100x150", label: "100 × 150 mm (4 × 6 in, Zebra / Xprinter)", w: 100, h: 150 },
  { key: "80x120",  label: "80 × 120 mm",                         w: 80,  h: 120 },
];

/** The text a member's QR code carries. The check-in search understands it. */
export const qrPayload = (registrationId: string) => `DYO:${registrationId}`;

export const makeQr = (registrationId: string, px = 480) =>
  QRCode.toDataURL(qrPayload(registrationId), { margin: 1, width: px, errorCorrectionLevel: "M" });

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/**
 * Builds a complete HTML page holding one tag per person, sized exactly to
 * the label, so the thermal printer feeds one label per tag.
 * Everything is sized from the label width, so any label size works.
 */
export async function buildTagHtml(
  people: TagData[], size: { w: number; h: number }, programmeTitle: string,
): Promise<string> {
  const { w, h } = size;
  const u = Math.min(w / 62, h / 100);               // scale against the 62 x 100mm design
  const mm = (n: number) => `${(n * u).toFixed(2)}mm`;

  const tags = await Promise.all(people.map(async (p) => {
    const qr = await makeQr(p.id);
    const name = (p.full_name || "").trim();
    // long names shrink so they stay on two lines
    const nameSize = name.length > 26 ? 5.2 : name.length > 18 ? 6.2 : 7.4;

    const row = (label: string, value?: string | null) => `
      <div class="row"><span class="k">${label}</span><span class="v">${esc(value?.trim() || "—")}</span></div>`;

    return `
      <section class="tag">
        <div class="event">${esc(programmeTitle)}</div>
        ${p.photo_url
          ? `<img class="photo" src="${esc(p.photo_url)}" alt="" />`
          : `<div class="photo photo--none">${esc(name.charAt(0).toUpperCase())}</div>`}
        <div class="name" style="font-size:${mm(nameSize)}">${esc(name)}</div>
        <div class="arch">${esc(p.archdeaconry?.trim() || "")}</div>
        <div class="rows">
          ${row("Hostel", p.hostel)}
          ${row("Class", p.bible_study_class)}
          ${row("Unit", p.unit)}
        </div>
        <img class="qr" src="${qr}" alt="" />
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
    .event {
      font-size: ${mm(2.7)}; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
      width: 100%; padding-bottom: ${mm(1.2)}; border-bottom: ${mm(0.5)} solid #000;
      line-height: 1.15; max-height: 2.3em; overflow: hidden;
    }
    .tag > * { flex-shrink: 0; }
    .photo {
      width: ${mm(27)}; height: ${mm(27)}; margin-top: ${mm(2.2)};
      object-fit: cover; object-position: center 20%;
      border: ${mm(0.5)} solid #000; border-radius: ${mm(2)};
      filter: grayscale(1) contrast(1.25);   /* thermal printers are black only */
    }
    .photo--none {
      display: flex; align-items: center; justify-content: center;
      font-size: ${mm(14)}; font-weight: 700; filter: none;
    }
    .name { font-weight: 800; line-height: 1.08; margin-top: ${mm(2)}; max-height: 2.2em; overflow: hidden; }
    .arch { font-size: ${mm(3.6)}; margin-top: ${mm(0.8)}; font-weight: 600; }
    .rows {
      width: 100%; margin-top: ${mm(2)};
      border-top: ${mm(0.35)} solid #000;
    }
    .row {
      display: flex; justify-content: space-between; gap: ${mm(2)};
      font-size: ${mm(3.5)}; padding: ${mm(0.9)} 0;
      border-bottom: ${mm(0.35)} solid #000;
    }
    .k { font-weight: 400; text-transform: uppercase; font-size: ${mm(2.6)}; letter-spacing: .05em; align-self: center; }
    .v { font-weight: 800; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qr { width: ${mm(22)}; height: ${mm(22)}; margin-top: auto; image-rendering: pixelated; }
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