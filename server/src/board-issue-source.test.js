import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runIdOf, boardMixSource, canCarryBoardMix, normaliseMixRows } from '../../client/src/lib/boardIssue.js';

// Where a job card's board mix comes from — ONE reader, for the three screens
// that start and complete cutting.
//
// A gang / combined-run PARENT card carries `order_line_id = null` (the run
// serves several sales orders), and its mix belongs to the RUN: entered once in
// the run's engine and stored split across the members (gang-mix.js). A plain
// card's mix belongs to its own order line. Every screen that offers cutting
// has to answer "which of the two is this?" before it can fetch anything.
//
// Job Cards, the Live Floor and the station workspace each answered it with
// their own copy of the same ~45 lines — the predicate, the fetch, the row
// mapping and the fail-closed catch, duplicated three times. They had already
// drifted apart in two ways, and both were live:
//
//   1. Section.jsx read the run id off `r.line_gang_run_id`. That column exists
//      only in JC_VIEW (`/job-cards`); the station page loads `/floor/:section`,
//      whose STAGE_VIEW spells it `gang_run_id` and has no `line_gang_run_id`
//      at all. So the field was ALWAYS undefined: on a run parent the station
//      fell into the no-mix branch and never fetched the run's mix, while
//      Floor.jsx — reading the SAME payload with the right field name — did.
//   2. Section.jsx skipped the planned-breakup fetch for any card with no order
//      line, on a comment asserting "a gang card can never carry a mix". That
//      stopped being true when run mixes shipped: attachBoardMix reads a run
//      parent's rows back through its members. Job Cards had been updated to
//      `order_line_id == null && !gang_run_id`; the station had not, so the
//      operator completing a run's cutting saw a single-board fallback where
//      the job card showed the real multi-board plan.
//
// Accepting BOTH spellings of the run id is deliberate: the two payloads really
// do name the column differently, and a reader that knows about both is what
// stops the next screen from picking the wrong one.

const runParent = (over = {}) => ({ order_line_id: null, gang_run_id: 44, ...over });
const lineCard = (over = {}) => ({ order_line_id: 7, gang_run_id: null, ...over });

// ── which source ──────────────────────────────────────────────────────
test('a plain card takes its mix from its own order line', () => {
  const s = boardMixSource(lineCard());
  assert.equal(s.kind, 'line');
  assert.equal(s.id, 7);
  assert.equal(s.path, '/planning/7/context');
  assert.equal(runIdOf(lineCard()), null);
});

test('a run parent takes its mix from the run', () => {
  const s = boardMixSource(runParent());
  assert.equal(s.kind, 'run');
  assert.equal(s.id, 44);
  assert.equal(s.path, '/gang-runs/44');
});

// The regression for divergence 1. STAGE_VIEW (/floor, /floor/:section) says
// `gang_run_id`; JC_VIEW (/job-cards) carries `line_gang_run_id` as well. A
// reader that knows only one of them silently returns null for the other.
test('the run id is found under either payload spelling', () => {
  assert.equal(runIdOf({ order_line_id: null, gang_run_id: 44 }), 44, 'STAGE_VIEW spelling');
  assert.equal(runIdOf({ order_line_id: null, line_gang_run_id: 44 }), 44, 'JC_VIEW spelling');
  assert.equal(boardMixSource({ order_line_id: null, line_gang_run_id: 44 })?.path, '/gang-runs/44');
});

// A SPLIT gang child has BOTH a gang_run_id and its own order line. Its board
// was already consumed by the parent at cutting; its mix, if any, is its own
// line's. All three pages already agreed on this — the shared reader must not
// quietly change it.
test('a split gang child reads as a LINE, not a run', () => {
  const s = boardMixSource({ order_line_id: 12, gang_run_id: 44 });
  assert.equal(s.kind, 'line');
  assert.equal(s.id, 12);
  assert.equal(runIdOf({ order_line_id: 12, gang_run_id: 44 }), null,
    'the card has a line of its own — the run id must not win');
});

test('a card anchored to neither a line nor a run has no mix source', () => {
  assert.equal(boardMixSource({ order_line_id: null, gang_run_id: null }), null);
  assert.equal(boardMixSource(null), null);
  assert.equal(boardMixSource(undefined), null);
});

// The regression for divergence 2 — the planned-breakup guard.
test('a run parent CAN carry a mix', () => {
  assert.equal(canCarryBoardMix(runParent()), true,
    'attachBoardMix reads a run parent\'s rows back through its members — skipping the '
    + 'fetch shows a single-board fallback where the job card shows the real plan');
  assert.equal(canCarryBoardMix(lineCard()), true);
  assert.equal(canCarryBoardMix({ order_line_id: null, gang_run_id: null }), false,
    'nothing to fetch, and the caller resolves straight to loaded');
});

