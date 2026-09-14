// What the station workspace (GET /floor/:section) is allowed to stop sending,
// and what it may never stop sending.
//
// The endpoint carries two lists in one shape. `queue` is live work — it needs
// the line clearance, the extra sheets in flight, the hold, the print spec.
// `completed` is history: two hundred finished runs, re-read by every tablet on
// every refresh and every realtime tick, rendering nine fixed columns. It used
// to carry the queue's whole working state anyway, 559 KB of a 658 KB cutting
// payload measured on live prod.
//
// These tests pin both halves of that trade: the drop list does what it says,
// and it can never grow over a field the Completed tab actually reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPLETED_DROPS, leanCompletedRun } from './routes/floor.js';

// Every field the Completed tab touches, read off client/src/pages/Section.jsx:
// the desktop table and the phone cards, the export columns, the deep search,
// the KPI strip (kpisFor in lib/operatorScope.js), the press-operator scope
// (effectiveMachineId / rowMachineId), and the three row actions — Adjust,
// Send back, Reverse. If a field here ever lands in COMPLETED_DROPS, a cell on
// the floor goes blank; that is what this list exists to prevent.
const READ_BY_THE_COMPLETED_TAB = [
  'id', 'job_card_id', 'stage', 'seq', 'status', 'unit',
  'qty_in', 'qty_out', 'qty_scrap', 'qty_planned', 'sheets_issued', 'children_per_parent',
  'yield_pct', 'wastage_pct', 'duration_min', 'scrap_reason',
  'operator', 'started_at', 'completed_at',
  'machine_id', 'press_machine_id', 'card_machine_id', 'machine_name',
  'jc_number', 'output_number', 'run_output_number', 'gang_number', 'run_kind',
  'gang_members', 'gang_run_id', 'wip',
  'product_id', 'product_name', 'product_code', 'party_item_code', 'party_artwork_code',
  'line_remark', 'size', 'gsm', 'ups', 'child_l', 'child_w',
  'board_name', 'board_grade', 'customer_name', 'po_number',
  'order_line_id', 'anchor_line_id',
];

test('a finished run keeps every field the Completed tab reads', () => {
  const dropped = READ_BY_THE_COMPLETED_TAB.filter(f => COMPLETED_DROPS.includes(f));
  assert.deepEqual(dropped, [], `these are rendered on the floor: ${dropped.join(', ')}`);
});

test('leanCompletedRun drops the live queue state and keeps the rest verbatim', () => {
  const row = {
    id: 7, job_card_id: 3, jc_number: 'CI-JC-0042', qty_in: 1200, qty_out: 1180,
    qty_scrap: 20, operator: 'Ramesh', completed_at: '2026-09-10T04:00:00.000Z',
    machine_id: 4, press_machine_id: null, product_name: 'Q MET 500',
    gang_members: [{ id: 1, product_name: 'Q MET 500' }],
    // …and the working state a finished run has no cell for:
    line_clearance: { checks: [1, 2, 3] }, open_xs: 9, hold_reason: 'ink',
    ready_override: true, print_instructions: 'two hits', po_date: '2026-08-01',
  };
  const lean = leanCompletedRun(row);
  for (const k of COMPLETED_DROPS) assert.equal(k in lean, false, `${k} should be gone`);
  for (const [k, v] of Object.entries(row)) {
    if (COMPLETED_DROPS.includes(k)) continue;
    assert.deepEqual(lean[k], v, `${k} must travel unchanged`);
  }
  assert.deepEqual(row.line_clearance, { checks: [1, 2, 3] }, 'the caller’s row is not mutated');
});

test('the drop list names each field once', () => {
  assert.equal(new Set(COMPLETED_DROPS).size, COMPLETED_DROPS.length);
});

// The other half of the change: a station loads the cards with live work AT
// that station, not every open card in the plant. The readiness, board and
// plate passes below it run over whatever this query returns, and their results
// are keyed by job card and read only for rows this section keeps — so pulling
// the whole floor was work thrown away. Pinned as source text because the
// saving IS the WHERE clause; a route that drops it still answers correctly and
// silently costs the floor its speed back.
test('the station query loads only the cards with live work at that station', () => {
  const src = readFileSync(new URL('./routes/floor.js', import.meta.url), 'utf8');
  const section = src.slice(src.indexOf("r.get('/floor/:section'"));
  assert.ok(section.includes('${LIVE_AT_SECTION}'),
    'the section queue query must be scoped by LIVE_AT_SECTION');
  assert.match(src, /const LIVE_AT_SECTION = `EXISTS \(SELECT 1 FROM job_stages live/,
    'LIVE_AT_SECTION must test for an unfinished stage at this section');
  assert.ok(section.includes('jc.id, js.seq`, [section]);'),
    'the scoped query must be parameterised on the section');
});
