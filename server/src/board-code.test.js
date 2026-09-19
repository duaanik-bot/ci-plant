import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRADE_CODES, gradeCode, boardName, boardCode, parseBoardName, takenCodesFor, identityOnSave } from './board-code.js';

// ── boardName ─────────────────────────────────────────────────────────
test('boardName: matches the stored plant convention exactly', () => {
  assert.equal(boardName({ grade: 'Duplex GB', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 }),
    'Duplex GB · 330 GSM · 24.6x31.2');
  assert.equal(boardName({ grade: 'FBB', gsm: 290, sheet_l: 20, sheet_w: 38 }),
    'FBB · 290 GSM · 20x38');
});
test('boardName: trailing zeros are trimmed, so 20.0 renders as 20', () => {
  assert.equal(boardName({ grade: 'FBB', gsm: 290, sheet_l: 20.0, sheet_w: 38.00 }),
    'FBB · 290 GSM · 20x38');
});
test('boardName: incomplete input returns null rather than a half-built name', () => {
  assert.equal(boardName({ grade: 'FBB', gsm: null, sheet_l: 20, sheet_w: 38 }), null);
  assert.equal(boardName({ grade: '', gsm: 290, sheet_l: 20, sheet_w: 38 }), null);
});
test('boardName: a known grade is canonicalized, so name and code cannot disagree', () => {
  // 'saffire' must not yield 'saffire · …' next to code '2336300SAFF'. The grade
  // source is not guaranteed clean — products.board_grade carries coarse values.
  assert.equal(boardName({ grade: 'saffire', gsm: 300, sheet_l: 23, sheet_w: 36 }),
    'Saffire · 300 GSM · 23x36');
  assert.equal(boardName({ grade: 'DUPLEX gb', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 }),
    'Duplex GB · 330 GSM · 24.6x31.2');
});
test('boardName: an unknown grade is kept as typed, merely trimmed', () => {
  assert.equal(boardName({ grade: '  Kraft Liner ', gsm: 300, sheet_l: 23, sheet_w: 36 }),
    'Kraft Liner · 300 GSM · 23x36');
});
test('boardName: the L x W pair is closed up, never spaced', () => {
  // The floor reads and types the size as one token. Stored names were migrated
  // to match; this asserts the composer cannot drift back to the spaced form.
  for (const b of [
    { grade: 'FBB', gsm: 290, sheet_l: 20, sheet_w: 38 },
    { grade: 'Saffire', gsm: 300, sheet_l: 31.5, sheet_w: 41.5 },
  ]) {
    const name = boardName(b);
    assert.ok(!/\d\s+x\s+\d|\d\s+x|x\s+\d/.test(name), `"${name}" still spaces the separator`);
    assert.match(name, /\d+(\.\d+)?x\d+(\.\d+)?$/);
  }
});
test('parseBoardName: reads the spaced legacy form as well as the closed-up one', () => {
  // Names arrive from products.board_name and PO imports, which may still hold a
  // pre-migration string. Both must resolve to the same board.
  assert.deepEqual(parseBoardName('FBB · 290 GSM · 20 x 38'),
    parseBoardName('FBB · 290 GSM · 20x38'));
});

// ── parseBoardName (round-trip) ───────────────────────────────────────
test('parseBoardName: round-trips a composed name', () => {
  assert.deepEqual(parseBoardName('Duplex GB · 330 GSM · 24.6x31.2'),
    { grade: 'Duplex GB', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 });
});
test('parseBoardName: accepts the × separator as well as x', () => {
  assert.deepEqual(parseBoardName('Saffire · 300 GSM · 23 × 36'),
    { grade: 'Saffire', gsm: 300, sheet_l: 23, sheet_w: 36 });
});
test('parseBoardName: sheet sizes round-trip at 2dp — a deliberate truncation', () => {
  // dim() fixes dimensions to 2 decimal places, so 22.567 is stored as 22.57.
  // Board sizes are inches to 2dp in practice; documenting it as a decision.
  assert.deepEqual(parseBoardName(boardName({ grade: 'FBB', gsm: 290, sheet_l: 22.567, sheet_w: 28 })),
    { grade: 'FBB', gsm: 290, sheet_l: 22.57, sheet_w: 28 });
});
test('parseBoardName: unparseable names return null', () => {
  assert.equal(parseBoardName('Unspecified board'), null);
  assert.equal(parseBoardName(''), null);
  assert.equal(parseBoardName(null), null);
});