// ── the rows themselves ───────────────────────────────────────────────
test('mix rows are normalised the same way for a run and a line', () => {
  const { rows, lots, plannedUps } = normaliseMixRows({
    mix: {
      rows: [{ material_id: 3, stock_batch_id: 9, sheets: 500, ups: 4, covers: 480,
               role: 'primary', reason: 'r', board_name: 'FBB' }],
      lots: [{ id: 9 }], planned_ups: 4,
    },
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { material_id: 3, stock_batch_id: 9, sheets: 500, ups: 4,
    covers: 480, role: 'primary', reason: 'r', board_name: 'FBB' });
  assert.deepEqual(lots, [{ id: 9 }]);
  assert.equal(plannedUps, 4);
});

// A RUN-level row prices itself — covers === sheets, because a differing cut is
// refused at plan-save and the server re-derives covers on confirm. All three
// copies carried this `?? x.sheets`; losing it in the extraction would quietly
// zero a run's cover count.
test('a row with no covers falls back to its sheet count', () => {
  const { rows } = normaliseMixRows({ mix: { rows: [{ material_id: 3, sheets: 500 }] } });
  assert.equal(rows[0].covers, 500);
  assert.equal(rows[0].stock_batch_id, undefined, 'absent stays absent — never invented');
});

test('an empty or absent mix normalises to empty, never to null', () => {
  for (const d of [null, undefined, {}, { mix: null }, { mix: { rows: [] } }]) {
    const n = normaliseMixRows(d);
    assert.deepEqual(n.rows, []);
    assert.deepEqual(n.lots, []);
    assert.equal(n.plannedUps, 0);
  }
});

// ── the source guard: no page may re-derive the rule ──────────────────
const PAGES = ['Production.jsx', 'Floor.jsx', 'Section.jsx'];
const pageSrc = p => readFileSync(new URL(`../../client/src/pages/${p}`, import.meta.url), 'utf8');

// A guard on CODE must not read PROSE. The banned spellings below are exactly
// what the comments in these files now explain the history of — a guard that
// scanned raw source would forbid documenting the very bug it protects against,
// and the fix would be to delete the explanation. Block comments go first, then
// each line's `//` tail; a `//` preceded by `:` is left alone so a URL survives.
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

// The stripper decides what the two guards below can still see. If it ate too
// much they would pass on anything, so it is pinned here rather than trusted.
test('the comment stripper hides prose and keeps code', () => {
  assert.doesNotMatch(code('// r.order_line_id == null ? x : y'), /order_line_id/, 'a whole-line comment goes');
  assert.doesNotMatch(code('const a = 1; // r.line_gang_run_id'), /line_gang_run_id/, 'a trailing comment goes');
  assert.doesNotMatch(code('/* r.order_line_id == null */'), /order_line_id/, 'a block comment goes');
  assert.match(code('const a = 1; // note'), /const a = 1;/, 'the code on that line stays');
  assert.match(code('const runId = r.order_line_id == null ? r.gang_run_id : null;'), /order_line_id\s*==\s*null/,
    'REAL code must still be caught — this is the spelling the guard exists to ban');
  assert.match(code("api.get('https://x/y')"), /https:\/\/x\/y/, 'a URL is not a comment');
});

test('no cutting screen hand-rolls the run-vs-line predicate', () => {
  for (const p of PAGES) {
    const src = code(pageSrc(p));
    assert.doesNotMatch(src, /order_line_id\s*==\s*null/,
      `${p}: the run-vs-line choice belongs to boardIssue.js. Spelled here it drifts — `
      + 'this exact line is how the station came to read a column its payload never had');
    assert.doesNotMatch(src, /line_gang_run_id/,
      `${p}: line_gang_run_id exists only in JC_VIEW; STAGE_VIEW has no such column. `
      + 'The shared reader accepts both spellings so no page has to know which payload it got');
  }
});

test('every cutting screen fetches its mix through the shared reader', () => {
  for (const p of PAGES) {
    const src = code(pageSrc(p));
    assert.match(src, /from '\.\.\/lib\/boardIssue\.js'/,
      `${p}: must import the shared reader`);
    assert.doesNotMatch(src, /api\.get\(`\/gang-runs\/\$\{[^}]*\}`\)/,
      `${p}: the endpoint choice is part of the rule — boardMixSource().path decides it, `
      + 'so a page cannot fetch a run one way and a line another');
  }
});
