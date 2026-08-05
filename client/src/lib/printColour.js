// Printing colour + process — the pure logic, client half.
//
// Twin of server/src/print-colour.js. The two are asserted identical, key for
// key and case for case, by the client-twin parity block in
// server/src/print-colour.test.js — same precedent as boardMix / boardMath.
// Change one, change both, or the test fails.
//
// TWO AXES, never merged:
//   colour_type   — what the colour build IS   (CMYK / Pantone / CMYK + Pantone)
//   print_process — how it is LAID DOWN        (Offset / Metallic / Offset + Metallic)
// A Pantone spot colour is not a metallic ink. Pantone 871 C looks gold and
// prints on a conventional offset unit; folding the two axes into one field is
// exactly what put Pantone and metallic jobs into the same bucket on the floor.
//
// Presentation (labels, tones, icons, badges, the filter rail) lives in
// client/src/components/PrintColour.jsx — nothing here renders.

export const COLOUR_TYPES = ['CMYK', 'Pantone', 'CMYK + Pantone'];
export const PRINT_PROCESSES = ['Offset', 'Metallic', 'Offset + Metallic'];

export const PRINT_COLOUR_FIELDS = [
  'print_process', 'cmyk_colours', 'pantone_colours', 'pantone_codes',
  'metallic_colours', 'metallic_details', 'print_instructions',
];
export const PRINT_COLOUR_INT_FIELDS = ['cmyk_colours', 'pantone_colours', 'metallic_colours'];
export const PRINT_COLOUR_TEXT_FIELDS = ['print_process', 'pantone_codes', 'metallic_details', 'print_instructions'];

const s = v => String(v ?? '').trim();
const n = v => (v == null || v === '' ? null : Number(v));
const isNum = v => v != null && Number.isFinite(v);

// Tolerates the free-text history in products.colour_type ("cmyk+pantone",
// "CMYK & Pantone") — the master is a picker now, the imported rows are not.
export function colourTypeOf(row) {
  const raw = s(row?.colour_type).toLowerCase();
  if (!raw) return null;
  const hasC = raw.includes('cmyk') || raw.includes('process');
  const hasP = raw.includes('pantone') || raw.includes('spot');
  if (hasC && hasP) return 'CMYK + Pantone';
  if (hasP) return 'Pantone';
  if (hasC) return 'CMYK';
  return null;
}

export function processOf(row) {
  const raw = s(row?.print_process).toLowerCase();
  if (raw) {
    const hasM = raw.includes('metallic');
    const hasO = raw.includes('offset');
    if (hasM && hasO) return 'Offset + Metallic';
    if (hasM) return 'Metallic';
    if (hasO) return 'Offset';
    return null;
  }
  // Nothing recorded: only a metallic count or a named metallic ink may imply
  // metallic. A Pantone code never does.
  if ((Number(row?.metallic_colours) || 0) > 0 || s(row?.metallic_details)) return 'Offset + Metallic';
  return 'Offset';
}

export function metallicCountOf(row) {
  const typed = n(row?.metallic_colours);
  if (isNum(typed)) return typed;
  return s(row?.metallic_details) && processOf(row) !== 'Offset' ? 1 : 0;
}

export function cmykCountOf(row) {
  const typed = n(row?.cmyk_colours);
  if (isNum(typed)) return typed;
  const type = colourTypeOf(row);
  if (!type || type === 'Pantone') return 0;
  return 4;                                     // the plant's process set is always 4
}

export function totalColoursOf(row) {
  const t = n(row?.colors);
  if (isNum(t)) return t;
  const sum = [row?.cmyk_colours, row?.pantone_colours, row?.metallic_colours]
    .reduce((a, v) => a + (Number(v) || 0), 0);
  return sum || null;
}

export function pantoneCountOf(row) {
  const typed = n(row?.pantone_colours);
  if (isNum(typed)) return typed;
  const type = colourTypeOf(row);
  if (!type || type === 'CMYK') return 0;
  const total = totalColoursOf(row);
  if (total == null) return 0;
  return Math.max(0, total - (type === 'Pantone' ? 0 : 4) - metallicCountOf(row));
}

// The counts a screen should show, in one call. A typed value always wins;
// anything NULL is inferred from colour_type + colors so a legacy row still
// reads correctly. That is the NORMAL case on day one: 300+ live products
// carry only colour_type + colors and nothing was backfilled.
export function derivedCounts(row) {
  return {
    cmyk: cmykCountOf(row),
    pantone: pantoneCountOf(row),
    metallic: metallicCountOf(row),
    total: totalColoursOf(row),
  };
}

// First metallic shade named in metallic_details ("Metallic Gold (Pantone 871 C)" → "Gold").
export function metallicNameOf(row) {
  const d = s(row?.metallic_details);
  if (!d) return null;
  const first = d.split(/[,;/]/)[0].trim();
  return first.replace(/^metallic\s+/i, '').replace(/\s*\(.*\)\s*$/, '').trim() || null;
}

