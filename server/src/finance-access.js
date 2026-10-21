// Who may do what in Finance (spec §8). A login's right to a book is a row of its own, in fin_access:
// one row per (user, book), carrying the roles it holds there and whether it may export. The plant
// `role` in the token is never consulted: five plant logins are `admin`, and none of that is a right to
// the books of account. A login with no row for a book sees nothing of that book.
//
// Looked up per request, like access.js: the token carries only id, name and role, grants change
// mid-session, and the answer is held a few seconds per server instance. A grant that changes on THIS
// instance is forgotten at once (finForgetAccess, called by the routes that grant and revoke); on
// another instance it is out of date for 10 s at most.

import { q } from './db.js';
import { withoutLedger } from './data-tables.js';
import { finCan } from './finance-rules.js';
import { finError } from './finance-errors.js';

const HOLD_MS = 10_000;
const held = new Map();   // user id -> { at, grants }

export function finForgetAccess(userId = null) {
  if (userId == null) held.clear(); else held.delete(Number(userId));
}

// What one login holds, as a Map of book id -> { roles, can_export }. Always a Map: a login with no
// grants (or no valid id at all) gets an empty one, which refuses everything.
//
// Read outside the request's ledger (data-tables.js), as access.js does for `users`: who may ask is not
// part of any answer, and a read of fin_access here would tie every cached Finance response to that
// table. (GET /finance/me, whose answer IS the grants, reads fin_access in the ledger itself.)
//
// The cache holds frozen entries and hands each caller its own Map, so nothing a caller does to what it
// was given can change what the next request is told.
export async function finAccessOf(userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id < 1) return new Map();
  const hit = held.get(id);
  if (hit && Date.now() - hit.at < HOLD_MS) return new Map(hit.grants);
  const rows = await withoutLedger(() => q('SELECT book_id, roles, can_export FROM fin_access WHERE user_id = $1', [id]));
  const grants = new Map(rows.map(r => [r.book_id, Object.freeze({ roles: Object.freeze([...r.roles]), can_export: r.can_export })]));
  held.set(id, { at: Date.now(), grants });
  return new Map(grants);
}

// The caller's grant on a book, or a 403. `cap` is a capability of finance-rules' finCan (view, enter,
// ledger, import, approve, admin). A login with no grant on the book and one whose grant lacks the
// capability get the same answer, so a refusal never says whether a book exists.
export async function finRequire(req, cap, bookId) {
  const grant = (await finAccessOf(req.user?.id)).get(Number(bookId));
  if (!grant || !finCan(grant.roles, cap)) throw finError(403, 'FIN_FORBIDDEN');
  return grant;
}

// The book of a voucher, an import or an activity row that a route names by its id (`id`: a row id already read, or null
// for none), when the caller may see that book. A row that is not there and a row in a book the caller holds no view on
// are the same 404 FIN_NOT_FOUND, so a refusal never says whether it is there. What the caller may do with a row it can
// see is finRequire's to say next, for the book this returns. Read through the pool, before any transaction.
const FIN_BOOK_OF = Object.freeze({
  voucher: 'SELECT book_id FROM fin_vouchers WHERE id = $1',
  import: 'SELECT book_id FROM fin_imports WHERE id = $1',
  activity: 'SELECT book_id FROM fin_audit_log WHERE id = $1',
});
export async function finSeenBookOf(kind, id, req) {
  const row = id == null ? null : (await q(FIN_BOOK_OF[kind], [id]))[0];
  const grant = row ? (await finAccessOf(req.user?.id)).get(row.book_id) : undefined;
  if (!grant || !finCan(grant.roles, 'view')) throw finError(404, 'FIN_NOT_FOUND');
  return row.book_id;
}

// The books the caller holds `cap` on, by id, for the routes that list across books and must stay inside
// them (the vouchers list, the reports).
export async function finBookIdsFor(req, cap = 'view') {
  const grants = await finAccessOf(req.user?.id);
  return [...grants].filter(([, g]) => finCan(g.roles, cap)).map(([bookId]) => bookId).sort((a, b) => a - b);
}

// The active logins holding `approver` on a book: who is told when an entry waits. It takes the
// transaction's `qc` and nothing else: the posting transactions that call it hold the pool's only client
// on Vercel, so a pool query from inside one would wait for it forever.
export async function finApproverIds(bookId, qc) {
  if (typeof qc !== 'function') throw new TypeError("finApproverIds needs the transaction's qc");
  const rows = await qc(
    `SELECT a.user_id FROM fin_access a JOIN users u ON u.id = a.user_id
      WHERE a.book_id = $1 AND 'approver' = ANY (a.roles) AND u.active = 1
      ORDER BY a.user_id`, [bookId]);
  return rows.map(r => r.user_id);
}
