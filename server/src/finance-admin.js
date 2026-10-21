// Finance — who may do what, and when an Approver is needed: the writes behind Setup → Approval Rules and
// Setup → Access (spec §6.8, §8.1, §8.3), and the two lists those screens read.
//
// A write takes the `qc` / `oc` of the transaction its route opened, and uses nothing else: the pool is one client
// on Vercel, and a pool call made while the transaction holds it would wait for it forever. The route has already
// asked finRequire for the admin right on the row's book, BEFORE it opened the transaction. Each write appends ONE
// finAudit row in the same transaction, with before and after, so a change and its record commit or roll back
// together; a call that changes nothing writes nothing and says nothing. Only the two lists (finListRules,
// finListAccess) read through the pool, inside the request's ledger (data-tables.js), so a browser's copy of either
// is voided the moment a rule, a grant or a login changes.
//
// Not here: the 10 s hold of who-may-do-what (finance-access.js). A function in this file runs INSIDE the
// transaction and cannot know when it commits, so the route forgets the login's held grants (finForgetAccess) once
// the transaction has returned. finGrantAccess and finRevokeAccess hand back the grant, user_id included, for that.
//
// What each writes to the audit log (entity / action):
//   • rule   / edit    before and after are { rule_key, mode, limit_paise }
//   • access / grant   a new grant, or a change to one: a grant is an upsert on (user, book). before is null for a new one
//   • access / revoke  before is the grant that went, after is null
// An access snapshot is { user_id, user_name, email, roles, can_export }: what finance-setup.js writes for a grant, with the
// login's name added (the name is null if the login has since been deleted).
//
// The limit of a rule is NUMERIC in rupees in the table and whole paise everywhere else (finToPaise, finFromPaise),
// so it goes in as a safe integer and comes out as one. It is also kept under FIN_MAX_PAISE, as every typed amount is:
// above about ₹70 lakh crore a double can no longer hold a rupee amount to the paisa, and a limit read back one paisa
// out (or as an unsafe integer, which finNeedsApproval refuses) would stop every payment in the book.
//
// The last admin. A book needs at least one Finance Admin, or nobody could change a rule, a grant or a group in it
// again (FIN_LAST_ADMIN). So the 'admin' role is not taken from a grant, whether by editing it or by revoking it,
// unless another grant on the book holds it for a login that is switched on (a login that is switched off cannot
// sign in, so the role on its grant counts for nothing). Two admins removing each other at the same moment must not
// both pass, so before counting, ALL the book's grants are locked FOR UPDATE, in id order: two of these meet at the
// first grant and never each hold one the other waits for. The count is its own statement, taken once the locks are
// won, so the second sees whatever the first committed. Nothing else locks these rows (posting only reads them), and
// the guard takes no lock of its own on any other table.

import { finAudit } from './finance-audit.js';
import { finError } from './finance-errors.js';
import { finIdOf } from './finance-masters.js';
import { FIN_ROLES } from './finance-rules.js';
import { q } from './db.js';
import { FIN_MAX_PAISE, finFromPaise, finToPaise } from '../../client/src/lib/finance/money.js';

const FIN_RULE_MODES = Object.freeze(['always', 'above_limit', 'never']);
const FIN_RULE_COLS = 'id, book_id, rule_key, mode, limit_amount, updated_by, updated_at';

// A grant as the screens read it: the login's name and email come from users, read here and never written. A
// grant whose login has been deleted still lists (the join is a LEFT one), so that an admin can revoke it.
const FIN_GRANT_COLS = 'a.id, a.user_id, u.name AS user_name, u.email, a.book_id, a.roles, a.can_export';
const FIN_GRANT_FROM = 'FROM fin_access a LEFT JOIN users u ON u.id = a.user_id';

// ── Small pieces ─────────────────────────────────────────────────────────────────────────────

// 400. `field` names what is wrong so a form can say where; it goes in `body`, as every structured field does.
const finBad = (message, field) => finError(400, 'FIN_BAD_INPUT', message, field ? { field } : {});

const finMissing = () => finError(404, 'FIN_NOT_FOUND');

// Who is acting, the way the audit log wants it. A write with nobody to blame is a bug in the caller.
function finWho(actor) {
  const name = typeof actor?.name === 'string' ? actor.name.trim() : '';
  if (!name) throw new Error('A Finance write needs to know who is acting: pass { id, name }');
  return { id: Number.isInteger(actor.id) ? actor.id : null, name };
}

// ── Approval rules ───────────────────────────────────────────────────────────────────────────

