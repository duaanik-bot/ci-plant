// The customer's quotation as a PDF (A4), made from a quotation row and the letterhead only — never from a
// costing (enquiry-desk.js customerLine is the only source of its lines). Standard fonts, so ₹ is written
// "Rs." and anything the font cannot draw becomes "?".
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// What WinAnsi (the standard fonts' encoding) can draw beyond Latin-1.
const WIN_ANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
export function pdfSafe(s) {
  return String(s ?? '').replace(/₹\s?/g, 'Rs. ').replace(/[   ]/g, ' ')
    .replace(/[^\n\x20-\x7e\xa1-\xff]/g, ch => (WIN_ANSI_EXTRA.has(ch) ? ch : '?'));
}
const money = n => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const istDate = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
  .format(d ? new Date(d) : new Date());

// Words wrapped to a width, each line a string.
function wrap(text, font, size, width) {
  const out = [];
  for (const para of pdfSafe(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) out.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

export async function quotationPdf(qt, entity = {}, { trialFor = null } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`Quotation ${qt.quotation_no}`));
  doc.setAuthor(pdfSafe(entity.name || 'Colour Impressions'));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 40;
  const ink = rgb(0.11, 0.11, 0.12), grey = rgb(0.4, 0.42, 0.46), line = rgb(0.82, 0.84, 0.87);
  let page = doc.addPage([W, H]);
  let y = H - M;
  const draw = (t, x, size = 10, f = font, color = ink) => page.drawText(pdfSafe(t), { x, y, size, font: f, color });
  const right = (t, xr, size = 10, f = font) => { const s = pdfSafe(t); page.drawText(s, { x: xr - f.widthOfTextAtSize(s, size), y, size, font: f, color: ink }); };
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };

  if (trialFor) {
    draw(`TRIAL — in business use this would go to ${trialFor}`, M, 9, bold, rgb(0.71, 0.28, 0.03));
    y -= 16;
  }
  // Letterhead
  draw(entity.name || 'Colour Impressions', M, 16, bold);
  y -= 14;
  // The city and state are added only when the address does not already carry them.
  const has = x => x && String(entity.address || '').toLowerCase().includes(String(x).toLowerCase());
  const address = [entity.address, has(entity.city) ? null : entity.city, has(entity.state) ? null : entity.state].filter(Boolean).join(', ');
  for (const l of [entity.tagline, address, entity.gstin ? `GSTIN ${entity.gstin}` : null].filter(Boolean)) {
    for (const w of wrap(l, font, 9, W - 2 * M)) { draw(w, M, 9, font, grey); y -= 11; }
  }
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: line });
  y -= 22;
  draw('QUOTATION', M, 13, bold);
  right(`No. ${qt.quotation_no}`, W - M, 10, bold);
  y -= 14;
  right(`Date ${istDate(qt.created_at)}`, W - M, 9);
  y -= 18;
  draw('To', M, 9, font, grey); y -= 12;
  for (const l of [qt.customer_name, qt.contact_name && qt.contact_name !== qt.customer_name ? `Kind attn: ${qt.contact_name}` : null, qt.contact_email].filter(Boolean)) {
    draw(l, M, 10, l === qt.customer_name ? bold : font); y -= 13;
  }
  y -= 10;

  // The table: each item's rate a carton at each quantity — no amount and no total (owner, 3 Nov 2026).
  const cols = [
    { k: 'n', label: '#', x: M, w: 18 },
    { k: 'item', label: 'Item and specification', x: M + 20, w: 330 },
    { k: 'qty', label: 'Quantity', x: M + 360, w: 70, right: true },
    { k: 'rate', label: 'Rate a carton (Rs.)', x: M + 435, w: W - 2 * M - 435, right: true },
  ];
  const header = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.95, 0.96, 0.97) });
    for (const c of cols) (c.right ? right(c.label, c.x + c.w, 8, bold) : draw(c.label, c.x, 8, bold));
    y -= 18;
  };
  header();
  (qt.lines || []).forEach((l, i) => {
    const item = wrap([l.product, l.size ? `${l.size} mm` : null].filter(Boolean).join(' — '), bold, 9, cols[1].w);
    const specs = l.specs ? wrap(l.specs, font, 8, cols[1].w) : [];
    const need = (item.length + specs.length) * 11 + 8;
    if (y - need < M + 120) { newPage(); header(); }
    draw(String(i + 1), cols[0].x, 9);
    right(Number(l.qty).toLocaleString('en-IN'), cols[2].x + cols[2].w, 9);
    right(money(l.rate), cols[3].x + cols[3].w, 9);
    for (const t of item) { draw(t, cols[1].x, 9, bold); y -= 11; }
    for (const t of specs) { draw(t, cols[1].x, 8, font, grey); y -= 11; }
    y -= 4;
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.5, color: line });
    y -= 6;
  });
  y -= 14;

  if (qt.terms) {
    if (y < M + 90) newPage();
    draw('Terms', M, 9, bold); y -= 12;
    for (const t of wrap(qt.terms, font, 9, W - 2 * M)) { draw(t, M, 9, font, grey); y -= 11; }
    y -= 14;
  }
  if (y < M + 50) newPage();
  draw(`for ${entity.name || 'Colour Impressions'}`, M, 10, bold);
  return doc.save();
}
