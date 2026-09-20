// The single planning engine's parent, judged on the board's REAL sheet (Task 7,
// review round 2, 19 Sep 2026). Until then the engine's "board" was LINE_VIEW's
// FOLDED sheet — the saved parent itself — so SW-544 opened with its fossil
// 22×28 measured against 22×28 and never warned, the one-click could write the
// fossil back, every pick "carried" a genuine trim away (SW-258's 22×28 on a
// 26×30 board), and Undo re-derived a parent instead of restoring the one the
// planner had. These are the rules the screen now asks;
// planning-parent-screen.test.js pins Planning.jsx to calling them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveParent, childFit } from './helpers.js';
import { engineParent, engineParentError, boardSheetFill, boardSwitch, boardUndo, parentLosesCuts, clientFit } from '../../client/src/lib/cutFit.js';

const B399 = { l: 23, w: 38 };            // SW-544's board now (#399)
const B53 = { l: 22, w: 28 };             // its old board (#53)
const SW544 = { l: 22, w: 28 };           // the parent it kept on file: #53's sheet
const NONE = { l: null, w: null };        // nothing on file
const typed = (parent_l, parent_w) => ({ parent_l, parent_w });

// ── engineParent: the parent this plan cuts on ──────────────────────────────

test('SW-544 opened: the seeded fields declare the parent on file, and on the real board it costs cuts (1 vs 3)', () => {
  const { declared, parent } = engineParent({ form: typed('22', '28'), saved: SW544, board: B399 });
  assert.deepEqual(declared, { l: 22, w: 28 });
  assert.deepEqual(parent, { l: 22, w: 28 });
  const lossy = parentLosesCuts({ parentL: declared.l, parentW: declared.w, boardL: B399.l, boardW: B399.w, childL: 12.6, childW: 23 });
  assert.equal(lossy.cuts_declared, 1);
  assert.equal(lossy.cuts_board, 3);
});

test('blank fields are "no change" to plan-save: the SAVED parent, never the board', () => {
  assert.deepEqual(engineParent({ form: typed('', ''), saved: SW544, board: B399 }),
    { declared: { l: 22, w: 28 }, parent: { l: 22, w: 28 } });
});

test('half typed with nothing on file is no parent: the plan cuts on the board', () => {
  assert.deepEqual(engineParent({ form: typed('22', ''), saved: NONE, board: B399 }),
    { declared: null, parent: { l: 23, w: 38 } });
});

test('per side, as the server reads it: a typed L beside the saved W', () => {
  assert.deepEqual(engineParent({ form: typed('20', ''), saved: { l: 22, w: 28 }, board: B399 }).declared,
    { l: 20, w: 28 });
});

test('a zero or negative side is still a parent, as plan-save reads it (!= null) — no cut fits it, so it issues 1:1', () => {
  assert.deepEqual(engineParent({ form: typed('0', '28'), saved: SW544, board: B399 }),
    { declared: { l: 0, w: 28 }, parent: { l: 0, w: 28 } });
  assert.deepEqual(engineParent({ form: typed('-5', ''), saved: SW544, board: B399 }).declared, { l: -5, w: 28 });
  assert.deepEqual(engineParent({ form: typed('', ''), saved: { l: 22, w: 0 }, board: B399 }).declared, { l: 22, w: 0 });
  // The lock counts 1 on it (childFit: no size to fit); the screen's unsized
  // path (clientFit null) issues the same 1:1.
  assert.equal(childFit({ sheet_l: 22, sheet_w: 0 }, { child_l: 12.6, child_w: 23 }).count, 1);
  assert.equal(clientFit(22, 0, 12.6, 23), null);
});

