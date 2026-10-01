// The QA decision stamped on an AVS report PDF (owner's request, 1 Oct 2026).
//
// Claude files the report before QA decides, so the PDF in Drive has no
// decision on it. CI Plant serves the PDF itself (GET /avs/reports/:no/pdf) and,
// once QA has released, rejected or kept the issue on hold, draws the decision
// on it: a band across the top of page 1 (words, who, when, remark) and one
// line in the bottom margin of every page. The Drive copy is never changed.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const TONES = {
  green: { ink: rgb(0.08, 0.5, 0.24), bg: rgb(0.9, 0.97, 0.92) },
  red: { ink: rgb(0.69, 0, 0.13), bg: rgb(0.99, 0.92, 0.93) },
  amber: { ink: rgb(0.63, 0.36, 0), bg: rgb(1, 0.96, 0.88) },
};

// pdf-lib's standard fonts speak WinAnsi only: anything else becomes '?'.
const safe = t => String(t ?? '').replace(/₹/g, 'Rs.').replace(/[–—]/g, '-').replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

function fit(font, text, size, width) {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t}...`;
}

export async function stampPdf(bytes, stamp) {
  if (!stamp) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const tone = TONES[stamp.tone] || TONES.green;
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    if (i === 0) {
      // Top band of page 1, inside the top margin (14 mm), above the title.
      const h = stamp.remark ? 30 : 20;
      const y = height - h - 4;
      page.drawRectangle({ x: 36, y, width: width - 72, height: h, color: tone.bg, borderColor: tone.ink, borderWidth: 1.2 });
      page.drawText(safe(stamp.words), { x: 44, y: y + h - 14, size: 11, font: bold, color: tone.ink });
      const left = 44 + bold.widthOfTextAtSize(safe(stamp.words), 11) + 10;
      page.drawText(fit(reg, stamp.line, 9, width - 72 - (left - 36) - 8), { x: left, y: y + h - 13.5, size: 9, font: reg, color: tone.ink });
      if (stamp.remark) {
        page.drawText(fit(reg, `Remark: ${stamp.remark}`, 8, width - 88), { x: 44, y: y + 5, size: 8, font: reg, color: tone.ink });
      }
    }
    // Every page: one line in the bottom margin, under the footer.
    const t = fit(bold, `${stamp.words}${stamp.line ? ` - ${stamp.line}` : ''}`, 7.5, width - 72);
    page.drawText(t, { x: (width - bold.widthOfTextAtSize(t, 7.5)) / 2, y: 12, size: 7.5, font: bold, color: tone.ink });
  });
  doc.setSubject(`${safe(stamp.words)} ${safe(stamp.line)}`.trim());
  return doc.save();
}
