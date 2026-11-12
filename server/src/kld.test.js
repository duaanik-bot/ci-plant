import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kldBlank, kldSvg } from '../../client/src/lib/kld.js';

// The KLD CI Plant draws from a size and the house rules (owner, 12 Nov 2026: "you will create the KLD for the
// product and save it … in the cost sheet itself"). Paths are millimetres, y down, origin at the blank's top-left.

const bbox = path => {
  const nums = [...path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(m => [+m[1], +m[2]]);
  const xs = nums.map(p => p[0]), ys = nums.map(p => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

test('reverse tuck: 2 × face + 2 × W + glue across, tube + 2 × (W + tuck) along', () => {
  const b = kldBlank({ construction: 'RTE', tube: 100, face: 65, w: 40 });
  assert.equal(b.width, 220);
  assert.equal(b.height, 204);
  const o = bbox(b.cut[0]);
  assert.ok(Math.abs(o.x0) < 0.01 && Math.abs(o.x1 - 220) < 0.01 && Math.abs(o.y0) < 0.01 && Math.abs(o.y1 - 204) < 0.01, JSON.stringify(o));
});

test('lock bottom: 2L + 2W + glue across, lock + H + W + tuck along', () => {
  const b = kldBlank({ construction: 'LOCK', tube: 66, face: 92, w: 80 });
  assert.equal(b.width, 359);
  assert.equal(b.height, 205);
  const o = bbox(b.cut[0]);
  assert.ok(Math.abs(o.x1 - 359) < 0.01 && Math.abs(o.y1 - 205) < 0.01, JSON.stringify(o));
});

test('the cut is one closed outline and every crease is drawn', () => {
  const rte = kldBlank({ construction: 'RTE', tube: 100, face: 65, w: 40 });
  assert.match(rte.cut[0], /^M[\d.,\- ]+(L[\d.,\- ]+)+Z$/);
  assert.equal(rte.crease.length, 12);   // 4 body · 2 closure hinges · 2 tuck creases · 4 dust hinges
  const lock = kldBlank({ construction: 'LOCK', tube: 66, face: 92, w: 80 });
  assert.equal(lock.crease.length, 14);  // 4 body · closure hinge · tuck crease · 2 dust hinges · 4 bottom hinges · 2 diagonals
  for (const c of [...rte.crease, ...lock.crease]) assert.match(c, /^M-?[\d.]+,-?[\d.]+ L-?[\d.]+,-?[\d.]+$/);
});

test('the drawing says what it is: glue area, dimensions and the grain', () => {
  const b = kldBlank({ construction: 'RTE', tube: 100, face: 65, w: 40 });
  assert.ok(b.glue.startsWith('M'));
  const labels = b.dims.map(d => d.label);
  for (const want of ['220', '204', '65', '40', '100', '10', '12']) assert.ok(labels.includes(want), `dimension ${want}`);
  assert.ok(b.grain.x2 > b.grain.x1, 'the grain runs across, round the carton');
});

test('the SVG is drawn in millimetres with a cut and a crease layer', () => {
  const svg = kldSvg(kldBlank({ construction: 'LOCK', tube: 66, face: 92, w: 80 }), { title: 'KLD 92 × 80 × 66 lock bottom' });
  assert.match(svg, /^<svg [^>]*viewBox="-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+"/);
  assert.match(svg, /class="cut"/);
  assert.match(svg, /class="crease"/);
  assert.match(svg, /KLD 92 × 80 × 66 lock bottom/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});
