// ─── Branded report exporter — PDF (jsPDF) + Excel (ExcelJS) ────────────────
// One spec drives both formats:
//   { name, title, subtitle, meta: ['Status: Open', ...], summary: [{label, value}],
//     columns, rows,                          // simple single-table report
//     sections: [{ heading, columns, rows, summary, pdfColumns?, pdfGroup? }],
//     orientation,                            // 'portrait' | 'landscape' (auto by width)
//     sheetPerSection }                       // XLSX only: one worksheet per section,
//                                             // each with its own filter + frozen header
// Column: { key, label, align, render?, export?, exportable?, pdfWeight?, pdfTone? }.
// pdfGroup: { by(row), label(rows), status?(rows), tone?(rows) } — prints the
// section as banded groups with a coloured rail (PDF only; see the section loop).
// pdfTone(row) -> a PDF_TONE key, colouring that one cell by what it MEANS.
//
// PAPER IS NOT A SPREADSHEET. A section may carry `pdfColumns` — a second,
// usually shorter column set used for the PDF only, while `columns` still
// drives Excel. Excel wants one fact per column so it can be filtered and
// pivoted; an A4 page wants few enough columns that each one can hold a word.
// Combining "product · code · artwork" into one printed cell (newlines allowed)
// is the difference between a readable page and sixteen vertical letter strips.
// See `pdfWeight` at the section loop for how printed widths are shared out.
// Value resolution: col.export(row) → nodeText(col.render(row)) → row[key].
// Libraries are dynamically imported so the main bundle stays light.
// Extension spelled out: Vite resolves '../api' happily, plain Node does not,
// and this module is imported by a node:test that asserts its palette.
import { auth } from '../api.js';

export const BRAND = {
  company: 'Colour Impressions',
  companyAccentWord: 'Impressions', // rendered in systemBlue in the wordmark
  tagline: 'Pharma & FMCG Carton Plant · Rajpura, Punjab',
  gstin: 'GSTIN 03BCMPD4475P1Z7',
  app: 'CI ERP',
  accent: [0, 122, 255],      // #007AFF systemBlue
  accentDeep: [0, 100, 210],  // #0064D2
  ink: [29, 29, 31],          // #1D1D1F
  sub: [110, 110, 115],       // #6E6E73
  faint: [134, 134, 139],     // #86868B
  hairline: [229, 231, 235],
  headFill: [241, 245, 251],  // table head — cool slate wash
  rowAlt: [248, 250, 253],
  chipFill: [230, 240, 255],  // meta chips — blue-50
};

// ─── Significance palette ────────────────────────────────────────────────────
// The printed twin of the screen's vocabulary, so a report means the same thing
// on paper as it does in the app. Colour here is never decoration: a tone is
// only ever applied to a cell whose VALUE carries that meaning, and every toned
// cell still says the word as well ("Stock Short — No PR Raised"), because a
// report gets photocopied, faxed and printed in mono.
//
// The two troubled tones are both red and DEPTH separates them, exactly as the
// board badges do on screen: `alert` = someone has already acted (a PR is
// raised, a count found a discrepancy), `alarm` = nobody has acted yet.
export const PDF_TONE = {
  ok:    { text: [4, 120, 87],    fill: [236, 253, 245], rail: [16, 185, 129] },  // emerald
  warn:  { text: [146, 64, 14],   fill: [255, 251, 235], rail: [245, 158, 11] },  // amber
  alert: { text: [185, 28, 28],   fill: [254, 242, 242], rail: [248, 113, 113] }, // soft red
  alarm: { text: [153, 27, 27],   fill: [254, 226, 226], rail: [220, 38, 38] },   // hard red
  info:  { text: [0, 100, 210],   fill: [230, 240, 255], rail: [0, 122, 255] },   // systemBlue
  muted: { text: [100, 116, 139], fill: [248, 250, 253], rail: [203, 213, 225] }, // slate
};

