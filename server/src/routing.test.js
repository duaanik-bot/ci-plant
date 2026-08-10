// Dynamic production routing — the optional finishing stages (Coating, Leafing,
// Embossing) are added ONLY when the Product Master field is set; the mandatory
// stages are always present. Pasting is mandatory AND last: it doubles as the
// packing station, so every job passes through it (even a die-cut-only box with
// no gluing), and it is the release point — the separate 'qc' hop is gone, so
// closing pasting closes the job card. See routingFor() in helpers.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingFor } from './helpers.js';

const seq = p => routingFor(p).map(s => s.stage);
const MANDATORY = ['cutting', 'printing', 'die_cutting', 'sorting', 'pasting'];

test('routing: blank spec runs only the mandatory stages', () => {
  assert.deepEqual(seq({}), MANDATORY);
});

test('routing: mandatory stages are always present regardless of options', () => {
  const s = seq({ coating: 'Full UV Coating', emboss: 1, leafing: 1, pasting_type: 'Auto Bottom' });
  for (const m of MANDATORY) assert.ok(s.includes(m), `missing mandatory stage ${m}`);
});

test('routing: pasting is always present — it is also the packing station', () => {
  // A die-cut-only cake box still routes through pasting to record packing,
  // whether or not pasting_type names a gluing style.
  assert.ok(seq({}).includes('pasting'));
  assert.ok(seq({ pasting_type: 'Straight Line' }).includes('pasting'));
  assert.ok(seq({ pasting_type: 'None' }).includes('pasting'));
  assert.ok(seq({ pasting_type: '' }).includes('pasting'));
});

test('routing: coating label inserts the coating stage after printing', () => {
  assert.deepEqual(seq({ coating: 'Aqueous Varnish (Gloss)' }),
    ['cutting', 'printing', 'coating', 'die_cutting', 'sorting', 'pasting']);
});

test('routing: a lamination finish inserts lamination, not coating', () => {
  assert.ok(seq({ coating: 'Thermal Lamination (Matte)' }).includes('lamination'));
});

test('routing: leafing (hot-foil) routes through the foiling press', () => {
  assert.deepEqual(seq({ leafing: 1 }),
    ['cutting', 'printing', 'foiling', 'die_cutting', 'sorting', 'pasting']);
});

test('routing: emboss flag inserts the embossing stage', () => {
  assert.ok(seq({ emboss: 1 }).includes('embossing'));
});

