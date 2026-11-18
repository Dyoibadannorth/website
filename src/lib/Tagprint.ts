import QRCode from "qrcode";

/** One line on the tag, e.g. { label: "Hostel", value: "Hall B" }. */
export interface TagRow { label: string; value?: string | null }

/** What goes on a printed tag. */
export interface TagData {
  id: string;                 // registration id (goes in the QR)
  full_name: string;
  church?: string | null;
  archdeaconry?: string | null;
  photo_url?: string | null;
  rows?: TagRow[];            // whatever the programme assigns and prints (up to 5)
}

/** "colour" for colour printers; "bw" is tuned for black-only thermal printers. */
export type TagStyle = "colour" | "bw";

export interface TagOptions {
  style?: TagStyle;
  /** The programme's own tag design (an image). It fills the tag; the details sit on a white panel. */
  design?: string | null;
}

export interface LabelSize { key: string; label: string; w: number; h: number }

/** Common label sizes, in millimetres (portrait). */
export const LABEL_SIZES: LabelSize[] = [
  { key: "62x100",  label: "62 × 100 mm (Brother QL 62mm roll)", w: 62,  h: 100 },
  { key: "76x102",  label: "76 × 102 mm (3 × 4 in)",             w: 76,  h: 102 },
  { key: "100x150", label: "100 × 150 mm (4 × 6 in, Zebra / Xprinter)", w: 100, h: 150 },
  { key: "80x120",  label: "80 × 120 mm",                         w: 80,  h: 120 },
];

/** The most lines a tag can carry and still fit the smallest label. */
export const MAX_TAG_ROWS = 5;

/** With a design, this share of the tag's height shows the design above the white panel. */
export const DESIGN_TOP_SHARE = 0.18;

/** The text a member's QR code carries. The desk and the scanner understand it. */
export const qrPayload = (registrationId: string) => `DYO:${registrationId}`;

/** The short code members see as "Confirmed · 1A2B3C4D", printed under the QR. */
export const shortCode = (registrationId: string) => registrationId.slice(0, 8).toUpperCase();

export const makeQr = (registrationId: string, px = 480) =>
  QRCode.toDataURL(qrPayload(registrationId), { margin: 1, width: px, errorCorrectionLevel: "M" });

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const MAROON = "#800000";
const GOLD = "#F2C230";
const FONT = "Arial, Helvetica, sans-serif";

/* ---------- fitting the name into two lines ---------- */

const measureCtx: Record<number, CanvasRenderingContext2D | null> = {};
/** Width of `text` in mm when set at 1 mm. Uses the real font when a browser is available. */
function widthAt1mm(text: string, weight = 800): number {
  if (!(weight in measureCtx)) {
    const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    if (ctx) ctx.font = `${weight} 100px ${FONT}`;
    measureCtx[weight] = ctx;
  }
  const ctx = measureCtx[weight];
  if (ctx) return ctx.measureText(text).width / 100;
  return text.length * (weight >= 700 ? 0.64 : 0.58);   // no browser: a cautious average for Arial
}

/**
 * How many lines `text` wraps to at `size` mm in `width` mm, and its longest
 * unbreakable piece. Like the browser, a line may break after a hyphen
 * ("Adebayo-" / "Williams").
 */
function wrap(text: string, size: number, width: number, weight = 800, spacingEm = 0) {
  const wid = (t: string) => (widthAt1mm(t, weight) + t.length * spacingEm) * size;
  const space = wid(" ");
  const pieces: { t: string; joined: boolean }[] = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    word.replace(/-/g, "-\u0000").split("\u0000").filter(Boolean)
      .forEach((t, k) => pieces.push({ t, joined: k > 0 }));
  }
  let lines = pieces.length ? 1 : 0;
  let line = 0;
  let longest = 0;
  for (const piece of pieces) {
    const ww = wid(piece.t);
    longest = Math.max(longest, ww);
    const add = piece.joined ? ww : space + ww;
    if (line === 0) line = ww;
    else if (line + add <= width) line += add;
    else { lines++; line = ww; }
  }
  return { lines, longest };
}

const NAME_SIZES = [7.4, 7.0, 6.6, 6.2, 5.8, 5.4, 5.0, 4.6, 4.3, 4.0];

/** The largest name size (mm, before scaling) that keeps the name within `maxLines` lines. */
export function fitNameSize(name: string, widthMm: number, maxSize = 7.4, maxLines = 2): number {
  const room = widthMm * 0.95;          // a little slack for rendering differences
  for (const size of NAME_SIZES) {
    if (size > maxSize) continue;
    const { lines, longest } = wrap(name, size, room);
    if (longest <= room && lines <= maxLines) return size;
  }
  return NAME_SIZES[NAME_SIZES.length - 1];
}

