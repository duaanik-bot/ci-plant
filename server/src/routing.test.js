// Dynamic production routing — the optional finishing stages (Coating, Leafing,
// Embossing) are added ONLY when the Product Master field is set; the mandatory
// stages are always present. Pasting is mandatory: it doubles as the packing
// station, so every job passes through it (even a die-cut-only box with no
// gluing). See routingFor() in helpers.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingFor } from './helpers.js';

const seq = p => routingFor(p).map(s => s.stage);
const MANDATORY = ['cutting', 'printing', 'die_cutting', 'sorting', 'pasting', 'qc'];

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
    ['cutting', 'printing', 'coating', 'die_cutting', 'sorting', 'pasting', 'qc']);
});

test('routing: a lamination finish inserts lamination, not coating', () => {
  assert.ok(seq({ coating: 'Thermal Lamination (Matte)' }).includes('lamination'));
});

test('routing: leafing (hot-foil) routes through the foiling press', () => {
  assert.deepEqual(seq({ leafing: 1 }),
    ['cutting', 'printing', 'foiling', 'die_cutting', 'sorting', 'pasting', 'qc']);
});

test('routing: emboss flag inserts the embossing stage', () => {
  assert.ok(seq({ emboss: 1 }).includes('embossing'));
});

test('routing: full works keeps every stage in the correct order', () => {
  assert.deepEqual(seq({ coating: 'Full UV Coating', emboss: 1, leafing: 1, pasting_type: 'Auto Bottom' }),
    ['cutting', 'printing', 'coating', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting', 'qc']);
});

test('routing: legacy special enum still routes foiling + embossing', () => {
  assert.deepEqual(seq({ special: 'foil_emboss' }),
    ['cutting', 'printing', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting', 'qc']);
});

test('routing: spec_override booleans/strings are honoured for optional stages', () => {
  const s = seq({ emboss: true, leafing: '1' });
  assert.ok(s.includes('embossing') && s.includes('foiling'));
  assert.ok(s.includes('pasting')); // still mandatory
});
