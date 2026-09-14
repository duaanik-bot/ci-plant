// CI-JC-0335 / CI-MRG-0022 (14 Sep 2026) — CI-JC-0050 again, walking through
// the door that incident's own fix left open.
//
// cutting-parent-fallback.test.js said it in as many words: "orders.js's
// single-line plan-save already refuses this shape with a 409. The gang/run
// path and readiness() never asked, so nothing stopped it." readiness() was
// fixed that day. The gang/run path was named and left alone, and six weeks
// later it locked the same wrong number on FOUR runs in six minutes.
//
// Product SW-097 carried a master parent of 25×36 against its 26.7×28 board —
// a 36" edge no guillotine takes off a 28" sheet. The single-line lock refuses
// exactly that, and did, eleven minutes later: the refusal is what made the
// planner correct the master (audit: "parent_l: 25 → 25.6; parent_w: 36 → 28").
// The gang/merge lock never asked. It measured 14×25.6 children against the
// impossible sheet, got ONE up where the board gives TWO, and wrote
// 1,205 child → 1,205 parent. CI-JC-0335 then went to the floor asking for
// 2,210 parent sheets for a job that needs 1,106, with "2 print sheets /
// parent" printed underneath it — because readiness() recomputes THAT figure
// live, off cuttingParent, and had been right since August.
//
// The rule this file pins: a plan LOCK refuses a parent the board cannot
// yield — both engines, one spelling — and every site that merely re-derives
// or displays a cut measures on cuttingParent, so a stored parent figure can
// never again disagree with the children_per_parent printed beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planLockParent, effectiveParent, cuttingParent, childFit,
  parentSheetsRequired, sheetsRequired,
} from './helpers.js';

// The live rows, exactly as they stood at 10:04:25 on 14 Sep 2026.
const SW097 = { name: 'BISOPROLOL FUMARATE TAB IP2.5MG', code: 'SW-097',
                parent_l: 25, parent_w: 36, child_l: 14, child_w: 25.6, ups: 10 };
const BOARD = { id: 52, name: 'Duplex WB · 340 GSM · 26.7x28', sheet_l: 26.7, sheet_w: 28 };
// The same product after the planner corrected the master at 10:10:36.
const SW097_FIXED = { ...SW097, parent_l: 25.6, parent_w: 28 };

const thrown = fn => { try { fn(); return null; } catch (e) { return e; } };

test('the live shape is refused, with the 409 the single-line lock already speaks', () => {
  const e = thrown(() => planLockParent(SW097, BOARD));
  assert.ok(e, 'the gang/merge lock accepted a 36" parent off a 28" board');
  assert.equal(e.status, 409);
  assert.match(e.message, /25×36/, 'the planner must be told WHICH parent is impossible');
  assert.match(e.message, /26\.7×28/, '…and which board it cannot come off');
  assert.match(e.message, /cut plan or the Product Master/, 'and where to go and fix it');
});

test('a member can be named, so a run of eight says which job to fix', () => {
  const e = thrown(() => planLockParent(SW097, BOARD, 'line 260'));
  assert.match(e.message, /^line 260: /,
    'a run refusal that names no member sends the planner hunting');
  // The reference is a prefix, never a replacement — the figures must survive.
  assert.match(e.message, /25×36/);
});

test('a parent that FITS is returned untouched — the trim, not the board', () => {
  const p = planLockParent(SW097_FIXED, BOARD);
  assert.equal(p.sheet_l, 25.6);
  assert.equal(p.sheet_w, 28, 'the declared trim is still authoritative when it is possible');
  assert.notEqual(p.sheet_w, BOARD.sheet_w === 28 ? null : 28);
});

test('a product with no parent of its own reads the board and never refuses', () => {
  const p = planLockParent({ child_l: 14, child_w: 25.6, ups: 10 }, BOARD);
  assert.equal(p.sheet_l, 26.7);
  assert.equal(p.sheet_w, 28);
});

test('unsized data cannot be judged and must not start refusing boards', () => {
  assert.doesNotThrow(() => planLockParent({ parent_l: 25, parent_w: 36 }, {}));
  assert.doesNotThrow(() => planLockParent({ parent_l: 25, parent_w: 36 }, null));
  assert.doesNotThrow(() => planLockParent({}, BOARD));
});

test('the doubling the refusal prevents, in the numbers that reached the floor', () => {
  // What the merge lock actually measured, and what the board really gives.
  assert.equal(childFit(effectiveParent(SW097, BOARD), SW097).count, 1, 'the wrong one');
  assert.equal(childFit(cuttingParent(SW097, BOARD), SW097).count, 2, 'the true one');

  // CI-MRG-0022's two members, ups 10, wastage 200 on the lead only.
  const lead = sheetsRequired(SW097, 10050, 200);
  const mate = sheetsRequired(SW097, 10050, 0);
  assert.equal(lead, 1205);
  assert.equal(mate, 1005);
  assert.equal(parentSheetsRequired(lead, 1) + parentSheetsRequired(mate, 1), 2210, 'what was frozen');
  assert.equal(parentSheetsRequired(lead, 2) + parentSheetsRequired(mate, 2), 1106, 'what it needed');
});

test('effectiveParent stays raw, so the guard it feeds keeps firing', () => {
  // Folding the fallback into effectiveParent would make planLockParent's own
  // check vacuously true and silently retire every guard built on it.
  const raw = effectiveParent(SW097, BOARD);
  assert.equal(raw.sheet_l, 25);
  assert.equal(raw.sheet_w, 36);
});

// ── one spelling, at every door ────────────────────────────────────────────
const src = f => readFileSync(new URL(`./routes/${f}`, import.meta.url), 'utf8');

test('BOTH plan locks ask the one rule — neither hand-rolls it', () => {
  const orders = src('orders.js');
  const gangs = src('gangs.js');
  assert.match(orders, /planLockParent\(eff, board\)/,
    'the single-line lock must go through the shared rule, not its own copy');
  assert.match(gangs, /planLockParent\(eff, board, /,
    'the gang/merge lock never asked at all — that is the whole bug');
  assert.doesNotMatch(orders, /if \(!parentFitsBoard\(parent, board\)\) throw/,
    'the inline copy is gone; one spelling or they drift again');
  for (const [name, s] of [['orders.js', orders], ['gangs.js', gangs]]) {
    assert.doesNotMatch(s, /const parent = effectiveParent\(eff, board\);/,
      `${name} still measures a lock on the raw declared parent`);
  }
});

test('every re-derive and display site measures on cuttingParent', () => {
  // None of these has a planner in front of it, so none can refuse — but each
  // writes or quotes a cut count, and readiness() computes the figure printed
  // beside it from cuttingParent. Anything else re-opens the same gap.
  assert.match(src('gangs.js'), /const parent = cuttingParent\(eff, board\);/,
    'reDeriveMemberSheets rewrites a locked plan after a qty/ups edit');
  assert.match(src('gangs.js'), /childFit\(cuttingParent\(eff, board\), eff\)/,
    'gangMixContext quotes planned_ups — its own comment demands it agree with the gate');
  assert.match(src('production.js'), /childFit\(cuttingParent\(eff, board\), eff\)/,
    'the job-card amendment re-derives a plan mid-production');
  for (const f of ['gangs.js', 'production.js']) {
    assert.doesNotMatch(src(f), /childFit\(effectiveParent\(eff, board\), eff\)/,
      `${f} still measures a cut on a sheet the board may not yield`);
  }
});
