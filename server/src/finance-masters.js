// Finance — the chart of accounts and the months: the writes behind the Setup screens (spec §6.2 to §6.4, §8).
// Groups and ledgers are added, edited and (groups only) deleted; a financial year is added with its twelve
// months; a month moves between open, closing and locked.
//
// Every function takes the `qc` / `oc` of the transaction its route opened, and uses nothing else: the pool is
// one client on Vercel, and a pool call made while the transaction holds it would wait for it forever.
// The route has already asked finRequire who may do this, for the book it acts on, BEFORE opening the
// transaction (finRequire reads through the pool too). Each function writes ONE finAudit row in the same
// transaction, with before and after, so a change and its record commit or roll back together; a call that
// changes nothing writes nothing and says nothing.
//
// A refusal is a finError. Where the app knows more than the code's plain sentence (which field, which month,
// what it would take) it says so in its own words; the database stays the last stop for what only it can see:
// a name or a code taken, a party already linked, a group still held by a foreign key (finance-errors.js).
//
// What each writes to the audit log (entity / action): group create, edit, delete; ledger create, edit;
// period status (the reason, where there is one, in the row's `reason`); and, from finCreateYear, year create.
//
// Locks, because a book's chart is shared by every accountant. Rows are taken in this order, so no two of these
// wait for one another:
//   • Reshaping a book's group tree (finUpdateGroup) takes the book's row first, FOR NO KEY UPDATE. Two admins
//     moving groups at once then go one after the other, each reading the tree the last one left, and no two
//     moves can tie it in a loop (A under B and B under A). That mode does not wait for the key-share locks that
//     a posting or a new ledger takes on the book, so nothing else is held up by it. Adding and deleting a group
//     take no book lock: neither can make a loop.
//   • Then the row being changed: a group about to be deleted FOR UPDATE, which waits for anyone still adding a
//     ledger or a sub-group under it, and every other row FOR NO KEY UPDATE.
//   • Then anything that row is about to point at (a parent group, the group a ledger moves to) FOR KEY SHARE,
//     which is what the foreign key would take anyway. It is taken early so that a group deleted a moment before
//     is a clean refusal and not a foreign-key error.
//   • A month is taken FOR UPDATE. Posting reads its month FOR SHARE (spec §7.4), so a posting into a month and
//     a change of that month's status wait for one another, and a month moved twice at once moves once.

import { finAudit } from './finance-audit.js';
import { finCreateYear } from './finance-setup.js';
import { finError } from './finance-errors.js';
import { finMonthsOfFy } from '../../client/src/lib/finance/fy.js';
import { finPeriodMove, finPeriodMoves } from '../../client/src/lib/finance/periods.js';
import { optionalText } from './helpers.js';

const FIN_INT4_MAX = 2_147_483_647;
export const FIN_NAME_MAX = 255;   // a group's or a ledger's name, and a Tally import's names
const FIN_CODE_MAX = 50;
const FIN_NOTES_MAX = 2000;
const FIN_REASON_MAX = 500;
const FIN_SORT_MAX = 1_000_000;
const FIN_FIRST_YEAR = 2000;     // the year a financial year starts in, as its label spells it: 2000-01 to 2099-00
const FIN_LAST_YEAR = 2099;

const FIN_GROUP_COLS = 'id, book_id, parent_id, name, nature, affects_gross_profit, is_system, sort_order';
const FIN_LEDGER_COLS = 'id, book_id, group_id, name, code, tally_name, party_type, party_id, manual_entry, is_system, active, notes';
const FIN_PERIOD_COLS = 'id, book_id, year_id, month_no, label, start_date, end_date, status, status_changed_by, status_changed_at';

const FIN_PARTY_TYPES = ['customer', 'vendor'];
const FIN_STATUSES = ['before_books', 'open', 'closing', 'locked'];

// ── Small pieces ─────────────────────────────────────────────────────────────────────────────

// 400. `field` names what is wrong so a form can say where; it goes in `body`, as every structured field does.
const finBad = (message, field) => finError(400, 'FIN_BAD_INPUT', message, field ? { field } : {});

