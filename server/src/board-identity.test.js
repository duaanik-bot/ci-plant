import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describedBoard, followBoardRename, settleBoardIdentity, carryBoardIdentity } from './board-identity.js';

// A board's name is its identity everywhere it is shown, and two things used to
// let an edit leave that identity behind:
//   1. the Boards master kept an existing row's stored name + code on save, so
//      materials 386 read CFBB / 280 GSM in its fields and 'FBB · 300 GSM ·
//      20.5x31.5' / 2132300FBB in its name and code (live 2026-09-10); and
//   2. products.board_name / board_grade are COPIES of the board, taken when a
//      product is planned onto it — PF-036 took 'FBB · 300 GSM · 20.5x31.5' and
//      grade FBB from 386's stale name the same afternoon. Nothing carried a
//      board rename onto its copies, so they would have stayed stale for good.

const BOARD_386_BEFORE = {
  id: 386, category: 'board', leftover: 0,
  name: 'FBB · 300 GSM · 20.5x31.5', spec: '2132300FBB',
  grade: 'CFBB', gsm: 280, sheet_l: 20.5, sheet_w: 31.5,
};
const BOARD_386_AFTER = { ...BOARD_386_BEFORE, name: 'CFBB · 280 GSM · 20.5x31.5', spec: '2132280CFBB' };

// ── describedBoard: the two spellings the product master carries ───────────
test('describedBoard: reads the composed spelling', () => {
  assert.deepEqual(describedBoard('FBB · 300 GSM · 20.5x31.5'),
    { grade: 'FBB', gsm: 300, sheet_l: 20.5, sheet_w: 31.5 });
});

test('describedBoard: reads the legacy spelling — 870 live product copies are written this way', () => {
  assert.deepEqual(describedBoard('Chromo Paper  205 GSM 22x28'),
    { grade: 'Chromo Paper', gsm: 205, sheet_l: 22, sheet_w: 28 });
  assert.deepEqual(describedBoard('FBB 300 GSM 31.5 x 41.5'),
    { grade: 'FBB', gsm: 300, sheet_l: 31.5, sheet_w: 41.5 });
});

test('describedBoard: a text that names no whole board is null, never a guess', () => {
  for (const t of ['Duplex GB  GSM 25x30', 'Unspecified board', '', null, undefined, 'FBB · 300 GSM']) {
    assert.equal(describedBoard(t), null, JSON.stringify(t));
  }
});

// ── followBoardRename: one product's copies, after its board is renamed ───
test('followBoardRename: PF-036 — an exact copy of the old name and the grade taken from it both follow', () => {
  assert.deepEqual(
    followBoardRename({ id: 137, board_name: 'FBB · 300 GSM · 20.5x31.5', board_grade: 'FBB' },
      BOARD_386_BEFORE, BOARD_386_AFTER),
    { board_name: 'CFBB · 280 GSM · 20.5x31.5', board_grade: 'CFBB' });
});

test('followBoardRename: a legacy spelling of the OLD board is a copy too, and follows', () => {
  const before = { ...BOARD_386_BEFORE, name: 'Saffire · 300 GSM · 31.5x41.5', grade: 'Saffire', gsm: 300, sheet_l: 31.5, sheet_w: 41.5 };
  const after = { ...before, name: 'Saffire · 280 GSM · 31.5x41.5', gsm: 280 };
  assert.deepEqual(
    followBoardRename({ board_name: 'Saffire 300 GSM 31.5x41.5', board_grade: 'Saffire' }, before, after),
    { board_name: 'Saffire · 280 GSM · 31.5x41.5' },
    'GSM moved, grade did not — so board_grade stays exactly as it was');
});

test('followBoardRename: a copy that names some OTHER board is not this rename\'s to touch', () => {
  // Left behind by an older link — wrong already, and not wrong because of this edit.
  assert.equal(followBoardRename({ board_name: 'FBB · 320 GSM · 23x36', board_grade: 'Saffire' },
    BOARD_386_BEFORE, BOARD_386_AFTER), null);
});

test('followBoardRename: blank copies stay blank — the live board name already shows through', () => {
  assert.equal(followBoardRename({ board_name: '', board_grade: null }, BOARD_386_BEFORE, BOARD_386_AFTER), null);
  assert.equal(followBoardRename({ board_name: null, board_grade: '' }, BOARD_386_BEFORE, BOARD_386_AFTER), null);
});

test('followBoardRename: a copy already reading the new identity changes nothing', () => {
  assert.equal(followBoardRename({ board_name: 'CFBB · 280 GSM · 20.5x31.5', board_grade: 'CFBB' },
    BOARD_386_BEFORE, BOARD_386_AFTER), null);
});

