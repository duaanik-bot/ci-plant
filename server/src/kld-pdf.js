// A KLD as the die maker's PDF: page one is the blank at 1:1 (millimetres) with its dimensions and a title block,
// page two the print sheet with every up. Drawn from the saved KLD (costing_sizes.kld) and the same geometry the
// screen draws (client/src/lib/kld.js), so the two never disagree. Standard fonts: text goes through pdfSafe.
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { kldBlank } from '../../client/src/lib/kld.js';
import { layoutBlocks, overRulesText, cleanSettings, outputText, READING_LABEL, IN } from '../../client/src/lib/sizing.js';
import { pdfSafe } from './quotation-pdf.js';

const PT = 72 / 25.4;
const RED = rgb(0.75, 0.16, 0.11), BLUE = rgb(0.12, 0.31, 0.64), GREEN = rgb(0.04, 0.48, 0.29);
const INK = rgb(0.11, 0.15, 0.19), MUTED = rgb(0.35, 0.4, 0.45);
const GLUE = rgb(0.98, 0.92, 0.72), BODY = rgb(0.9, 0.93, 0.97), FLAP = rgb(0.98, 0.87, 0.84);
const istDate = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
  .format(d ? new Date(d) : new Date());
const mm = x => String(Math.round(x * 100) / 100);

