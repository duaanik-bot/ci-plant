// Two ways into a Plate GRN, and neither of them is a new implementation.
//
// Receiving could only START on the PO register — find the order, press GRN on
// its row — so plates that arrived WITHOUT paperwork had no door at all:
// opening stock, a set cut outside the system, plates found on a shelf. The
// purchase order is now offered rather than demanded.
//
// The direct door is Add Plates, reused. That form already solved the hard part
// twice over: a carton is found by output number OR by product, because the
// number is exactly what nobody remembers for old stock, and it writes the
// number back to a blank master. Re-solving that here would give the plant two
// answers to "which carton is this", and they would drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const page = () => read('client/src/components/PlatesLifecycle.jsx');

function component(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const next = source.indexOf('\nfunction ', at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

test('the GRN register has its own Create GRN door', () => {
  const source = page();
  assert.match(source, /onClick=\{\(\)=>setNewGrn\(true\)\}/,
    'the GRN tab must offer Create GRN — otherwise receiving can only ever start from the PO register, '
    + 'and a delivery with no paperwork has nowhere to go');
  assert.ok(component(source, 'NewPlateGrnModal'), 'NewPlateGrnModal is missing');
});

test('the purchase order is offered, not demanded', () => {
  const body = component(page(), 'NewPlateGrnModal');
  assert.match(body, /key: 'direct'/,
    'a direct tab must exist, or the PO is still a hard mandate');
  // The confirm button must be reachable on the direct tab without a PO chosen.
  assert.match(body, /mode === 'po'\s*\?[\s\S]*disabled=\{!chosen\}[\s\S]*:\s*<Button variant="success" onClick=\{onDirect\}/,
    'only the PO route may be gated on choosing a PO; the direct route must not be');
});

test('a fully received PO is not offered as somewhere to receive', () => {
  const body = component(page(), 'NewPlateGrnModal');
  assert.match(body, /outstandingTotal\(po\) > 0/,
    'a PO with nothing outstanding leads to a form with nothing tickable on it');
  assert.match(body, /'reversed', 'closed'/,
    'a reversed or closed PO cannot take a receipt');
});

test('the direct door REUSES Add Plates rather than reimplementing it', () => {
  const source = page();
  const body = component(source, 'NewPlateGrnModal');

  // It hands off. It must not grow its own lookup.
  assert.doesNotMatch(body, /plates\/entry-context|plates\/entry-products|plates\/warehouse\/assets/,
    'the direct tab has started doing its own carton lookup — that is a second answer to '
    + '"which carton is this", and it will drift from Add Plates');
  assert.match(source, /onDirect=\{\(\)=>\{setNewGrn\(false\); setAddingPlates\(true\);\}\}/,
    'the direct door must open the existing Add Plates form');

  // And Add Plates must still be the thing that owns both keys.
  const addPlates = component(source, 'AddPlatesModal');
  assert.ok(addPlates, 'AddPlatesModal is missing');
  assert.match(addPlates, /output_number=/, 'Add Plates must still look a carton up by output number');
  assert.match(addPlates, /product_id=/, 'and by product — the number is not a gate');
  assert.match(addPlates, /masterOutputSync/, 'and must still offer to write the number back to a blank master');
});

test('the PO route hands off to the whole-PO receipt, not a second form', () => {
  const source = page();
  assert.match(source, /onPickPo=\{po=>\{setNewGrn\(false\); setGrnModal\(po\);\}\}/,
    'choosing a PO must open the same PlateGrnModal the PO register opens, or the two doors '
    + 'will offer different rules about what can be received');
});