// A row id: a whole number from 1 to what an INTEGER column holds, as a number or as the digits of one, or null.
// The ceiling matters: a larger number is a perfectly good JS integer that Postgres refuses as out of range,
// which would come back a 500 and not the 400 or 404 it is.
export function finIdOf(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^[0-9]{1,10}$/.test(value) ? Number(value) : NaN);
  return Number.isInteger(n) && n >= 1 && n <= FIN_INT4_MAX ? n : null;
}

// A name as it is kept: trimmed, every run of whitespace one space (spec: names are unique ignoring capitals,
// and "Beta  Bank" and "Beta Bank" are the same name to a person). Not text is '', which callers refuse as blank.
export const finCleanName = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

// A required name. Shared with the other Finance modules (ruling R22). The control-character test below is
// also what turns away a NUL byte (\u0000), which Postgres refuses in TEXT: it would come back a 500.
export function finRequiredName(value, what) {
  const name = finCleanName(value);
  if (!name) throw finBad(`${what} needs a name.`, 'name');
  if (name.length > FIN_NAME_MAX) throw finBad(`The name is too long: ${FIN_NAME_MAX} characters at most.`, 'name');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw finBad("The name has a character that can't be used.", 'name');
  return name;
}

// Optional text: null for nothing (absent, null, blank, or the words a client sends when it means nothing, which
// optionalText turns away), the trimmed text otherwise. A number or an object is not text. Shared with the other
// Finance modules (ruling R22: the voucher's narration, reference and bill reference go through it too). A NUL
// byte (\u0000) is refused as a 400, because Postgres refuses it in TEXT and the write would come back a 500.
// Every other character is text, a line break included: a narration may run to several lines.
export function finOptionalText(value, field, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw finBad(`${field} must be text.`, field);
  if (value.includes('\u0000')) throw finBad("That text has a character that can't be used.", field);
  const text = optionalText(value);
  if (text && text.length > max) throw finBad(`That is too long: ${max} characters at most.`, field);
  return text;
}

// A flag must be true or false and nothing else; 0, 'no' and null are no answer.
function finFlag(value, field) {
  if (typeof value !== 'boolean') throw finBad(`${field} must be true or false.`, field);
  return value;
}

// Who is acting, the way the audit log wants it. A write with nobody to blame is a bug in the caller.
function finWho(actor) {
  const name = typeof actor?.name === 'string' ? actor.name.trim() : '';
  if (!name) throw new Error('A Finance write needs to know who is acting: pass { id, name }');
  return { id: Number.isInteger(actor.id) ? actor.id : null, name };
}

const finMissing = () => finError(404, 'FIN_NOT_FOUND');

// A group of THIS book, held FOR KEY SHARE so it cannot be deleted from under the row about to point at it.
// Another book's group and a group that is gone are the same answer.
async function finGroupInBook(oc, groupId, bookId, field) {
  const group = await oc(
    'SELECT id, nature, affects_gross_profit FROM fin_groups WHERE id = $1 AND book_id = $2 FOR KEY SHARE', [groupId, bookId]);
  if (!group) throw finBad("That group isn't one of this book's groups.", field);
  return group;
}

// A party link is a type and an id together, or neither (the table's CHECK says so too).
function finPartyOf(type, id) {
  const noType = type == null || type === '';
  const noId = id == null || id === '';
  if (noType && noId) return { party_type: null, party_id: null };
  if (noType || noId) throw finBad('A link to a customer or vendor needs both: which kind, and which one.', noType ? 'party_type' : 'party_id');
  if (!FIN_PARTY_TYPES.includes(type)) throw finBad('A ledger links to a customer or a vendor.', 'party_type');
  const partyId = finIdOf(id);
  if (partyId == null) throw finBad("That isn't a customer or vendor id.", 'party_id');
  return { party_type: type, party_id: partyId };
}

// The ERP keeps customers and vendors; Finance stores their ids bare (no foreign key), so existence is
// checked here. A party that is switched off may still be linked: a former customer can have a balance.
async function finPartyMustExist(oc, { party_type, party_id }) {
  const found = party_type === 'customer'
    ? await oc('SELECT id FROM customers WHERE id = $1', [party_id])
    : await oc('SELECT id FROM vendors WHERE id = $1', [party_id]);
  if (!found) throw finBad(`That ${party_type} could not be found.`, 'party_id');
}

