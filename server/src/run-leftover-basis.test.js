import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runBanksLeftover, runLeftoverBasis } from './routes/gangs.js';
import { leftoverStrips, childFit } from './helpers.js';
import * as client from '../../client/src/lib/cutFit.js';

// Which runs bank an offcut, and what sheet the offcut is measured on.
//
// Before this, a run could bank only as a side effect of opening a board mix,
// and only if it was a combined run: the ordinary case — one run, one board,
// no substitute — had no control at all, and a gang had none ever.

// ── The predicate ───────────────────────────────────────────────────────────

test('a combined run banks', () => {
  assert.equal(runBanksLeftover({ kind: 'merge', layout_mode: 'separate' }), true);
});

test('a CO-PRINTED gang banks — one child, one fit, one strip', () => {
  assert.equal(runBanksLeftover({ kind: 'gang', layout_mode: 'shared' }), true);
});

test('a SEPARATE-layout gang does not — N members, N impositions', () => {
  assert.equal(runBanksLeftover({ kind: 'gang', layout_mode: 'separate' }), false);
});

// The plan route's own warning: convert-to-merge only began stamping
// layout_mode='separate' later, so a merge converted before that still carries
// a stale 'shared'. The kind is the truth. Reading layout first would answer
// the same for this row and the wrong thing for a merge stamped 'separate'.
test('kind wins over a stale layout_mode on a converted merge', () => {
  assert.equal(runBanksLeftover({ kind: 'merge', layout_mode: 'shared' }), true);
  assert.equal(runBanksLeftover({ kind: 'merge', layout_mode: null }), true);
});

test('nothing at all is not a run that banks', () => {
  assert.equal(runBanksLeftover(null), false);
  assert.equal(runBanksLeftover(undefined), false);
  assert.equal(runBanksLeftover({}), false);
});

// ── The basis ───────────────────────────────────────────────────────────────

const board = { id: 7, name: 'Saffire · 300 GSM · 25 x 36', sheet_l: 25, sheet_w: 36 };

test('a co-printed gang measures on the BOARD, never the lead member’s trim', () => {
  // CI-GANG-0010's shape: the lead carries a 23×36 solo parent trim left over
  // from planning alone, while the run cuts the 25×36 sheet it actually buys.
  const lead = { parent_l: 23, parent_w: 36, child_l: 18, child_w: 25 };
  const basis = runLeftoverBasis({ kind: 'gang', layout_mode: 'shared' }, board,
    { sharedChild: { l: 18, w: 25 } });
  assert.deepEqual(basis.parent, { sheet_l: 25, sheet_w: 36 });
  assert.deepEqual(basis.child, { child_l: 18, child_w: 25 });
  // And the trim is genuinely a different cut — otherwise this proves nothing.
  assert.notEqual(
    childFit({ sheet_l: 23, sheet_w: 36 }, lead).count,
    childFit(basis.parent, basis.child).count);
});

test('a combined run measures on the lead member’s effectiveParent', () => {
  const lead = { parent_l: 20, parent_w: 26, child_l: 20, child_w: 12 };
  const basis = runLeftoverBasis({ kind: 'merge' }, board, { mergeChild: lead });
  assert.equal(basis.parent.sheet_l, 20);
  assert.equal(basis.parent.sheet_w, 26);
  assert.deepEqual(basis.child, { child_l: 20, child_w: 12 });
});

test('a combined run with no trim on file falls back to the board’s sheet', () => {
  const lead = { child_l: 20, child_w: 12 };
  const basis = runLeftoverBasis({ kind: 'merge' }, board, { mergeChild: lead });
  assert.equal(basis.parent.sheet_l, 25);
  assert.equal(basis.parent.sheet_w, 36);
});

test('a separate-layout gang has no basis at all', () => {
  assert.equal(
    runLeftoverBasis({ kind: 'gang', layout_mode: 'separate' }, board,
      { sharedChild: { l: 18, w: 25 } }),
    null);
});

