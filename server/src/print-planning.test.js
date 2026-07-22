import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printReverseBlockers, printQueueEditBlock } from './helpers.js';

// ── printReverseBlockers ──────────────────────────────────────────────
test('printReverse: completed run with only pending downstream is clean', () => {
  assert.deepEqual(
    printReverseBlockers({
      printingStatus: 'completed', jcStatus: 'in_progress',
      downstreamStages: [{ stage: 'coating', status: 'pending' }],
    }),
    []);
});
test('printReverse: a non-completed printing stage cannot be reversed', () => {
  const b = printReverseBlockers({ printingStatus: 'in_progress', jcStatus: 'in_progress' });
  assert.match(b[0], /completed/i);
});
test('printReverse: a started downstream stage blocks and names it', () => {
  const b = printReverseBlockers({
    printingStatus: 'completed', jcStatus: 'in_progress',
    downstreamStages: [{ stage: 'die_cutting', status: 'in_progress' }],
  });
  assert.match(b.join(' '), /Die cutting is already in progress/);
});
test('printReverse: a closed/split job is blocked', () => {
  assert.match(printReverseBlockers({ printingStatus: 'completed', jcStatus: 'closed' }).join(' '), /closed/i);
});

// ── printQueueEditBlock ───────────────────────────────────────────────
test('printQueueEdit: a pending (queued) run is editable', () => {
  assert.equal(printQueueEditBlock({ printingStatus: 'pending', jcStatus: 'in_progress' }), null);
});
test('printQueueEdit: an in-progress run blocks with a reverse hint', () => {
  assert.match(printQueueEditBlock({ printingStatus: 'in_progress', jcStatus: 'in_progress' }), /Reverse this run/i);
});
test('printQueueEdit: a completed run blocks with a reverse hint', () => {
  assert.match(printQueueEditBlock({ printingStatus: 'completed', jcStatus: 'in_progress' }), /Reverse this run/i);
});
test('printQueueEdit: a finalised card blocks', () => {
  assert.match(printQueueEditBlock({ printingStatus: 'pending', jcStatus: 'open', finalised: true }), /finalised/i);
});
test('printQueueEdit: a closed card blocks', () => {
  assert.match(printQueueEditBlock({ printingStatus: 'pending', jcStatus: 'closed' }), /Closed/i);
});