test('routing: full works keeps every stage in the correct order', () => {
  assert.deepEqual(seq({ coating: 'Full UV Coating', emboss: 1, leafing: 1, pasting_type: 'Auto Bottom' }),
    ['cutting', 'printing', 'coating', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting']);
});

test('routing: legacy special enum still routes foiling + embossing', () => {
  assert.deepEqual(seq({ special: 'foil_emboss' }),
    ['cutting', 'printing', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting']);
});

test('routing: spec_override booleans/strings are honoured for optional stages', () => {
  const s = seq({ emboss: true, leafing: '1' });
  assert.ok(s.includes('embossing') && s.includes('foiling'));
  assert.ok(s.includes('pasting')); // still mandatory
});

test('routing: no route ever produces a qc stage — Sort & Paste is the release point', () => {
  const specs = [{}, { coating: 'Full UV Coating' }, { leafing: 1 }, { emboss: 1 },
    { special: 'foil_emboss' }, { coating: 'Thermal Lamination (Matte)', emboss: 1, leafing: 1 }];
  for (const p of specs) assert.ok(!seq(p).includes('qc'), `qc stage leaked into ${JSON.stringify(p)}`);
});

test('routing: pasting is the LAST stage — the closer fires on it', () => {
  // The job-card closer keys on seq === MAX(seq), not on a stage name. If any
  // route grew a stage after pasting, jobs would silently stop releasing to
  // Dispatch and stock would never reach Finished Goods.
  const specs = [{}, { coating: 'Full UV Coating' }, { leafing: 1 }, { emboss: 1 },
    { special: 'foil_emboss' }, { coating: 'Thermal Lamination (Matte)', emboss: 1, leafing: 1 }];
  for (const p of specs) assert.equal(seq(p).at(-1), 'pasting', `pasting is not last for ${JSON.stringify(p)}`);
});

test('routing: a gang child ends at pasting, so the split job still releases', () => {
  // createJobCardForGang splits the parent at die cutting and gives each child
  // the tail of its own route. That slice is taken with this same filter — if it
  // ever kept a stage after pasting, gang children would close but never reach
  // Dispatch, and only the gang half of the plant would break.
  const tail = p => routingFor(p).filter(s => ['sorting', 'pasting'].includes(s.stage)).map(s => s.stage);
  for (const p of [{}, { coating: 'Full UV Coating' }, { special: 'foil_emboss' }]) {
    assert.deepEqual(tail(p), ['sorting', 'pasting'], `bad gang-child tail for ${JSON.stringify(p)}`);
  }
});

// Every spec branch routingFor() has: no finish, both finish families, each
// finishing flag in each accepted form, and the legacy `special` enum. The two
// tests below assert a POSITION, so they need the widest matrix in this file —
// a stage order that holds for a blank product but not a foiled one would be
// exactly the case nobody tries by hand.
const EVERY_SPEC = [
  {}, { coating: null }, { coating: '' }, { coating: 'none' },
  { coating: 'Full UV Coating' }, { coating: 'Aqueous Varnish (Gloss)' },
  { coating: 'Thermal Lamination (Matte)' }, { coating: 'Soft Touch' }, { coating: 'Spot UV' },
  { leafing: 1 }, { leafing: true }, { leafing: '1' }, { leafing: 'yes' },
  { emboss: 1 }, { emboss: true }, { emboss: '1' },
  { special: 'foil' }, { special: 'emboss' }, { special: 'foil_emboss' },
  { coating: 'Full UV Coating', emboss: 1, leafing: 1, pasting_type: 'Auto Bottom' },
  { coating: 'Thermal Lamination (Matte)', emboss: true, leafing: '1', special: 'foil_emboss' },
];

test('routing: cutting is the FIRST stage — the BOARD DRAW fires on it', () => {
  // The mirror of the pasting rule above, and load-bearing for the same reason:
  // POST /job-stages/:id/start issues board when `!prev` — when the stage being
  // started is the FIRST one — NOT when it is named 'cutting'. So "cutting is
  // first" is what actually decides which station draws board out of the
  // warehouse.
  //
  // It matters because the reverses are not equivalent. Cutting's reverses give
  // the board back: sendStageBack() returns it before resetting the stage to
  // pending, and the in-place /job-stages/:id/reverse leaves the stage
  // 'in_progress' so it can never be re-started. /print-planning/reverse does
  // NEITHER — it resets printing to 'pending' and returns no board at all.
  //
  // So the day cutting stops being first, printing becomes the board-drawing
  // stage, and reverse-to-Triage → start again draws the same board TWICE.
  // Nothing would catch it: a double draw writes two consumption rows AND
  // drops the batch twice, so every stock reconciliation still balances
  // perfectly. That is the FG double-count (main@9e1f52e) in the more
  // expensive ledger. If this test fails, gate the draw on the stage before
  // changing the route.
  for (const p of EVERY_SPEC)
    assert.equal(seq(p)[0], 'cutting', `cutting is not first for ${JSON.stringify(p)}`);
});

test('routing: printing is NEVER the first stage — it cannot be allowed to draw board', () => {
  // Stated separately from the rule above because printing is the specific
  // danger, not just "something other than cutting": it is the one stage with a
  // reverse (/print-planning/reverse, back to Triage) that resets it to
  // 'pending' while returning nothing to the warehouse.
  for (const p of EVERY_SPEC)
    assert.notEqual(seq(p)[0], 'printing', `printing became first for ${JSON.stringify(p)}`);
});