// ── gradeCode ─────────────────────────────────────────────────────────
test('gradeCode: known grades map to their stored 3-4 letter codes', () => {
  assert.equal(gradeCode('Duplex GB'), 'GB');
  assert.equal(gradeCode('Duplex WB'), 'WB');
  assert.equal(gradeCode('Saffire'), 'SAFF');
  assert.equal(gradeCode('FBB'), 'FBB');
  assert.equal(gradeCode('Paper'), 'PAPR');
  assert.equal(gradeCode('Chromo Paper'), 'CHRM');
});
test('gradeCode: an unknown grade degrades to its first 4 alnum chars, uppercased', () => {
  assert.equal(gradeCode('Kraft Liner'), 'KRAF');
  assert.equal(gradeCode('sbs'), 'SBS');
});
test('gradeCode: an absent grade returns null rather than an empty code', () => {
  assert.equal(gradeCode(''), null);
  assert.equal(gradeCode('   '), null);
  assert.equal(gradeCode(null), null);
  assert.equal(gradeCode(undefined), null);
});

// ── GRADE_CODES ───────────────────────────────────────────────────────
test('GRADE_CODES: the six plant grades map to their stored codes', () => {
  assert.deepEqual(GRADE_CODES, {
    'Duplex GB': 'GB',
    'Duplex WB': 'WB',
    'Saffire': 'SAFF',
    'FBB': 'FBB',
    'Paper': 'PAPR',
    'Chromo Paper': 'CHRM',
  });
});

// ── boardCode ─────────────────────────────────────────────────────────
test('boardCode: reproduces stored codes — round(L)+round(W)+GRADE+GSM', () => {
  assert.equal(boardCode({ grade: 'Duplex GB', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 }), '2531330GB');
  assert.equal(boardCode({ grade: 'FBB', gsm: 290, sheet_l: 20, sheet_w: 38 }), '2038290FBB');
  assert.equal(boardCode({ grade: 'Saffire', gsm: 300, sheet_l: 23, sheet_w: 36 }), '2336300SAFF');
  assert.equal(boardCode({ grade: 'Saffire', gsm: 280, sheet_l: 22, sheet_w: 28 }), '2228280SAFF');
});
test('boardCode: collisions take a -N suffix, matching the existing data', () => {
  const taken = new Set(['2228280SAFF']);
  assert.equal(boardCode({ grade: 'Saffire', gsm: 280, sheet_l: 22.4, sheet_w: 28.1 }, taken), '2228280SAFF-1');
  taken.add('2228280SAFF-1');
  assert.equal(boardCode({ grade: 'Saffire', gsm: 280, sheet_l: 22.3, sheet_w: 27.6 }, taken), '2228280SAFF-2');
});
test('boardCode: incomplete input returns null', () => {
  assert.equal(boardCode({ grade: 'FBB', gsm: null, sheet_l: 20, sheet_w: 38 }), null);
});
test('boardCode: layout is size then GSM then grade — digits unbroken by letters', () => {
  // The plant reads '20x38, 340gsm, Duplex GB' left to right, so the code is
  // 2038340GB. Asserted structurally, not just by example, so a reordering back
  // to the old size+grade+gsm form fails here rather than in production data.
  const code = boardCode({ grade: 'Duplex GB', gsm: 340, sheet_l: 20, sheet_w: 38 });
  assert.equal(code, '2038340GB');
  assert.match(code, /^\d+[A-Z]+$/, 'all digits must precede all letters');
  assert.equal(boardCode({ grade: 'Duplex WB', gsm: 350, sheet_l: 20, sheet_w: 38 }), '2038350WB');
});
test('boardCode: Duplex carries the bare GB/WB, with no DP prefix', () => {
  for (const g of ['Duplex GB', 'Duplex WB']) {
    assert.ok(!boardCode({ grade: g, gsm: 300, sheet_l: 20, sheet_w: 38 }).includes('DP'),
      `${g} must not reintroduce the DP prefix`);
  }
});
test('boardCode: every plant grade yields a distinct code for one size+GSM', () => {
  // The grade suffix is the only thing separating these, so a duplicate mapping
  // in GRADE_CODES would silently merge two grades into one code.
  const codes = Object.keys(GRADE_CODES)
    .map(g => boardCode({ grade: g, gsm: 300, sheet_l: 20, sheet_w: 38 }));
  assert.equal(new Set(codes).size, codes.length, `codes collide: ${codes}`);
});