// What a rule's body must say: when an Approver is needed, and above what. The limit goes with the mode
// 'above_limit' and with no other, which is what the table's CHECK says too: the limit is set if and only if the
// mode is above_limit. An absent limit and a null one are the same nothing. Returns { mode, limit_paise }.
export function finRuleChange(input) {
  const { mode, limit_paise } = input ?? {};
  if (typeof mode !== 'string' || !FIN_RULE_MODES.includes(mode)) {
    throw finBad('Say when an Approver is needed: always, above_limit or never.', 'mode');
  }
  const hasLimit = limit_paise !== undefined && limit_paise !== null;
  if (mode !== 'above_limit') {
    if (hasLimit) throw finBad('Only a rule that applies above a limit has a limit. Leave it out for always and never.', 'limit_paise');
    return { mode, limit_paise: null };
  }
  if (!hasLimit) throw finBad('A rule that applies above a limit needs the limit.', 'limit_paise');
  if (!Number.isSafeInteger(limit_paise) || limit_paise < 0 || limit_paise >= FIN_MAX_PAISE) {
    throw finBad('The limit must be a whole number of paise, 0 or more, and under ₹1 lakh crore.', 'limit_paise');
  }
  return { mode, limit_paise };
}

// A rule as the API says it: the limit in whole paise, and null for a mode with none.
export function finRuleOut(row) {
  return {
    id: row.id, book_id: row.book_id, rule_key: row.rule_key, mode: row.mode,
    limit_paise: row.limit_amount == null ? null : finToPaise(row.limit_amount),
    updated_by: row.updated_by, updated_at: row.updated_at,
  };
}

const finRuleSnapshot = rule => ({ rule_key: rule.rule_key, mode: rule.mode, limit_paise: rule.limit_paise });

// A book's rules, in the order they were made, which is the order of the spec's table (setup inserts them so).
export async function finListRules(bookId) {
  const rows = await q(`SELECT ${FIN_RULE_COLS} FROM fin_approval_rules WHERE book_id = $1 ORDER BY id`, [bookId]);
  return { rules: rows.map(finRuleOut) };
}

// Change when an Approver is needed for one rule. The rule is locked FOR NO KEY UPDATE, so two admins editing it at
// the same moment go one after the other and the second one's `before` is what the first left. Posting reads a rule
// without locking it, so an edit never makes a posting wait. A save that changes nothing writes nothing.
export async function finUpdateRule(qc, oc, ruleId, input, actor) {
  const by = finWho(actor);
  const id = finIdOf(ruleId);
  if (id == null) throw finMissing();
  const next = finRuleChange(input);

  const found = await oc(`SELECT ${FIN_RULE_COLS} FROM fin_approval_rules WHERE id = $1 FOR NO KEY UPDATE`, [id]);
  if (!found) throw finMissing();
  const before = finRuleOut(found);
  if (before.mode === next.mode && before.limit_paise === next.limit_paise) return before;

  const after = finRuleOut(await oc(
    `UPDATE fin_approval_rules SET mode = $2, limit_amount = $3::numeric, updated_by = $4, updated_at = now()
      WHERE id = $1 RETURNING ${FIN_RULE_COLS}`,
    [id, next.mode, next.limit_paise == null ? null : finFromPaise(next.limit_paise), by.name]));
  await finAudit(qc, {
    bookId: after.book_id, entity: 'rule', entityId: id, action: 'edit', userId: by.id, userName: by.name,
    before: finRuleSnapshot(before), after: finRuleSnapshot(after),
  });
  return after;
}

// ── Access ───────────────────────────────────────────────────────────────────────────────────

// The roles a grant holds: a non-empty list of roles Finance knows, once each, in the order of FIN_ROLES, so the
// same set is always stored (and compared) the same way. Anything else is a 400.
export function finRolesOf(value) {
  const list = Array.isArray(value) ? Array.from(value) : [];
  if (list.length === 0) throw finBad('Pick at least one role.', 'roles');
  if (!list.every(role => typeof role === 'string' && FIN_ROLES.includes(role))) {
    throw finBad(`A role is one of ${FIN_ROLES.join(', ')}.`, 'roles');
  }
  return FIN_ROLES.filter(role => list.includes(role));
}

const finSameRoles = (a, b) => a.length === b.length && b.every(role => a.includes(role));

const finGrantSnapshot = grant => ({
  user_id: grant.user_id, user_name: grant.user_name, email: grant.email, roles: grant.roles, can_export: grant.can_export,
});

// The grants on the books named, with the login behind each, and every login that can be given one (those switched
// on). The caller has worked out the books: only those it administers are passed.
export async function finListAccess(bookIds) {
  const grants = await q(
    `SELECT ${FIN_GRANT_COLS} ${FIN_GRANT_FROM}
      WHERE a.book_id = ANY($1::int[])
      ORDER BY a.book_id, lower(u.name), a.id`, [bookIds]);
  const users = await q('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY lower(name), id');
  return { grants, users };
}