// Extract readable text from a rendered JSX cell (badges, formatted spans …).
export function nodeText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).filter(Boolean).join(' ');
  return nodeText(node.props?.children);
}

// jsPDF core fonts are WinAnsi — swap glyphs that would print as garbage.
//
// The newline is deliberately kept: autoTable renders "\n" as a real line break,
// and a printed cell that stacks "product / code / artwork" is how a wide report
// survives on paper. Before it was whitelisted the strip below deleted it
// outright, which did not merely lose the break — it GLUED the two lines into
// one unbreakable word ("CARTONSAMPLE-2015498SW-513"), the very thing that
// forces per-character wrapping.
function pdfText(v) {
  return String(v ?? '')
    .replace(/₹\s?/g, 'Rs ')
    .replace(/→/g, '->').replace(/←/g, '<-')
    .replace(/✓|✔/g, 'Yes').replace(/✕|✗|×/g, 'x')
    .replace(/…/g, '...')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E\n -ÿ–—·]/g, '');
}

function cellValue(col, row) {
  if (col.export) return col.export(row);
  if (col.render) return nodeText(col.render(row));
  const v = row[col.key];
  return v == null ? '' : v;
}

export function exportableColumns(columns) {
  return (columns || []).filter(c => c.exportable !== false && c.label && c.key && !String(c.key).startsWith('_'));
}

function stamp() {
  const d = new Date();
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const fileStamp = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s || 'report').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function normalizeSection(s) {
  const columns = exportableColumns(s.columns);
  const rows = s.rows || [];
  // A PDF-only column set, resolved against the same rows. Absent on every
  // report that does not need one, in which case the PDF prints `columns`.
  const pdfColumns = s.pdfColumns ? exportableColumns(s.pdfColumns) : null;
  return {
    heading: s.heading,
    columns,
    pdfColumns,
    // The rows themselves ride along: grouping and per-cell tones are decided
    // from the row, not from the flattened text of its cells.
    rows,
    pdfGroup: s.pdfGroup || null,
    pdfRowTone: s.pdfRowTone || null,
    summary: (s.summary || []).filter(Boolean),
    grid: rows.map((r, i) => [i + 1, ...columns.map(c => cellValue(c, r))]),
    pdfGrid: pdfColumns ? rows.map((r, i) => [i + 1, ...pdfColumns.map(c => cellValue(c, r))]) : null,
  };
}

// A report is filed by what it is plus when it was pulled, so `name` gets the
// date stamp appended. A DOCUMENT is filed by its own number — CI-VPO-0017 is
// already unique and a re-download should overwrite, not accumulate — so a spec
// may name its file outright with `fileName` and skip the stamp entirely.
const specFileName = spec => (spec.fileName
  ? slug(spec.fileName)
  : `${slug(spec.name || spec.title)}_${fileStamp()}`);

function normalizeSpec(spec) {
  const sections = (spec.sections && spec.sections.length
    ? spec.sections
    : [{ columns: spec.columns, rows: spec.rows, summary: null }]
  ).filter(s => (s.rows || []).length || (s.columns || []).length).map(normalizeSection);
  return {
    name: spec.name,
    fileName: spec.fileName,
    orientation: spec.orientation,
    sheetPerSection: !!spec.sheetPerSection,
    title: spec.title || spec.name || 'Report',
    subtitle: spec.subtitle,
    meta: (spec.meta || []).filter(Boolean),
    summary: (spec.summary || []).filter(Boolean),
    sections,
    rowCount: sections.reduce((n, s) => n + s.grid.length, 0),
  };
}

export function specRowCount(spec) {
  if (spec.sections?.length) return spec.sections.reduce((n, s) => n + (s.rows || []).length, 0);
  return (spec.rows || []).length;
}

