import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineIdsClosedBy, closeRunLines, reopenRunLines, dispatchedLinesBlockingReverse } from './helpers.js';

// "The lines this card closes" — ONE spelling, shared by the closer, its
// inverse and every dispatched gate in front of them.
//
// A split gang CHILD carries BOTH keys: its own order_line_id AND its run's
// gang_run_id (splitGangParentJob copies the run onto every child). It made
// cartons for its own sales order only, so it closes that one line, which is
// what closeRunLines always did. Sort & Paste's gates asked something wider —
// `ol.id = order_line_id OR ol.gang_run_id = gang_run_id` — so once a PARTNER
// shipped, the child could be neither closed, reversed nor adjusted though its
// own line was untouched. Live on 17 Sep 2026: CI-JC-0182 (line 179) behind
// CI-JC-0183 (line 401) on CI-GANG-0024, CI-JC-0210 (line 446) behind
// CI-JC-0211 (line 493) on CI-GANG-0034.
//
// Only a RUN card — order_line_id NULL, a combined run whose one pile serves
// every member — closes every line on its run, so only a run card is refused
// when any member has shipped.

// CI-GANG-0024 (run 59) as it stood: 179 still at Sort & Paste, 401 shipped.
const GANG_59 = [
  { id: 179, gang_run_id: 59, status: 'in_production', dispatched_qty: 0, po_number: 'PO-179' },
  { id: 401, gang_run_id: 59, status: 'dispatched', dispatched_qty: 5000, po_number: 'SHORTAGE' },
];
const CHILD_0182 = { id: 182, order_line_id: 179, gang_run_id: 59, parent_job_card_id: 150 };

const fakeDb = (lines) => {
  const runReads = [];
  const moved = [];
  const qc = async (sql, params) => {
    if (/FROM order_lines WHERE gang_run_id/.test(sql)) {
      runReads.push(params[0]);
      return lines.filter(l => l.gang_run_id === params[0]).map(l => ({ id: l.id }));
    }
    if (/UPDATE order_lines SET status/.test(sql)) { moved.push(params[1]); return []; }
    return [];
  };
  // Serves reopenRunLines' status probe and setLineStatus' own `SELECT *`.
  const oc = async (sql, params) => {
    if (/FROM order_lines WHERE id=/.test(sql)) return lines.find(l => l.id === params[0]) || null;
    return null;
  };
  return { qc, oc, runReads, moved };
};

test('a split gang CHILD closes its own line — never the run it was cut on', async () => {
  const { qc, runReads } = fakeDb(GANG_59);
  assert.deepEqual(await lineIdsClosedBy(CHILD_0182, qc), [179],
    'the partner line 401 is not this card\'s to close, so it is not this card\'s to be refused by');
  assert.deepEqual(runReads, [], 'a card with a line of its own never needs to read its run');
});

test('a COMBINED RUN card (no line of its own) closes every line on its run', async () => {
  const { qc } = fakeDb([
    { id: 446, gang_run_id: 73 }, { id: 493, gang_run_id: 73 }, { id: 500, gang_run_id: 74 },
  ]);
  assert.deepEqual(await lineIdsClosedBy({ id: 9, order_line_id: null, gang_run_id: 73 }, qc), [446, 493]);
});

test('a plain card closes its one line', async () => {
  const { qc, runReads } = fakeDb([]);
  assert.deepEqual(await lineIdsClosedBy({ order_line_id: 12, gang_run_id: null }, qc), [12]);
  assert.deepEqual(runReads, []);
});

test('a card anchored to neither a line nor a run closes nothing', async () => {
  const { qc } = fakeDb([]);
  assert.deepEqual(await lineIdsClosedBy({}, qc), []);
});

test('closeRunLines moves exactly lineIdsClosedBy — a child\'s close never touches its partner', async () => {
  const { qc, oc, moved } = fakeDb(GANG_59);
  await closeRunLines(CHILD_0182, qc, oc, 'tester');
  assert.deepEqual(moved, [179]);
});

test('reopenRunLines reopens exactly lineIdsClosedBy — the same set the close moved', async () => {
  const { qc, oc, moved, runReads } = fakeDb([
    { id: 179, gang_run_id: 59, status: 'produced' },
    { id: 401, gang_run_id: 59, status: 'produced' },
  ]);
  await reopenRunLines(CHILD_0182, qc, oc, 'tester');
  assert.deepEqual(moved, [179], 'reversing one child must not pull its partner back onto the floor');
  assert.deepEqual(runReads, []);
});

test('THE GATE: a partner\'s shipment does not block the child — a run member\'s still blocks the run card', async () => {
  const { qc } = fakeDb(GANG_59);
  const askedBy = async jc => {
    const ids = await lineIdsClosedBy(jc, qc);
    return GANG_59.filter(l => ids.includes(l.id));
  };
  assert.deepEqual(dispatchedLinesBlockingReverse(await askedBy(CHILD_0182)), [],
    'CI-JC-0182 was refused over line 401, which it never produced for');
  assert.deepEqual(
    dispatchedLinesBlockingReverse(await askedBy({ order_line_id: null, gang_run_id: 59 })).map(l => l.id), [401],
    'a card with no line of its own produced for every member — a shipped member still refuses it');
});