// Hold every grant of the book until this transaction ends. See the header: this is what makes the count below true.
const finLockBookAccess = (qc, bookId) => qc('SELECT id FROM fin_access WHERE book_id = $1 ORDER BY id FOR UPDATE', [bookId]);

// The 'admin' role is about to leave this grant. 409 FIN_LAST_ADMIN unless another grant on the book keeps it, for a
// login that is switched on. Call it with the book's grants locked.
async function finKeepAnAdmin(oc, bookId, grantId) {
  const { others } = await oc(
    `SELECT COUNT(*)::int AS others
       FROM fin_access a JOIN users u ON u.id = a.user_id
      WHERE a.book_id = $1 AND a.id <> $2 AND 'admin' = ANY (a.roles) AND u.active = 1`, [bookId, grantId]);
  if (others === 0) throw finError(409, 'FIN_LAST_ADMIN');
}

// Give a login its roles in a book, or change them: one grant per (login, book). The roles are written whole: what is
// sent replaces what was there. Export is the one field a body may leave out (ruling R31): a grant that is new exports
// (true, the table's own default), and a grant that exists keeps what it has, so widening someone's roles can never
// switch back on an export an admin turned off. finance-setup.js never does either. Only an explicit true does, and
// that is a change like any other. The login must exist and be switched on (400). Taking admin from the only admin is
// FIN_LAST_ADMIN (409). A grant that is already exactly this writes nothing. Returns the grant, as the list shows it.
export async function finGrantAccess(qc, oc, input, actor) {
  const by = finWho(actor);
  const { user_id, book_id, roles, can_export } = input ?? {};
  const userId = finIdOf(user_id);
  if (userId == null) throw finBad('Say which login this is for.', 'user_id');
  const bookId = finIdOf(book_id);
  if (bookId == null) throw finBad('Say which book this is for.', 'book_id');
  const held = finRolesOf(roles);
  if (can_export !== undefined && typeof can_export !== 'boolean') throw finBad('can_export must be true or false.', 'can_export');

  const user = await oc('SELECT id, name, email FROM users WHERE id = $1 AND active = 1', [userId]);
  if (!user) throw finBad("That login doesn't exist or is switched off.", 'user_id');
  if (!await oc('SELECT id FROM fin_books WHERE id = $1', [bookId])) throw finMissing();

  await finLockBookAccess(qc, bookId);
  const had = await oc(`SELECT ${FIN_GRANT_COLS} ${FIN_GRANT_FROM} WHERE a.user_id = $1 AND a.book_id = $2`, [userId, bookId]);
  const canExport = can_export ?? had?.can_export ?? true;          // sent, else what the grant has (read under the lock), else a new grant's true
  if (had && finSameRoles(had.roles, held) && had.can_export === canExport) return had;
  if (had?.roles.includes('admin') && !held.includes('admin')) await finKeepAnAdmin(oc, bookId, had.id);

  const row = await oc(
    `INSERT INTO fin_access (user_id, book_id, roles, can_export, granted_by)
     VALUES ($1, $2, $3::text[], $4, $5)
     ON CONFLICT (user_id, book_id) DO UPDATE
       SET roles = EXCLUDED.roles, can_export = EXCLUDED.can_export, granted_by = EXCLUDED.granted_by, updated_at = now()
     RETURNING id`,
    [userId, bookId, held, canExport, by.name]);
  const after = { id: row.id, user_id: user.id, user_name: user.name, email: user.email, book_id: bookId, roles: held, can_export: canExport };
  await finAudit(qc, {
    bookId, entity: 'access', entityId: row.id, action: 'grant', userId: by.id, userName: by.name,
    before: had && finGrantSnapshot(had), after: finGrantSnapshot(after),
  });
  return after;
}

// Take a grant away. Revoking the only admin's grant is FIN_LAST_ADMIN (409). A grant that is already gone is a 404.
// Returns the grant that went, with its user_id, for the route to forget what it held for that login.
export async function finRevokeAccess(qc, oc, grantId, actor) {
  const by = finWho(actor);
  const id = finIdOf(grantId);
  if (id == null) throw finMissing();
  const found = await oc('SELECT book_id FROM fin_access WHERE id = $1', [id]);
  if (!found) throw finMissing();

  await finLockBookAccess(qc, found.book_id);
  const had = await oc(`SELECT ${FIN_GRANT_COLS} ${FIN_GRANT_FROM} WHERE a.id = $1`, [id]);
  if (!had) throw finMissing();                                  // revoked by someone else while this waited
  if (had.roles.includes('admin')) await finKeepAnAdmin(oc, had.book_id, id);

  await qc('DELETE FROM fin_access WHERE id = $1', [id]);
  await finAudit(qc, {
    bookId: had.book_id, entity: 'access', entityId: id, action: 'revoke', userId: by.id, userName: by.name,
    before: finGrantSnapshot(had), after: null,
  });
  return had;
}
