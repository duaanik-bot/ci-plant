// The station workspace stops shipping two hundred finished runs to a tablet
// that is looking at its queue.
//
// GET /floor/:section carries `completed` — 200 finished runs, 283 KB of a
// 385 KB cutting payload and 290 of 416 KB at printing on live prod
// (2026-09-17) — and every tablet re-reads it on every realtime tick while it
// sits on the Production Queue tab, which is where it opens. The Completed tab
// is the only thing that draws those rows.
//
// But the queue tab is NOT blind to them: once an operator is picked (the normal
// tablet state — the pick is restored per device) the KPI strip is kpisFor over
// the picked man's finished runs, and the Completed tab's count is
// runsForOperator over the same rows. So the opt-in `?completed=kpi` mode keeps
// all 200 rows but sends each one as the handful of fields those two read.
//
// Old bundles stay on plant tablets for days and never send the param, so the
// default response must be byte-for-byte what it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sectionPayload } from './routes/floor.js';
import {
  COMPLETED_KPI_FIELDS, completedKpiRow, sectionFloorPath, hasCompletedRows, latestOnly,
} from '../../client/src/lib/sectionCompleted.js';
import { kpisFor, runsForOperator } from '../../client/src/lib/operatorScope.js';

const NOW = new Date('2026-09-17T09:00:00+05:30');
const run = (id, over = {}) => ({
  id, job_card_id: 100 + id, jc_number: `CI-JC-${id}`, stage: 'printing', status: 'completed',
  unit: 'sheets', qty_in: 1000 + id, qty_out: 980 + id, qty_scrap: 20, operator: 'Ramesh',
  started_at: '2026-09-17T02:00:00.000Z', completed_at: NOW.toISOString(),
  machine_id: 4, press_machine_id: 4, product_name: 'Q MET 500', customer_name: 'Fluence',
  gang_members: null, yield_pct: 98, wastage_pct: 2, duration_min: 60, ...over,
});
const COMPLETED = [
  run(1),
  run(2, { operator: 'Suresh', machine_id: 5, press_machine_id: 5 }),
  run(3, { completed_at: '2026-09-10T04:00:00.000Z' }),                 // not today
  run(4, { machine_id: null, press_machine_id: 5, operator: null }),     // pinned, never started on a machine
  run(5, { qty_in: 0, qty_out: 0, qty_scrap: 0 }),
];
const QUEUE = [{ id: 9, queue_state: 'queued', machine_id: 4, operator: null }];
const KPIS = { pending: 1, incoming: 0, running: 0, on_hold: 0, completed_today: 4 };
const PARTS = {
  section: 'printing', kpis: KPIS, queue: QUEUE, completed: COMPLETED,
  audit: [{ id: 1, action: 'start' }], extraSheets: [], machines: [{ id: 4, name: 'P1' }],
};

test('without the param the response is byte-identical to the legacy shape', () => {
  // The literal the route built before this change, key for key, in order.
  const legacy = {
    section: PARTS.section, kpis: PARTS.kpis, queue: PARTS.queue, completed: PARTS.completed,
    audit: PARTS.audit, extra_sheets: PARTS.extraSheets, machines: PARTS.machines,
  };
  for (const query of [{}, { completed: '' }, { completed: 'full' }, { completed: ['kpi', 'kpi'] }, { other: 'kpi' }]) {
    assert.equal(JSON.stringify(sectionPayload(PARTS, query)), JSON.stringify(legacy),
      `query ${JSON.stringify(query)} must get today's response`);
  }
});

test('?completed=kpi keeps every run but only the fields the queue tab reads', () => {
  const out = sectionPayload(PARTS, { completed: 'kpi' });
  assert.equal(out.completed_rows, 'kpi', 'the client must be able to tell a projection from full rows');
  assert.equal(out.completed.length, COMPLETED.length, 'same 200 runs — the tab count is their length');
  for (const row of out.completed) assert.deepEqual(Object.keys(row), [...COMPLETED_KPI_FIELDS]);
  // everything else untouched
  for (const k of ['section', 'kpis', 'queue', 'audit', 'extra_sheets', 'machines'])
    assert.deepEqual(out[k], sectionPayload(PARTS, {})[k], `${k} must not change`);
});

test('kpisFor and runsForOperator give the same answer over the projection', () => {
  const lean = COMPLETED.map(completedKpiRow);
  const chips = [
    null,
    { mode: 'machine', machineId: 4 }, { mode: 'machine', machineId: '5' },
    { mode: 'pool', name: 'Ramesh' }, { mode: 'pool', name: 'Suresh' },
  ];
  for (const chip of chips) {
    const full = runsForOperator(COMPLETED, chip);
    const proj = runsForOperator(lean, chip);
    assert.deepEqual(proj.map(r => r.id), full.map(r => r.id), `tab count for ${JSON.stringify(chip)}`);
    assert.deepEqual(kpisFor(QUEUE, proj, NOW), kpisFor(QUEUE, full, NOW), `KPI strip for ${JSON.stringify(chip)}`);
  }
});

test('the station asks for full rows only while the Completed tab is open', () => {
  assert.equal(sectionFloorPath('cutting', 'completed'), '/floor/cutting');
  for (const tab of ['queue', 'extra_sheets', 'audit'])
    assert.equal(sectionFloorPath('cutting', tab), '/floor/cutting?completed=kpi');
  assert.equal(hasCompletedRows(null), false);
  assert.equal(hasCompletedRows({ completed: [] }), true, 'an old server (or the full mode) sends real rows');
  assert.equal(hasCompletedRows({ completed: [], completed_rows: 'kpi' }), false);
});

test('an older response never overwrites a newer one on screen', () => {
  const gate = latestOnly();
  const lean = gate.begin();      // queue tab refresh in flight
  const full = gate.begin();      // operator taps Completed
  assert.equal(gate.accept(full), true, 'the full rows land first');
  assert.equal(gate.accept(lean), false, 'the slower lean answer must not blank the Completed tab');
  const next = gate.begin();
  assert.equal(gate.accept(next), true);
  // A newer answer landing before an older one still paints — a busy floor
  // refetching faster than the server answers must never freeze the screen.
  const a = gate.begin(); const b = gate.begin();
  assert.equal(gate.accept(a), true);
  assert.equal(gate.accept(b), true);
});

test('Section.jsx loads through the tab ref and the sequence gate', () => {
  const src = readFileSync(new URL('../../client/src/pages/Section.jsx', import.meta.url), 'utf8');
  assert.match(src, /sectionFloorPath\(section, tabRef\.current\)/,
    'load() must choose the param from a ref — the realtime hook holds an older closure');
  assert.match(src, /loadGate\.current\.accept\(/, 'stale answers must be dropped');
  assert.match(src, /runsForOperator\(data\?\.completed \|\| \[\], pick\)/,
    'the tab count and KPI strip still read every run, projection or not');
});
