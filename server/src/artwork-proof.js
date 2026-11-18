// The approval proof (owner, 17 Nov 2026: the proof is the designer's CorelDRAW export; "make the stamp 'Colour
// Impressions' for approval of design and text … a good industry-standard stamp"). Design:
// plans/2026-11-17-artwork-workflow-design.md §6.
//
// Each page of the designer's export is copied UNTOUCHED (embedded as a whole page: no colour conversion, no
// re-drawing) onto a taller page; below it a strip carries the proof data and a drawn rubber stamp. The stamp is vector,
// so it stays sharp at any size. Nothing is drawn over the artwork.
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const MM = 72 / 25.4;
export const STRIP_MM = 45;
const MIN_W_MM = 190;                       // the strip needs this much room, whatever the carton's width
const INK = rgb(0.11, 0.27, 0.62);          // stamp blue
const GREY = rgb(0.35, 0.35, 0.35);
const BLACK = rgb(0, 0, 0);

const dateOf = iso => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })
  .format(new Date(Number.isFinite(Date.parse(iso)) ? iso : Date.now()));
const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(1)));

// The stamp's words.
export function stampText(info) {
  return { ring: 'COLOUR IMPRESSIONS', band: ['APPROVAL OF', 'DESIGN & TEXT'], no: info.proof_no, date: dateOf(info.date).toUpperCase() };
}

// Only characters the PDF's standard font can draw; anything else becomes "?".
const drawable = font => {
  const ok = new Set(font.getCharacterSet());
  return s => [...String(s ?? '')].map(ch => (ok.has(ch.codePointAt(0)) ? ch : '?')).join('');
};

function drawStamp(page, fonts, info, cx, cy, r, clean) {
  const s = stampText(info);
  page.drawCircle({ x: cx, y: cy, size: r, borderColor: INK, borderWidth: 1.6, opacity: 0, borderOpacity: 0.95 });
  page.drawCircle({ x: cx, y: cy, size: r * 0.72, borderColor: INK, borderWidth: 0.8, opacity: 0, borderOpacity: 0.95 });
  // COLOUR IMPRESSIONS round the top of the ring, each letter turned to follow it
  const size = r * 0.125, ring = r * 0.855;
  const letters = [...clean(s.ring)];
  const widths = letters.map(ch => fonts.bold.widthOfTextAtSize(ch, size));
  const total = widths.reduce((a, b) => a + b, 0) + (letters.length - 1) * size * 0.12;
  let angle = Math.PI / 2 + total / ring / 2;                   // start left of the top, run clockwise
  letters.forEach((ch, i) => {
    const half = widths[i] / 2 / ring;
    angle -= half;
    const x = cx + ring * Math.cos(angle), y = cy + ring * Math.sin(angle);
    const rot = angle - Math.PI / 2;
    // place the letter so its centre sits on the ring, upright towards the outside
    page.drawText(ch, { x: x - (widths[i] / 2) * Math.cos(rot), y: y - (widths[i] / 2) * Math.sin(rot) - size * 0.35,
      size, font: fonts.bold, color: INK, rotate: degrees((rot * 180) / Math.PI) });
    angle -= half + (size * 0.12) / ring;
  });
  // ★ marks at the sides of the lower ring, as rubber stamps carry
  for (const a of [Math.PI * 1.08, Math.PI * 1.92]) {
    page.drawCircle({ x: cx + ring * Math.cos(a), y: cy + ring * Math.sin(a), size: size * 0.22, color: INK });
  }
  // the band across the middle
  const bh = r * 0.5;
  page.drawRectangle({ x: cx - r * 1.05, y: cy - bh / 2, width: r * 2.1, height: bh, color: rgb(1, 1, 1), borderColor: INK, borderWidth: 1.2 });
  const b1 = clean(s.band[0]), b2 = clean(s.band[1]), bs = r * 0.16;
  page.drawText(b1, { x: cx - fonts.bold.widthOfTextAtSize(b1, bs) / 2, y: cy + bh * 0.06, size: bs, font: fonts.bold, color: INK });
  page.drawText(b2, { x: cx - fonts.bold.widthOfTextAtSize(b2, bs) / 2, y: cy - bh * 0.36, size: bs, font: fonts.bold, color: INK });
  // proof number and date inside, under the band
  const ns = r * 0.085, no = clean(s.no), dt = clean(s.date);
  page.drawText(no, { x: cx - fonts.reg.widthOfTextAtSize(no, ns) / 2, y: cy - bh / 2 - ns * 1.6, size: ns, font: fonts.reg, color: INK });
  page.drawText(dt, { x: cx - fonts.bold.widthOfTextAtSize(dt, ns * 1.2) / 2, y: cy - bh / 2 - ns * 3.3, size: ns * 1.2, font: fonts.bold, color: INK });
}