// ── takenCodesFor + edit idempotence ──────────────────────────────────
// The Boards form regenerates a board's code from its own grade/gsm/size on
// save. If the `taken` set it feeds boardCode still contains the board's OWN
// code, the collision engine appends -1 and silently rewrites a live identifier
// on an ordinary edit. This is the exact bug that lived in Masters.jsx: the
// taken-set must exclude the row being edited AND every leftover offcut (which
// inherits the parent's spec). Proven here where it can be unit-tested.
//
// Fixture mirrors the real master's shape: rated parents with stored specs,
// including a genuine -1 collision pair, plus a leftover carrying its parent's
// exact spec (helpers.js createLeftover copies sourceBoard.spec verbatim).
const MASTER = [
  { id: 1, category: 'board', grade: 'Duplex GB', gsm: 285, sheet_l: 22, sheet_w: 28, spec: '2228285GB' },
  { id: 2, category: 'board', grade: 'Saffire', gsm: 280, sheet_l: 22, sheet_w: 28, spec: '2228280SAFF' },
  { id: 3, category: 'board', grade: 'Saffire', gsm: 280, sheet_l: 22.4, sheet_w: 28.1, spec: '2228280SAFF-1' }, // collision twin
  { id: 4, category: 'board', grade: 'FBB', gsm: 290, sheet_l: 20, sheet_w: 38, spec: '2038290FBB' },
  { id: 5, category: 'board', grade: 'Saffire', gsm: 300, sheet_l: 23, sheet_w: 36, spec: '2336300SAFF' },
  // Leftover offcut of board 5 — same spec, category 'board', leftover flag set.
  { id: 99, category: 'board', grade: 'Saffire', gsm: 300, sheet_l: 11, sheet_w: 18, spec: '2336300SAFF', leftover: 1 },
];

test('takenCodesFor: excludes the edited row and all leftovers', () => {
  const taken = takenCodesFor(MASTER, 5);
  assert.ok(!taken.has('2336300SAFF'), 'edited board 5 (and its leftover twin) must not be in taken');
  assert.ok(taken.has('2228280SAFF') && taken.has('2228280SAFF-1'), 'other boards stay in taken');
});

test('edit idempotence: recomputing an existing board reproduces its stored code (no silent -1)', () => {
  for (const b of MASTER.filter(r => !r.leftover)) {
    const taken = takenCodesFor(MASTER, b.id);
    assert.equal(boardCode(b, taken), b.spec,
      `editing ${b.spec} must reproduce it, not a suffixed variant`);
  }
});

test('edit idempotence: the leftover-inherited spec is the exact regression — parent code survives edit', () => {
  // Board 5 has a leftover (id 99) carrying spec '2336300SAFF'. Without leftover
  // exclusion, taken would contain the parent's own code via the child and the
  // recompute would yield '2336300SAFF-1'. With the fix it stays '2336300SAFF'.
  const parent = MASTER.find(r => r.id === 5);
  assert.equal(boardCode(parent, takenCodesFor(MASTER, 5)), '2336300SAFF');
  // And prove the naive taken set (id-only exclusion, leftovers kept) WOULD break —
  // documents why leftover exclusion is load-bearing, not incidental.
  const naive = new Set(MASTER.filter(r => r.id !== 5).map(r => r.spec));
  assert.equal(boardCode(parent, naive), '2336300SAFF-1');
});

test('takenCodesFor: a brand-new board (null editingId) still excludes leftovers', () => {
  const taken = takenCodesFor(MASTER, null);
  assert.ok(taken.has('2336300SAFF'), 'parent code present for a new board');
  // Only one copy — the leftover duplicate does not add a second entry (it is a Set anyway),
  // and crucially leftovers never contribute a code the new board would need to dodge falsely.
  assert.equal([...taken].filter(c => c === '2336300SAFF').length, 1);
});

// ── identityOnSave ────────────────────────────────────────────────────
// materials 386, live 2026-09-10: created 'FBB · 300 GSM · 20.5x31.5' /
// 2132300FBB, then its grade edited FBB → CFBB and its GSM 300 → 280 in the
// Boards master. The form PREVIEWED 'CFBB · 280 GSM · 20.5x31.5' but SAVED the
// stored name and code, because an existing row's derived fields were kept
// verbatim. Three more presses of Save changed nothing. The row then read
// CFBB/280 in its fields and FBB/300 in its name and code — and Planning copied
// the stale name (and the grade parsed from it) onto the next product it was
// planned for.
test('identityOnSave: the 386 regression — grade and GSM edited, name AND code follow', () => {
  assert.deepEqual(
    identityOnSave({ name: 'FBB · 300 GSM · 20.5x31.5', spec: '2132300FBB' },
      { grade: 'CFBB', gsm: 280, sheet_l: 20.5, sheet_w: 31.5 }, new Set()),
    { name: 'CFBB · 280 GSM · 20.5x31.5', spec: '2132280CFBB' });
});

