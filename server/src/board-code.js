// Composes a board's display name and short code from its structured fields, so
// 'Saffire · 300 GSM · 23x36' / '2336300SAFF' are generated rather than typed.
//
// CODE LAYOUT — size, then GSM, then grade: '20x38, 340gsm, Duplex GB' reads as
// '2038340GB'. Chosen 2026-07-27 so the code is scanned left-to-right in the
// order the floor says it, with the digits unbroken by letters. Duplex codes are
// the bare 'GB'/'WB' — the 'DP' carried no information, every Duplex has it.
// Stored codes were migrated to this layout (migration 0004), so the composer
// and the master agree.
//
// The earlier layout was size+grade+gsm with 'DPGB'/'DPWB'
// ('2038DPGB340'), reverse-engineered from the live master; the numeric prefix
// round(L)+round(W) matched with zero mismatches across the 242 coded boards,
// which is why round() (half away from zero, NOT banker's rounding) is still the
// rule below.
export const GRADE_CODES = {
  'Duplex GB': 'GB',
  'Duplex WB': 'WB',
  'Saffire': 'SAFF',
  'FBB': 'FBB',
  'Paper': 'PAPR',
  'Chromo Paper': 'CHRM',
};

// Resolves a free-typed grade to its canonical GRADE_CODES spelling, or null if
// unknown. Single source of truth for the case-insensitive match, so boardName
// and boardCode cannot drift apart — the grade source is NOT guaranteed clean
// (products.board_grade carries coarser values than materials).
function canonicalGrade(grade) {
  const g = String(grade ?? '').trim();
  if (!g) return null;
  return Object.keys(GRADE_CODES).find(k => k.toLowerCase() === g.toLowerCase()) ?? null;
}

// Unknown grades degrade to their first 4 alphanumerics so a newly added grade
// still produces a usable code without a code-change.
export function gradeCode(grade) {
  const g = String(grade ?? '').trim();
  if (!g) return null;
  const hit = canonicalGrade(g);
  if (hit) return GRADE_CODES[hit];
  return g.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || null;
}

// 20.0 → '20', 24.60 → '24.6'.
//
// The L x W pair is written closed up ('23x36', not '23 x 36'): the size is
// spoken and typed on the floor as one token. Stored names were migrated to
// match (db.js), so the composer and the master agree. parseBoardName reads
// both forms, so an un-migrated name from anywhere still parses.
const dim = n => String(+(+n).toFixed(2));

// The grade is canonicalized to its GRADE_CODES spelling so the name can never
// disagree with the code ('saffire · …' next to '2336SAFF300'). An unrecognised
// grade is kept as typed — only trimmed — since there is nothing to canonicalize to.
export function boardName({ grade, gsm, sheet_l, sheet_w } = {}) {
  const raw = String(grade ?? '').trim();
  const g = canonicalGrade(raw) ?? raw;
  if (!g || !(+gsm > 0) || !(+sheet_l > 0) || !(+sheet_w > 0)) return null;
  return `${g} · ${+gsm} GSM · ${dim(sheet_l)}x${dim(sheet_w)}`;
}

// Accepts both 'x' and '×'. Tolerates extra whitespace.
const NAME_RE = /^\s*(.+?)\s*·\s*(\d{2,4})\s*GSM\s*·\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*$/i;

export function parseBoardName(name) {
  const m = NAME_RE.exec(String(name ?? ''));
  if (!m) return null;
  return { grade: m[1].trim(), gsm: +m[2], sheet_l: +m[3], sheet_w: +m[4] };
}

// `taken` is the set of codes already in use. On collision the existing data
// appends -1, -2, … (2236285GB-1, 2532280SAFF-1) — reproduce that rather than
// invent a new scheme.
//
// Two boards collide when they round to the same size AND share GSM and grade
// (31.5x41.5 and 32x42 both key '3242'), so the suffix carries real rows — the
// live master has 7 of them.
//
// ORDER-DEPENDENCE (precondition for any bulk caller): which row keeps the bare
// base code and which gets -1 depends on the order rows are processed. Verified
// empirically against the live master: generating per-row WITHOUT accumulating
// `taken` gives 7/242 mismatches (all missing a -1); iterating in id ASC order
// and seeding `taken` with each stored code as it goes gives 0/242. So a bulk
// caller MUST iterate in original-creation order (id ASC) and grow `taken` as
// it goes.
//
// The safer rule bulk callers should rely on: an EXISTING code is never
// regenerated, only a blank one is filled. Ordering then only affects codes
// being newly generated, never already-issued ones.
export function boardCode({ grade, gsm, sheet_l, sheet_w } = {}, taken = new Set()) {
  const gc = gradeCode(grade);
  if (!gc || !(+gsm > 0) || !(+sheet_l > 0) || !(+sheet_w > 0)) return null;
  const base = `${Math.round(+sheet_l)}${Math.round(+sheet_w)}${+gsm}${gc}`;
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Builds the `taken` set to feed boardCode when generating a code for a board
// form. Two rows MUST be excluded or the collision engine silently re-suffixes
// an existing board's code on an ordinary edit:
//   1. the row being edited itself (else it would collide with its own stored
//      code and become base-1), and
//   2. every leftover offcut — these are created with the parent's EXACT spec
//      (helpers.js createLeftover), so a parent edited while it has an offcut
//      would see its own code as "taken" via the child and get re-suffixed.
// `editingId` is nullable (a brand-new board excludes nothing but leftovers).
export function takenCodesFor(rows, editingId) {
  const self = editingId == null ? '' : String(editingId);
  const taken = new Set();
  for (const r of rows || []) {
    if (r.leftover) continue;
    if (String(r.id) === self) continue;
    if (r.spec) taken.add(r.spec);
  }
  return taken;
}