// ─── PDF ─────────────────────────────────────────────────────────────────────
export async function exportPDF(rawSpec) {
  const spec = normalizeSpec(rawSpec);
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  // Measured on what will actually be PRINTED, so a section that trades 16
  // spreadsheet columns for 9 printed ones is judged on the 9.
  const widest = Math.max(...spec.sections.map(s => (s.pdfColumns || s.columns).length), 0);
  const landscape = spec.orientation ? spec.orientation === 'landscape' : widest > 6;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  const user = auth?.user || null;

  const footer = () => {
    const page = doc.internal.getCurrentPageInfo().pageNumber;
    doc.setDrawColor(...BRAND.hairline).setLineWidth(0.25);
    doc.line(M, H - 11, W - M, H - 11);
    doc.setFont('helvetica', 'normal').setFontSize(6.8).setTextColor(...BRAND.faint);
    doc.text(`${BRAND.app} · ${BRAND.company} · ${pdfText(spec.title)}`, M, H - 7);
    doc.text(`Page ${page}`, W - M, H - 7, { align: 'right' });
  };
  // `continued` names the group whose rows spill onto this page. Without it a
  // grouped section reads as anonymous rows after every page break: the band
  // carrying the board name is back on the previous page, and the reader has
  // no way to tell which board the first rows belong to.
  const contHeader = (continued = null) => {
    doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...BRAND.ink);
    doc.text(`${BRAND.company} — ${pdfText(spec.title)}`, M, 12);
    if (continued) {
      doc.setFont('helvetica', 'normal').setFontSize(7.4).setTextColor(...BRAND.sub);
      doc.text(`${pdfText(continued)} — continued`, W - M, 12, { align: 'right' });
    }
    doc.setDrawColor(...BRAND.hairline).setLineWidth(0.25);
    doc.line(M, 15, W - M, 15);
  };

  // ── Header (first page) ──
  let y = 16;
  // Wordmark — "Colour" ink + "Impressions" systemBlue, exactly like the sidebar.
  doc.setFont('helvetica', 'bold').setFontSize(17).setTextColor(...BRAND.ink);
  const w1 = 'Colour ';
  doc.text(w1, M, y);
  doc.setTextColor(...BRAND.accent);
  doc.text(BRAND.companyAccentWord, M + doc.getTextWidth(w1), y);
  doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...BRAND.faint);
  doc.text(`${BRAND.tagline}  ·  ${BRAND.gstin}`, M, y + 5);

  // Right block — report identity.
  doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(...BRAND.ink);
  doc.text(pdfText(spec.title), W - M, y, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...BRAND.sub);
  const genLine = `Generated ${stamp()}${user?.name ? `  ·  ${user.name}` : ''}`;
  if (spec.subtitle) {
    doc.text(pdfText(spec.subtitle), W - M, y + 4.5, { align: 'right' });
    doc.text(genLine, W - M, y + 8.5, { align: 'right' });
  } else {
    doc.text(genLine, W - M, y + 4.5, { align: 'right' });
  }

  // Accent rule under the header.
  y += 12;
  doc.setDrawColor(...BRAND.accent).setLineWidth(0.9);
  doc.line(M, y, M + 22, y);
  doc.setDrawColor(...BRAND.hairline).setLineWidth(0.25);
  doc.line(M + 22, y, W - M, y);
  y += 5;

  // ── Meta chips (active filters / context) ──
  if (spec.meta.length) {
    doc.setFont('helvetica', 'bold').setFontSize(7.2);
    let cx = M;
    for (const m of spec.meta) {
      const t = pdfText(m);
      const tw = doc.getTextWidth(t);
      if (cx + tw + 8 > W - M) { cx = M; y += 7; }
      doc.setFillColor(...BRAND.chipFill);
      doc.roundedRect(cx, y - 3.6, tw + 6, 5.6, 2.8, 2.8, 'F');
      doc.setTextColor(...BRAND.accentDeep);
      doc.text(t, cx + 3, y);
      cx += tw + 8.5;
    }
    y += 6;
  }

  // ── Summary band (KPIs) — wraps to rows of up to 5 tiles ──
  const drawSummary = (items, atY) => {
    let yy = atY;
    for (let start = 0; start < items.length; start += 5) {
      const chunk = items.slice(start, start + 5);
      const n = chunk.length;
      const gap = 3;
      const bw = (W - 2 * M - gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) {
        const bx = M + i * (bw + gap);
        doc.setFillColor(250, 251, 254);
        doc.setDrawColor(...BRAND.hairline).setLineWidth(0.25);
        doc.roundedRect(bx, yy, bw, 13, 2.6, 2.6, 'FD');
        doc.setFont('helvetica', 'bold').setFontSize(6.4).setTextColor(...BRAND.faint);
        doc.text(pdfText(chunk[i].label).toUpperCase(), bx + 3.4, yy + 4.6);
        doc.setFontSize(10.5).setTextColor(...BRAND.ink);
        doc.text(pdfText(chunk[i].value), bx + 3.4, yy + 10);
      }
      yy += 16;
    }
    return yy + 1;
  };
  if (spec.summary.length) y = drawSummary(spec.summary, y);

  // ── Sections ──
  // Page number → the group whose rows open that page mid-block, so the page
  // header can say which board they belong to. Spans sections, since page
  // numbers do.
  const pageOpensWith = {};
  let firstPageOfSection = true;
  for (const section of spec.sections) {
    if (section.heading) {
      if (y > H - 40) { doc.addPage(); contHeader(); y = 22; }
      doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...BRAND.ink);
      doc.text(pdfText(section.heading), M, y + 4);
      doc.setDrawColor(...BRAND.accent).setLineWidth(0.7);
      doc.line(M, y + 6, M + 10, y + 6);
      y += 9;
    }
    if (section.summary.length) y = drawSummary(section.summary, y);
    if (!section.columns.length) continue;

    const cols = section.pdfColumns || section.columns;
    const grid = section.pdfGrid || section.grid;
    const numeric = cols.map(c => c.align === 'right');

    // ── Printed column widths ───────────────────────────────────────────────
    // autoTable's default 'auto' shares the page out in proportion to CONTENT,
    // which starves a short-headed column standing next to a long-texted one.
    // At sixteen columns on landscape A4 the REMARKS heading was allotted ~8mm;
    // with no word narrow enough to fit, jsPDF broke it one letter per line and
    // the section printed as vertical alphabet strips.
    //
    // A column may therefore declare `pdfWeight`: its share of the printable
    // width. If ANY column in the section declares one this file fixes every
    // width itself, so a column is never narrower than the caller intended.
    // If none does, nothing is passed and autoTable behaves exactly as before —
    // every report written before this keeps its existing layout untouched.
    const SERIAL_W = 9;
    const weighted = cols.some(c => +c.pdfWeight > 0);
    const widths = {};
    if (weighted) {
      const usable = W - 2 * M - SERIAL_W;
      const weights = cols.map(c => +c.pdfWeight || 1);
      const sum = weights.reduce((a, b) => a + b, 0);
      weights.forEach((w, i) => { widths[i + 1] = { cellWidth: usable * w / sum }; });
    }
    // Dense tables buy their remaining room from the type, not from the words.
    const dense = cols.length > 10;

    // ── Grouping ────────────────────────────────────────────────────────────
    // A section may declare `pdfGroup` and print as the app's grouped tables
    // read: a banded header naming the group, its rows beneath it, and a
    // coloured rail down the left of the whole block. It earns its place by
    // deleting repetition — a board with four jobs printed its name, GSM and
    // size on all four rows, and the eye had to compare them to see they were
    // one board.
    //
    // Excel is deliberately NOT grouped: a header row wedged between data rows
    // breaks sorting, filtering and every pivot built on the sheet. There the
    // grouping key stays an ordinary column, which is what a spreadsheet wants.
    const group = section.pdfGroup;
    const totalCols = cols.length + 1;
    const RAIL_W = 1.1;
    const body = [];
    // Per printed row: which tone paints its rail, and whether it is a band.
    // `row` is kept so a column's own pdfTone can be resolved against the data.
    const meta = [];

    if (group) {
      const blocks = [];
      for (const row of section.rows) {
        const key = group.by(row);
        const last = blocks[blocks.length - 1];
        if (!last || last.key !== key) blocks.push({ key, rows: [row] });
        else last.rows.push(row);
      }
      let serial = 0;
      for (const block of blocks) {
        const tone = (group.tone && group.tone(block.rows)) || 'muted';
        const right = group.status ? pdfText(group.status(block.rows)) : '';
        // The band is split so the group's verdict sits hard right, under the
        // columns that carry the numbers it is a verdict about.
        const short = group.shortLabel ? group.shortLabel(block.rows) : group.label(block.rows);
        body.push(right && totalCols >= 3
          ? [
            { content: pdfText(group.label(block.rows)), colSpan: totalCols - 2 },
            { content: right, colSpan: 2, styles: { halign: 'right' } },
          ]
          : [{ content: pdfText(group.label(block.rows)), colSpan: totalCols }]);
        meta.push({ tone, band: true, name: short });
        for (const row of block.rows) {
          serial += 1;
          body.push([String(serial), ...cols.map(c => pdfText(cellValue(c, row)))]);
          meta.push({ tone, band: false, row, name: short });
        }
      }
    } else {
      // An ungrouped section can still earn a rail: `pdfRowTone` paints the
      // left edge by what the ROW means, so a page of boards shows its risk
      // down the margin without a reader having to find the verdict column.
      grid.forEach((r, i) => {
        const row = section.rows[i];
        body.push(r.map(pdfText));
        meta.push({ tone: section.pdfRowTone ? section.pdfRowTone(row) : null, band: false, row });
      });
    }

    autoTable(doc, {
      startY: y + 1,
      margin: { left: M, right: M, top: 20, bottom: 16 },
      head: [['#', ...cols.map(c => pdfText(c.label).toUpperCase())]],
      body,
      styles: {
        font: 'helvetica', fontSize: dense ? 6.7 : 7.8, textColor: BRAND.ink,
        cellPadding: dense
          ? { top: 1.8, bottom: 1.8, left: 1.6, right: 1.6 }
          : { top: 2.2, bottom: 2.2, left: 2.4, right: 2.4 },
        lineColor: BRAND.hairline, lineWidth: { bottom: 0.18 },
        // Wrap on word boundaries and hang every cell from the top, so the
        // lines of a stacked cell sit level with its neighbours.
        overflow: 'linebreak',
        valign: 'top',
      },
      headStyles: {
        fillColor: BRAND.headFill, textColor: [71, 85, 105], fontStyle: 'bold',
        fontSize: dense ? 6 : 6.8, lineWidth: { bottom: 0.5 }, lineColor: BRAND.accent,
        valign: 'bottom',
      },
      alternateRowStyles: { fillColor: BRAND.rowAlt },
      // A row moves to the next page whole rather than being sliced through the
      // middle. With stacked cells a split row is unreadable: the page break
      // lands between a product's name and its code, and the reader cannot tell
      // the orphaned line from a row of its own.
      rowPageBreak: 'avoid',
      columnStyles: Object.fromEntries([
        [0, { halign: 'right', textColor: BRAND.faint, cellWidth: SERIAL_W }],
        ...cols.map((c, i) => [i + 1, {
          ...(numeric[i] ? { halign: 'right' } : {}),
          ...(widths[i + 1] || {}),
        }]),
      ]),
      // Tones are applied here, after autoTable has computed its own styles,
      // so a toned cell wins over the zebra fill rather than fighting it.
      didParseCell: data => {
        if (data.section !== 'body') return;
        const m = meta[data.row.index];
        if (!m) return;
        if (m.band) {
          const t = PDF_TONE[m.tone] || PDF_TONE.muted;
          data.cell.styles.fillColor = t.fill;
          data.cell.styles.textColor = t.text;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fontSize = dense ? 7 : 8.2;
          data.cell.styles.cellPadding = { top: 2.6, bottom: 2.6, left: 3.4, right: 3.4 };
          data.cell.styles.lineWidth = { bottom: 0.3 };
          data.cell.styles.lineColor = t.rail;
          return;
        }
        const col = cols[data.column.index - 1];
        const t = col?.pdfTone && m.row ? PDF_TONE[col.pdfTone(m.row)] : null;
        if (t) {
          data.cell.styles.textColor = t.text;
          data.cell.styles.fontStyle = 'bold';
        }
      },
      // The rail — drawn rather than declared, because autoTable takes one
      // border colour for all four sides of a cell and this one is its own.
      didDrawCell: data => {
        if (data.section !== 'body' || data.column.index !== 0) return;
        const m = meta[data.row.index];
        if (!m) return;
        // The first body row a page receives decides whether that page opens
        // mid-group. A band means the group starts here and names itself; any
        // other row means its band is on the page before.
        const page = doc.internal.getCurrentPageInfo().pageNumber;
        if (!(page in pageOpensWith)) pageOpensWith[page] = m.band ? null : (m.name || null);
        const t = PDF_TONE[m.tone];
        if (!t) return;
        doc.setFillColor(...t.rail);
        doc.rect(data.cell.x, data.cell.y, RAIL_W, data.cell.height, 'F');
      },
      didDrawPage: () => {
        const page = doc.internal.getCurrentPageInfo().pageNumber;
        if (page > 1) contHeader(pageOpensWith[page] || null);
        footer();
      },
    });
    firstPageOfSection = false;
    y = (doc.lastAutoTable?.finalY || y) + 8;
  }

  // Empty report edge case — no autotable ran, so draw the footer ourselves.
  if (!spec.sections.some(s => s.columns.length)) footer();

  // Total page count in footers ("Page x of y").
  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFillColor(255, 255, 255);
    doc.rect(W - M - 30, H - 10.5, 30, 5, 'F');
    doc.setFont('helvetica', 'normal').setFontSize(6.8).setTextColor(...BRAND.faint);
    doc.text(`Page ${p} of ${pages}`, W - M, H - 7, { align: 'right' });
  }

  doc.save(`${specFileName(spec)}.pdf`);
}

