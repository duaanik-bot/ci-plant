import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePoRate, pickPoRate } from './routes/procurement.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

// Real plant fixture: Saffire · 300 GSM · 23 x 36 → kgPerSheet 0.160257744.
const saffire = { category: 'board', grade: 'Saffire', gsm: 300, sheet_l: 23, sheet_w: 36,
  std_rate: null, last_rate: 999 };
const baseRates = [{ grade: 'Saffire', vendor_id: null, rate_per_kg: 81, active: 1 }];
const vendorRates = [...baseRates, { grade: 'Saffire', vendor_id: 7, rate_per_kg: 84, active: 1 }];

// A board with a base rate on file derives ₹/sheet = kg/sheet × base ₹/kg,
// never the material's stale last_rate.
test('resolvePoRate: board with base rate → derived ₹/sheet, source base', () => {
  const r = resolvePoRate(saffire, null, baseRates);
  near(r.rate, 0.160257744 * 81); // ≈ 12.98
  assert.equal(r.rate_per_kg, 81);
  assert.equal(r.source, 'base');
  assert.notEqual(r.rate, 999); // NOT last_rate
});

// A vendor-specific rate row overrides the base for that vendor.
test('resolvePoRate: board with vendor override → vendor ₹/sheet, source vendor', () => {
  const r = resolvePoRate(saffire, 7, vendorRates);
  near(r.rate, 0.160257744 * 84); // ≈ 13.46
  assert.equal(r.rate_per_kg, 84);
  assert.equal(r.source, 'vendor');
});

// A different vendor with no override still gets the base rate.
test('resolvePoRate: other vendor falls back to base', () => {
  const r = resolvePoRate(saffire, 99, vendorRates);
  assert.equal(r.rate_per_kg, 81);
  assert.equal(r.source, 'base');
});

// A board whose grade has no rate on file returns null (never a stale price).
test('resolvePoRate: unrated board → null, source none', () => {
  const paper = { category: 'board', grade: 'Chromo Paper', gsm: 130, sheet_l: 20, sheet_w: 30, last_rate: 50 };
  const r = resolvePoRate(paper, null, baseRates);
  assert.equal(r.rate, null);
  assert.equal(r.source, 'none');
});

// A board with a rate but incomplete spec (no gsm/size) can't derive → null.
test('resolvePoRate: rated board missing spec → null', () => {
  const noSpec = { category: 'board', grade: 'Saffire', gsm: null, sheet_l: null, sheet_w: null, last_rate: 50 };
  const r = resolvePoRate(noSpec, null, baseRates);
  assert.equal(r.rate, null);
  assert.equal(r.source, 'none');
});

// Non-board material keeps its manual std_rate first.
test('resolvePoRate: non-board uses std_rate, source std', () => {
  const ink = { category: 'ink', std_rate: 250, last_rate: 200 };
  const r = resolvePoRate(ink, null, baseRates);
  assert.equal(r.rate, 250);
  assert.equal(r.source, 'std');
});

// Non-board with no std_rate falls back to last_rate.
test('resolvePoRate: non-board with no std_rate falls back to last_rate', () => {
  const ink = { category: 'ink', std_rate: null, last_rate: 200 };
  const r = resolvePoRate(ink, null, baseRates);
  assert.equal(r.rate, 200);
  assert.equal(r.source, 'last');
});

// ── pickPoRate — buyer rate vs resolved master (presence, not truthiness) ──
// Pins the money bug: a deliberate est_rate of 0 (a free line) must survive and
// NOT be replaced by the resolved board rate. Fails against the old `||`.
test('pickPoRate: a deliberate 0 buyer rate is honoured, not overridden', () => {
  const resolved = resolvePoRate(saffire, null, baseRates); // rate ≈ 12.98
  assert.ok(resolved.rate > 0);
  assert.equal(pickPoRate(0, resolved), 0);   // 0 kept, NOT 12.98
  assert.equal(pickPoRate('0', resolved), 0); // string '0' too
});

// A blank/absent buyer rate defers to the resolved master rate.
test('pickPoRate: blank buyer rate defers to resolved master rate', () => {
  const resolved = resolvePoRate(saffire, null, baseRates);
  near(pickPoRate(null, resolved), 0.160257744 * 81);
  near(pickPoRate(undefined, resolved), 0.160257744 * 81);
  near(pickPoRate('', resolved), 0.160257744 * 81);
});

// A present, non-zero buyer rate wins over the master.
test('pickPoRate: a present non-zero buyer rate wins over the master', () => {
  const resolved = resolvePoRate(saffire, null, baseRates);
  assert.equal(pickPoRate(50, resolved), 50);
});

// An unrated board resolves to null → the line falls to 0, never null.
test('pickPoRate: unrated board (resolved null) falls to 0', () => {
  const unrated = { rate: null, source: 'none' };
  assert.equal(pickPoRate(null, unrated), 0);
  assert.equal(pickPoRate(25, unrated), 25);
});
