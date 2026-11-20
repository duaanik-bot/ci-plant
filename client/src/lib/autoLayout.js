// The layout picker for a new costing (owner, 20 Nov 2026: an enquiry is costed on the sheet and ups the plant would
// really run — an old Die Master die first, else the least board a carton, and never a cheaper "reading" than the
// enquiry gave).
//
// Pure: no database, no fetch, no React. Shared by the costing screen and the server, like sizing.js. Sheets in inches.
//   1. The Die Master die of exactly the size: its ups, on the smallest stocked piece that holds the die's sheet. A sheet
//      written but unreadable is flagged, and the layout with the die's ups is chosen by least board.
//   2. Else the least sheet area per up among the Size Library's layouts and the size proposals in the reading the
//      enquiry gives (side-pasted: the opening it names, else side-open, said as a flag).
//   3. Else none, with the reason.
// A flat size (no depth: a leaflet, a die-cut card) still takes its Size Library layouts; only a side- or lock-pasted
// carton needs the depth, to be drawn (final review I3).
import { sheetLadder, proposals, READING_LABEL } from './sizing.js';
import { isUsableDie } from './costingRules.js';

const EPS = 1e-6;
const pos = x => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
const two = x => Math.round(x * 100) / 100;
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// A Die Master sheet size ("17.5X22.5", "15.75 x 20.75"; millimetres when both are above 60) → { long, short } in
// inches. Anything else is null.
export function dieSheet(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  let a = Number(m[1]), b = Number(m[2]);
  if (!pos(a) || !pos(b)) return null;
  if (a > 60 && b > 60) { a = two(a / 25.4); b = two(b / 25.4); }
  else if (a > 60 || b > 60) return null;
  return { long: Math.max(a, b), short: Math.min(a, b) };
}

// The smallest ladder piece (sheetLadder, smallest area first) that holds the sheet.
export function stockedPiece(sheet, ladder) {
  const hit = (ladder || []).find(p => p.long >= sheet.long - 0.01 && p.short >= sheet.short - 0.01);
  return hit ? { long: hit.long, short: hit.short } : null;
}

// The readings a carton may be drawn in: the enquiry's opening is kept, never the cheaper one.
function allowedKeys(style, opening) {
  if (style === 'LOCK') return { keys: ['lock'], assumed: false };
  if (opening === 'top') return { keys: ['top-open'], assumed: false };
  if (opening === 'side') return { keys: ['side-open'], assumed: false };
  return { keys: ['side-open'], assumed: true };
}

const perUp = (l, w, ups) => (l * w) / ups;

export function pickLayout({ style, size, opening = null, library = [], dies = [], masterDie = null, boards = [], gsm = null } = {}) {
  const styleText = norm(style), styleKey = styleText.toUpperCase();
  if (!styleText) return { none: true, why: 'needs pasting: side or lock?' };
  if (!pos(size?.l) || !pos(size?.w)) return { none: true, why: 'needs a size' };

  const { keys, assumed } = allowedKeys(styleKey, opening);
  const drawn = styleKey === 'SIDE' || styleKey === 'LOCK';
  // A carton is drawn in its readings only with its depth; a flat size takes the library's layouts alone.
  const draws = drawn && !!pos(size.h);
  const flags = [];
  if (draws && assumed) flags.push('opening assumed: side-open');

  // the proposals in the allowed reading(s), as { sheet_l = short side, sheet_w = long side }
  const props = [];
  if (draws) {
    for (const r of proposals({ style: styleKey, size, boards, gsm }).readings || []) {
      if (!keys.includes(r.reading.key)) continue;
      for (const o of r.options) props.push({ kind: 'proposal', sheet_l: o.sheet.short, sheet_w: o.sheet.long, ups: o.ups, label: READING_LABEL[r.reading.key].split(':')[0] });
    }
  }
  const libs = (library || []).filter(e => pos(e?.sheet_l) && pos(e?.sheet_w) && pos(e?.ups)
    && (!norm(e.style) || norm(e.style).toUpperCase() === styleKey))
    .map(e => ({ kind: 'library', sheet_l: Number(e.sheet_l), sheet_w: Number(e.sheet_w), ups: Number(e.ups), used: e.times_costed ?? 0 }));

  const text = c => {
    const L = Math.max(c.sheet_l, c.sheet_w), W = Math.min(c.sheet_l, c.sheet_w);
    return c.kind === 'library'
      ? `least board a carton: ${c.sheet_l} × ${c.sheet_w} in, ${c.ups} up (Size Library, used ${c.used}×)`
      : `least board a carton: ${L} × ${W} in, ${c.ups} up (${c.label})`;
  };
  const result = c => ({ sheet_l: c.sheet_l, sheet_w: c.sheet_w, ups: c.ups, kind: c.kind, note: text(c), flags });
  // least board a carton; a tie goes to the library, then to more ups
  const least = list => list.reduce((best, c) => {
    if (!best) return c;
    const d = perUp(c.sheet_l, c.sheet_w, c.ups) - perUp(best.sheet_l, best.sheet_w, best.ups);
    if (d < -EPS) return c;
    if (d > EPS) return best;
    if (c.kind !== best.kind) return c.kind === 'library' ? c : best;
    return c.ups > best.ups ? c : best;
  }, null);

  // 1. the old die
  const d = masterDie == null ? null : (dies || []).find(x => x?.code === masterDie);
  if (d && isUsableDie(d) && pos(d.ups)) {
    const ups = Number(d.ups), sheet = dieSheet(d.sheet_size);
    if (sheet) {
      const piece = stockedPiece(sheet, sheetLadder(boards));
      const costed = piece || sheet;
      if (!piece) flags.push(`die sheet ${sheet.short}×${sheet.long} is bigger than every stocked piece — costed as the die`);
      return {
        sheet_l: costed.short, sheet_w: costed.long, ups, kind: 'die', flags,
        note: `Die Master ${d.code}: ${ups} up; die sheet ${sheet.short}×${sheet.long} → costed on ${costed.short}×${costed.long}`,
      };
    }
    // A sheet written but not readable ("N/A", "18 x 23 in", inches beside millimetres) is said on the costing (M3).
    const written = norm(d.sheet_size);
    if (written) flags.push(`Die Master ${d.code}: sheet '${written}' unreadable — layout chosen by least board`);
    // the library entry with the die's ups first, else the proposal with them
    const sameLib = libs.filter(c => c.ups === ups);
    const same = sameLib.length ? least(sameLib) : least(props.filter(c => c.ups === ups));
    return same ? result(same) : { none: true, why: `Die Master ${d.code} has no readable sheet and no layout with ${ups} up` };
  }

  // 2. the least board a carton
  const best = least([...libs, ...props]);
  if (best) return result(best);
  if (drawn && !draws) return { none: true, why: 'needs a size' };
  return { none: true, why: drawn ? 'no stocked sheet takes this carton — type the sheet and ups' : `${styleText} cartons are not drawn — type the sheet and ups` };
}
