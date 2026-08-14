// The rules that make an imported WIP list cumulative, and the clamp that stops
// widening the sheet from lying about how late the plant is.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_SHEET_SCOPE_SQL, PENDING_SQL, HAS_WIP_RECORD_SQL, LINE_STATUS_SQL, LINE_EDD_SQL,
  overdueDaysSql, isWipState, wipDateFor,
} from './wip-scope.js';

// ── The scope predicate ──────────────────────────────────────────────────────
// SQL cannot be run without a database here, so these assert the SHAPE that the
// behaviour depends on. Each one names a real regression: the pieces silently
// dropping out is exactly how the sheet and the matcher drifted apart before.

test('scope keeps a line that is pending OR carries a WIP record', () => {
  assert.ok(STATUS_SHEET_SCOPE_SQL.includes(PENDING_SQL));
  assert.ok(STATUS_SHEET_SCOPE_SQL.includes(HAS_WIP_RECORD_SQL));
  assert.match(STATUS_SHEET_SCOPE_SQL, / OR /);
});

test('a WIP record is IS NOT NULL, not = true — Non-WIP stays on the sheet', () => {
  // The whole tri-state rests on this. `wip = true` here would drop every line
  // the customer told us is NOT in progress, which is the one state that has no
  // other way of being seen.
  assert.equal(HAS_WIP_RECORD_SQL, 'ol.wip IS NOT NULL');
});

test('a cancelled line is out under every reading', () => {
  assert.match(STATUS_SHEET_SCOPE_SQL, /ol\.status <> 'cancelled'/);
  // AND, never OR: a cancelled line carrying an old WIP record must not be
  // readmitted by the second half of the predicate.
  assert.ok(STATUS_SHEET_SCOPE_SQL.indexOf("ol.status <> 'cancelled' AND") === 0);
});

test('pending still means owed — the original predicate is unchanged', () => {
  assert.match(PENDING_SQL, /ol\.qty > ol\.dispatched_qty/);
  assert.match(PENDING_SQL, /ol\.completed_at IS NULL/);
  assert.match(PENDING_SQL, /o\.status IN \('pending','hold'\)/);
});

// ── The status cascade ───────────────────────────────────────────────────────

test('line status is a cascade — dispatched wins over completed', () => {
  // A dispatched line is nearly always also completed. Independent tests would
  // let one line answer two chips and appear twice in a customer's workbook.
  const dispatchedAt = LINE_STATUS_SQL.indexOf("THEN 'dispatched'");
  const completedAt = LINE_STATUS_SQL.indexOf("THEN 'completed'");
  assert.ok(dispatchedAt > -1 && completedAt > -1);
  assert.ok(dispatchedAt < completedAt, 'dispatched must be tested first');
});

test('a fully shipped line reads dispatched even if nobody restatused it', () => {
  assert.match(LINE_STATUS_SQL, /ol\.dispatched_qty >= ol\.qty/);
});

test('status falls back to pending, never to null', () => {
  assert.match(LINE_STATUS_SQL, /ELSE 'pending'/);
});

// ── The overdue clamp ────────────────────────────────────────────────────────

test('overdue only counts a line that is still pending', () => {
  const sql = overdueDaysSql('CURRENT_DATE');
  // Without this, widening the sheet to finished work would inflate the Overdue
  // KPI with lines that are already out of the door.
  assert.ok(sql.includes(`${LINE_STATUS_SQL} = 'pending'`));
  assert.match(sql, /ELSE 0/);
});

test('overdue uses the plant clock it is handed, not its own', () => {
  const sql = overdueDaysSql('PLANT_TODAY');
  assert.ok(sql.includes('PLANT_TODAY'));
  assert.ok(!sql.includes('CURRENT_DATE'), 'must not reach for a second clock');
});

// ── The tri-state ────────────────────────────────────────────────────────────

test('only true, false and null are WIP states', () => {
  for (const ok of [true, false, null]) assert.equal(isWipState(ok), true);
  // The coercions that would write the opposite of what a caller meant:
  // Boolean('false') is true, and 0/'' would quietly become Non-WIP.
  for (const bad of ['yes', 'no', 'true', 'false', 0, 1, '', undefined, {}]) {
    assert.equal(isWipState(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('an explicit date always wins — the customer names their own day', () => {
  assert.equal(wipDateFor(true, '2026-08-01', '2026-08-12'), '2026-08-01');
  assert.equal(wipDateFor(false, '2026-08-01', '2026-08-12'), '2026-08-01');
});

test('a bare record stamps today — for Non-WIP as well as WIP', () => {
  assert.equal(wipDateFor(true, null, '2026-08-12'), '2026-08-12');
  // Non-WIP is something the customer SAID, on a day. Dropping its date would
  // make "they told us it is not in progress" indistinguishable from a guess.
  assert.equal(wipDateFor(false, null, '2026-08-12'), '2026-08-12');
});

test('removing the record clears the date, even one explicitly passed', () => {
  // A date with no record is a stale claim.
  assert.equal(wipDateFor(null, null, '2026-08-12'), null);
  assert.equal(wipDateFor(null, '2026-08-01', '2026-08-12'), null);
});

// ── EDD is a LINE-level override ─────────────────────────────────────────────
// orders.delivery_date is one date for a whole PO, and 79% of the lines on this
// sheet share a PO with other products (one carries 26). The customer's list
// names a date per ITEM, so the line may carry its own and the order's is the
// fallback.

test('the resolved EDD prefers the line and falls back to the order', () => {
  assert.equal(LINE_EDD_SQL, 'COALESCE(ol.delivery_date, o.delivery_date)');
  // The ORDER matters: reversed, a line could never override its PO and the
  // whole feature would be inert.
  assert.ok(LINE_EDD_SQL.indexOf('ol.delivery_date') < LINE_EDD_SQL.indexOf('o.delivery_date'));
});

test('overdue is judged against the RESOLVED EDD, not the PO’s', () => {
  const sql = overdueDaysSql('CURRENT_DATE');
  assert.ok(sql.includes(LINE_EDD_SQL), 'a line with its own EDD must be judged on that one');
  // The bare order column must not survive anywhere in the clamp, or a line
  // that overrode its date would still be called late on the PO's.
  assert.ok(!/(?<!ol\.delivery_date, )\bo\.delivery_date\b(?!\))/.test(
    sql.split(LINE_EDD_SQL).join('')), 'no stray o.delivery_date outside the COALESCE');
});

test('overdue still only counts a pending line', () => {
  assert.ok(overdueDaysSql('CURRENT_DATE').includes(`${LINE_STATUS_SQL} = 'pending'`));
});
