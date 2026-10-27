// Idle job cards — the rule that decides which live cards Job Cards and the
// Live Floor leave out until someone asks for them (idle-cards.js).
//
// Three rules here fail QUIETLY, which is why they are tested, not trusted:
//  1. a card on a machine or on hold is never idle, however long ago it moved;
//  2. a run is never split — board and plate verdicts collapse a gang to its
//     weakest member over the set they are handed;
//  3. no `idle` param is the legacy request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_DAYS, idleCardIds, idleModeOf } from './idle-cards.js';

const NOW = new Date('2026-10-17T10:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000);
const C = (id, last_days, { gang = null, working = false } = {}) =>
  ({ id, gang_run_id: gang, last_at: last_days == null ? null : daysAgo(last_days), working });

test('IDLE_DAYS is fourteen', () => {
  assert.equal(IDLE_DAYS, 14);
});

test('a card quiet for the threshold or longer is idle; one inside it is not', () => {
  const ids = idleCardIds([C(1, 14), C(2, 13.9), C(3, 60), C(4, 0)], NOW);
  assert.deepEqual([...ids].sort(), [1, 3]);
});

test('a working stage keeps an old card on screen', () => {
  const ids = idleCardIds([C(1, 90, { working: true }), C(2, 90)], NOW);
  assert.deepEqual([...ids], [2]);
});

test('a card with no activity stamp at all is not hidden', () => {
  // last_at NULL cannot happen for a real card (created_at is NOT NULL), but a
  // missing fact must never be read as "quiet" — show it.
  assert.equal(idleCardIds([C(1, null)], NOW).size, 0);
});

test('a run is idle only when every live card of it is idle', () => {
  const ids = idleCardIds([
    C(1, 40, { gang: 7 }), C(2, 2, { gang: 7 }),      // run 7: one member moved
    C(3, 40, { gang: 8 }), C(4, 30, { gang: 8 }),     // run 8: all quiet
    C(5, 40, { gang: 9, working: true }), C(6, 40, { gang: 9 }), // run 9: one on a machine
  ], NOW);
  assert.deepEqual([...ids].sort(), [3, 4]);
});

test('custom threshold', () => {
  assert.deepEqual([...idleCardIds([C(1, 5), C(2, 8)], NOW, 7)], [2]);
});

test('only idle=hide and idle=mark are new; anything else is the legacy answer', () => {
  assert.equal(idleModeOf({ idle: 'hide' }), 'hide');
  assert.equal(idleModeOf({ idle: 'mark' }), 'mark');
  for (const q of [{}, { idle: '' }, { idle: 'show' }, { idle: ['hide', 'hide'] }, undefined])
    assert.equal(idleModeOf(q), null);
});

test('the floor counts every unfinished stage of an idle card in its own section', async () => {
  const { idleBySection } = await import('./idle-cards.js');
  const S = ['cutting', 'printing', 'die_cutting'];
  const rows = [
    { job_card_id: 1, stage: 'cutting', status: 'completed', machine_id: null },
    { job_card_id: 1, stage: 'printing', status: 'pending', machine_id: 4 },
    { job_card_id: 1, stage: 'die_cutting', status: 'pending', machine_id: null },
    { job_card_id: 2, stage: 'printing', status: 'pending', machine_id: 5 },
    { job_card_id: 3, stage: 'qc', status: 'pending', machine_id: null }, // not a section here
  ];
  assert.deepEqual(idleBySection(rows, S), { cards: 2, sections: { cutting: 0, printing: 2, die_cutting: 1 } });
  // A press-scoped login sees only its own press's printing rows.
  assert.deepEqual(idleBySection(rows, S, [5]), { cards: 2, sections: { cutting: 0, printing: 1, die_cutting: 1 } });
});
