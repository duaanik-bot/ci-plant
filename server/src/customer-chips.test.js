import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerChipsFrom, filterByCustomers, showCustomerChips }
  from '../../client/src/lib/customerChips.js';

// The customer filter chips, shared by Planning, Artwork, Job Cards and Print
// Planning. Two rules and a threshold, all three of which fail QUIETLY — which
// is the reason they are tested rather than trusted.
//
// The plant's real ids are 1, 2, 4, 5, 6 and 43; the three biggest customers
// hold 4, 5 and 6. The fixtures use those rather than 1,2,3, so a bug that only
// shows on the actual data has somewhere to show.

// A gang: one ROW standing for several cartons, as Planning and Artwork build it.
const gang = (id, members) => ({ id, _gang: members });
const line = (id, customer_id, customer_name) => ({ id, customer_id, customer_name });
const membersOf = r => r._gang;

const SGLS = 'Swiss Garnier Life Sciences';
const SGB = 'Swiss Garniers Biotech Private Limited';
const FLUENCE = 'Fluence Pharamceuticals Pvt. Ltd. ';   // misspelled + trailing space, verbatim from prod

// ── counting ─────────────────────────────────────────────────────────
test('a chip counts ROWS, and a run counts once however many members a customer owns', () => {
  // One gang row, three cartons, TWO of them the same customer. The row is one
  // line in the table, so SGLS's chip must read 1 — not 2.
  const rows = [gang('g1', [line(1, 4, SGLS), line(2, 4, SGLS), line(3, 5, SGB)])];
  const chips = customerChipsFrom(rows, membersOf);
  // By id, not by position — the ORDER is test 3's subject and both read 1 here.
  assert.equal(chips.find(c => c.id === 4).count, 1, 'two cartons, one row, one');
  assert.equal(chips.find(c => c.id === 5).count, 1);
});

test('a gang row answers to EVERY company on it', () => {
  const rows = [gang('g1', [line(1, 4, SGLS), line(2, 5, SGB)]), line(9, 4, SGLS)];
  const chips = customerChipsFrom(rows, membersOf);
  assert.equal(chips.find(c => c.id === 4).count, 2, 'the gang and the single line');
  assert.equal(chips.find(c => c.id === 5).count, 1, 'the gang alone');
});

test('busiest first, ties broken on the initials so the rail order is stable', () => {
  const rows = [
    line(1, 5, SGB), line(2, 5, SGB), line(3, 5, SGB),
    line(4, 43, FLUENCE),
    line(5, 4, SGLS),
  ];
  // SGB 3 leads; FP and SGLS both have 1, so FP sorts ahead on initials — NOT
  // on the id, which would have put 4 before 43 and moved the rail as ids grow.
  assert.deepEqual(customerChipsFrom(rows).map(c => c.id), [5, 43, 4]);
});

test('a row with no customer is skipped, never bucketed under a null chip', () => {
  const rows = [line(1, null, null), line(2, 4, SGLS), { id: 3 }];
  const chips = customerChipsFrom(rows);
  assert.deepEqual(chips.map(c => c.id), [4]);
});

test('a page that passes no membersOf treats each row as its own member', () => {
  // Print Planning: one customer per card, resolved through the gang's lead line.
  const chips = customerChipsFrom([line(1, 4, SGLS), line(2, 4, SGLS), line(3, 6, 'Herboveda')]);
  assert.deepEqual(chips.map(c => [c.id, c.count]), [[4, 2], [6, 1]]);
});

// ── filtering ────────────────────────────────────────────────────────
test('nothing selected keeps every row', () => {
  const rows = [line(1, 4, SGLS), line(2, 5, SGB)];
  assert.equal(filterByCustomers(rows, [], customerChipsFrom(rows)).length, 2);
});

test('several selected customers OR together — “SGLS and SGB, nothing else”', () => {
  const rows = [line(1, 4, SGLS), line(2, 5, SGB), line(3, 43, FLUENCE)];
  const kept = filterByCustomers(rows, [4, 5], customerChipsFrom(rows));
  assert.deepEqual(kept.map(r => r.id), [1, 2]);
});

test('a gang survives if ANY of its cartons belongs to a selected customer', () => {
  const rows = [gang('g1', [line(1, 4, SGLS), line(2, 5, SGB)]), line(9, 43, FLUENCE)];
  const kept = filterByCustomers(rows, [5], customerChipsFrom(rows, membersOf), membersOf);
  assert.deepEqual(kept.map(r => r.id), ['g1']);
});

// ── rule 2: the release guard ────────────────────────────────────────
// This is the one that fails silently. A chip vanishes when its last row leaves
// the tab, so the selection can outlive the control that set it — and the
// planner is then on an empty table with nothing visible to clear.
test('a selection whose customer has left the tab RELEASES instead of emptying the table', () => {
  const rows = [line(1, 4, SGLS), line(2, 5, SGB)];
  const chips = customerChipsFrom(rows);
  // 43 was selected on a tab that had Fluence rows. This one does not.
  const kept = filterByCustomers(rows, [43], chips);
  assert.equal(kept.length, 2, 'the queue comes back rather than stranding an empty table');
});

test('a PARTLY stale selection keeps filtering on the ids that survive', () => {
  const rows = [line(1, 4, SGLS), line(2, 5, SGB)];
  const kept = filterByCustomers(rows, [43, 5], customerChipsFrom(rows));
  assert.deepEqual(kept.map(r => r.id), [2],
    'one dead id must not release the whole filter — only its own clause');
});

// ── the threshold ────────────────────────────────────────────────────
test('the rail hides below two customers — one choice narrows nothing', () => {
  assert.equal(showCustomerChips([]), false);
  assert.equal(showCustomerChips([{ id: 4 }]), false);
  assert.equal(showCustomerChips([{ id: 4 }, { id: 5 }]), true);
  assert.equal(showCustomerChips(undefined), false, 'a page loading its rows must not throw');
});