export async function kldPdf({ kld, title = '' }) {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`KLD ${kld.size_key || ''} rev ${kld.rev || 1}`));
  doc.setProducer('CI Plant');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const blank = kldBlank({ construction: kld.construction, tube: kld.tube, face: kld.face, w: kld.w });

  // ── page one: the blank at 1:1 ──────────────────────────────────────────────────────────────────
  const M = 15, right = 22, below = 14, block = 34;
  const pw = Math.max(297, blank.width + M + right + M), ph = Math.max(210, M + blank.height + below + block + M);
  const page = doc.addPage([pw * PT, ph * PT]);
  const X = x => (M + x) * PT, Y = y => (ph - M - y) * PT;
  const svg = (path, o) => page.drawSvgPath(path, { x: X(0), y: Y(0), scale: PT, ...o });
  svg(blank.glue, { color: GLUE });
  for (const c of blank.crease) svg(c, { borderColor: BLUE, borderWidth: 0.25, borderDashArray: [2, 1.2] });
  for (const c of blank.cut) svg(c, { borderColor: RED, borderWidth: 0.3 });
  // grain arrow
  const g = blank.grain;
  page.drawLine({ start: { x: X(g.x1), y: Y(g.y1) }, end: { x: X(g.x2), y: Y(g.y2) }, thickness: 1.2, color: GREEN });
  page.drawSvgPath(`M0,0 L-3,-1.5 L-3,1.5 Z`, { x: X(g.x2), y: Y(g.y2), scale: PT, color: GREEN });
  page.drawText('grain', { x: X((g.x1 + g.x2) / 2) - 8, y: Y(g.y1) + 4, size: 7, font, color: GREEN });
  // dimensions
  for (const d of blank.dims) {
    page.drawLine({ start: { x: X(d.x1), y: Y(d.y1) }, end: { x: X(d.x2), y: Y(d.y2) }, thickness: 0.4, color: GREEN });
    for (const [px, py] of [[d.x1, d.y1], [d.x2, d.y2]]) {
      const tick = d.side === 'h' ? [[px, py - 1.2], [px, py + 1.2]] : [[px - 1.2, py], [px + 1.2, py]];
      page.drawLine({ start: { x: X(tick[0][0]), y: Y(tick[0][1]) }, end: { x: X(tick[1][0]), y: Y(tick[1][1]) }, thickness: 0.4, color: GREEN });
    }
    const label = pdfSafe(d.label), w = font.widthOfTextAtSize(label, 7);
    if (d.side === 'h') page.drawText(label, { x: X((d.x1 + d.x2) / 2) - w / 2, y: Y(d.y1) + 1.5, size: 7, font, color: GREEN });
    else page.drawText(label, { x: X(d.x1) - 1.5, y: Y((d.y1 + d.y2) / 2) - w / 2, size: 7, font, color: GREEN, rotate: degrees(90) });
  }
  // title block
  const lay = kld.layout;
  const over = overRulesText(lay);
  const rules = `Glue ${mm(blank.glueWidth)} · tuck ${mm(blank.tuck)} · dust ${mm(blank.dust)}${blank.lock != null ? ` · lock ${mm(blank.lock)}` : ''} mm`;
  const lines = [
    [bold, 12, `KLD  ${title || kld.size_key || ''}`],
    [font, 9, `${READING_LABEL[kld.reading] || kld.construction} · ${mm(blank.width)} × ${mm(blank.height)} mm blank · ${rules}`],
    ...(lay ? [[font, 9, `Print sheet ${lay.sheet_short} × ${lay.sheet_long} in · ${lay.ups} up (${lay.m} × ${lay.n}) · board grain along the ${lay.across_on === 'long' ? lay.sheet_long : lay.sheet_short} in side`]] : []),
    ...(over ? [[bold, 8, over, RED]] : []),
    [font, 9, `Rev ${kld.rev || 1} · drawn ${istDate(kld.drawn_at)}${kld.drawn_by ? ` by ${kld.drawn_by}` : ''} · CI Plant`],
    [font, 8, `Inner sizes at 1:1. Red = cut, blue dashed = crease, yellow = glue, green arrow = board grain.${kld.construction === 'LOCK' ? ' Lock flaps follow the standard pattern: check against the die maker\'s.' : ''}`],
  ];
  let ty = ph - M - block + 4;
  page.drawLine({ start: { x: M * PT, y: (M + block) * PT }, end: { x: (pw - M) * PT, y: (M + block) * PT }, thickness: 0.6, color: INK });
  for (const [f, size, text, color] of lines) {
    page.drawText(pdfSafe(text), { x: M * PT, y: (ph - ty) * PT - size, size, font: f, color: color || (f === bold ? INK : MUTED) });
    ty += size * 0.48;
  }

  // ── page two: the output — the print sheet with every up (owner, 13 Nov 2026: "proper layout options also for output
  // setting"): the gripper band, the edges, each up numbered at its place with the gaps, and the settings it was drawn with.
  if (lay && lay.m > 0 && lay.n > 0) {
    const p2 = doc.addPage([297 * PT, 210 * PT]);
    const SL = lay.sheet_long * IN, SS = lay.sheet_short * IN;
    const s = Math.min((297 - 2 * M) / SL, (210 - 2 * M - 30) / SS);
    const ox = M, oy = 210 - M - 14;           // top-left of the sheet, mm on the page (y up)
    const P = (x, y) => ({ x: (ox + x * s) * PT, y: (oy - y * s) * PT });
    const mm0 = x => String(Math.round(x));
    p2.drawText(pdfSafe(`Output · ${lay.sheet_short} × ${lay.sheet_long} in (${mm0(SS)} × ${mm0(SL)} mm) · ${lay.ups} up (${lay.m} × ${lay.n}) · ${title || kld.size_key || ''}`),
      { x: M * PT, y: (210 - M) * PT - 4, size: 11, font: bold, color: INK });
    p2.drawRectangle({ x: P(0, SS).x, y: P(0, SS).y, width: SL * s * PT, height: SS * s * PT, borderColor: INK, borderWidth: 1, color: rgb(1, 1, 1) });
    const st = cleanSettings(lay.settings);
    if (st.gripper > 0) {
      // the gripper bites the long edge drawn at the top
      p2.drawRectangle({ x: P(0, st.gripper).x, y: P(0, st.gripper).y, width: SL * s * PT, height: st.gripper * s * PT, color: rgb(0.88, 0.9, 0.93) });
      p2.drawText(pdfSafe(`GRIPPER ${st.gripper} mm`), { x: P(4, 0).x, y: P(0, st.gripper).y + 1.5, size: 6.5, font: bold, color: MUTED });
    }
    if (st.gripper > 0 || st.edge > 0) {
      p2.drawRectangle({ x: P(st.edge, SS - st.edge).x, y: P(st.edge, SS - st.edge).y, width: (SL - 2 * st.edge) * s * PT,
        height: (SS - st.gripper - st.edge) * s * PT, borderColor: MUTED, borderWidth: 0.4, borderDashArray: [2, 1.5] });
    }
    const reading = { construction: kld.construction, tube: kld.tube, face: kld.face, w: kld.w };
    const blocks = layoutBlocks(null, reading, { acrossOn: lay.across_on, m: lay.m, n: lay.n, settings: lay.settings });
    for (const b of blocks) {
      const at = P(b.x, b.y + b.h);
      p2.drawRectangle({ x: at.x, y: at.y, width: b.w * s * PT, height: b.h * s * PT,
        color: b.kind === 'body' ? BODY : b.kind === 'glue' ? GLUE : FLAP, borderColor: b.kind === 'flap' ? RED : BLUE, borderWidth: 0.5 });
    }
    // each up numbered at the middle of its body
    blocks.filter(b => b.kind === 'body').forEach((b, i) => {
      const label = String(i + 1), w = bold.widthOfTextAtSize(label, 9);
      const c = P(b.x + b.w / 2, b.y + b.h / 2);
      p2.drawText(label, { x: c.x - w / 2, y: c.y - 3, size: 9, font: bold, color: INK });
    });
    const below = (oy - SS * s) * PT;
    const grainText = `Board grain must run along the ${lay.across_on === 'long' ? lay.sheet_long : lay.sheet_short} in side (round the carton).`;
    p2.drawText(pdfSafe(grainText), { x: M * PT, y: below - 8 * PT, size: 9, font, color: GREEN });
    p2.drawText(pdfSafe(`Output settings: ${outputText(lay)}.`), { x: M * PT, y: below - 13 * PT, size: 9, font, color: MUTED });
    if (over) p2.drawText(pdfSafe(over), { x: M * PT, y: below - 18 * PT, size: 9, font: bold, color: RED });
  }
  return doc.save();
}
