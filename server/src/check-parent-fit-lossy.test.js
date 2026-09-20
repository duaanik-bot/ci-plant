// check:parent is the standing net under the parent rules. CHECK 1 (a locked
// plan priced in child sheets) must measure the parent the lock used — the
// EFFECTIVE one, job override included. CHECK 3 lists parents that cost cuts
// (CI-MRG-0028's shape) for a human to judge, and must never fail the run:
// a deliberate trim is allowed (no hard blockers — Anik, 19 Sep 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const S = readFileSync(new URL('../../scripts/check-parent-fit.mjs', import.meta.url), 'utf8');

test('CHECK 1 reads the effective parent, not the master\'s alone', () => {
  const locked = S.slice(S.indexOf('const LOCKED_LINES'), S.indexOf('ORDER BY ol.id`;', S.indexOf('const LOCKED_LINES')));
  assert.match(locked, /COALESCE\(\(ol\.spec_override->>'parent_l'\)::float, p\.parent_l\) AS parent_l/);
  assert.match(locked, /COALESCE\(\(ol\.spec_override->>'parent_w'\)::float, p\.parent_w\) AS parent_w/);
  assert.doesNotMatch(locked, /p\.name AS product, p\.parent_l, p\.parent_w,/);
});

test('CHECK 1 counts a co-printed run on the board, the sheet its lock used', () => {
  const locked = S.slice(S.indexOf('const LOCKED_LINES'), S.indexOf('ORDER BY ol.id`;', S.indexOf('const LOCKED_LINES')));
  assert.match(locked, /gr\.layout_mode,/);
  assert.match(S, /const coPrinted = r\.layout_mode === 'shared' && r\.run_kind !== 'merge';/);
  assert.match(S, /parent_l: coPrinted \? null : r\.parent_l, parent_w: coPrinted \? null : r\.parent_w,/);
});

