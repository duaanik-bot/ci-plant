import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readinessLight } from './readiness-light.js';

// ─── Station-aware readiness light ───────────────────────────────────────────
// The same dot on every station, but each station is asked only about what IT
// needs, plus the one fact a station has that planning does not: has the work
// physically reached me yet.

// Everything a job could need, all good — so any amber/red in a test comes from
// the thing that test is actually about.
const CLEAN = {
  gates: {
    artwork: 1, material: true,
    tooling_detail: [{ family: 'plate', status: 'ready' }, { family: 'die', status: 'ready' }],
  },
  machineId: 1, finalisedAt: '2026-07-30', shade: { eligible: true }, cuttingStatus: 'completed',
};
const at = (stage, extra = {}) => readinessLight({ ...CLEAN, stage, ...extra });
const row = (r, key) => r.items.find(i => i.key === key);

test('station: no stage is the planning view — unchanged, and no input row', () => {
  const r = readinessLight(CLEAN);
  assert.equal(row(r, 'input_ready'), undefined);
  assert.equal(r.items.length, 9);
});

test('station: a station view asks about arrival of work', () => {
  const r = at('printing', { prevStatus: 'completed' });
  assert.equal(row(r, 'input_ready').state, 'ok');
});

test('station: printing is asked about its plate, never about the die', () => {
  const r = at('printing', { prevStatus: 'completed' });
  assert.equal(row(r, 'plate').state, 'ok');
  assert.equal(row(r, 'die').state, 'na');
});

test('station: die cutting is asked about its die, never about the plate', () => {
  const r = at('die_cutting', { prevStatus: 'completed' });
  assert.equal(row(r, 'die').state, 'ok');
  assert.equal(row(r, 'plate').state, 'na');
});

test('station: cutting is asked for board, and not whether board is cut', () => {
  const r = at('cutting', { prevStatus: null });
  assert.equal(row(r, 'board_available').state, 'ok');
  assert.equal(row(r, 'board_cut').state, 'na');
});

test('station: a later station is not asked to find board — it was issued upstream', () => {
  const r = at('printing', { prevStatus: 'completed' });
  assert.equal(row(r, 'board_available').state, 'na');
});

// ── the colour rules Anik asked for ──
test('station: upstream still running with nothing here yet is AMBER', () => {
  for (const prevStatus of ['in_progress', 'partially_completed', 'hold']) {
    const r = at('printing', { prevStatus, qtyReceived: 0 });
    assert.equal(row(r, 'input_ready').state, 'pending', prevStatus);
    assert.equal(r.light, 'amber', prevStatus);
  }
});

test('station: upstream not started and nothing here is RED', () => {
  const r = at('printing', { prevStatus: 'pending', prevStage: 'cutting', qtyReceived: 0 });
  assert.equal(row(r, 'input_ready').state, 'blocked');
  assert.equal(r.light, 'red');
  assert.match(r.blockers[0], /cutting/i);
});

test('station: work that has physically arrived is GREEN even mid-run upstream', () => {
  const r = at('printing', { prevStatus: 'in_progress', qtyReceived: 4200 });
  assert.equal(row(r, 'input_ready').state, 'ok');
  assert.equal(r.light, 'green');
});

test('station: upstream completed is GREEN with everything else ready', () => {
  const r = at('printing', { prevStatus: 'completed' });
  assert.equal(r.light, 'green');
});

test('station: the first stage has no upstream to wait for', () => {
  const r = at('cutting', { prevStatus: null });
  assert.equal(row(r, 'input_ready').state, 'na');
  assert.equal(r.light, 'green');
});

test('station: the input row names the stage the work is waiting on', () => {
  const r = at('printing', { prevStatus: 'in_progress', prevStage: 'cutting' });
  assert.match(row(r, 'input_ready').note, /cutting/i);
});

test('station: masked-out rows do not drag the percentage down', () => {
  const r = at('pasting', { prevStatus: 'completed' });
  assert.equal(r.pct, 100);
  assert.equal(r.light, 'green');
});

// Caught by an end-to-end run, not by the rows above: 'board_cut' and
// 'input_ready' answer the same question at a station — has cutting delivered?
// board_cut is planning's proxy and demands cutting be COMPLETED, so leaving it
// in a station mask silently pinned printing to amber while sheets sat on the
// press. input_ready is the route-aware version and must be the only voice.
test('station: sheets in hand beat a cutting stage that is still running', () => {
  const r = readinessLight({
    ...CLEAN, cuttingStatus: 'in_progress',
    stage: 'printing', prevStatus: 'in_progress', prevStage: 'cutting', qtyReceived: 4200,
  });
  assert.equal(row(r, 'board_cut').state, 'na');
  assert.equal(row(r, 'input_ready').state, 'ok');
  assert.equal(r.light, 'green');
});

test('station: a hard gate still overrides a happy station view', () => {
  // Artwork, not shade: shade became a warning when printing start became an
  // acknowledge-and-run alarm. The rule under test is that a REFUSAL still
  // beats a station whose own work has arrived, so it needs a gate the ERP
  // actually refuses on.
  const r = at('printing', { prevStatus: 'completed', gates: { ...CLEAN.gates, artwork: 0 } });
  assert.equal(r.light, 'red');
  assert.match(r.blockers[0], /artwork/i);
});

test('station: a lapsed shade card warns the press without stopping it', () => {
  const r = at('printing', { prevStatus: 'completed', shade: { eligible: false, reason: 'Shade card not approved' } });
  assert.equal(r.light, 'amber');
  assert.deepEqual(r.blockers, []);
  assert.match(row(r, 'shade').note, /shade/i);
});