test('an unmeasurable run has no basis — no board, no child, no sizes', () => {
  const gang = { kind: 'gang', layout_mode: 'shared' };
  assert.equal(runLeftoverBasis(gang, null, { sharedChild: { l: 18, w: 25 } }), null);
  assert.equal(runLeftoverBasis(gang, board, { sharedChild: null }), null);
  assert.equal(runLeftoverBasis(gang, board, { sharedChild: { l: 0, w: 25 } }), null);
  assert.equal(runLeftoverBasis({ kind: 'merge' }, board, { mergeChild: null }), null);
  assert.equal(runLeftoverBasis({ kind: 'merge' }, board,
    { mergeChild: { child_l: 0, child_w: 12 } }), null);
  assert.equal(runLeftoverBasis(gang, { sheet_l: 0, sheet_w: 0 },
    { sharedChild: { l: 18, w: 25 } }), null);
});

test('string dimensions off the DB are coerced, not concatenated', () => {
  const basis = runLeftoverBasis({ kind: 'gang', layout_mode: 'shared' },
    { sheet_l: '25', sheet_w: '36' }, { sharedChild: { l: '18', w: '25' } });
  assert.deepEqual(basis.parent, { sheet_l: 25, sheet_w: 36 });
  assert.deepEqual(basis.child, { child_l: 18, child_w: 25 });
});

// ── The card and the lock measure the same thing ────────────────────────────
//
// The failure this guards is the one the leftover-strip-parent wave paid for on
// single lines: a card drawn from different geometry than the save offers a
// strip the lock then 409s, and the planner cannot see why. The run's card runs
// clientStrips over exactly the basis the server hands it, so the two agree by
// construction — asserted here over the run's own shapes.
test('clientStrips over the basis == leftoverStrips over the basis', () => {
  const cases = [
    [{ kind: 'gang', layout_mode: 'shared' }, board, { sharedChild: { l: 18, w: 25 } }],
    [{ kind: 'gang', layout_mode: 'shared' }, board, { sharedChild: { l: 12.66, w: 23 } }],
    [{ kind: 'merge' }, board, { mergeChild: { child_l: 20, child_w: 12 } }],
    [{ kind: 'merge' }, board, { mergeChild: { parent_l: 20, parent_w: 26, child_l: 20, child_w: 12 } }],
  ];
  for (const [gang, b, opts] of cases) {
    const basis = runLeftoverBasis(gang, b, opts);
    assert.ok(basis, 'basis expected for this case');
    assert.deepEqual(
      client.clientStrips(basis.parent.sheet_l, basis.parent.sheet_w,
        basis.child.child_l, basis.child.child_w),
      leftoverStrips(basis.parent, basis.child));
  }
});

// ── ONE spelling ────────────────────────────────────────────────────────────
//
// The rule lives in runBanksLeftover and is read from there by the plan route's
// two bank arms, gangDetail's toggle seed, reDeriveMemberSheets' unbank and
// production.js's cutting confirm. A hand-written sixth copy is how the gang
// anchor drifted into five spellings and stayed broken in one of them; the same
// mistake here would let the lock bank a strip the cutting confirm never books,
// leaving planned stock on the rack forever.
const HERE = new URL('./', import.meta.url);
function sourceFiles(dir = HERE, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) sourceFiles(u, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(u);
  }
  return out;
}

test('no file re-derives "which runs bank" by hand', () => {
  // A kind test written next to a leftover/bank/unbank word within the same
  // line — the shape every one of the converted call sites used to have.
  const inline = /kind\s*[=!]==?\s*'merge'/;
  const offenders = [];
  for (const f of sourceFiles()) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!inline.test(line)) return;
      if (!/leftover|bank|Bank/i.test(line)) return;
      offenders.push(`${f.pathname.split('/').pop()}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'use runBanksLeftover(gang) instead of an inline kind test:\n' + offenders.join('\n'));
});
