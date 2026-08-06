import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortPastePhase } from './floor-order.js';

// Anik's case: a 5,400 day count on a 10,200 job, then "complete the balance"
// offered 10,200 instead of 4,800 — because the day count had been filed
// against sorting, leaving the pasting log (which the close reads) empty.

test('nothing pasted yet — the job is sorting', () => {
  assert.deepEqual(sortPastePhase('in_progress', 'pending'), { pasteStarted: false, phase: 'sort' });
  assert.equal(sortPastePhase('pending', 'pending').phase, 'sort');
});

test('THE FIX — pasting started while sorting is still open: the job is PASTING', () => {
  // This is the state a day count creates. Under the old rule (phase = sorting
  // is completed ? paste : sort) this said 'sort', the run went to the sorting
  // stage, and the balance was lost.
  assert.deepEqual(sortPastePhase('in_progress', 'in_progress'), { pasteStarted: true, phase: 'paste' });
  assert.equal(sortPastePhase('partially_completed', 'in_progress').phase, 'paste');
});

test('the ordinary path is unchanged — sorting closed, pasting running', () => {
  assert.equal(sortPastePhase('completed', 'in_progress').phase, 'paste');
  assert.equal(sortPastePhase('completed', 'pending').phase, 'sort');
});

test('a completed pasting stage is still pasting, never back to sorting', () => {
  assert.equal(sortPastePhase('completed', 'completed').phase, 'paste');
});
