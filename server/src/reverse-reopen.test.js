import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reopenRunLines } from './helpers.js';

// Reversing a Sort & Paste run has to put the ORDER LINE back too. The line was
// marked `produced` when the job closed; left there it reads delivered over a
// job that is visibly back on the floor, and the re-completion dies on
// "Invalid status change".

const fakeDb = (lines) => {
  const calls = [];
  const qc = async (sql, params) => {
    if (/FROM order_lines WHERE gang_run_id/.test(sql))
      return lines.filter(l => l.gang_run_id === params[0]).map(l => ({ id: l.id }));
    if (/UPDATE order_lines/.test(sql)) { calls.push(params); return []; }
    return [];
  };
  // Matches both reads: reopenRunLines' own status probe AND the `SELECT *`
  // that setLineStatus does before it asserts the transition.
  const oc = async (sql, params) => {
    if (/FROM order_lines WHERE id=/.test(sql))
      return lines.find(l => l.id === params[0]) || null;
    return null;
  };
  return { qc, oc, calls };
};

test('a plain card reopens its one produced line', async () => {
  const { qc, oc } = fakeDb([{ id: 1, status: 'produced' }]);
  const out = await reopenRunLines({ order_line_id: 1 }, qc, oc, 'tester');
  assert.equal(out.length, 1);
});

test('a combined run reopens EVERY member — closeRunLines closed them all', async () => {
  const { qc, oc } = fakeDb([
    { id: 1, gang_run_id: 9, status: 'produced' },
    { id: 2, gang_run_id: 9, status: 'produced' },
    { id: 3, gang_run_id: 9, status: 'produced' },
  ]);
  const out = await reopenRunLines({ gang_run_id: 9 }, qc, oc, 'tester');
  assert.equal(out.length, 3);
});

test('a DISPATCHED member is skipped, not thrown on — the rest still reopen', async () => {
  // Cartons that left cannot be un-made, but a gang must not be stuck because
  // one of its lines shipped.
  const { qc, oc } = fakeDb([
    { id: 1, gang_run_id: 9, status: 'dispatched' },
    { id: 2, gang_run_id: 9, status: 'produced' },
  ]);
  const out = await reopenRunLines({ gang_run_id: 9 }, qc, oc, 'tester');
  assert.equal(out.length, 1, 'only the produced line moved');
});

test('a line that was never produced is left alone', async () => {
  const { qc, oc } = fakeDb([{ id: 1, status: 'in_production' }]);
  assert.equal((await reopenRunLines({ order_line_id: 1 }, qc, oc, 'tester')).length, 0);
});

test('a card anchored to neither a line nor a run reopens nothing', async () => {
  const { qc, oc } = fakeDb([]);
  assert.equal((await reopenRunLines({}, qc, oc, 'tester')).length, 0);
});
