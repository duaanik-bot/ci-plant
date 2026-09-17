// What the job-card register carries, and what it may never stop carrying.
//
// GET /job-cards hands Production.jsx every card with every stage — 2,020 stage
// rows and 2.9 MB on live prod, 1.96 MB of it stages, and 772 KB of THAT the
// line-clearance sheet that no line of client code reads anywhere. The register
// draws a rail (stage, state, counts, who ran it); the bench detail belongs to
// the station screens, which fetch their own rows.
//
// This pins the keep-list against what Production.jsx, WorkflowControls and
// JobCardSheet actually read off these rows. The plate warehouse no longer reads
// this register: its issue picker has its own lean route (id, jc_number,
// product_name, status) — see job-cards-open-picker.test.js — so nothing here
// has to be kept on its account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOB_CARD_STAGE_FIELDS, JOB_CARD_LIST_DROPS, leanStage } from './routes/production.js';

// Read off a stage row of THIS payload, by file:
//   Production.jsx  st.id · st.seq · st.stage · st.status · st.unit · st.qty_out
//                   st.qty_scrap · st.operator, and jc.stages.length/.some/.find
//   lib/received.js receivedQty(st) → received ?? qty_in ?? upstream_available
//   WorkflowControls.jsx  s.status      JobCardSheet.jsx  s.stage · s.operator
const READ_OFF_A_STAGE = [
  'id', 'seq', 'stage', 'status', 'unit',
  'qty_in', 'qty_out', 'qty_scrap', 'operator',
  'received', 'upstream_available',
];

test('a stage rail keeps every field its readers touch', () => {
  const missing = READ_OFF_A_STAGE.filter(f => !JOB_CARD_STAGE_FIELDS.includes(f));
  assert.deepEqual(missing, [], `the register renders these: ${missing.join(', ')}`);
});

test('leanStage keeps the listed fields verbatim and drops everything else', () => {
  const stage = {
    id: 12, job_card_id: 3, seq: 2, stage: 'printing', status: 'completed', unit: 'sheets',
    qty_in: 1200, qty_out: 1180, qty_scrap: 20, operator: 'Ramesh', machine_id: 4,
    started_at: '2026-09-14T04:00:00.000Z', completed_at: '2026-09-14T06:00:00.000Z',
    received: 1200, upstream_available: 1200, live: true, extra_issued: 0,
    // the bench's own working state — read on /floor/:section, never here:
    line_clearance: { points: [1, 2, 3, 4, 5] }, hold_reason: 'ink', remarks: 'note',
    inspector: 'QC', qty_accepted: 1180, pack_boxes: 4, floor_pos: 2, ceiling: 1300,
  };
  const lean = leanStage(stage);
  assert.deepEqual(Object.keys(lean).sort(),
    JOB_CARD_STAGE_FIELDS.filter(f => f in stage).sort());
  for (const k of Object.keys(lean)) assert.deepEqual(lean[k], stage[k], `${k} must travel unchanged`);
  assert.equal('line_clearance' in lean, false, 'the clearance sheet is 772 KB and unread here');
  assert.deepEqual(stage.line_clearance, { points: [1, 2, 3, 4, 5] }, 'the caller’s row is not mutated');
});

test('a field is never in both the stage keep-list and the card drop-list', () => {
  const both = JOB_CARD_LIST_DROPS.filter(f => JOB_CARD_STAGE_FIELDS.includes(f));
  assert.deepEqual(both, []);
});

test('the card drop-list names each field once', () => {
  assert.equal(new Set(JOB_CARD_LIST_DROPS).size, JOB_CARD_LIST_DROPS.length);
  assert.equal(new Set(JOB_CARD_STAGE_FIELDS).size, JOB_CARD_STAGE_FIELDS.length);
});