test('CHECK 3 lists parents that cost cuts through the server rule, splitting a co-printed line into its own group', () => {
  // Order-independent: parentLosesCuts just has to be among the imported names.
  const importLine = S.split('\n').find(l => l.includes("from '../server/src/helpers.js'"));
  const names = importLine.slice(importLine.indexOf('{') + 1, importLine.indexOf('}')).split(',').map(s => s.trim());
  assert.ok(names.includes('parentLosesCuts'), `expected parentLosesCuts among the names imported from helpers.js, got [${names}]`);
  assert.match(S, /── CHECK 3 — a parent on file that costs cuts/);
  // A co-printed run's lock never reads the parent on file (CHECK 1's own
  // coPrinted branch), so its lossy rows are split out of the headline count
  // and reported in their own group — never silently merged into the same
  // "N open line(s)" figure the single/separate-run screens warn about.
  assert.match(S, /const lossyOpen = openWithParent\.map\(r => \(\{ r, v: losesOn\(r\) \}\)\)\.filter\(x => x\.v\);/);
  assert.match(S, /lossyLines = lossyOpen\.filter\(x => !x\.r\.co_printed\);/);
  assert.match(S, /coPrintedLossy = lossyOpen\.filter\(x => x\.r\.co_printed\);/);
  assert.match(S, /single-line and combined\/separate-run screens show the same warning with a one-click fix/);
  assert.match(S, /costs nothing on this run \(a co-printed lock/);
});

test('CHECK 3 never changes the exit code', () => {
  const start = S.indexOf('── CHECK 3 — a parent on file that costs cuts');
  const end = S.indexOf('if (!wrong.length && !armed.length)');
  assert.ok(start >= 0 && end > start, 'expected to find the CHECK 3 block before the final success check');
  const check3 = S.slice(start, end);
  assert.doesNotMatch(check3, /process\.exit\(/);
  assert.doesNotMatch(check3, /process\.exitCode/);
  assert.doesNotMatch(check3, /console\.error/);
});

test('CHECK 3\'s queries run only after CHECK 1/2\'s, wrapped in their own try/catch, and c.end() still runs on every path', () => {
  const iLocked = S.indexOf('const locked = (await c.query(LOCKED_LINES)).rows;');
  const iArmed = S.indexOf('const armed = (await c.query(ARMED_PAIRS)).rows;');
  const iTry = S.indexOf('try {', iArmed);
  const iOpen = S.indexOf('const openWithParent = (await c.query(OPEN_WITH_PARENT)).rows;');
  const iCatch = S.indexOf('} catch (e) {');
  const iCheck3Error = S.indexOf('check3Error = e.message;');
  const iEnd = S.indexOf('await c.end();');
  assert.ok(
    iLocked >= 0 && iArmed > iLocked && iTry > iArmed && iOpen > iTry
      && iCatch > iOpen && iCheck3Error > iCatch && iEnd > iCheck3Error,
    `expected LOCKED_LINES, ARMED_PAIRS, then try { CHECK 3 queries } catch (e) { check3Error = e.message }, `
      + `then c.end() — got ${JSON.stringify({ iLocked, iArmed, iTry, iOpen, iCatch, iCheck3Error, iEnd })}`);
  assert.match(S, /i CHECK 3 skipped — \$\{check3Error\}/);
});

test('CHECK 1 reads a co-printed row\'s child from the layout override only, and ignores a 0/1-sheet parent-equals-child reading', () => {
  assert.match(S, /\(ol\.spec_override->>'child_l'\)::float AS override_child_l,/);
  assert.match(S, /\(ol\.spec_override->>'child_w'\)::float AS override_child_w,/);
  assert.match(S, /const childL = coPrinted \? r\.override_child_l : r\.child_l;/);
  assert.match(S, /const childW = coPrinted \? r\.override_child_w : r\.child_w;/);
  assert.match(S, /if \(!\(childL > 0 && childW > 0\)\) continue;/);
  assert.match(S, /if \(!\(r\.sheets_required >= 2\)\) continue;/);
});

test('a dropped connection cannot crash the process outside the try/catch (pg also emits \'error\' on the Client)', () => {
  const iCtorEnd = S.indexOf('});', S.indexOf('const c = new pg.Client({')) + 3;
  const iOn = S.indexOf("c.on('error', () => {});");
  const iConnect = S.indexOf('await c.connect();');
  assert.ok(
    iCtorEnd > 3 && iOn > iCtorEnd && iConnect > iOn,
    `expected c.on('error', () => {}) right after the client is constructed and before c.connect() — `
      + `got ${JSON.stringify({ iCtorEnd, iOn, iConnect })}`);
});

test('the final exit call never depends on CHECK 3\'s outcome', () => {
  assert.doesNotMatch(S.slice(S.lastIndexOf('process.exit(')), /lossy|coPrinted|check3/);
});

// ── Task 10 (final whole-branch review, 19 Sep 2026) ────────────────────────
// Masters whose OWN parent their OWN board cannot yield: the plan lock
// (planLockParent, the 14-Sep rule) refuses the next order of each. ARMED_PAIRS
// judges the effective pair of OPEN lines only, so a master with no open line
// is invisible to it. Informational, like CHECK 3 — to run on prod after the
// deploy that stops "Update Product Master" from writing such a pair.
const mastersQuery = () => {
  const at = S.indexOf('const IMPOSSIBLE_MASTERS = `');
  assert.ok(at >= 0, 'IMPOSSIBLE_MASTERS query missing');
  return S.slice(at, S.indexOf('`;', at));
};

test('the impossible-master list uses ARMED_PAIRS\' orientation-free rule, on each master\'s own board', () => {
  const MASTERS_Q = mastersQuery();
  assert.match(MASTERS_Q, /FROM products p JOIN materials b ON b\.id = p\.board_material_id/);
  assert.match(MASTERS_Q, /WHERE p\.active = 1 AND p\.parent_l IS NOT NULL AND p\.parent_w IS NOT NULL/);
  assert.match(MASTERS_Q, /AND b\.sheet_l > 0 AND b\.sheet_w > 0/);
  assert.match(MASTERS_Q, /AND \( GREATEST\(p\.parent_l, p\.parent_w\) > GREATEST\(b\.sheet_l, b\.sheet_w\) \+ 1e-6/);
  assert.match(MASTERS_Q, /OR LEAST\(p\.parent_l, p\.parent_w\)\s+> LEAST\(b\.sheet_l, b\.sheet_w\)\s+\+ 1e-6 \)/);
  assert.doesNotMatch(MASTERS_Q, /spec_override/, 'the master\'s own pair, never a job\'s');
});

test('it is queried inside CHECK 3\'s try, after CHECK 1/2 have their data', () => {
  const iArmed = S.indexOf('const armed = (await c.query(ARMED_PAIRS)).rows;');
  const iTry = S.indexOf('try {', iArmed);
  const iQuery = S.indexOf('impossibleMasters = (await c.query(IMPOSSIBLE_MASTERS)).rows;');
  const iCatch = S.indexOf('} catch (e) {');
  assert.ok(iArmed >= 0 && iTry > iArmed && iQuery > iTry && iCatch > iQuery,
    JSON.stringify({ iArmed, iTry, iQuery, iCatch }));
});

test('it prints with console.log in CHECK 3\'s region, and never reaches the exit code', () => {
  const region = S.slice(S.indexOf('── CHECK 3 — a parent on file that costs cuts'), S.indexOf('if (!wrong.length && !armed.length)'));
  assert.match(region, /if \(!check3Error && impossibleMasters\.length\) \{/);
  assert.match(region, /console\.log\(`\\ni \$\{impossibleMasters\.length\} active master\(s\) declare a parent their own board cannot yield/);
  assert.match(S, /const check3Printed = !!check3Error \|\| check3HasFindings \|\| impossibleMasters\.length > 0;/);
  assert.doesNotMatch(S.slice(S.lastIndexOf('process.exit(')), /impossibleMasters/);
});

test('the all-clear never contradicts the list printed above it', () => {
  const clear = S.slice(S.indexOf('if (!wrong.length && !armed.length)'), S.lastIndexOf('process.exit('));
  assert.match(clear, /impossibleMasters\.length\s*\? '  and no open line plans on a parent its board cannot yield/);
  assert.match(clear, /: '  and no active master declares a parent its board cannot yield'/);
});