// → { bytes, sha256, lines, page_w_mm, page_h_mm } — page size = the export's first page.
export async function buildProof({ pdfBytes, info }) {
  let src;
  try { src = await PDFDocument.load(pdfBytes, { ignoreEncryption: false }); }
  catch { throw Object.assign(new Error("The designer's file could not be read as a PDF — export it again from CorelDRAW."), { status: 422 }); }
  const out = await PDFDocument.create();
  out.setTitle(`Proof ${info.proof_no}`);
  out.setProducer('CI Plant');
  const fonts = { reg: await out.embedFont(StandardFonts.Helvetica), bold: await out.embedFont(StandardFonts.HelveticaBold) };
  const clean = drawable(fonts.reg);
  const pages = src.getPages();
  if (!pages.length) throw Object.assign(new Error("The designer's PDF has no pages."), { status: 422 });
  const first = pages[0].getSize();
  const w0 = num(first.width / MM), h0 = num(first.height / MM);
  const colours = (info.colours || []).filter(Boolean);
  const lines = [
    `PROOF ${info.proof_no}   ·   ${dateOf(info.date)}`,
    `Client: ${info.customer || '—'}`,
    `Product: ${info.product_name || '—'}   ·   ${[info.client_item_code, info.label].filter(Boolean).join(' ')}`,
    `Size: ${w0} × ${h0} mm${pages.length > 1 ? `   ·   ${pages.length} pages` : ''}`,
    `Colours: ${colours.length ? colours.join(', ') : 'as in the file'}`,
    'FOR APPROVAL — NOT FOR PRINT',
    'Please check design, text and colours, and quote the proof number in your reply.',
  ].map(clean);

  // a page with nothing drawn on it has no content stream, which cannot be embedded: give it an empty one
  for (const p of pages) if (!p.node.Contents()) p.drawRectangle({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });
  const embedded = await out.embedPages(pages);
  embedded.forEach((art, i) => {
    const { width, height } = pages[i].getSize();
    const W = Math.max(width, MIN_W_MM * MM), S = STRIP_MM * MM;
    const page = out.addPage([W, height + S]);
    page.drawPage(art, { x: (W - width) / 2, y: S, width, height });
    page.drawLine({ start: { x: 0, y: S }, end: { x: W, y: S }, thickness: 0.4, color: GREY, dashArray: [3, 2] });
    const stampR = (S / 2) * 0.86;
    const left = 6 * MM, textW = W - left - stampR * 2.4 - 8 * MM;
    let y = S - 9 * MM;
    lines.forEach((l, k) => {
      const last2 = k >= lines.length - 2;
      const size = k === 0 ? 11 : last2 ? 7.5 : 8.5;
      const font = k === 0 || k === lines.length - 2 ? fonts.bold : fonts.reg;
      let t = l;
      while (t.length > 4 && font.widthOfTextAtSize(t, size) > textW) t = `${t.slice(0, -2)}…`.replace(/……$/, '…');
      page.drawText(clean(t), { x: left, y, size, font, color: last2 ? INK : BLACK });
      y -= size + 2.8;
    });
    drawStamp(page, fonts, info, W - stampR * 1.25 - 4 * MM, S / 2, stampR, clean);
  });
  const bytes = await out.save();
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), lines, page_w_mm: w0, page_h_mm: h0 };
}