// changedSpec (Planning.jsx) → JSON → plan-save's SPEC_FIELDS loop, one side:
// the side the lock will cut on. changedSpec sends a non-blank side only when
// it differs from the one on file compared as +value (so +null is 0, and a
// typed 0 over an empty side is never sent); JSON carries NaN as null; the
// save skips null and otherwise writes the value (as an override or to the
// master — the number is the same either way).
const lockSide = (typedSide, savedSide) => {
  if (typedSide === '' || typedSide == null) return savedSide;
  const cur = +typedSide;
  if (String(cur) === String(+savedSide)) return savedSide;
  const sent = JSON.parse(JSON.stringify({ v: cur })).v;
  return sent == null ? savedSide : sent;
};

test('every parent the engine lets you Save or Lock is the parent plan-save locks on — the rest are said, not saved', () => {
  const board = { sheet_l: 23, sheet_w: 38 };
  // [form, saved, refused at Save/Lock]
  const cases = [
    [typed('22', '28'), SW544, false], [typed('', ''), SW544, false], [typed('20', ''), SW544, false],
    [typed('', '36'), SW544, false], [typed('22', ''), NONE, true], [typed('', ''), NONE, false],
    [typed('20', '38'), NONE, false], [typed('', '28'), { l: 22, w: null }, false],
    [typed('22', ''), { l: 22, w: null }, false],                      // half on file, untouched
    [typed('0', '28'), SW544, true], [typed('-5', '28'), SW544, true], [typed('0', '0'), NONE, true],
    [typed('', ''), { l: 22, w: 0 }, false], [typed('22', '0'), { l: 22, w: 0 }, false],   // zero on file, untouched
    [typed('-5', '28'), { l: -5, w: 28 }, false], [typed('20', '0'), { l: 22, w: 0 }, true],
  ];
  for (const [form, saved, refused] of cases) {
    const label = JSON.stringify({ form, saved });
    assert.equal(!!engineParentError({ form, saved }), refused, label);
    if (refused) continue;
    const server = effectiveParent({ parent_l: lockSide(form.parent_l, saved.l), parent_w: lockSide(form.parent_w, saved.w) }, board);
    assert.deepEqual(engineParent({ form, saved, board: { l: board.sheet_l, w: board.sheet_w } }).parent,
      { l: server.sheet_l, w: server.sheet_w }, label);
  }
});

// ── engineParentError: a TYPED parent no cut can use is said at Save/Lock ────

const HALF = 'Parent size needs both length and width — or leave both blank for the board\'s full sheet';
const ZERO = 'Parent size must be greater than zero';

test('engineParentError: half a parent typed, nothing on file — said, with the Run Sheet\'s words', () => {
  assert.equal(engineParentError({ form: typed('20', ''), saved: NONE }), HALF);
  assert.equal(engineParentError({ form: typed('', '38'), saved: NONE }), HALF);
});

test('engineParentError: a side of zero or less typed — said', () => {
  assert.equal(engineParentError({ form: typed('0', '28'), saved: SW544 }), ZERO);
  assert.equal(engineParentError({ form: typed('-5', '28'), saved: SW544 }), ZERO);
  assert.equal(engineParentError({ form: typed('0', '0'), saved: NONE }), ZERO);
  // touching one side of a parent whose other side on file is zero: the pair
  // it would save is still no sheet
  assert.equal(engineParentError({ form: typed('20', '0'), saved: { l: 22, w: 0 } }), ZERO);
});

test('engineParentError: never blocks an untouched parent on file — half, zero or whole — nor blank fields', () => {
  assert.equal(engineParentError({ form: typed('22', ''), saved: { l: 22, w: null } }), null);
  assert.equal(engineParentError({ form: typed('22', '0'), saved: { l: 22, w: 0 } }), null);
  assert.equal(engineParentError({ form: typed('22.0', '28'), saved: SW544 }), null);
  assert.equal(engineParentError({ form: typed('', ''), saved: SW544 }), null);
  assert.equal(engineParentError({ form: typed('', ''), saved: NONE }), null);
});