/* ---------- planning each tag so everything fits ---------- */

interface Plan {
  compact: boolean;           // photo beside the name instead of above it
  nameSize: number; nameLines: number; photo: number; qr: number;
  rowFont: number; rowPad: number; churchLines: number; churchSize: number;
}

const NAME_LH = 1.08, TEXT_LH = 1.15;

/**
 * Works out sizes for one tag, in unscaled mm. `room` is the card's inner
 * height and `width` its inner width. Normal tags keep the photo on top;
 * crowded ones squeeze a little, and if the photo would get too small they
 * switch to a compact layout with the photo beside the name.
 */
function planTag(p: TagData, n: number, room: number, width: number, design: boolean): Plan {
  const name = (p.full_name || "").trim();
  const church = p.church?.trim() ?? "";
  const hasArch = !!p.archdeaconry?.trim();
  const archH = hasArch ? 0.5 + 2.6 * 1.2 : 0;
  const rowsH = (font: number, pad: number) => (n ? 1.4 + 0.35 + n * (font * TEXT_LH + 2 * pad + 0.35) : 0);
  const footH = (qr: number) => 1.2 + qr + 0.4 + 2.6 * TEXT_LH;
  const churchH = (lines: number, size: number) => (lines ? 0.8 + lines * size * TEXT_LH : 0);
  const slack = 1.2;

  // 1–2. photo on top. Start roomy, then squeeze one thing at a time until
  //      the photo keeps a sensible size.
  const crowded = n >= 4 || (design && n >= 3);
  const ROWS: [number, number][] = [[3.4, 0.8], [3.0, 0.45], [2.9, 0.35]];
  const base = n <= 2 ? 29 : n === 3 ? 26 : n === 4 ? 22 : 19;
  const churchMaxLines = church ? Math.min(2, wrap(church, 2.9, width * 0.97, 600).lines) : 0;
  const steps = [
    { rows: crowded ? 1 : 0, qr: crowded ? 17 : n === 3 ? 19 : 21, church: 2, name: 7.4, need: 15 },
    { rows: 1, qr: 17, church: 2, name: 7.4, need: 15 },
    { rows: 1, qr: 17, church: 1, name: 7.4, need: 14 },
    { rows: 2, qr: 16, church: 1, name: 6.2, need: 13 },
  ];
  let rowFont = ROWS[2][0], rowPad = ROWS[2][1];
  let qr = 16;
  let nameSize = fitNameSize(name, width);
  let churchLines = Math.min(churchMaxLines, 1);
  for (const st of steps) {
    const [font, pad] = ROWS[st.rows];
    const size = fitNameSize(name, width, st.name);
    const cl = Math.min(churchMaxLines, st.church);
    const textH = 1.6 + wrap(name, size, width * 0.95).lines * size * NAME_LH + churchH(cl, 2.9) + archH;
    const photoRoom = room - textH - rowsH(font, pad) - footH(st.qr) - slack;
    if (photoRoom >= st.need) {
      return { compact: false, nameSize: size, nameLines: 2, photo: Math.min(base, photoRoom),
               qr: st.qr, rowFont: font, rowPad: pad, churchLines: cl, churchSize: 2.9 };
    }
    rowFont = font; rowPad = pad; qr = st.qr; nameSize = size; churchLines = cl;
  }

  // 3. compact: photo beside the name. Pick the largest name size that fits
  //    both the narrow column and the height left, relaxing the church line
  //    and the QR a little if needed.
  const photo = 18;
  const textWidth = width - photo - 2.4;
  const colRoom = textWidth * 0.95;
  const churchSize = 2.7;
  const churchFull = church ? Math.min(2, wrap(church, churchSize, textWidth * 0.97, 600).lines) : 0;
  let nameLines = 5;
  nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  churchLines = Math.min(churchFull, 1);
  qr = 15;
  search:
  for (const step of [{ church: churchFull, qr: 16 }, { church: Math.min(churchFull, 1), qr: 16 }, { church: Math.min(churchFull, 1), qr: 15 }]) {
    const headRoom = room - rowsH(rowFont, rowPad) - footH(step.qr) - slack;
    for (const size of NAME_SIZES) {
      if (size > 6.0) continue;
      const fit = wrap(name, size, colRoom);
      if (fit.longest > colRoom || fit.lines > 5) continue;
      const head = Math.max(photo, fit.lines * size * NAME_LH + churchH(step.church, churchSize) + archH);
      if (head <= headRoom) {
        nameSize = size; nameLines = fit.lines; churchLines = step.church; qr = step.qr;
        break search;
      }
    }
  }
  return { compact: true, nameSize, nameLines, photo, qr, rowFont, rowPad, churchLines, churchSize };
}