test('followBoardRename: the grade copy follows in the form it was copied — full grade or first word', () => {
  const before = { id: 7, category: 'board', name: 'Met Saffire · 340 GSM · 20x38', spec: '2038340METS', grade: 'Met Saffire', gsm: 340, sheet_l: 20, sheet_w: 38 };
  const after = { ...before, name: 'Saffire · 340 GSM · 20x38', spec: '2038340SAFF', grade: 'Saffire' };
  // Planning writes the FIRST WORD of the board name (orders.js boardIdentity).
  assert.deepEqual(followBoardRename({ board_name: '', board_grade: 'Met' }, before, after), { board_grade: 'Saffire' });
  // PO import writes the board's full grade.
  assert.deepEqual(followBoardRename({ board_name: '', board_grade: 'met saffire' }, before, after), { board_grade: 'Saffire' });
  // A grade that was never this board's is somebody's deliberate entry.
  assert.equal(followBoardRename({ board_name: '', board_grade: 'Duplex' }, before, after), null);
});

test('followBoardRename: a first word both grades share is still true, and stays', () => {
  const before = { id: 8, category: 'board', name: 'Duplex GB · 300 GSM · 23x36', spec: '2336300GB', grade: 'Duplex GB', gsm: 300, sheet_l: 23, sheet_w: 36 };
  const after = { ...before, name: 'Duplex WB · 300 GSM · 23x36', spec: '2336300WB', grade: 'Duplex WB' };
  assert.equal(followBoardRename({ board_name: '', board_grade: 'Duplex' }, before, after), null);
  assert.deepEqual(followBoardRename({ board_name: '', board_grade: 'Duplex GB' }, before, after), { board_grade: 'Duplex WB' });
});

test('followBoardRename: never proposes the product GSM — that is the carton spec, not a copy', () => {
  const out = followBoardRename({ board_name: 'FBB · 300 GSM · 20.5x31.5', board_grade: 'FBB', gsm: 300 },
    BOARD_386_BEFORE, BOARD_386_AFTER);
  assert.ok(!('gsm' in out));
});

// ── settleBoardIdentity: the server decides the name + code a board edit stores ──
// A stub `qc` answers the one read settle makes. No pool is ever connected, so an
// escape to the module-level q()/one() throws — on Vercel (pool max 1) that
// escape would be a self-deadlock inside the caller's transaction.
function boardsQc(boards) {
  const seen = [];
  const qc = async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM materials/.test(sql) && /category\s*=\s*'board'/.test(sql)) return boards;
    throw new Error(`stub qc got an unexpected statement: ${sql}`);
  };
  return { qc, seen };
}
const MASTER_BOARDS = [
  { id: 386, name: 'FBB · 300 GSM · 20.5x31.5', spec: '2132300FBB', leftover: 0 },
  { id: 391, name: 'CFBB · 300 GSM · 20.5x31.5', spec: '2132300CFBB', leftover: 0 },
  { id: 382, name: 'Met Saffire · 340 GSM · 20.75x31.5', spec: '2132340METS', leftover: 0 },
];

test('settleBoardIdentity: a form save that moved the grade and GSM stores the moved name and code', async () => {
  const { qc } = boardsQc(MASTER_BOARDS);
  // Exactly what the form sends — including the stale name an old browser tab still holds.
  const body = { grade: 'CFBB', gsm: 280, sheet_l: 20.5, sheet_w: 31.5, name: 'FBB · 300 GSM · 20.5x31.5', spec: '2132300FBB', reorder_level: 15000 };
  await settleBoardIdentity(body, { ...BOARD_386_BEFORE, grade: 'FBB', gsm: 300 }, qc);
  assert.equal(body.name, 'CFBB · 280 GSM · 20.5x31.5');
  assert.equal(body.spec, '2132280CFBB');
  assert.equal(body.reorder_level, 15000, 'every other field passes through untouched');
});

test('settleBoardIdentity: re-saving 386 as it stands today repairs it', async () => {
  const { qc } = boardsQc(MASTER_BOARDS);
  const body = { grade: 'CFBB', gsm: 280, sheet_l: 20.5, sheet_w: 31.5, name: BOARD_386_BEFORE.name, spec: BOARD_386_BEFORE.spec };
  await settleBoardIdentity(body, BOARD_386_BEFORE, qc);
  assert.equal(body.name, 'CFBB · 280 GSM · 20.5x31.5');
  assert.equal(body.spec, '2132280CFBB');
});

test('settleBoardIdentity: the Active toggle sends {active} alone and never renames anything', async () => {
  const { qc, seen } = boardsQc(MASTER_BOARDS);
  const body = { active: 0 };
  await settleBoardIdentity(body, BOARD_386_BEFORE, qc);
  assert.deepEqual(body, { active: 0 });
  assert.equal(seen.length, 0);
});