// UPDATE ... SET for the columns that changed, and nothing else. The column names are this file's own keys.
const finSets = (changes, from = 2) => Object.keys(changes).map((col, i) => `${col} = $${i + from}`);

// ── Groups ───────────────────────────────────────────────────────────────────────────────────

// A new sub-group, under a group of the same book. It takes the parent's nature and gross-profit flag (a
// sub-group's nature never drifts from its parent's), is never a system group, and goes last in the book's order.
export async function finCreateGroup(qc, oc, { book_id, parent_id, name } = {}, actor) {
  const by = finWho(actor);
  const bookId = finIdOf(book_id);
  if (bookId == null) throw finBad('Say which book this group is for.', 'book_id');
  const parentId = finIdOf(parent_id);
  if (parentId == null) throw finBad('A group needs a parent group to sit under.', 'parent_id');
  const clean = finRequiredName(name, 'A group');

  const parent = await finGroupInBook(oc, parentId, bookId, 'parent_id');
  const group = await oc(
    `INSERT INTO fin_groups (book_id, parent_id, name, nature, affects_gross_profit, is_system, sort_order)
     VALUES ($1, $2, $3, $4, $5, false, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM fin_groups WHERE book_id = $1))
     RETURNING ${FIN_GROUP_COLS}`,
    [bookId, parentId, clean, parent.nature, parent.affects_gross_profit]);
  await finAudit(qc, { bookId, entity: 'group', entityId: group.id, action: 'create', userId: by.id, userName: by.name, after: group });
  return group;
}

// Rename a group, move it under another, or change where it sits in the order. A save that changes nothing is
// not an edit. Ruling R19: a system group is neither renamed nor moved, because bank and cash, debtors and
// creditors and the Profit & Loss A/c are found by the template's names, and renaming one would quietly stop
// the shape checks finding them. Its place in the order is the one thing about it that can change.
export async function finUpdateGroup(qc, oc, id, fields, actor) {
  const by = finWho(actor);
  const groupId = finIdOf(id);
  if (groupId == null) throw finMissing();
  const edit = fields ?? {};

  const found = await oc('SELECT book_id FROM fin_groups WHERE id = $1', [groupId]);
  if (!found) throw finMissing();
  await oc('SELECT id FROM fin_books WHERE id = $1 FOR NO KEY UPDATE', [found.book_id]);   // the lock order above
  const before = await oc(`SELECT ${FIN_GROUP_COLS} FROM fin_groups WHERE id = $1 FOR NO KEY UPDATE`, [groupId]);
  if (!before) throw finMissing();                                                        // deleted while this waited

  const changes = {};
  if (edit.name !== undefined) {
    const name = finRequiredName(edit.name, 'A group');
    if (name !== before.name) changes.name = name;
  }
  if (edit.parent_id !== undefined && edit.parent_id !== before.parent_id) {
    const parentId = finIdOf(edit.parent_id);
    if (parentId == null) throw finBad('A group needs a parent group to sit under.', 'parent_id');
    if (parentId !== before.parent_id) changes.parent_id = parentId;
  }
  if (edit.sort_order !== undefined) {
    const order = edit.sort_order;
    if (!Number.isInteger(order) || order < 0 || order > FIN_SORT_MAX) throw finBad('The order is a whole number.', 'sort_order');
    if (order !== before.sort_order) changes.sort_order = order;
  }

  if (before.is_system && ('name' in changes || 'parent_id' in changes)) {
    throw finBad("A built-in group can't be renamed or moved: the books find bank and cash, debtors and creditors by its name.");
  }
  if ('parent_id' in changes) {
    const parent = await finGroupInBook(oc, changes.parent_id, before.book_id, 'parent_id');
    // The new parent must not be the group or anything under it, or the tree would loop. UNION, not UNION ALL:
    // the walk ends even on a loop that is already there.
    const { cyclic } = await oc(
      `WITH RECURSIVE under_group AS (
         SELECT id FROM fin_groups WHERE id = $1
         UNION
         SELECT g.id FROM fin_groups g JOIN under_group u ON g.parent_id = u.id WHERE g.book_id = $3
       )
       SELECT EXISTS (SELECT 1 FROM under_group WHERE id = $2) AS cyclic`,
      [groupId, parent.id, before.book_id]);
    if (cyclic) throw finBad("A group can't be moved under itself or under one of its own sub-groups.", 'parent_id');
    if (parent.nature !== before.nature) {
      throw finBad(`A ${before.nature} group can only sit under another ${before.nature} group.`, 'parent_id');
    }
    // Direct and indirect sit on either side of gross profit: a sub-group moved across would change what the
    // books report, so it stays on its side, as its flag was set from its parent's.
    if (parent.affects_gross_profit !== before.affects_gross_profit) {
      throw finBad("That parent is on the other side of gross profit. Make a new group there and move the ledgers instead.", 'parent_id');
    }
  }

  if (Object.keys(changes).length === 0) return before;
  const after = await oc(
    `UPDATE fin_groups SET ${finSets(changes).join(', ')} WHERE id = $1 RETURNING ${FIN_GROUP_COLS}`,
    [groupId, ...Object.values(changes)]);
  await finAudit(qc, { bookId: after.book_id, entity: 'group', entityId: groupId, action: 'edit', userId: by.id, userName: by.name, before, after });
  return after;
}

