import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { looseAfter } from './packet-plan.js';

// A RETURNED SHEET IS LOOSE. loose ≡ qty (mod P) is definitional — a pile of N
// sheets holds N mod P loose and the rest in sealed packets — and five return
// paths wrote `UPDATE stock_batches SET qty=...` raw, moving the level and
// leaving the loose count behind. Live damage: batch 167 read 12 loose on a
// 20-sheet pile (12 asserts 8 sheets inside a sealed 144-packet, which cannot
// exist) and batch 127 read 0 loose on 3,050 where 50 must be — and an explicit
// 0 is a COUNT to packet-plan.js, never an absence, so 50 sheets were reported
// unreachable and `suspect` fired on every packet suggestion for that board.
const helpers = readFileSync(new URL('./helpers.js', import.meta.url), 'utf8');
const xs = readFileSync(new URL('./extra-sheet-returns.js', import.meta.url), 'utf8');

test('every return path moves the level through the ONE spelling', () => {
  assert.equal((helpers.match(/moveBatchLevel\(/g) || []).length, 6,
    'the definition plus all five helpers.js sites — sendStageBack x3 (board, '
    + 'variance, unbank) and forceUnwindJobCard x2 (returns, unbank)');
  assert.match(xs, /moveBatchLevel\(row\.batch_id, row\.material_id, back, qc, oc\)/,
    'and the extra-sheet return');
  // A DRAW may still write the level raw — consumeFifo and issueWithWriteOn
  // both call applyLoose on the very next line, with the packetsOpened the
  // storeman actually reported. What must not exist is a RETURN that writes a
  // level and walks away, so the ban is on the returning shape: a batch read
  // FOR UPDATE, a level written, and no loose in sight.
  const returns = [...helpers.matchAll(/const b = await oc\('SELECT qty FROM stock_batches WHERE id=\$1 FOR UPDATE'[\s\S]{0,400}?UPDATE stock_batches SET qty=/g)];
  assert.equal(returns.length, 0,
    'a return path still writes a level raw — that is exactly how loose_sheets '
    + 'was left behind on batches 127 and 167');
  const xsReturns = [...xs.matchAll(/const b = await oc\('SELECT qty FROM stock_batches[\s\S]{0,400}?UPDATE stock_batches SET qty=/g)];
  assert.equal(xsReturns.length, 0);
});

test('moveBatchLevel re-reads loose_sheets — a missing field would re-derive it', () => {
  const fn = helpers.slice(helpers.indexOf('export async function moveBatchLevel'),
                           helpers.indexOf('export async function availableQty'));
  assert.match(fn, /SELECT id, qty, loose_sheets FROM stock_batches/,
    'applyLoose reads a missing loose_sheets as "never counted" and would guess');
  assert.match(fn, /applyLoose\(b, P, -Number\(delta \|\| 0\), null, newQty, qc\)/,
    'a return is a NEGATIVE issue, and packetsOpened derives');
});

// The arithmetic itself, on the two live piles.
test('a return puts its sheets straight back on the loose pile', () => {
  // batch 167: 136 loose, P=144, 5,480 returned → 5,616, and 5,760 mod 144 = 0
  // …but the pile it landed on was 280 → 5,760, so loose 5,616 is right and
  // 5,760 − 5,616 = 144 sits in exactly one sealed packet.
  assert.equal(looseAfter({ looseBefore: 136, packetSize: 144, issued: -5480, packetsOpened: null }), 5616);
  // batch 127: 0 loose on 5,500 after draws, 50 handed back → 50 loose.
  assert.equal(looseAfter({ looseBefore: 0, packetSize: 100, issued: -50, packetsOpened: null }), 50);
  // A return never opens a packet: opened derives to 0 on a negative issue.
  assert.equal(looseAfter({ looseBefore: 12, packetSize: 144, issued: -8, packetsOpened: null }), 20);
});

// An over-receipt is PHYSICS — board that arrived is on the shelf and the GRN
// is never refused for exceeding the order. But it must not land silently:
// nine po_lines are over-received on the live plant, one by 3,600 sheets
// against a 50-sheet line, booked 13 ms after the previous GRN on that line —
// the shape of a double submit nobody was told about.
test('an over-receipt is booked and SAID, never blocked', () => {
  const proc = readFileSync(new URL('./routes/procurement.js', import.meta.url), 'utf8');
  const i = proc.indexOf("r.post('/grns/:id/qc'");
  const block = proc.slice(i, i + 3000);
  assert.match(block, /const over = Math\.max\(0, Number\(g\.qty\) - remaining\)/,
    'the excess is measured against what is still due on the line');
  assert.match(block, /'over_receipt'/, 'and audited against the PO');
  // The receipt itself must still go through untouched.
  assert.match(block, /UPDATE po_lines SET received_qty = received_qty \+ \$1/,
    'stock that arrived is always booked');
  const guard = block.slice(0, block.indexOf('UPDATE po_lines SET received_qty'));
  assert.doesNotMatch(guard, /throw Object\.assign\(new Error\([^)]*over/i,
    'never a refusal — physics hard, paperwork soft');
});