test('engineParentError: a whole typed parent, one side typed over a whole parent on file, and every fill pass', () => {
  assert.equal(engineParentError({ form: typed('20', '38'), saved: NONE }), null);
  assert.equal(engineParentError({ form: typed('20', ''), saved: SW544 }), null);   // W stays 28
  assert.equal(engineParentError({ form: boardSheetFill({ saved: SW544, board: B399 }), saved: SW544 }), null);
  assert.equal(engineParentError({ form: boardSheetFill({ saved: NONE, board: B399 }), saved: NONE }), null);
});

// ── boardSheetFill: what "the board's full sheet" puts in the fields ─────────

test('boardSheetFill: over a parent on file, the board\'s dims — a blank cannot clear a saved parent', () => {
  assert.deepEqual(boardSheetFill({ saved: SW544, board: B399 }), { parent_l: '23', parent_w: '38' });
});

test('boardSheetFill: nothing (or only half a parent) on file — blanks, which IS the board\'s sheet', () => {
  assert.deepEqual(boardSheetFill({ saved: NONE, board: B399 }), { parent_l: '', parent_w: '' });
  assert.deepEqual(boardSheetFill({ saved: { l: 22, w: null }, board: B399 }), { parent_l: '', parent_w: '' });
});

// ── boardSwitch: a board change carries a parent that cannot stay ────────────

test('SW-258: a genuine trim on a same-size board stays exactly as it is', () => {
  const r = boardSwitch({ form: typed('22', '28'), saved: { l: 22, w: 28 }, from: { l: 26, w: 30 }, to: { l: 26, w: 30 } });
  assert.deepEqual(r.declared, { l: 22, w: 28 });
  assert.equal(r.carried, null);
  assert.equal(r.fill, null);
});

test('a copy of the old board\'s sheet ON FILE follows the board: the new board\'s dims, for the master question', () => {
  const r = boardSwitch({ form: typed('22', '28'), saved: SW544, from: B53, to: B399 });
  assert.deepEqual(r.declared, { l: 22, w: 28 });
  assert.deepEqual(r.carried, { l: 23, w: 38 });
  assert.deepEqual(r.fill, { parent_l: '23', parent_w: '38' });
});

test('…the same copy only TYPED, nothing on file: blanks — no edit, no question, nothing left to fossilise', () => {
  const r = boardSwitch({ form: typed('22', '28'), saved: NONE, from: B53, to: B399 });
  assert.deepEqual(r.carried, { l: 23, w: 38 });
  assert.deepEqual(r.fill, { parent_l: '', parent_w: '' });
});

test('blank fields over a saved copy of the old board still carry it (blank means the saved parent)', () => {
  const r = boardSwitch({ form: typed('', ''), saved: SW544, from: B53, to: B399 });
  assert.deepEqual(r.fill, { parent_l: '23', parent_w: '38' });
});

test('a parent on file the new board cannot yield takes the new board\'s dims', () => {
  const r = boardSwitch({ form: typed('25.6', '28'), saved: { l: 25.6, w: 28 }, from: { l: 26.7, w: 28 }, to: B399 });
  assert.deepEqual(r.carried, { l: 23, w: 38 });
  assert.deepEqual(r.fill, { parent_l: '23', parent_w: '38' });
});

test('from an UNSIZED board, a genuine 20×38 trim picking the 23×38 board does not carry', () => {
  // "Unspecified board" (#278) has no sheet; 613 products sat on it in August.
  const r = boardSwitch({ form: typed('20', '38'), saved: { l: 20, w: 38 }, from: { l: null, w: null }, to: B399 });
  assert.equal(r.carried, null);
  assert.equal(r.fill, null);
  // …whereas the folded parent standing in for that board (round 2's `??`
  // seed) made the trim a "copy of the old board" and carried it away.
  assert.deepEqual(boardSwitch({ form: typed('20', '38'), saved: { l: 20, w: 38 }, from: { l: 20, w: 38 }, to: B399 }).fill,
    { parent_l: '23', parent_w: '38' });
});