// Delete a group nothing else needs: not a system group, with no ledger in it (a switched-off one counts: it
// keeps its history), no sub-group, and nothing else that points at it. Locked FOR UPDATE first, which waits for
// anyone still adding a ledger or a sub-group, so the counts below are the truth for as long as this holds.
export async function finDeleteGroup(qc, oc, id, actor) {
  const by = finWho(actor);
  const groupId = finIdOf(id);
  if (groupId == null) throw finMissing();
  const group = await oc(`SELECT ${FIN_GROUP_COLS} FROM fin_groups WHERE id = $1 FOR UPDATE`, [groupId]);
  if (!group) throw finMissing();
  if (group.is_system) throw finBad("A built-in group can't be deleted.");

  const used = await oc(
    `SELECT (SELECT COUNT(*) FROM fin_ledgers WHERE group_id = $1)::int AS ledgers,
            (SELECT COUNT(*) FROM fin_groups WHERE parent_id = $1)::int AS groups`, [groupId]);
  if (used.ledgers || used.groups) {
    const parts = [];
    if (used.ledgers) parts.push(`${used.ledgers} ${used.ledgers === 1 ? 'ledger' : 'ledgers'}`);
    if (used.groups) parts.push(`${used.groups} ${used.groups === 1 ? 'sub-group' : 'sub-groups'}`);
    throw finError(409, 'FIN_IN_USE', `This group still has ${parts.join(' and ')} in it, so it can't be deleted. Move or delete ${used.ledgers + used.groups === 1 ? 'it' : 'them'} first.`);
  }
  await qc('DELETE FROM fin_groups WHERE id = $1', [groupId]);   // a foreign key still holding it (a staged import) refuses here: FIN_IN_USE
  await finAudit(qc, { bookId: group.book_id, entity: 'group', entityId: groupId, action: 'delete', userId: by.id, userName: by.name, before: group });
}

// ── Ledgers ──────────────────────────────────────────────────────────────────────────────────

// A new ledger, under a group of the same book. It starts active and open to hand-typed vouchers: switching
// either off, and making it a system ledger, is not something a new ledger is born with (finUpdateLedger).
// A party ledger keeps the name it has in Tally and is linked to the ERP's customer or vendor beside it.
export async function finCreateLedger(qc, oc, { book_id, group_id, name, code, tally_name, party_type, party_id, notes } = {}, actor) {
  const by = finWho(actor);
  const bookId = finIdOf(book_id);
  if (bookId == null) throw finBad('Say which book this ledger is for.', 'book_id');
  const groupId = finIdOf(group_id);
  if (groupId == null) throw finBad('A ledger needs a group to sit under.', 'group_id');
  const clean = finRequiredName(name, 'A ledger');
  const text = {
    code: finOptionalText(code, 'code', FIN_CODE_MAX),
    tally_name: finOptionalText(tally_name, 'tally_name', FIN_NAME_MAX),
    notes: finOptionalText(notes, 'notes', FIN_NOTES_MAX),
  };
  const party = finPartyOf(party_type, party_id);

  await finGroupInBook(oc, groupId, bookId, 'group_id');
  if (party.party_type) await finPartyMustExist(oc, party);
  const ledger = await oc(
    `INSERT INTO fin_ledgers (book_id, group_id, name, code, tally_name, party_type, party_id, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${FIN_LEDGER_COLS}`,
    [bookId, groupId, clean, text.code, text.tally_name, party.party_type, party.party_id, text.notes, by.name]);
  await finAudit(qc, { bookId, entity: 'ledger', entityId: ledger.id, action: 'create', userId: by.id, userName: by.name, after: ledger });
  return ledger;
}

