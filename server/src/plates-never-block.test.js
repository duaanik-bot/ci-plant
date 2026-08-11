import test from 'node:test';
import assert from 'node:assert/strict';
import { toolingGateOk, toolingDetail } from './tooling-gate.js';
import { plateReadinessForPrinting } from './plate-lifecycle.js';
import { validatePlateDispositions } from './plates.js';
import { readFileSync } from 'node:fs';

// THE RULE, in one file: plates inform, plates never block.
//
// The plate warehouse is reconnected to the plant flow, but on an explicit
// instruction that it must never stand between a press and its run. A missing or
// unready plate is a thing to TELL somebody, never a thing that refuses a click.
// Dies keep their hard gate and blocks keep their soft one; plates alone are
// carved out completely.
//
// This file exists so that rule cannot be quietly undone: every path that could
// refuse a start or a completion over plates is asserted not to.

test('an unready plate set does not hold a line back from ready', () => {
  // The defect that prompted the detach: `hard: false` reads as "cannot block",
  // but the gate failed a soft family on an explicit 'not_ready' too, so a plate
  // set at the maker could stop a line going ready with nothing on screen saying so.
  const detail = [
    { family: 'die', hard: true, status: 'ready' },
    { family: 'plate', hard: false, status: 'not_ready' },
  ];
  assert.equal(toolingGateOk(detail, 0), true, 'a plate must never fail the gate');
});

test('a missing die still blocks — only the soft families were loosened', () => {
  assert.equal(toolingGateOk([{ family: 'die', hard: true, status: 'not_ready' }], 0), false);
  assert.equal(toolingGateOk([{ family: 'die', hard: true, status: 'missing' }], 0), false);
});

test('a plate cannot block at ANY status', () => {
  for (const status of ['missing', 'not_ready', 'ready', 'on_order', 'anything_at_all']) {
    assert.equal(toolingGateOk([{ family: 'plate', hard: false, status }], 0), true,
      `a plate at '${status}' must not block`);
  }
});

test('the carve-out is plates only — a block at the maker still holds a line', () => {
  // Scope discipline: the instruction was about plates. An emboss block missing
  // from the rack is a real reason to hold a line, and that rule is untouched.
  assert.equal(toolingGateOk([{ family: 'block', hard: false, status: 'not_ready' }], 0), false);
  // An untracked block still informs rather than blocks, exactly as before.
  assert.equal(toolingGateOk([{ family: 'block', hard: false, status: 'missing' }], 0), true);
});

test('printing start reports missing plates instead of refusing', async () => {
  // Three of four plates in hand is a fact the press wants told, not a locked door.
  const qc = async () => ([
    { status: 'available', component_label: 'Cyan', request_number: 'CI-TR-1' },
    { status: 'pr_required', component_label: 'Black', request_number: 'CI-TR-1' },
  ]);
  const verdict = await plateReadinessForPrinting(qc, 42);
  assert.equal(verdict.is_ready, false);
  assert.equal(verdict.required, 2);
  assert.equal(verdict.ready, 1);
  // Named, so the operator knows which plate to go and look for.
  assert.deepEqual(verdict.missing.map(row => row.component_label), ['Black']);
  assert.deepEqual(verdict.request_numbers, ['CI-TR-1']);
});

test('a job with no plates at all starts clean', async () => {
  const verdict = await plateReadinessForPrinting(async () => [], 42);
  assert.equal(verdict.is_ready, true);
  assert.equal(verdict.required, 0);
});

test('completion accepts a partial account of the plates', async () => {
  // The press closes its job. Whatever it says about plates is recorded; what it
  // does not say is simply not recorded. Nothing refuses the completion.
  const issued = [{ id: 1, component_label: 'Cyan' }, { id: 2, component_label: 'Black' }];
  const decided = validatePlateDispositions(issued, [{ asset_id: 1, action: 'return', condition: 'Good' }]);
  assert.equal(decided.length, 1, 'only the plate that was spoken for');
  assert.equal(decided[0].asset.id, 1);
});

test('completion accepts no plate account at all', async () => {
  const issued = [{ id: 1, component_label: 'Cyan' }];
  assert.deepEqual(validatePlateDispositions(issued, []), []);
  assert.deepEqual(validatePlateDispositions(issued, null), []);
});

test('finalising a Job Card raises NO plate requirement — plates are asked for by hand', () => {
  // Finalising a card used to fire a Plate PR by itself. Anik: raising plates is
  // a DECISION — most cards reuse a plate set that already exists, so the
  // automatic PR filled the plate queue with paperwork nobody had asked for and
  // buried the handful that were real.
  //
  // It is raised manually now, through the door that already existed and is
  // reached from both places the plant works from:
  //   Artwork    -> POST /tools/push                     { families: ['plate', ...] }
  //   Job Cards  -> POST /job-cards/:id/tooling-requirements  (ToolingForwardModal)
  // Neither is touched by this change; only the automatic firing is gone.
  //
  // Asserted structurally and NEGATIVELY, because the failure mode is silent:
  // re-adding the call breaks nothing, throws nothing, and simply refills the
  // queue — which is exactly how it got there the first time.
  const route = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');

  assert.ok(!/auto_from_finalise/.test(route),
    "production.js writes an 'auto_from_finalise' event again — the Job Card finalise is raising "
    + 'Plate PRs by itself. Plates are raised by hand from Artwork or the Job Card.');
  assert.ok(!/raisePlateRequirement\s*\(/.test(route),
    'raisePlateRequirement is being called again from production.js. The manual doors are '
    + "POST /tools/push (Artwork) and POST /job-cards/:id/tooling-requirements (Job Cards).");
});

test('what the press DOES say is still checked', () => {
  // Soft on absence, strict on content: a stated condition must be a real one, or
  // the record is worse than no record.
  assert.throws(() => validatePlateDispositions(
    [{ id: 1, component_label: 'Cyan' }],
    [{ asset_id: 1, action: 'return', condition: 'Excellent' }]),
  /Good, Fair or Damaged/);
});
