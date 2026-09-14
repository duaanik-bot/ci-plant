// The readiness gates a Planning row carries to the browser.
//
// readiness() answers a far larger question for the server — the cut
// arithmetic, the incoming sheets, the mix rows — and every bit of it was
// riding to the client on each of 356 lines. The planner's screen reads three
// gates, a pending flag and the four numbers boardShortOf() needs.
//
// This pins the list against its readers, so the next trim cannot take one of
// them away: Planning.jsx (boardGate, ReadinessCell), lib/boardShort.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leanReadiness } from './routes/orders.js';

// grep -rn "readiness\." client/src  →  these, and only these:
const READ_BY_THE_PLANNER = [
  'artwork',           // ReadinessCell gate chip
  'tooling',           // ReadinessCell gate chip
  'material',          // ReadinessCell + boardGate + boardShortOf
  'material_pending',  // ReadinessCell hint ("PR/PO raised, board awaited")
  'parent_needed',     // boardShortOf
  'available_sheets',  // boardShortOf
  'mix_active',        // boardShortOf
  'mix_short',         // boardShortOf
  'board_drawn',       // Planning.jsx
];

test('the readiness projection keeps every gate the planner reads', () => {
  const gates = Object.fromEntries(READ_BY_THE_PLANNER.map(k => [k, 'kept']));
  const lean = leanReadiness(gates);
  const missing = READ_BY_THE_PLANNER.filter(k => !(k in lean));
  assert.deepEqual(missing, [], `Planning renders these: ${missing.join(', ')}`);
});

test('it drops the server-side arithmetic no client line reads', () => {
  const lean = leanReadiness({
    artwork: true, material: false, parent_needed: 125, available_sheets: 60,
    tooling_detail: 'list', die_condition: 'Good', incoming_sheets: 20000,
    needed_sheets: 250, child_size: '19×20"', mix_balance: 125, mix_rows: 0,
  });
  for (const k of ['tooling_detail', 'die_condition', 'incoming_sheets',
    'needed_sheets', 'child_size', 'mix_balance', 'mix_rows']) {
    assert.equal(k in lean, false, `${k} is not read by any client line`);
  }
  assert.equal(lean.parent_needed, 125);
  assert.equal(lean.material, false);
});

test('no gates is still no gates — a line without readiness is left alone', () => {
  assert.equal(leanReadiness(null), null);
  assert.equal(leanReadiness(undefined), undefined);
});