// What only an admin may change on a ledger (spec §8.1): where it sits, whether hand-typed vouchers may use it,
// whether it is switched on, and which customer or vendor it stands for.
const FIN_ADMIN_FIELDS = ['group_id', 'manual_entry', 'active', 'party_type', 'party_id'];

// Edit a ledger. The accountant changes its name, code, Tally name and notes; the fields above are the
// admin's (`isAdmin`, from the admin capability, which the route has resolved). Only a CHANGE to one of them
// needs the admin: a form sent back as it was read, with the admin-only fields as they were, is not an
// admin act, and a save that changes nothing at all writes nothing. A system ledger (Cash, Profit & Loss A/c)
// cannot be moved or switched off.
export async function finUpdateLedger(qc, oc, id, fields, actor, { isAdmin = false } = {}) {
  const by = finWho(actor);
  const ledgerId = finIdOf(id);
  if (ledgerId == null) throw finMissing();
  const edit = fields ?? {};

  const before = await oc(`SELECT ${FIN_LEDGER_COLS} FROM fin_ledgers WHERE id = $1 FOR NO KEY UPDATE`, [ledgerId]);
  if (!before) throw finMissing();

  if (!isAdmin) {
    for (const key of FIN_ADMIN_FIELDS) {
      if (edit[key] !== undefined && edit[key] !== before[key]) throw finError(403, 'FIN_FORBIDDEN');
    }
  }

  const next = {};
  if (edit.name !== undefined) next.name = finRequiredName(edit.name, 'A ledger');
  if (edit.code !== undefined) next.code = finOptionalText(edit.code, 'code', FIN_CODE_MAX);
  if (edit.tally_name !== undefined) next.tally_name = finOptionalText(edit.tally_name, 'tally_name', FIN_NAME_MAX);
  if (edit.notes !== undefined) next.notes = finOptionalText(edit.notes, 'notes', FIN_NOTES_MAX);
  if (isAdmin) {
    if (edit.group_id !== undefined) {
      const groupId = finIdOf(edit.group_id);
      if (groupId == null) throw finBad('A ledger needs a group to sit under.', 'group_id');
      next.group_id = groupId;
    }
    if (edit.manual_entry !== undefined) next.manual_entry = finFlag(edit.manual_entry, 'manual_entry');
    if (edit.active !== undefined) next.active = finFlag(edit.active, 'active');
    if (edit.party_type !== undefined || edit.party_id !== undefined) {
      Object.assign(next, finPartyOf(edit.party_type !== undefined ? edit.party_type : before.party_type,
        edit.party_id !== undefined ? edit.party_id : before.party_id));
    }
  }
  const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== before[key]));

  if (before.is_system && ('group_id' in changes || changes.active === false)) {
    throw finBad("A built-in ledger can't be moved or switched off.");
  }
  if ('group_id' in changes) await finGroupInBook(oc, changes.group_id, before.book_id, 'group_id');
  if (('party_type' in changes || 'party_id' in changes) && next.party_type) await finPartyMustExist(oc, next);

  if (Object.keys(changes).length === 0) return before;
  const after = await oc(
    `UPDATE fin_ledgers SET ${[...finSets(changes), 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING ${FIN_LEDGER_COLS}`,
    [ledgerId, ...Object.values(changes)]);
  await finAudit(qc, { bookId: after.book_id, entity: 'ledger', entityId: ledgerId, action: 'edit', userId: by.id, userName: by.name, before, after });
  return after;
}

