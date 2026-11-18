import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSize } from './costing-engine.js';
import { registerMatchesFrom, dieMasterMatches, REGISTER_MM } from './costing-match.js';
import { dieName, dieFrom, dieFacts, dieSize, masterItem, listItem, listed, noNewDieLabel } from '../../client/src/lib/die-check.js';

// The size check's die list (owner, 15 Nov 2026): a die is found whichever order its size is written in, a die with
// the same three numbers in another order is a check ("does it open the same way?"), never "this size". Invented
// dies and sizes; nothing here is the plant's.
const die = (die_no, l, w, h) => ({ die_no, l, w, h });
const nos = list => list.map(d => d.die_no);

test('the die list: exact, the same numbers in another order, and close dies in either order', () => {
  const size = parseSize('92x80x66');
  const out = registerMatchesFrom(size, [
    die('A', 92, 80, 66), die('B', 80, 92, 66), die('C', 90, 79, 64), die('D', 64, 90, 79), die('E', 100, 80, 66),
  ]);
  assert.equal(REGISTER_MM, 3);
  assert.deepEqual(nos(out.exact), ['A']);
  assert.deepEqual(nos(out.reordered), ['B']);
  assert.deepEqual(nos(out.near), ['C', 'D']);
  assert.deepEqual(out.near.map(d => d.other_order), [false, true]);
});

test('two equal sides: the written order is exact once, the other orders are only "another order"', () => {
  const out = registerMatchesFrom(parseSize('50x50x100'), [die('P', 50, 50, 100), die('Q', 50, 100, 50), die('R', 100, 50, 50)]);
  assert.deepEqual(nos(out.exact), ['P']);
  assert.deepEqual(nos(out.reordered), ['Q', 'R']);
  assert.deepEqual(out.near, []);
});

test('close dies come nearest first, by the smaller of the written-order and the sorted difference', () => {
  const size = parseSize('92x80x66');
  const rows = [die('C', 90, 79, 64), die('G', 66, 80, 91)]; // C: 5 mm off in all; G: 1 mm off once sorted
  assert.deepEqual(nos(registerMatchesFrom(size, rows).near), ['G', 'C']);
  assert.deepEqual(nos(registerMatchesFrom(size, rows, { limit: 1 }).near), ['G']);
});

test('the Die Master on this screen: the die list\'s rule, so a die 3 mm off or in another order is not missed', () => {
  // hiding the die list's copies of Die Master dies must not lose the 3 mm net those copies gave (matchDies stops at 2 mm)
  const out = dieMasterMatches(parseSize('92x80x66'), [
    { code: 'T1', carton_size: '92X80X66' }, { code: 'T2', carton_size: '80X92X66' }, { code: 'T3', carton_size: '95X80X66' },
    { code: 'T4', carton_size: '66X80X93' }, { code: 'T5', carton_size: '96X80X66' }, { code: 'T6', carton_size: '150X240' },
  ]);
  assert.deepEqual(out.exact.map(d => d.code), ['T1']);
  assert.deepEqual(out.reordered.map(d => d.code), ['T2']);
  assert.deepEqual(out.near.map(d => [d.code, d.other_order]), [['T4', true], ['T3', false]]);
});

// The words on the screen. The register's numbers are not written on the dies (owner, 15 Nov 2026), so a die is named
// by its job where one is recorded, and the line says where the die is known from.
test('a die is named by its job; without one, by its list number or its die number', () => {
  const reg = { die_no: '7', job_no: '12345', source: 'DIE DATA 2024' };
  assert.equal(dieName(reg), "Job 12345's die");
  assert.equal(dieFrom(reg), '2024 die list no. 7');
  const noJob = { die_no: '7', source: 'DIE DATA 2024' };
  assert.equal(dieName(noJob), '2024 die list no. 7');
  assert.equal(dieFrom(noJob), 'no job no. recorded');
  assert.equal(dieName({ die_no: 'J12345/2', job_no: '12345', source: 'DRIVE NEW DIE' }), "Job 12345's die no. 2");
  assert.equal(dieName({ die_no: 'X-1', source: 'somewhere else' }), 'Die X-1');
});

test('where a die is known from, and only the facts that are recorded', () => {
  assert.equal(dieFrom({ die_no: 'J1', job_no: '1', source: 'DRIVE NEW DIE' }), 'new-die drawing in Drive');
  assert.equal(dieFrom({ die_no: 'J1', job_no: '1', source: 'DRIVE DIE LINE' }), 'die line in Drive');
  assert.equal(dieFrom({ die_no: 'J1', job_no: '1', source: 'DRIVE OLD DIE USE' }), 'old-die job file in Drive');
  assert.equal(dieFrom({ die_no: 'X-1', source: 'somewhere else' }), 'in the die list');
  assert.deepEqual(dieFacts({ style: 'LOCK', ups: 2 }), ['Lock bottom', '2 up']);
  assert.deepEqual(dieFacts({}), []);
  assert.equal(dieSize({ l: 71.5, w: 43.5, h: 109 }), '71.5 × 43.5 × 109');
});

test('the list lines: size first, the Die Master marked, another order said, at most six then "+ n more"', () => {
  assert.equal(masterItem({ code: 'T4', carton_size: '66X80X93', ups: 4, other_order: true }), '66 × 80 × 93, Die Master die T4 (4 up, another order)');
  assert.equal(masterItem({ code: 'T3', carton_size: '95X80X66' }), '95 × 80 × 66, Die Master die T3');
  assert.equal(listItem({ die_no: 'J12345/1', job_no: '12345', source: 'DRIVE DIE LINE', l: 80, w: 92, h: 66 }, 'another order'),
    "80 × 92 × 66, Job 12345's die no. 1 (die line in Drive, another order)");
  const nine = Array.from({ length: 9 }, (_, i) => `d${i}`);
  assert.equal(listed(nine), 'd0 · d1 · d2 · d3 · d4 · d5 · + 3 more');
  assert.equal(listed(nine.slice(0, 6)), 'd0 · d1 · d2 · d3 · d4 · d5');
});

test('the costing card\'s button for a die-list die names the die', () => {
  assert.equal(noNewDieLabel({ die_no: 'J12345', job_no: '12345', source: 'DRIVE NEW DIE' }), "No new die — use Job 12345's die");
  assert.equal(noNewDieLabel({ die_no: '7', source: 'DIE DATA 2024' }), 'No new die — use 2024 die list no. 7');
});