test('no parent at all never carries', () => {
  assert.deepEqual(boardSwitch({ form: typed('', ''), saved: NONE, from: B53, to: B399 }),
    { declared: null, carried: null, fill: null });
});

// ── boardUndo: Undo restores what the switch changed, never re-derives ───────

const entryOf = (board, parentBefore, sw) => ({ board, parentBefore, fill: sw.fill });

test('Undo after a carry, the fields untouched: the parent as it was before the switch', () => {
  const sw = boardSwitch({ form: typed('22', '28'), saved: SW544, from: B53, to: B399 });
  assert.deepEqual(boardUndo({ form: typed('23', '38'), entry: entryOf({ id: 53 }, typed('22', '28'), sw) }),
    typed('22', '28'));
});

test('Undo after a carry and then an edit: the edit is the planner\'s, and stands', () => {
  const sw = boardSwitch({ form: typed('22', '28'), saved: SW544, from: B53, to: B399 });
  assert.equal(boardUndo({ form: typed('20', '38'), entry: entryOf({ id: 53 }, typed('22', '28'), sw) }), null);
});

test('Undo after a switch that did not carry: the fields are left alone', () => {
  const sw = boardSwitch({ form: typed('22', '28'), saved: { l: 22, w: 28 }, from: { l: 26, w: 30 }, to: { l: 26, w: 30 } });
  assert.equal(boardUndo({ form: typed('22', '28'), entry: entryOf({ id: 500 }, typed('22', '28'), sw) }), null);
});

// The review's I1: Undo re-derived the parent — a carry run backwards — instead
// of putting back what the planner had. Each sequence is switch, then Undo.
const pickThenUndo = ({ form, saved, from, to }) => {
  const sw = boardSwitch({ form, saved, from, to });
  const after = sw.fill ? { ...form, ...sw.fill } : form;
  const back = boardUndo({ form: after, entry: { board: from, parentBefore: form, fill: sw.fill } });
  return { sw, after, undone: back ?? after };
};

test('I1: typed 22×36 on the 23×38 board, pick 26×30 — it carries; Undo gives 22×36 back', () => {
  const r = pickThenUndo({ form: typed('22', '36'), saved: NONE, from: B399, to: { l: 26, w: 30 } });
  assert.deepEqual(r.sw.carried, { l: 26, w: 30 });
  assert.deepEqual(r.after, typed('', ''));
  assert.deepEqual(r.undone, typed('22', '36'));
});

test('I1: typed 22×28 on the 23×38 board, pick the 22×28 board — no carry; Undo leaves 22×28', () => {
  const r = pickThenUndo({ form: typed('22', '28'), saved: NONE, from: B399, to: B53 });
  assert.equal(r.sw.fill, null);
  assert.deepEqual(r.undone, typed('22', '28'));
});

test('SW-544 before the incident: pick 23×38 carries the fossil to the new board; Undo puts it back', () => {
  const r = pickThenUndo({ form: typed('22', '28'), saved: SW544, from: B53, to: B399 });
  assert.deepEqual(r.after, typed('23', '38'));
  assert.deepEqual(r.undone, typed('22', '28'));
});

// ── null safety: a render-time throw would blank the Planning page ───────────

test('null arguments never throw', () => {
  assert.doesNotThrow(() => engineParent(null));
  assert.equal(engineParent(null).declared, null);
  assert.equal(engineParent({ form: null, saved: null, board: null }).declared, null);
  assert.deepEqual(boardSheetFill(null), { parent_l: '', parent_w: '' });
  assert.deepEqual(boardSwitch(null), { declared: null, carried: null, fill: null });
  assert.equal(boardUndo(null), null);
  assert.equal(boardUndo({ form: null, entry: { board: null, parentBefore: null, fill: { parent_l: '23', parent_w: '38' } } }), null);
  assert.equal(engineParentError(null), null);
  assert.equal(engineParentError({ form: null, saved: null }), null);
});