/**
 * Builds a complete HTML page holding one tag per person, sized exactly to
 * the label, so the printer feeds one label per tag.
 *
 * Everything is laid out on a 62 × 100 mm design and scaled to the label.
 * The photo is the one thing that gives way on a crowded tag, so the QR and
 * the text always fit; the name is sized to stay on two lines.
 */
export async function buildTagHtml(
  people: TagData[], size: { w: number; h: number }, programmeTitle: string, opts: TagOptions = {},
): Promise<string> {
  const { w, h } = size;
  const style: TagStyle = opts.style ?? "colour";
  const design = opts.design?.trim() || null;
  const colour = style === "colour";

  const u = Math.min(w / 62, h / 100);
  const mm = (n: number) => `${(n * u).toFixed(2)}mm`;

  // the card's inner size, in unscaled mm, for planning each tag
  const W = w / u, H = h / u;
  const innerWidth = design ? W - 2 * 2.5 - 2 * 2.4 : W - 2 * 3;
  const titleLines = Math.max(1, Math.min(2, wrap((programmeTitle || " ").toUpperCase(), 2.8, W - 6, 800, 0.04).lines));
  const bandH = colour ? 2 * 2.4 + titleLines * 2.8 * TEXT_LH + 0.9 : 3 + 1.2 + titleLines * 2.8 * TEXT_LH + 0.5;
  const innerHeight = design
    ? H - (h * DESIGN_TOP_SHARE) / u - 2.5 - 2 * 1.8
    : H - bandH - 2 - (colour ? 3.2 : 2.4);

  const ink = colour ? "#111" : "#000";
  const accent = colour ? MAROON : "#000";
  const rule = colour ? "#E4D8CE" : "#000";

  const tags = await Promise.all(people.map(async (p) => {
    const qr = await makeQr(p.id);
    const name = (p.full_name || "").trim();
    const rows = (p.rows ?? []).slice(0, MAX_TAG_ROWS);
    const n = rows.length;

    const plan = planTag(p, n, innerHeight, innerWidth, design !== null);
    const { nameSize, photo, rowFont, rowPad } = plan;
    const qrSize = plan.qr;

    const rowHtml = rows.map((r) => `
        <div class="row" style="font-size:${mm(rowFont)};padding:${mm(rowPad)} 0">
          <span class="k">${esc(r.label)}</span><span class="v">${esc(r.value?.trim() || "—")}</span>
        </div>`).join("");

    const church = p.church?.trim();
    const arch = p.archdeaconry?.trim();
    const churchStyle = `font-size:${mm(plan.churchSize)};-webkit-line-clamp:${Math.max(1, plan.churchLines)}`;
    const photoHtml = p.photo_url
      ? `<img class="photo" style="height:${mm(photo)}${plan.compact ? `;width:${mm(photo)}` : ""}" src="${esc(p.photo_url)}" alt="" />`
      : `<div class="photo photo--none" style="height:${mm(photo)}${plan.compact ? `;width:${mm(photo)}` : ""};font-size:${mm(photo * 0.45)}">${esc(name.charAt(0).toUpperCase())}</div>`;
    const whoHtml = `
          <div class="name" style="font-size:${mm(nameSize)};-webkit-line-clamp:${plan.nameLines}">${esc(name)}</div>
          ${church ? `<div class="church" style="${churchStyle}">${esc(church)}</div>` : ""}
          ${arch ? `<div class="arch">${esc(arch)}</div>` : ""}`;

    return `
      <section class="tag${design ? " tag--design" : ""}">
        ${design
          ? `<img class="design" src="${esc(design)}" alt="" />`
          : `<div class="band">${esc(programmeTitle)}</div>`}
        <div class="card${plan.compact ? " card--compact" : ""}">
          ${plan.compact
            ? `<div class="head">${photoHtml}<div class="who">${whoHtml}</div></div>`
            : `${photoHtml}${whoHtml}`}
          ${n ? `<div class="rows">${rowHtml}</div>` : ""}
          <div class="foot">
            <img class="qr" style="width:${mm(qrSize)};height:${mm(qrSize)}" src="${qr}" alt="" />
            <div class="code">${shortCode(p.id)}</div>
          </div>
        </div>
      </section>`;
  }));

  return `<!doctype html><html><head><meta charset="utf-8"><title>Tags</title><style>
    @page { size: ${w}mm ${h}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: ${FONT}; color: ${ink}; background: #fff;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;   /* print the colours */
    }
    .tag {
      position: relative; width: ${w}mm; height: ${h}mm; overflow: hidden;
      display: flex; flex-direction: column;
      page-break-after: always; break-after: page;
    }
    .tag:last-child { page-break-after: auto; break-after: auto; }

    /* ---- top: plain band, or the programme's own design ---- */
    .band {
      flex: 0 0 auto; text-align: center; text-transform: uppercase; font-weight: 800;
      font-size: ${mm(2.8)}; letter-spacing: .04em; line-height: 1.15;
      ${colour
        ? `background: ${MAROON}; color: #fff; padding: ${mm(2.4)} ${mm(3)}; border-bottom: ${mm(0.9)} solid ${GOLD};`
        : `color: #000; padding: ${mm(3)} ${mm(3)} ${mm(1.2)}; margin: 0 ${mm(3)}; border-bottom: ${mm(0.5)} solid #000;`}
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
    }
    .design {
      position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0;
      ${colour ? "" : "filter: grayscale(1);"}
    }

    /* ---- the details ---- */
    .card {
      position: relative; z-index: 1; flex: 1 1 auto; min-height: 0;
      display: flex; flex-direction: column; align-items: center; text-align: center;
      padding: ${mm(2)} ${mm(3)} ${mm(colour && !design ? 3.2 : 2.4)};
    }
    .tag--design .card {
      margin: ${(h * DESIGN_TOP_SHARE).toFixed(2)}mm ${mm(2.5)} ${mm(2.5)};
      padding: ${mm(1.8)} ${mm(2.4)} ${mm(1.8)};
      background: rgba(255, 255, 255, .94); border-radius: ${mm(2.5)};
    }
    .card > * { flex-shrink: 0; }

    /* The photo is the one thing that gives way: on a crowded tag it shrinks so the QR always fits. */
    .photo {
      flex: 0 1 auto; aspect-ratio: 1 / 1; width: auto; min-height: ${mm(12)};
      object-fit: cover; object-position: center 20%;
      border: ${mm(0.6)} solid ${accent}; border-radius: ${mm(2.2)};
      ${colour ? "" : "filter: grayscale(1) contrast(1.25);   /* thermal printers are black only */"}
    }
    .photo--none {
      display: flex; align-items: center; justify-content: center; font-weight: 800;
      color: ${colour ? MAROON : "#000"}; background: ${colour ? "#F6EEE8" : "#fff"}; filter: none;
    }
    .name {
      font-weight: 800; line-height: 1.08; margin-top: ${mm(1.6)}; width: 100%;
      overflow-wrap: anywhere;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
    }
    .church {
      font-size: ${mm(2.9)}; font-weight: 600; line-height: 1.15; margin-top: ${mm(0.8)}; width: 100%;
      color: ${colour ? "#333" : "#000"};
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
    }
    .arch {
      font-size: ${mm(2.6)}; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
      line-height: 1.2; margin-top: ${mm(0.5)}; color: ${accent};
      max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* compact: photo beside the name, for crowded tags */
    .head { display: flex; align-items: center; gap: ${mm(2.4)}; width: 100%; text-align: left; }
    .head .photo { flex: 0 0 auto; min-height: 0; }
    .who { flex: 1 1 auto; min-width: 0; }
    .who .name { margin-top: 0; }
    .rows { width: 100%; margin-top: ${mm(1.4)}; border-top: ${mm(0.35)} solid ${rule}; }
    .row {
      display: flex; justify-content: space-between; align-items: baseline; gap: ${mm(2)};
      border-bottom: ${mm(0.35)} solid ${rule}; line-height: 1.15;
    }
    .k {
      font-weight: ${colour ? 700 : 400}; color: ${accent}; text-transform: uppercase;
      font-size: .72em; letter-spacing: .05em; white-space: nowrap;
    }
    .v { font-weight: 800; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .foot { margin-top: auto; display: flex; flex-direction: column; align-items: center; padding-top: ${mm(1.2)}; }
    .qr { image-rendering: pixelated; display: block; }
    .code {
      font-family: "Courier New", monospace; font-weight: 700; font-size: ${mm(2.6)};
      letter-spacing: .12em; margin-top: ${mm(0.4)}; color: ${colour ? "#333" : "#000"};
    }
    ${colour && !design ? `.tag::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: ${mm(1.6)}; background: ${MAROON}; }` : ""}
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

    // Wait for photos, the design and the QR codes, or the labels come out blank.
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