// The compact sentence a table cell, an export column or the traveler carries:
//   "CMYK — 4 colours" · "CMYK + 2 Pantone — 6 colours" · "CMYK + Metallic Gold — 5 colours"
export function colourSummary(row) {
  const type = colourTypeOf(row);
  const total = totalColoursOf(row);
  if (!type && total == null) return '—';
  const pantone = pantoneCountOf(row);
  const metallic = metallicCountOf(row);
  const bits = [];
  if (type === 'CMYK' || type === 'CMYK + Pantone') bits.push('CMYK');
  // A Pantone-ONLY job's spot count is already the total, and printing it twice
  // ("2 Pantone — 2 colours") reads as two different numbers. Name the count
  // only where Pantone is one part of a mix.
  if (pantone > 0) bits.push(type === 'Pantone' && metallic === 0 ? 'Pantone' : `${pantone} Pantone`);
  else if (type === 'Pantone') bits.push('Pantone');
  if (metallic > 0) {
    const name = metallicNameOf(row);
    bits.push(name ? `Metallic ${name}` : `${metallic} Metallic`);
  }
  const head = bits.length ? bits.join(' + ') : (type || '—');
  return total != null ? `${head} — ${total} ${total === 1 ? 'colour' : 'colours'}` : head;
}

// Everything a row should match on when someone types into a search box, so
// "pantone", "871", "gold" and "6 colours" all find the job.
export function colourSearchText(row) {
  const total = totalColoursOf(row);
  return [
    colourTypeOf(row), processOf(row), colourSummary(row),
    row?.pantone_codes, row?.metallic_details, row?.print_instructions,
    total != null ? `${total} colours` : null,
  ].filter(Boolean).join(' ');
}

// Total-colour banding for the "1 / 2 / 3 / 4 / 5–6 / 6+" filter.
export const COLOUR_BANDS = [
  { key: '1', label: '1', test: v => v === 1 },
  { key: '2', label: '2', test: v => v === 2 },
  { key: '3', label: '3', test: v => v === 3 },
  { key: '4', label: '4', test: v => v === 4 },
  { key: '5-6', label: '5–6', test: v => v >= 5 && v <= 6 },
  { key: '6+', label: '6+', test: v => v > 6 },
];
export function colourBandOf(row) {
  const v = totalColoursOf(row);
  if (v == null) return null;
  return COLOUR_BANDS.find(b => b.test(v))?.key || null;
}

// Soft warnings. Never a save gate — the caller decides how loudly to say them.
// Physics is hard, paperwork is soft: a missing Pantone code must say so and
// block nothing, because the plant has to plan a job while the customer is
// still choosing the shade.
export function printColourWarnings(row) {
  const out = [];
  if (!row || typeof row !== 'object') return out;
  const type = colourTypeOf(row);
  // Only judge the process when one was actually recorded; an inferred 'Offset'
  // is an absence of information, not a claim worth contradicting.
  const proc = s(row.print_process) ? processOf(row) : null;

  if ((type === 'Pantone' || type === 'CMYK + Pantone') && !s(row.pantone_codes)) {
    out.push({ code: 'PANTONE_NO_CODES', field: 'pantone_codes',
      message: 'Pantone is selected but no Pantone code or name is entered.' });
  }
  if ((proc === 'Metallic' || proc === 'Offset + Metallic') && !s(row.metallic_details)) {
    out.push({ code: 'METALLIC_NO_DETAIL', field: 'metallic_details',
      message: 'Metallic printing is selected but no metallic colour is entered.' });
  }
  // Only a TYPED total can disagree with typed parts — an inferred one is
  // derived FROM them and could never differ.
  const totalTyped = n(row.colors);
  const anyPartTyped = PRINT_COLOUR_INT_FIELDS.some(f => isNum(n(row[f])));
  if (isNum(totalTyped) && anyPartTyped) {
    const sum = (Number(row.cmyk_colours) || 0)
      + (Number(row.pantone_colours) || 0)
      + (Number(row.metallic_colours) || 0);
    if (sum !== totalTyped) {
      out.push({ code: 'TOTAL_MISMATCH', field: 'colors',
        message: `Total Colours is ${totalTyped} but CMYK + Pantone + metallic add to ${sum}.` });
    }
  }
  // A metallic ink named against a plain-Offset process. NOTE the guard is on
  // metallic fields ONLY — a Pantone code is never evidence of metallic.
  if (proc === 'Offset' && (s(row.metallic_details) || (Number(row.metallic_colours) || 0) > 0)) {
    out.push({ code: 'METALLIC_WITHOUT_PROCESS', field: 'print_process',
      message: 'A metallic colour is entered but the Printing Process is set to Offset only.' });
  }
  return out;
}

// ---- Filtering -------------------------------------------------------------
// MULTI-SELECT by design: picking Pantone AND CMYK + Pantone must show every
// job with any spot colour in it and hide CMYK-only work. An EMPTY set means
// "all" — never filter on an empty set.

export function toggleInSet(set, key) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

// Does this row survive the three colour filters? ONE predicate, so every
// surface that offers the rail narrows identically.
export function matchesColourFilters(row, { colour, process, band } = {}) {
  if (colour?.size && !colour.has(colourTypeOf(row))) return false;
  if (process?.size && !process.has(processOf(row))) return false;
  if (band?.size && !band.has(colourBandOf(row))) return false;
  return true;
}

// Count how many rows sit in each bucket. Always fed the UNFILTERED list, so a
// chip's count says how many jobs it would reveal, not how many survived a
// filter already applied.
export function colourFilterCounts(rows = []) {
  const colour = {}, process = {}, band = {};
  for (const r of rows) {
    const c = colourTypeOf(r); if (c) colour[c] = (colour[c] || 0) + 1;
    const p = processOf(r); if (p) process[p] = (process[p] || 0) + 1;
    const b = colourBandOf(r); if (b) band[b] = (band[b] || 0) + 1;
  }
  return { colour, process, band };
}