// ─── Excel ───────────────────────────────────────────────────────────────────
const XL = {
  accent: 'FF007AFF', accentDeep: 'FF0064D2', ink: 'FF1D1D1F', faint: 'FF86868B',
  headFill: 'FF007AFF', rowAlt: 'FFF6F9FE', hairline: 'FFE5E7EB', white: 'FFFFFFFF',
};

function xlNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v ?? '').trim().replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  if (!t || !/^-?\d+(\.\d+)?%?$/.test(t)) return null;
  return t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
}

// One worksheet per section — the shape a multi-part operational report wants
// in Excel: every sheet keeps its own frozen header row and auto-filter, which
// the stacked single-sheet layout necessarily loses. Opt-in; every existing
// caller keeps the stacked layout untouched. The top-level summary lands on
// the first sheet only.
function writeSectionSheets(wb, spec) {
  const user = auth?.user || null;
  const metaLine = [...spec.meta, `Generated ${stamp()}${user?.name ? ` by ${user.name}` : ''}`].join('   ·   ');
  const sheetName = (s, i) =>
    String(s.heading || `Sheet ${i + 1}`).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31).trim() || `Sheet ${i + 1}`;

  spec.sections.forEach((section, i) => {
    const ws = wb.addWorksheet(sheetName(section, i));
    const totalCols = Math.max(section.columns.length + 1, 4);

    ws.getCell('A1').value = BRAND.company;
    ws.getCell('A1').font = { name: 'Calibri', size: 13, bold: true, color: { argb: XL.accent } };
    ws.getCell('A2').value = section.heading ? `${spec.title} — ${section.heading}` : spec.title;
    ws.getCell('A2').font = { name: 'Calibri', size: 11, bold: true, color: { argb: XL.ink } };
    ws.getCell('A3').value = metaLine;
    ws.getCell('A3').font = { name: 'Calibri', size: 9, color: { argb: XL.faint } };
    [1, 2, 3].forEach(r => ws.mergeCells(r, 1, r, totalCols));

    let rowIdx = 4;
    const sums = [...(i === 0 ? spec.summary : []), ...section.summary];
    for (const s of sums) {
      rowIdx += 1;
      const lr = ws.getRow(rowIdx);
      lr.getCell(1).value = s.label;
      lr.getCell(1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: XL.faint } };
      const vc = lr.getCell(2);
      const n = xlNumber(s.value);
      vc.value = n != null ? n : String(s.value ?? '');
      vc.font = { name: 'Calibri', size: 10, bold: true, color: { argb: XL.ink } };
      if (typeof vc.value === 'number') vc.numFmt = Number.isInteger(vc.value) ? '#,##0' : '#,##0.00';
    }
    if (sums.length) rowIdx += 1;
    if (!section.columns.length) return;

    const cols = ['#', ...section.columns.map(c => c.label)];
    rowIdx += 1;
    const headRow = ws.getRow(rowIdx);
    headRow.values = cols;
    headRow.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: XL.white } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.headFill } };
      cell.alignment = { vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: XL.accentDeep } } };
    });
    headRow.height = 20;
    const headerAt = rowIdx;

    const colWidths = [];
    section.grid.forEach((r, ri) => {
      rowIdx += 1;
      const row = ws.getRow(rowIdx);
      row.values = r.map((v, ci) => {
        if (ci === 0) return v;
        const n = xlNumber(v);
        return n != null ? n : String(v ?? '');
      });
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        cell.font = { name: 'Calibri', size: 10, color: { argb: colNumber === 1 ? XL.faint : XL.ink } };
        if (ri % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.rowAlt } };
        cell.border = { bottom: { style: 'hair', color: { argb: XL.hairline } } };
        if (typeof cell.value === 'number' && colNumber > 1) {
          cell.numFmt = Number.isInteger(cell.value) ? '#,##0' : '#,##0.00';
        }
      });
    });
    cols.forEach((c, ci) => { colWidths[ci] = Math.max(colWidths[ci] || 0, String(c ?? '').length); });
    section.grid.forEach(r => r.forEach((v, ci) => { colWidths[ci] = Math.max(colWidths[ci] || 0, String(v ?? '').length); }));
    ws.columns.forEach((col, ci) => {
      col.width = Math.min(Math.max(ci === 0 ? 5 : (colWidths[ci] || 8) + 3, 8), 44);
    });
    ws.autoFilter = { from: { row: headerAt, column: 1 }, to: { row: headerAt, column: cols.length } };
    ws.views = [{ state: 'frozen', ySplit: headerAt }];
  });
}

