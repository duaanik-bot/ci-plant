import test from 'node:test';
import assert from 'node:assert/strict';
import { clubSuggestions } from '../../client/src/lib/prClubbing.js';

const pr = (id, pr_number, status, lines) => ({ id, pr_number, status, lines });
const line = (material_id, qty, material_name = `board ${material_id}`) => ({ material_id, qty, material_name, unit: 'sheets' });

test('one board wanted by two open requisitions is a club', () => {
  const { acrossPrs } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [line(7, 20)]),
    pr(2, 'CI-PR-0002', 'approved', [line(7, 10)]),
  ]);
  assert.equal(acrossPrs.length, 1);
  assert.equal(acrossPrs[0].material_id, 7);
  assert.equal(acrossPrs[0].prCount, 2);
  assert.equal(acrossPrs[0].total_qty, 30);
  assert.deepEqual(acrossPrs[0].prs.map(p => p.pr_number), ['CI-PR-0001', 'CI-PR-0002']);
});

test('a board on a single requisition is not a club', () => {
  const { acrossPrs } = clubSuggestions([pr(1, 'CI-PR-0001', 'approved', [line(7, 20)])]);
  assert.deepEqual(acrossPrs, []);
});

// Converted and closed requisitions already have their order, or never will.
// Offering them would send the buyer to a PR they cannot act on.
test('converted and closed requisitions are never offered', () => {
  const { acrossPrs } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [line(7, 20)]),
    pr(2, 'CI-PR-0002', 'converted', [line(7, 10)]),
    pr(3, 'CI-PR-0003', 'closed', [line(7, 10)]),
  ]);
  assert.deepEqual(acrossPrs, [], 'only one OPEN requisition wants board 7');
});

test('pending and approved club together, and the set is flagged not ready', () => {
  const { acrossPrs } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [line(7, 20)]),
    pr(2, 'CI-PR-0002', 'pending', [line(7, 10)]),
  ]);
  assert.equal(acrossPrs.length, 1, 'still worth showing — approve the pending one and it goes');
  assert.equal(acrossPrs[0].readyToOrder, false);
});

test('an all-approved set is ready to order', () => {
  const { acrossPrs } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [line(7, 20)]),
    pr(2, 'CI-PR-0002', 'approved', [line(7, 10)]),
  ]);
  assert.equal(acrossPrs[0].readyToOrder, true);
});

test('one requisition naming a board twice is a within-PR club', () => {
  const { withinPr } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'pending', [line(7, 20), line(9, 5), line(7, 10)]),
  ]);
  assert.equal(withinPr.length, 1);
  assert.equal(withinPr[0].material_id, 7);
  assert.equal(withinPr[0].lineCount, 2);
  assert.equal(withinPr[0].total_qty, 30);
  assert.equal(withinPr[0].pr_number, 'CI-PR-0001');
});

// The two shapes are independent: a PR that repeats a board internally still
// counts as ONE demand when clubbing across requisitions, or the same sheets
// would be offered twice.
test('a requisition repeating a board counts once across PRs, at its summed quantity', () => {
  const { acrossPrs } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [line(7, 20), line(7, 10)]),
    pr(2, 'CI-PR-0002', 'approved', [line(7, 5)]),
  ]);
  assert.equal(acrossPrs[0].prCount, 2, 'two requisitions, not three lines');
  assert.equal(acrossPrs[0].prs.find(p => p.pr_number === 'CI-PR-0001').qty, 30);
  assert.equal(acrossPrs[0].total_qty, 35);
});

test('different boards never club', () => {
  const { acrossPrs } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [line(7, 20)]),
    pr(2, 'CI-PR-0002', 'approved', [line(9, 10)]),
  ]);
  assert.deepEqual(acrossPrs, []);
});

test('the biggest club is offered first', () => {
  const { acrossPrs } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [line(7, 20), line(9, 100)]),
    pr(2, 'CI-PR-0002', 'approved', [line(7, 10), line(9, 100)]),
    pr(3, 'CI-PR-0003', 'approved', [line(7, 10)]),
  ]);
  assert.equal(acrossPrs[0].material_id, 7, '3 requisitions beats 2, regardless of quantity');
  assert.equal(acrossPrs[1].material_id, 9);
});

// A requisition raised against an order line is "information, not a duplicate"
// to the PR form's re-raise warning. That test is the wrong one here: two jobs
// needing the same board is exactly the case worth buying once.
test('requisitions for different jobs still club', () => {
  const { acrossPrs } = clubSuggestions([
    { ...pr(1, 'CI-PR-0001', 'approved', [line(7, 20)]), order_line_id: 500 },
    { ...pr(2, 'CI-PR-0002', 'approved', [line(7, 10)]), order_line_id: 601 },
  ]);
  assert.equal(acrossPrs.length, 1);
  assert.equal(acrossPrs[0].total_qty, 30);
});

// Rows raised before multi-line requisitions existed carry the material on the
// header and have no lines array at all.
test('a header-only requisition still counts', () => {
  const { acrossPrs } = clubSuggestions([
    { id: 1, pr_number: 'CI-PR-0001', status: 'approved', material_id: 7, qty: 20, material_name: 'board 7' },
    pr(2, 'CI-PR-0002', 'approved', [line(7, 10)]),
  ]);
  assert.equal(acrossPrs.length, 1);
  assert.equal(acrossPrs[0].total_qty, 30);
});

test('a line with no material is ignored rather than grouping with other blanks', () => {
  const { acrossPrs, withinPr } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [{ material_id: '', qty: 0 }, { material_id: null, qty: 0 }]),
    pr(2, 'CI-PR-0002', 'approved', [{ material_id: '', qty: 0 }]),
  ]);
  assert.deepEqual(acrossPrs, []);
  assert.deepEqual(withinPr, []);
});

test('numeric and string material ids are the same board', () => {
  const { acrossPrs } = clubSuggestions([
    pr(1, 'CI-PR-0001', 'approved', [line('7', 20)]),
    pr(2, 'CI-PR-0002', 'approved', [line(7, 10)]),
  ]);
  assert.equal(acrossPrs.length, 1, 'the register mixes both');
});

test('an empty register is not a crash', () => {
  assert.deepEqual(clubSuggestions([]), { acrossPrs: [], withinPr: [] });
  assert.deepEqual(clubSuggestions(undefined), { acrossPrs: [], withinPr: [] });
});