test('settleBoardIdentity: an ordinary edit stores the name and code exactly as they were', async () => {
  const { qc } = boardsQc(MASTER_BOARDS);
  const before = { id: 382, category: 'board', leftover: 0, name: 'Met Saffire · 340 GSM · 20.75x31.5', spec: '2132340METS', grade: 'Met Saffire', gsm: 340, sheet_l: 20.75, sheet_w: 31.5 };
  const body = { grade: 'Met Saffire', gsm: 340, sheet_l: 20.75, sheet_w: 31.5, name: before.name, spec: before.spec, reorder_level: 50 };
  await settleBoardIdentity(body, before, qc);
  assert.equal(body.name, before.name);
  assert.equal(body.spec, before.spec);
});

test('settleBoardIdentity: moving a board onto a name another board holds is refused, inactive or not', async () => {
  const { qc } = boardsQc(MASTER_BOARDS);
  const body = { grade: 'CFBB', gsm: 300, sheet_l: 20.5, sheet_w: 31.5 };
  await assert.rejects(settleBoardIdentity(body, { ...BOARD_386_BEFORE, grade: 'FBB', gsm: 300 }, qc),
    e => e.status === 409 && /CFBB · 300 GSM · 20\.5x31\.5/.test(e.message));
});

test('settleBoardIdentity: leftovers and non-board rows are not this rule\'s', async () => {
  const { qc, seen } = boardsQc(MASTER_BOARDS);
  const leftover = { ...BOARD_386_BEFORE, leftover: 1, name: 'Leftover — FBB · 300 GSM · 20.5x31.5 · 12×20.5"' };
  const body = { grade: 'CFBB', gsm: 280 };
  await settleBoardIdentity(body, leftover, qc);
  await settleBoardIdentity(body, { ...BOARD_386_BEFORE, category: 'chemical' }, qc);
  await settleBoardIdentity(body, null, qc);
  assert.deepEqual(body, { grade: 'CFBB', gsm: 280 });
  assert.equal(seen.length, 0);
});

// ── carryBoardIdentity: after the write, every copy of the old identity follows ──
function carryQc({ products = [] } = {}) {
  const seen = [];
  const qc = async (sql, params = []) => {
    seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/^\s*SELECT[\s\S]*FROM products/.test(sql)) return products;
    if (/^\s*UPDATE products/.test(sql)) return [];
    if (/^\s*INSERT INTO audit_log/.test(sql)) return [];
    if (/^\s*UPDATE materials/.test(sql)) return [];
    throw new Error(`stub qc got an unexpected statement: ${sql}`);
  };
  return { qc, seen };
}

test('carryBoardIdentity: PF-036 follows 386, and the product history says why', async () => {
  const { qc, seen } = carryQc({ products: [
    { id: 137, board_name: 'FBB · 300 GSM · 20.5x31.5', board_grade: 'FBB' },
    { id: 999, board_name: 'Something typed by hand', board_grade: 'Kraft' },
  ] });
  const out = await carryBoardIdentity(BOARD_386_BEFORE, BOARD_386_AFTER, qc, 'Anik Dua (MD)');
  assert.equal(out.products, 1);

  const updates = seen.filter(s => s.sql.startsWith('UPDATE products'));
  assert.equal(updates.length, 1, 'only the true copy is written');
  assert.deepEqual(updates[0].params.slice(-1), [137]);
  assert.ok(updates[0].params.includes('CFBB · 280 GSM · 20.5x31.5'));
  assert.ok(updates[0].params.includes('CFBB'));

  const audits = seen.filter(s => s.sql.startsWith('INSERT INTO audit_log'));
  assert.equal(audits.length, 1);
  const [entity, entityId, action, detail, user] = audits[0].params;
  assert.deepEqual([entity, entityId, action, user], ['products', 137, 'update', 'Anik Dua (MD)']);
  assert.match(detail, /board_name: FBB · 300 GSM · 20\.5x31\.5 → CFBB · 280 GSM · 20\.5x31\.5/);
  assert.match(detail, /board_grade: FBB → CFBB/);
});

test('carryBoardIdentity: the board\'s leftover offcuts carry its new name and code', async () => {
  const { qc, seen } = carryQc();
  await carryBoardIdentity(BOARD_386_BEFORE, BOARD_386_AFTER, qc, 'Anik Dua (MD)');
  const lo = seen.find(s => s.sql.startsWith('UPDATE materials'));
  assert.ok(lo, 'offcuts are named "Leftover — <parent name> · L×W" and carry the parent code');
  assert.match(lo.sql, /leftover\s*=\s*1/);
  assert.ok(lo.params.includes('Leftover — FBB · 300 GSM · 20.5x31.5 · '));
  assert.ok(lo.params.includes('Leftover — CFBB · 280 GSM · 20.5x31.5 · '));
  assert.ok(lo.params.includes('2132300FBB') && lo.params.includes('2132280CFBB') && lo.params.includes(386));
});