// ── Years and months ─────────────────────────────────────────────────────────────────────────

// A financial year's label as it is kept: two years running April to March, written 2027-28.
function finYearLabel(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  const from = Number(text.slice(0, 4));
  try {
    finMonthsOfFy(text);                       // refuses everything but a real YYYY-YY
  } catch {
    const how = 'Write it like 2027-28: April of the first year to March of the next.';
    throw finBad(text ? `"${text}" isn't a financial year. ${how}` : `Say which financial year. ${how}`, 'label');
  }
  if (from < FIN_FIRST_YEAR || from > FIN_LAST_YEAR) {
    throw finBad(`Financial years run from ${FIN_FIRST_YEAR}-01 to ${FIN_LAST_YEAR}-00.`, 'label');
  }
  return text;
}

// Add a financial year to a book with its twelve months: those that end before the books begin are
// before_books and the rest are open (finCreateYear). A year the book already has is FIN_EXISTS. The year is
// audited by finCreateYear itself, once, so this adds no row of its own. Returns the year with its `periods`.
export async function finAddYear(qc, oc, { book_id, label } = {}, actor) {
  const by = finWho(actor);
  const bookId = finIdOf(book_id);
  if (bookId == null) throw finBad('Say which book this year is for.', 'book_id');
  const text = finYearLabel(label);
  const book = await oc('SELECT id, books_begin FROM fin_books WHERE id = $1', [bookId]);
  if (!book) throw finMissing();
  const { year, created } = await finCreateYear(qc, oc, { bookId, label: text, booksBegin: book.books_begin, actor: by });
  if (!created) throw finError(409, 'FIN_EXISTS', `The ${text} year already exists in this book.`);
  return year;
}

// Why a month cannot go where it was asked to, in the month's own words. The moves it names are the table's (periods.js).
function finMoveRefusal(month, to) {
  if (month.status === 'before_books') return `${month.label} comes before the books begin, so its status never changes.`;
  if (month.status === to) return `${month.label} is already ${to}.`;
  return `${month.label} is ${month.status}, so it can only move to ${finPeriodMoves(month.status).map(m => m.to).join(' or ')}.`;
}

// Move a month to a new status (spec §6.2): open to closing, closing to locked, closing back to open and
// locked back to closing, the last two with a reason. The moves are client/src/lib/finance/periods.js's, the ONE
// definition, so the Months & Years screen offers exactly these. Whether the move is allowed is judged before
// whether the reason is there: a move that is never allowed does not ask for a reason. The month is locked FOR
// UPDATE, and posting reads it FOR SHARE, so a posting into the month and a change of its status wait for one
// another. The caller has checked that the actor is an Approver of the month's book.
export async function finSetPeriodStatus(qc, oc, periodId, { status, reason } = {}, actor) {
  const by = finWho(actor);
  const id = finIdOf(periodId);
  if (id == null) throw finMissing();
  if (typeof status !== 'string' || !FIN_STATUSES.includes(status)) {
    throw finBad('Say which status the month should move to: open, closing or locked.', 'status');
  }
  const why = finOptionalText(reason, 'reason', FIN_REASON_MAX);

  const month = await oc(`SELECT ${FIN_PERIOD_COLS} FROM fin_periods WHERE id = $1 FOR UPDATE`, [id]);
  if (!month) throw finMissing();
  const move = finPeriodMove(month.status, status);
  if (!move.ok) throw finError(409, 'FIN_BAD_TRANSITION', finMoveRefusal(month, status));
  if (move.needsReason && !why) throw finError(400, 'FIN_REASON_REQUIRED');

  const after = await oc(
    `UPDATE fin_periods SET status = $2, status_changed_by = $3, status_changed_at = now() WHERE id = $1 RETURNING ${FIN_PERIOD_COLS}`,
    [id, status, by.name]);
  await finAudit(qc, {
    bookId: month.book_id, entity: 'period', entityId: id, action: 'status', userId: by.id, userName: by.name, reason: why,
    before: { label: month.label, status: month.status }, after: { label: month.label, status },
  });
  return after;
}
