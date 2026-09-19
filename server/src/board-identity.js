// A board's identity — its name and code — follows its grade, GSM and size, and
// every copy of that identity follows the board.
//
// The Boards master is where a board's grade, GSM or parent sheet is edited, and
// PUT /materials/:id is the one door (routes/masters.js). This module is the two
// halves of that save for a board:
//   settleBoardIdentity — BEFORE the write: the name and code the row will store
//     (identityOnSave, board-code.js), decided here and not trusted from the
//     client, so a tablet still running an old bundle cannot send a stale name
//     back over a corrected row.
//   carryBoardIdentity — AFTER the write, same transaction: the copies. Every
//     place that JOINs the board by id (POs, PRs, GRNs, stock, holds, job
//     cards) reads the new name by itself. Three things hold it as TEXT and do
//     not: products.board_name, products.board_grade (Planning and the gang
//     sheet lock copy both from the board when a product is planned onto it),
//     and the board's leftover offcuts ('Leftover — <parent name> · L×W"',
//     carrying the parent's code). History — audit rows, stock notes, issued
//     COAs — is what it was, and is never rewritten.
//
// materials 386 (2026-09-10) is the case: grade FBB → CFBB, GSM 300 → 280, and
// the name and code stayed 'FBB · 300 GSM · 20.5x31.5' / 2132300FBB. PF-036 was
// planned onto it that afternoon and copied the stale name and grade FBB.
//
// Both functions run INSIDE the caller's transaction and touch the database only
// through the `qc` they are handed — on Vercel the pool holds ONE client, so a
// pool query from in here would wait on the very transaction it sits in.
import { identityOnSave, parseBoardName, takenCodesFor } from './board-code.js';
import { audit } from './helpers.js';

const IDENTITY_FIELDS = ['grade', 'gsm', 'sheet_l', 'sheet_w'];

// A real board master — not a leftover offcut (those take their identity from
// their parent), not another category of material.
const isBoardMaster = row => !!row && row.category === 'board' && !Number(row.leftover);

const low = s => String(s ?? '').trim().toLowerCase();
const firstWord = s => String(s ?? '').trim().split(/[\s·]+/)[0] || '';

// The board a piece of text names, in either spelling the product master holds:
// composed 'FBB · 300 GSM · 31.5x41.5' (551 live copies) or legacy
// 'FBB 300 GSM 31.5x41.5' (870). Text that names no whole board is null.
const LOOSE_RE = /^\s*(.+?)\s*·?\s*(\d{2,4})\s*GSM\s*·?\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*"?\s*$/i;
export function describedBoard(text) {
  const m = LOOSE_RE.exec(String(text ?? ''));
  if (!m) return null;
  return { grade: m[1].trim(), gsm: +m[2], sheet_l: +m[3], sheet_w: +m[4] };
}

const sameBoard = (a, b) => !!a && !!b && low(a.grade) === low(b.grade)
  && a.gsm === b.gsm && a.sheet_l === b.sheet_l && a.sheet_w === b.sheet_w;

// What one product's copies of a board become once the board is renamed:
// only the columns that change, or null. The OLD identity is what the old NAME
// said — that is what the copies were taken from, and for a row like 386 it is
// not what the fields said.
//   board_name  — an exact copy of the old name, or the same board in the legacy
//                 spelling, becomes the new name. A copy naming some other board
//                 was not made from this one and is not this rename's to fix.
//   board_grade — follows only when the grade itself moved, and in the form it
//                 was copied: Planning copies the FIRST WORD of the board name,
//                 PO import the full grade. Anything else was typed on purpose.
// products.gsm is never proposed: it is the carton's specified GSM, and a
// carton may legitimately run on a board of another GSM.
export function followBoardRename(product, before, after) {
  const was = describedBoard(before?.name);
  const now = parseBoardName(after?.name);
  if (!was || !now) return null;
  const next = {};

  const copy = String(product?.board_name ?? '').trim();
  if (copy && copy !== after.name
      && (copy === String(before.name).trim() || sameBoard(describedBoard(copy), was))) {
    next.board_name = after.name;
  }

  const grade = low(product?.board_grade);
  if (grade) {
    if (grade === low(was.grade) && low(was.grade) !== low(now.grade)) {
      next.board_grade = now.grade;
    } else if (grade === low(firstWord(before.name)) && low(firstWord(before.name)) !== low(firstWord(after.name))) {
      next.board_grade = firstWord(after.name);
    }
  }

  return Object.keys(next).length ? next : null;
}

// Before the write: put the name and code this board will carry into the body.
// A bare Active toggle ({active}) says nothing about identity and is left alone.
// Moving a board onto a name another board already holds is refused, as the
// form refuses it — two boards may not share one identity.
export async function settleBoardIdentity(body, before, qc) {
  if (!isBoardMaster(before)) return;
  if (![...IDENTITY_FIELDS, 'name', 'spec'].some(k => k in body)) return;
  const row = { ...before };
  for (const k of IDENTITY_FIELDS) if (k in body) row[k] = body[k];
  const boards = await qc(`SELECT id, name, spec, leftover FROM materials WHERE category='board'`);
  const next = identityOnSave(before, row, takenCodesFor(boards, before.id));
  if (next.name !== before.name) {
    const clash = boards.find(b => !Number(b.leftover) && String(b.id) !== String(before.id)
      && low(b.name) === low(next.name));
    if (clash) {
      throw Object.assign(new Error(
        `“${next.name}” already exists in the board master — edit that board instead of turning this one into it.`),
      { status: 409 });
    }
  }
  body.name = next.name;
  body.spec = next.spec;
}

// After the write: every copy of the old identity follows the new one. Returns
// what moved. Each product it touches gets its own field-level history line, so
// the product's history panel says why its board name changed.
export async function carryBoardIdentity(before, after, qc, user = null) {
  const moved = { products: 0, leftovers: 0 };
  if (!isBoardMaster(before) || !after) return moved;
  if (before.name === after.name && before.spec === after.spec) return moved;

  const products = await qc(
    'SELECT id, board_name, board_grade FROM products WHERE board_material_id=$1 ORDER BY id', [after.id]);
  for (const p of products) {
    const next = followBoardRename(p, before, after);
    if (!next) continue;
    const cols = Object.keys(next);
    await qc(`UPDATE products SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')} WHERE id=$${cols.length + 1}`,
      [...cols.map(c => next[c]), p.id]);
    const diff = cols.map(c => `${c}: ${p[c] ?? '—'} → ${next[c]}`).join('; ');
    await audit('products', p.id, 'update', `${diff} (followed board ${after.spec || `#${after.id}`})`.slice(0, 500), qc, user);
    moved.products++;
  }

  if (before.name) {
    const offcuts = await qc(`
      UPDATE materials
         SET name = CASE WHEN left(name, length($1::text)) = $1::text
                         THEN $2::text || substr(name, length($1::text) + 1) ELSE name END,
             spec = CASE WHEN spec = $3::text THEN $4::text ELSE spec END
       WHERE leftover = 1 AND source_material_id = $5
         AND (left(name, length($1::text)) = $1::text OR spec = $3::text)
      RETURNING id`,
    [`Leftover — ${before.name} · `, `Leftover — ${after.name} · `, before.spec, after.spec, after.id]);
    moved.leftovers = offcuts.length;
  }
  return moved;
}