test('carryBoardIdentity: a save that renamed nothing writes nothing', async () => {
  const { qc, seen } = carryQc({ products: [{ id: 137, board_name: 'FBB · 300 GSM · 20.5x31.5', board_grade: 'FBB' }] });
  const out = await carryBoardIdentity(BOARD_386_AFTER, { ...BOARD_386_AFTER, reorder_level: 10 }, qc, 'x');
  assert.equal(out.products, 0);
  assert.equal(seen.length, 0);
});

test('carryBoardIdentity: only a board master carries — never a leftover, never another category', async () => {
  const { qc, seen } = carryQc();
  await carryBoardIdentity({ ...BOARD_386_BEFORE, leftover: 1 }, BOARD_386_AFTER, qc, 'x');
  await carryBoardIdentity({ ...BOARD_386_BEFORE, category: 'chemical' }, BOARD_386_AFTER, qc, 'x');
  assert.equal(seen.length, 0);
});

// ── the master save is wired to both, in one transaction ───────────────────
// PUT /materials/:id is the one door a board's grade, GSM or size is edited
// through. The rename and the copies it moves must commit together — a rename
// that landed while its copies failed would leave nothing to carry them later,
// because the next save would see no rename at all.
import { readFileSync } from 'node:fs';

const mastersSrc = readFileSync(new URL('./routes/masters.js', import.meta.url), 'utf8')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');   // prose must not satisfy a guard
const putHandler = mastersSrc.split('r.put(`/${table}/:id`')[1]?.split('r.delete(`/${table}/:id`')[0] ?? '';
// The body of the save itself — what runs inside the transaction for a board.
const inRun = putHandler.split('const update = async (qc, oc) => {')[1]?.split('const row =')[0] ?? '';

test('masters PUT: a board edit runs in one transaction, as a product edit does', () => {
  assert.ok(putHandler.length > 500, 'the generic PUT handler must be found');
  assert.match(putHandler,
    /const row = \(table === 'products' \|\| table === 'materials'\) \? await tx\(update\) : await update\(q, one\)/);
  assert.ok(inRun.length > 200, 'the save must go through update(qc, oc)');
});

test('masters PUT: the identity is settled before the columns are picked, and carried after the write', () => {
  const settle = inRun.indexOf('await settleBoardIdentity(req.body, before, qc)');
  const sets = inRun.indexOf('cols.filter(c => c in req.body)');
  const update = inRun.indexOf('UPDATE ${table} SET');
  const carry = inRun.indexOf('await carryBoardIdentity(before, updated, qc, req.user.name)');
  assert.ok(settle > 0 && sets > 0 && update > 0 && carry > 0, JSON.stringify({ settle, sets, update, carry }));
  assert.ok(settle < sets, 'settle writes name/spec into the body — it must run before `sets` is taken');
  assert.ok(update < carry, 'copies follow the row that was actually written');
});

// The form must show and send what the server will store — otherwise its
// duplicate-name check looks at the OLD name while the server writes a new one,
// and the preview promises a name the save does not keep (the 386 symptom).
const mastersJsx = readFileSync(new URL('../../client/src/pages/Masters.jsx', import.meta.url), 'utf8')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

test('Masters form: board name and code preview and save through identityOnSave', () => {
  const boards = mastersJsx.split('boards: {')[1]?.split('board_rates: {')[0] ?? '';
  assert.ok(boards.length > 500, 'the Boards config must be found');
  assert.match(boards, /key: 'name'[^\n]*\n\s*onSave: \(b, ctx\) => identityOnSave\(b, b, ctx\.takenCodes\)\.name/);
  assert.match(boards, /key: 'spec'[^\n]*\n\s*onSave: \(b, ctx\) => identityOnSave\(b, b, ctx\.takenCodes\)\.spec/);
  const save = mastersJsx.split('const save = async () => {')[1]?.split('const remove = async')[0] ?? '';
  assert.match(save, /body\[f\.key\] = f\.onSave\s*\?\s*\(f\.onSave\(editing, derivedCtx\)/,
    'save() must send the onSave value, not the stored one');
  assert.match(mastersJsx, /\(f\.onSave \? f\.onSave\(editing, derivedCtx\) : f\.compute\(editing, derivedCtx\)\)/,
    'the read-only preview must show the value save() sends');
});

test('masters PUT: nothing inside the transaction reaches for the pool (Vercel pool max 1 = deadlock)', () => {
  assert.ok(inRun.length > 200);
  assert.doesNotMatch(inRun, /\bawait (q|one)\(/);
  assert.match(inRun, /await audit\(table, \+req\.params\.id, 'update', .*?, qc, req\.user\.name\)/);
});