export async function exportXLSX(rawSpec) {
  const spec = normalizeSpec(rawSpec);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = `${BRAND.app} — ${BRAND.company}`;
  wb.created = new Date();
  if (spec.sheetPerSection && spec.sections.length > 1) {
    writeSectionSheets(wb, spec);
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(
      new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `${slug(spec.name || spec.title)}_${fileStamp()}.xlsx`,
    );
    return;
  }
  const single = spec.sections.length === 1;
  const ws = wb.addWorksheet(String(spec.title).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31).trim() || 'Report');

  const user = auth?.user || null;
  const totalCols = Math.max(...spec.sections.map(s => s.columns.length + 1), 4);

  // Title block.
  ws.getCell('A1').value = BRAND.company;
  ws.getCell('A1').font = { name: 'Calibri', size: 15, bold: true, color: { argb: XL.accent } };
  ws.getCell('A2').value = spec.subtitle ? `${spec.title} — ${spec.subtitle}` : spec.title;
  ws.getCell('A2').font = { name: 'Calibri', size: 12, bold: true, color: { argb: XL.ink } };
  ws.getCell('A3').value = [
    ...spec.meta,
    `Generated ${stamp()}${user?.name ? ` by ${user.name}` : ''}`,
  ].join('   ·   ');
  ws.getCell('A3').font = { name: 'Calibri', size: 9, color: { argb: XL.faint } };
  [1, 2, 3].forEach(r => ws.mergeCells(r, 1, r, totalCols));

  let rowIdx = 4;

  // Top-level summary block.
  const writeSummary = items => {
    for (const s of items) {
      rowIdx += 1;
      const lr = ws.getRow(rowIdx);
      lr.getCell(1).value = s.label;
      lr.getCell(1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: XL.faint } };
      const vc = lr.getCell(2);
      const n = xlNumber(s.value);
      vc.value = n != null ? n : String(s.value ?? '');
      vc.font = { name: 'Calibri', size: 10, bold: true, color: { argb: XL.ink } };
      if (typeof vc.value === 'number') vc.numFmt = Number.isInteger(vc.value) ? '#,##0' : '#,##0.00';
    }
    rowIdx += 1;
  };
  if (spec.summary.length) writeSummary(spec.summary);

  let headerRowForFilter = null;
  const colWidths = [];

  for (const section of spec.sections) {
    if (section.heading) {
      rowIdx += 1;
      const hr = ws.getRow(rowIdx);
      hr.getCell(1).value = section.heading;
      hr.getCell(1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: XL.accentDeep } };
      ws.mergeCells(rowIdx, 1, rowIdx, totalCols);
    }
    if (section.summary.length) writeSummary(section.summary);
    if (!section.columns.length) continue;

    const cols = ['#', ...section.columns.map(c => c.label)];
    rowIdx += 1;
    const headRow = ws.getRow(rowIdx);
    headRow.values = cols;
    headRow.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: XL.white } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.headFill } };
      cell.alignment = { vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: XL.accentDeep } } };
    });
    headRow.height = 20;
    if (single) headerRowForFilter = { row: rowIdx, cols: cols.length };

    section.grid.forEach((r, i) => {
      rowIdx += 1;
      const row = ws.getRow(rowIdx);
      row.values = r.map((v, ci) => {
        if (ci === 0) return v;
        const n = xlNumber(v);
        return n != null ? n : String(v ?? '');
      });
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        cell.font = { name: 'Calibri', size: 10, color: { argb: colNumber === 1 ? XL.faint : XL.ink } };
        if (i % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.rowAlt } };
        cell.border = { bottom: { style: 'hair', color: { argb: XL.hairline } } };
        if (typeof cell.value === 'number' && colNumber > 1) {
          cell.numFmt = Number.isInteger(cell.value) ? '#,##0' : '#,##0.00';
        }
      });
    });
    rowIdx += 1; // spacer between sections

    // Track widest content per column index.
    cols.forEach((c, i) => { colWidths[i] = Math.max(colWidths[i] || 0, String(c ?? '').length); });
    section.grid.forEach(r => r.forEach((v, i) => { colWidths[i] = Math.max(colWidths[i] || 0, String(v ?? '').length); }));
  }

  ws.columns.forEach((col, i) => {
    col.width = Math.min(Math.max(i === 0 ? 5 : (colWidths[i] || 8) + 3, 8), 44);
  });
  if (headerRowForFilter) {
    ws.autoFilter = { from: { row: headerRowForFilter.row, column: 1 }, to: { row: headerRowForFilter.row, column: headerRowForFilter.cols } };
    ws.views = [{ state: 'frozen', ySplit: headerRowForFilter.row }];
  }

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${specFileName(spec)}.xlsx`,
  );
}