test('identityOnSave: a GSM-only edit moves the name and the code', () => {
  assert.deepEqual(
    identityOnSave({ name: 'Met Saffire · 350 GSM · 20x38', spec: '2038350METS' },
      { grade: 'Met Saffire', gsm: 340, sheet_l: 20, sheet_w: 38 }, new Set()),
    { name: 'Met Saffire · 340 GSM · 20x38', spec: '2038340METS' });
});

test('identityOnSave: a size-only edit moves the name and the code', () => {
  assert.deepEqual(
    identityOnSave({ name: 'FBB · 290 GSM · 20x38', spec: '2038290FBB' },
      { grade: 'FBB', gsm: 290, sheet_l: 23, sheet_w: 36 }, new Set()),
    { name: 'FBB · 290 GSM · 23x36', spec: '2336290FBB' });
});

test('identityOnSave: an ordinary edit keeps every stored name and code byte-for-byte', () => {
  // Reorder level, GST, packet size — the identity is untouched, so nothing may
  // move, and in particular the -1 collision twin must NOT lose or gain a suffix.
  for (const b of MASTER.filter(r => !r.leftover)) {
    const stored = { name: boardName(b), spec: b.spec };
    assert.deepEqual(identityOnSave(stored, b, takenCodesFor(MASTER, b.id)), stored,
      `board ${b.id} (${b.spec}) must survive an ordinary save untouched`);
  }
});

test('identityOnSave: an agreeing name in another spelling is kept, never reformatted', () => {
  const row = { grade: 'Saffire', gsm: 300, sheet_l: 23, sheet_w: 36 };
  for (const name of ['Saffire · 300 GSM · 23 × 36', 'saffire · 300 GSM · 23x36', 'Saffire · 300 GSM · 23.00x36']) {
    assert.equal(identityOnSave({ name, spec: '2336300SAFF' }, row, new Set()).name, name);
  }
});

test('identityOnSave: a moved code dodges one already taken, the same -N scheme as a create', () => {
  const taken = new Set(['2336290FBB']);
  assert.equal(identityOnSave({ name: 'FBB · 290 GSM · 20x38', spec: '2038290FBB' },
    { grade: 'FBB', gsm: 290, sheet_l: 23, sheet_w: 36 }, taken).spec, '2336290FBB-1');
});

test('identityOnSave: a code that contradicts its row is rebuilt even when the name already agrees', () => {
  // Half-repaired: the name was corrected by hand, the code was not.
  assert.deepEqual(
    identityOnSave({ name: 'CFBB · 280 GSM · 20.5x31.5', spec: '2132300FBB' },
      { grade: 'CFBB', gsm: 280, sheet_l: 20.5, sheet_w: 31.5 }, new Set()),
    { name: 'CFBB · 280 GSM · 20.5x31.5', spec: '2132280CFBB' });
});

test('identityOnSave: a name that cannot be read against its row is rebuilt from the row', () => {
  // The Boards master composes names, it never takes them typed — a stored name
  // that does not even parse cannot be shown to describe the row it sits on.
  assert.equal(identityOnSave({ name: 'FBB 300 GSM 20.5x31.5', spec: '2132300FBB' },
    { grade: 'FBB', gsm: 300, sheet_l: 20.5, sheet_w: 31.5 }, new Set()).name,
  'FBB · 300 GSM · 20.5x31.5');
});

test('identityOnSave: incomplete fields never blank out or half-build what is stored', () => {
  const stored = { name: 'Unspecified board', spec: null };
  assert.deepEqual(identityOnSave(stored, { grade: null, gsm: null, sheet_l: null, sheet_w: null }, new Set()), stored);
  const kept = { name: 'FBB · 290 GSM · 20x38', spec: '2038290FBB' };
  assert.deepEqual(identityOnSave(kept, { grade: 'FBB', gsm: '', sheet_l: 20, sheet_w: 38 }, new Set()), kept);
});

test('identityOnSave: a blank stored name or code composes — the create and backfill case', () => {
  const row = { grade: 'FBB', gsm: 290, sheet_l: 20, sheet_w: 38 };
  for (const blank of [{}, { name: '', spec: '' }, { name: null, spec: null }, undefined]) {
    assert.deepEqual(identityOnSave(blank, row, new Set()), { name: 'FBB · 290 GSM · 20x38', spec: '2038290FBB' });
  }
});

test('identityOnSave: form values arrive as strings and still agree with the stored row', () => {
  const stored = { name: 'CFBB · 280 GSM · 20.5x31.5', spec: '2132280CFBB' };
  assert.deepEqual(identityOnSave(stored, { grade: 'CFBB', gsm: '280', sheet_l: '20.50', sheet_w: '31.5' }, new Set()), stored);
});

test('identityOnSave: idempotent — a second save of the repaired row changes nothing', () => {
  const row = { grade: 'CFBB', gsm: 280, sheet_l: 20.5, sheet_w: 31.5 };
  const once = identityOnSave({ name: 'FBB · 300 GSM · 20.5x31.5', spec: '2132300FBB' }, row, new Set());
  assert.deepEqual(identityOnSave(once, row, new Set()), once);
});

// ── client twin parity ────────────────────────────────────────────────
// The Boards master form composes the name and code in the browser as the user
// types, then saves exactly what it showed. A drift between the twins would let
// the form promise one code and the server store another. Same precedent as the
// boardMath twin parity block in board-math.test.js.
import * as client from '../../client/src/lib/boardCode.js';
import * as server from './board-code.js';

test('client twin: identical identityOnSave across edits, repairs and ordinary saves', () => {
  const cases = [
    [{ name: 'FBB · 300 GSM · 20.5x31.5', spec: '2132300FBB' }, { grade: 'CFBB', gsm: 280, sheet_l: 20.5, sheet_w: 31.5 }, []],
    [{ name: 'Saffire · 300 GSM · 23 × 36', spec: '2336300SAFF' }, { grade: 'saffire', gsm: '300', sheet_l: 23, sheet_w: 36 }, []],
    [{ name: 'FBB · 290 GSM · 20x38', spec: '2038290FBB' }, { grade: 'FBB', gsm: 290, sheet_l: 23, sheet_w: 36 }, ['2336290FBB']],
    [{ name: 'Unspecified board', spec: null }, {}, []],
    [undefined, { grade: 'Duplex GB', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 }, []],
  ];
  for (const [stored, row, taken] of cases) {
    assert.deepEqual(client.identityOnSave(stored, row, new Set(taken)),
      server.identityOnSave(stored, row, new Set(taken)));
  }
});

test('client twin: exported surface matches the server module', () => {
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
});

test('client twin: GRADE_CODES tables are identical', () => {
  assert.deepEqual(client.GRADE_CODES, server.GRADE_CODES);
});

test('client twin: identical name / code / parse across a spread of real boards', () => {
  const boards = [
    { grade: 'Duplex GB', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 },
    { grade: 'Duplex WB', gsm: 300, sheet_l: 23, sheet_w: 36 },
    { grade: 'FBB', gsm: 290, sheet_l: 20, sheet_w: 38 },
    { grade: 'Saffire', gsm: 300, sheet_l: 23, sheet_w: 36 },
    { grade: 'saffire', gsm: 280, sheet_l: 22, sheet_w: 28 },   // canonicalization
    { grade: '  Kraft Liner ', gsm: 300, sheet_l: 23, sheet_w: 36 }, // unknown grade
    { grade: 'Chromo Paper', gsm: 205, sheet_l: 22.567, sheet_w: 28 },
    { grade: 'FBB', gsm: null, sheet_l: 20, sheet_w: 38 },      // incomplete master
    { grade: '', gsm: 290, sheet_l: 20, sheet_w: 38 },
    {},
  ];
  for (const b of boards) {
    assert.equal(client.gradeCode(b.grade), server.gradeCode(b.grade));
    assert.equal(client.boardName(b), server.boardName(b));
    assert.equal(client.boardCode(b), server.boardCode(b));
    assert.deepEqual(client.parseBoardName(client.boardName(b)), server.parseBoardName(server.boardName(b)));
  }
  assert.equal(client.boardName(undefined), server.boardName(undefined));
  assert.equal(client.boardCode(undefined), server.boardCode(undefined));
});

test('client twin: identical collision suffixes for the same taken set', () => {
  const b = { grade: 'Saffire', gsm: 280, sheet_l: 22, sheet_w: 28 };
  for (const codes of [[], ['2228280SAFF'], ['2228280SAFF', '2228280SAFF-1']]) {
    assert.equal(client.boardCode(b, new Set(codes)), server.boardCode(b, new Set(codes)));
  }
});
