// Finance — the books of account (spec §9). ONE router. The logic lives in the flat modules
// server/src/finance-*.js; this file resolves who is asking and which book, then reads or hands over.
//
//   • Every route authorises itself. It names the book it acts on and calls finRequire(req, cap, bookId)
//     before it touches anything; the plant `role` in the token plays no part (finance-access.js).
//   • Every handler ends  catch (e) { next(finMapDbError(e)); }  so a refusal the database makes comes out
//     as a Finance refusal, with its code and its plain sentence (finance-errors.js).
//   • Routes are written  r.<verb>('/finance/…'  at column 0, single-quoted, with the handler inline:
//     mint-routes-join-once.test.js reads them that way.
//
// Read routes (this file, so far): the caller's books, and a book's groups, ledgers and years; the vouchers list
// and one voucher; and the reports (trial balance, a ledger's statement, the journal register, the self-approved
// list, and the activity log with one of its rows opened), which finance-reports.js answers from the pool; and, from
// finance-admin.js, a book's approval rules and the Finance access list; and, from finance-import.js, a book's Tally
// imports, one import, and the parallel run.
// Write routes: groups, ledgers, years and the month status (the chart of accounts and the months); voucher
// drafts (make, edit, discard); a voucher's way into the books (submit, approve, reject); its way out (reverse);
// who may do what: an approval rule's mode and limit, and a login's grant on a book (give, change, revoke); and the
// Tally import: an upload, the accountant's confirmation of its matches, and the Opening voucher built from it.
// Each asks finRequire who may, BEFORE it opens its transaction (finRequire reads through the pool, and the pool is
// one client on Vercel, so a pool call made inside a transaction would wait for the client that transaction holds),
// then hands the body to finance-masters.js, finance-vouchers.js, finance-admin.js or finance-import.js inside tx(),
// which use only the transaction's qc and oc. Submit, approve, reverse and build-opening can post, and posting mints
// the voucher's number, so all four are in client/src/lib/writeOnce.js MINTING_POSTS: a double-click joins the request
// already on the wire. Reject mints nothing, and neither does a rule, a grant, an upload or a confirmation: a repeated
// grant is the same grant, so none of those is joined.
// A grant or a revoke also makes finance-access.js forget what it holds for that login, once the transaction has
// returned, so the login's very next request is judged on the new grants.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { finBookIdsFor, finForgetAccess, finRequire, finSeenBookOf } from '../finance-access.js';
import { finCan } from '../finance-rules.js';
import { finError, finMapDbError } from '../finance-errors.js';
import {
  finIdOf, finCreateGroup, finUpdateGroup, finDeleteGroup, finCreateLedger, finUpdateLedger, finAddYear, finSetPeriodStatus,
} from '../finance-masters.js';
import { finListRules, finUpdateRule, finListAccess, finGrantAccess, finRevokeAccess } from '../finance-admin.js';
import {
  finCreateDraft, finUpdateDraft, finDiscardDraft, finVoucherBookOf, finVoucherView, finListVouchers,
  finSubmitVoucher, finApproveVoucher, finRejectVoucher, finReverseVoucher, finGroupKinds, finIsPartyLedger,
} from '../finance-vouchers.js';
import { finTrialBalance, finLedgerStatement, finJournalRegister, finSelfApproved, finActivity, finActivityRow } from '../finance-reports.js';
import {
  finImportBookOf, finCreateImport, finListImports, finImportView, finSaveMatches, finBuildOpening, finParallelRun,
} from '../finance-import.js';

const r = Router();

// The book a path names. A book id is a whole number or the path names nothing at all.
function finBookParam(req) {
  const id = +req.params.bookId;
  if (!Number.isInteger(id)) throw finError(404, 'FIN_NOT_FOUND');
  return id;
}

// The books a login holds a grant on, with what the grant lets it do. Read from fin_access here, inside
// the request's ledger (data-tables.js), because here the grants ARE the answer: a grant given or taken
// away has to void the copy a browser keeps of this response, and a read outside the ledger (the 10 s
// finAccessOf that finRequire uses) would not.
const finBooksOf = userId => q(
  `SELECT b.id, b.code, b.name, b.billing_entity_id, b.books_begin, a.roles, a.can_export
     FROM fin_access a JOIN fin_books b ON b.id = a.book_id
    WHERE a.user_id = $1
    ORDER BY b.id`, [userId]);

r.get('/finance/me', async (req, res, next) => {
  try {
    res.json({ user: { id: req.user.id, name: req.user.name }, books: await finBooksOf(req.user.id) });
  } catch (e) { next(finMapDbError(e)); }
});

r.get('/finance/books', async (req, res, next) => {
  try {
    res.json({ books: await finBooksOf(req.user.id) });
  } catch (e) { next(finMapDbError(e)); }
});

// Tally's group tree for the book, in its own order. ledger_count is the ledgers directly in the group,
// switched-off ones included: a group with any ledger cannot be deleted.
//   • is_bank_cash / is_party: the group is, or descends from, one of FIN_BANK_CASH_GROUPS / FIN_PARTY_GROUPS (ruling R23).
//     Both are finGroupKinds' answer (finance-vouchers.js), the very one the ledgers read below, the voucher drafts and the
//     Tally import use: a screen that must know whether a group is a party's (the Opening Match step: a new ledger under
//     one is linked to a customer or vendor) reads it here and never works it out from names of its own (ruling R23).
r.get('/finance/books/:bookId/groups', async (req, res, next) => {
  try {
    const bookId = finBookParam(req);
    await finRequire(req, 'view', bookId);
    const groups = await q(
      `SELECT g.id, g.parent_id, g.name, g.nature, g.affects_gross_profit, g.is_system, g.sort_order,
              COUNT(l.id)::int AS ledger_count
         FROM fin_groups g LEFT JOIN fin_ledgers l ON l.group_id = g.id AND l.book_id = g.book_id
        WHERE g.book_id = $1
        GROUP BY g.id
        ORDER BY g.sort_order, g.id`, [bookId]);
    const kinds = await finGroupKinds(q, bookId);
    res.json({ groups: groups.map(g => ({
      ...g, is_bank_cash: kinds.get(g.id)?.is_bank_cash === true, is_party: kinds.get(g.id)?.is_party === true,
    })) });
  } catch (e) { next(finMapDbError(e)); }
});

// The book's ledgers, switched-off ones only on ?include_inactive=1.
//   • party_name is the ERP customer or vendor the ledger is linked to; name_differs says the ledger's name
//     is no longer that party's, ignoring capitals and spaces (a party ledger keeps the name it had in
//     Tally, spec §6.4, so a difference is a hint and never a fault).
//   • is_bank_cash: the ledger's group is, or descends from, one of FIN_BANK_CASH_GROUPS.
//   • is_party (ruling R39): the ledger is linked to a customer or vendor, or its group is, or descends from, Sundry
//     Debtors or Sundry Creditors (ruling R23). It tells the voucher form which lines take bill details.
//     Both flags are finGroupKinds' and finIsPartyLedger's answer (finance-vouchers.js): the voucher drafts and the
//     Tally import ask the same two questions, so there is ONE definition of each and no SQL of its own here.
//   • notes: the edit form needs it.
r.get('/finance/books/:bookId/ledgers', async (req, res, next) => {
  try {
    const bookId = finBookParam(req);
    await finRequire(req, 'view', bookId);
    const withInactive = ['1', 'true'].includes(req.query.include_inactive);
    const ledgers = await q(
      `SELECT l.id, l.book_id, l.group_id, g.name AS group_name, l.name, l.code, l.tally_name, l.notes,
              l.party_type, l.party_id, COALESCE(c.name, v.name) AS party_name,
              COALESCE(lower(regexp_replace(l.name, '[[:space:]]', '', 'g'))
                       <> lower(regexp_replace(COALESCE(c.name, v.name), '[[:space:]]', '', 'g')), false) AS name_differs,
              l.manual_entry, l.is_system, l.active
         FROM fin_ledgers l
         JOIN fin_groups g ON g.id = l.group_id AND g.book_id = l.book_id
         LEFT JOIN customers c ON l.party_type = 'customer' AND c.id = l.party_id
         LEFT JOIN vendors v ON l.party_type = 'vendor' AND v.id = l.party_id
        WHERE l.book_id = $1 AND ($2::boolean OR l.active)
        ORDER BY lower(l.name), l.id`,
      [bookId, withInactive]);
    const kinds = await finGroupKinds(q, bookId);
    res.json({ ledgers: ledgers.map(l => ({
      ...l, is_bank_cash: kinds.get(l.group_id)?.is_bank_cash === true, is_party: finIsPartyLedger(l, kinds),
    })) });
  } catch (e) { next(finMapDbError(e)); }
});

// The book's financial years, oldest first, each with its months and their lock state.
r.get('/finance/books/:bookId/years', async (req, res, next) => {
  try {
    const bookId = finBookParam(req);
    await finRequire(req, 'view', bookId);
    const years = await q(
      'SELECT id, label, short, start_date, end_date FROM fin_years WHERE book_id = $1 ORDER BY start_date, id', [bookId]);
    const months = await q(
      `SELECT id, year_id, month_no, label, start_date, end_date, status, status_changed_by, status_changed_at
         FROM fin_periods WHERE book_id = $1 ORDER BY start_date, id`, [bookId]);
    res.json({ years: years.map(y => ({
      ...y, periods: months.filter(m => m.year_id === y.id).map(({ year_id, ...month }) => month),
    })) });
  } catch (e) { next(finMapDbError(e)); }
});

// ── The writes ───────────────────────────────────────────────────────────────────────────────

// The JSON object a write was sent. An array or a bare value is not a form.
function finBodyOf(req) {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw finError(400, 'FIN_BAD_INPUT', 'Send the details as a JSON object.');
  }
  return body;
}

// The book a write names in its body. A body that names no book, or names one that cannot be a book, is a 400;
// whether the caller may act on that book is finRequire's to say, next.
function finBodyBook(body) {
  const bookId = finIdOf(body.book_id);
  if (bookId == null) throw finError(400, 'FIN_BAD_INPUT', 'Say which book this is for.', { field: 'book_id' });
  return bookId;
}

// The book a report (or, named by `what`, a list) is for, ?book=<id>. A request that names no book, or one that
// cannot be a book, is a 400; whether the caller may read that book is finRequire's to say, next.
function finQueryBook(query, what = 'report') {
  const bookId = finIdOf(query.book);
  if (bookId == null) throw finError(400, 'FIN_BAD_INPUT', `Say which book this ${what} is for.`, { field: 'book' });
  return bookId;
}

// Who is acting, as the audit log wants it.
const finActorOf = req => ({ id: req.user.id, name: req.user.name });

// The book a group, ledger or month lives in, for the routes that name the row and not the book (the path has
// only its id). Read here, BEFORE the transaction, for the reason in the header. A row that does not exist and a
// row in a book the caller holds nothing on both come out of finRequire as the same 403, so a refusal never says
// whether a row is there (as the book routes say nothing of whether a book is). An id that cannot be a row id is 404.
const FIN_BOOK_OF_ROW = {
  group: 'SELECT book_id FROM fin_groups WHERE id = $1',
  ledger: 'SELECT book_id FROM fin_ledgers WHERE id = $1',
  period: 'SELECT book_id FROM fin_periods WHERE id = $1',
  rule: 'SELECT book_id FROM fin_approval_rules WHERE id = $1',
  access: 'SELECT book_id FROM fin_access WHERE id = $1',
};
async function finRequireRow(req, cap, what) {
  const id = finIdOf(req.params.id);
  if (id == null) throw finError(404, 'FIN_NOT_FOUND');
  const row = await one(FIN_BOOK_OF_ROW[what], [id]);
  const grant = await finRequire(req, cap, row?.book_id);
  return { id, grant };
}

// A group is added under a parent of the same book, and takes its nature and gross-profit flag.
r.post('/finance/groups', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'admin', bookId);
    res.json({ group: await tx((qc, oc) => finCreateGroup(qc, oc, body, finActorOf(req))) });
  } catch (e) { next(finMapDbError(e)); }
});

// Rename, move or reorder a group. A system group is never renamed or moved (ruling R19).
r.put('/finance/groups/:id', async (req, res, next) => {
  try {
    const { id } = await finRequireRow(req, 'admin', 'group');
    const body = finBodyOf(req);
    res.json({ group: await tx((qc, oc) => finUpdateGroup(qc, oc, id, body, finActorOf(req))) });
  } catch (e) { next(finMapDbError(e)); }
});

r.delete('/finance/groups/:id', async (req, res, next) => {
  try {
    const { id } = await finRequireRow(req, 'admin', 'group');
    await tx((qc, oc) => finDeleteGroup(qc, oc, id, finActorOf(req)));
    res.json({ ok: true });
  } catch (e) { next(finMapDbError(e)); }
});

// The accountant (or the admin) adds a ledger under an existing group. It starts active and open to hand-typed
// vouchers, whatever else the body says.
r.post('/finance/ledgers', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'ledger', bookId);
    res.json({ ledger: await tx((qc, oc) => finCreateLedger(qc, oc, body, finActorOf(req))) });
  } catch (e) { next(finMapDbError(e)); }
});

// The accountant edits a ledger's text; its group, flags and party link are the admin's. Whether the caller is
// the admin is the admin capability on the ledger's own book, which finRequire has just resolved.
r.put('/finance/ledgers/:id', async (req, res, next) => {
  try {
    const { id, grant } = await finRequireRow(req, 'ledger', 'ledger');
    const body = finBodyOf(req);
    const isAdmin = finCan(grant.roles, 'admin');
    res.json({ ledger: await tx((qc, oc) => finUpdateLedger(qc, oc, id, body, finActorOf(req), { isAdmin })) });
  } catch (e) { next(finMapDbError(e)); }
});

// A financial year with its twelve months. The year is audited by the code that makes it, so no row is added here.
r.post('/finance/years', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'admin', bookId);
    res.json({ year: await tx((qc, oc) => finAddYear(qc, oc, body, finActorOf(req))) });
  } catch (e) { next(finMapDbError(e)); }
});

// A month moves between open, closing and locked: the Approver's (spec §8.1), and only the four moves of §6.2.
r.put('/finance/periods/:id/status', async (req, res, next) => {
  try {
    const { id } = await finRequireRow(req, 'approve', 'period');
    const body = finBodyOf(req);
    res.json({ period: await tx((qc, oc) => finSetPeriodStatus(qc, oc, id, body, finActorOf(req))) });
  } catch (e) { next(finMapDbError(e)); }
});

// ── Vouchers ─────────────────────────────────────────────────────────────────────────────────

// The books' vouchers: the day book (the default), what waits for the caller to approve, or the caller's own
// drafts. Always inside the books the login holds a grant on; finListVouchers has the filters.
r.get('/finance/vouchers', async (req, res, next) => {
  try {
    res.json(await finListVouchers(req));
  } catch (e) { next(finMapDbError(e)); }
});

// One voucher: its lines, its history and what this login may do with it. A voucher the caller cannot see is a
// 404, the same answer as for one that is not there.
r.get('/finance/vouchers/:id', async (req, res, next) => {
  try {
    res.json(await finVoucherView(req.params.id, req));
  } catch (e) { next(finMapDbError(e)); }
});

// The accountant (or an approver) saves a draft. It takes no number. The same save key from the same login
// answers with the draft the first save made.
r.post('/finance/vouchers', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    const grant = await finRequire(req, 'enter', bookId);
    res.json({ voucher: await tx((qc, oc) => finCreateDraft(qc, oc, body, { ...finActorOf(req), roles: grant.roles })) });
  } catch (e) { next(finMapDbError(e)); }
});

// The maker edits a draft: its date, narration, reference and all its lines at once. The voucher is found first,
// and a voucher the caller cannot see is a 404; one they can see but may not enter is the 403.
r.put('/finance/vouchers/:id', async (req, res, next) => {
  try {
    const { id, bookId } = await finVoucherBookOf(req);
    const grant = await finRequire(req, 'enter', bookId);
    const body = finBodyOf(req);
    res.json({ voucher: await tx((qc, oc) => finUpdateDraft(qc, oc, id, body, { ...finActorOf(req), roles: grant.roles })) });
  } catch (e) { next(finMapDbError(e)); }
});

// The maker, or a Finance Admin, discards a draft. The right needed is enter OR admin, and finRequire takes one
// capability at a time, so it is asked for the lesser, view, and the roles it returns say which door was used.
r.post('/finance/vouchers/:id/discard', async (req, res, next) => {
  try {
    const { id, bookId } = await finVoucherBookOf(req);
    const grant = await finRequire(req, 'view', bookId);
    const isAdmin = finCan(grant.roles, 'admin');
    if (!isAdmin && !finCan(grant.roles, 'enter')) throw finError(403, 'FIN_FORBIDDEN');
    res.json({ voucher: await tx((qc, oc) => finDiscardDraft(qc, oc, id, { ...finActorOf(req), roles: grant.roles }, { isAdmin })) });
  } catch (e) { next(finMapDbError(e)); }
});

// The maker sends a draft on (spec §7.3). It posts at once when it needs no approval, or when its maker is an
// Approver of the book (self-approved); otherwise it waits for an Approver, and the book's Approvers are told.
r.post('/finance/vouchers/:id/submit', async (req, res, next) => {
  try {
    const { id, bookId } = await finVoucherBookOf(req);
    const grant = await finRequire(req, 'enter', bookId);
    res.json({ voucher: await tx((qc, oc) => finSubmitVoucher(qc, oc, id, { ...finActorOf(req), roles: grant.roles })) });
  } catch (e) { next(finMapDbError(e)); }
});

// An Approver of the book, not its maker, approves a waiting entry; it posts in the Approver's name.
r.post('/finance/vouchers/:id/approve', async (req, res, next) => {
  try {
    const { id, bookId } = await finVoucherBookOf(req);
    const grant = await finRequire(req, 'approve', bookId);
    res.json({ voucher: await tx((qc, oc) => finApproveVoucher(qc, oc, id, { ...finActorOf(req), roles: grant.roles })) });
  } catch (e) { next(finMapDbError(e)); }
});

// An Approver of the book sends a waiting entry back to its maker as a draft, with the reason (body: { reason }).
r.post('/finance/vouchers/:id/reject', async (req, res, next) => {
  try {
    const { id, bookId } = await finVoucherBookOf(req);
    const grant = await finRequire(req, 'approve', bookId);
    const body = finBodyOf(req);
    res.json({ voucher: await tx((qc, oc) => finRejectVoucher(qc, oc, id, { ...finActorOf(req), roles: grant.roles }, body.reason)) });
  } catch (e) { next(finMapDbError(e)); }
});

// Anyone who may enter vouchers in the book reverses a posted entry (body: { date, reason }; no date is today). The
// reversal is submitted under the book's reversal rule: an Approver's posts at once, self-approved, and an accountant's
// waits for an Approver (spec §7.5). The answer is the reversal.
r.post('/finance/vouchers/:id/reverse', async (req, res, next) => {
  try {
    const { id, bookId } = await finVoucherBookOf(req);
    const grant = await finRequire(req, 'enter', bookId);
    const body = finBodyOf(req);
    const actor = { ...finActorOf(req), roles: grant.roles };
    res.json({ voucher: await tx((qc, oc) => finReverseVoucher(qc, oc, id, actor, { date: body.date, reason: body.reason })) });
  } catch (e) { next(finMapDbError(e)); }
});

// ── Reports ──────────────────────────────────────────────────────────────────────────────────
// All five need only the right to view. Each asks finRequire first, for the book the report is about, and only then
// reads (through the pool, no transaction: they write nothing). The dates and the filters are checked in
// finance-reports.js, after the caller is known to hold the book.

// The trial balance as at ?to, or for ?from to ?to with the days before ?from as the opening. ?all=1 also lists the
// ledgers with no figures.
r.get('/finance/reports/trial-balance', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query);
    await finRequire(req, 'view', bookId);
    res.json(await finTrialBalance(bookId, { from: req.query.from, to: req.query.to, all: ['1', 'true'].includes(req.query.all) }));
  } catch (e) { next(finMapDbError(e)); }
});

// One ledger's statement. The book is the ledger's own, found from the ledger and never taken from the request: a login
// holding another book is refused, and so is an id that is no ledger (the same 403, as finRequireRow answers).
r.get('/finance/reports/ledger', async (req, res, next) => {
  try {
    const ledgerId = finIdOf(req.query.ledger);
    if (ledgerId == null) throw finError(400, 'FIN_BAD_INPUT', 'Say which ledger this report is for.', { field: 'ledger' });
    const row = await one(FIN_BOOK_OF_ROW.ledger, [ledgerId]);
    await finRequire(req, 'view', row?.book_id);
    res.json(await finLedgerStatement(ledgerId, { from: req.query.from, to: req.query.to }));
  } catch (e) { next(finMapDbError(e)); }
});

// The book's posted vouchers with their lines, ?from to ?to (either may be left out), and ?type to take one kind.
r.get('/finance/reports/journal-register', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query);
    await finRequire(req, 'view', bookId);
    res.json(await finJournalRegister(bookId, { from: req.query.from, to: req.query.to, type: req.query.type }));
  } catch (e) { next(finMapDbError(e)); }
});

// The posted vouchers an Approver passed on their own authority, ?from to ?to.
r.get('/finance/reports/self-approved', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query);
    await finRequire(req, 'view', bookId);
    res.json(await finSelfApproved(bookId, { from: req.query.from, to: req.query.to }));
  } catch (e) { next(finMapDbError(e)); }
});

// The audit log, as summaries (ruling R71: no record before and after; one row's is GET /finance/activity/:id). With ?book
// it is that one book, and a login that cannot read it is refused (403). Without, it is every book the login may read: the
// books are worked out here and handed over, so the log can never send a row outside them, and a login that may read none
// is refused (403), as every Finance route refuses a login with no grant (spec §14).
r.get('/finance/activity', async (req, res, next) => {
  try {
    let book = null;
    if (req.query.book !== undefined) {
      book = finIdOf(req.query.book);
      if (book == null) throw finError(400, 'FIN_BAD_INPUT', 'book must be a book id.', { field: 'book' });
      await finRequire(req, 'view', book);
    }
    const bookIds = await finBookIdsFor(req);
    if (bookIds.length === 0) throw finError(403, 'FIN_FORBIDDEN');
    res.json(await finActivity(bookIds, { book, from: req.query.from, to: req.query.to, user: req.query.user, entity: req.query.entity }));
  } catch (e) { next(finMapDbError(e)); }
});

// One row of the log, opened: the summary with the record before and after. Anyone who reads the row's book may open it; a
// row in a book the caller cannot read is a 404, the same answer as for one that is not there (finSeenBookOf).
r.get('/finance/activity/:id', async (req, res, next) => {
  try {
    const id = finIdOf(req.params.id);
    await finSeenBookOf('activity', id, req);
    res.json(await finActivityRow(id));
  } catch (e) { next(finMapDbError(e)); }
});

// ── Approval rules and Finance access (spec §6.8, §8.1) ──────────────────────────────────────

// The book's ten approval rules, with each limit in paise. Anyone who can read the book may read them: an accountant
// is told by the rules what will wait for an Approver.
r.get('/finance/approval-rules', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query, 'list');
    await finRequire(req, 'view', bookId);
    res.json(await finListRules(bookId));
  } catch (e) { next(finMapDbError(e)); }
});

// An admin of the rule's book changes when an Approver is needed: the mode, and for above_limit the limit in paise
// (body: { mode, limit_paise }). The book is the rule's own, found from the rule.
r.put('/finance/approval-rules/:id', async (req, res, next) => {
  try {
    const { id } = await finRequireRow(req, 'admin', 'rule');
    const body = finBodyOf(req);
    res.json({ rule: await tx((qc, oc) => finUpdateRule(qc, oc, id, body, finActorOf(req))) });
  } catch (e) { next(finMapDbError(e)); }
});

// Every grant on the books the caller administers, and the logins that can be given one. A login that administers no
// book has nothing to list: it is refused (403), the same answer as for a book it holds nothing on.
r.get('/finance/access', async (req, res, next) => {
  try {
    const bookIds = await finBookIdsFor(req, 'admin');
    if (bookIds.length === 0) throw finError(403, 'FIN_FORBIDDEN');
    res.json(await finListAccess(bookIds));
  } catch (e) { next(finMapDbError(e)); }
});

// An admin of the book gives a login its roles there, or changes them (body: { user_id, book_id, roles, can_export }).
// can_export may be left out: a new grant exports, and an existing one keeps what it has.
// The transaction has committed before the login's held grants are forgotten (finance-access.js holds them for 10 s),
// so its very next request is judged on the new ones: a grant is felt at once, and so is a revoke.
r.post('/finance/access', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'admin', bookId);
    const grant = await tx((qc, oc) => finGrantAccess(qc, oc, body, finActorOf(req)));
    finForgetAccess(grant.user_id);
    res.json({ grant });
  } catch (e) { next(finMapDbError(e)); }
});

// An admin of the grant's book takes it away. The book is the grant's own, found from the grant.
r.delete('/finance/access/:id', async (req, res, next) => {
  try {
    const { id } = await finRequireRow(req, 'admin', 'access');
    const grant = await tx((qc, oc) => finRevokeAccess(qc, oc, id, finActorOf(req)));
    finForgetAccess(grant.user_id);
    res.json({ ok: true });
  } catch (e) { next(finMapDbError(e)); }
});

// ── The Tally import (spec §11) ──────────────────────────────────────────────────────────────
// The accountant's Tally exports, read in the browser (client/src/lib/finance/tally.js) and sent as rows, make an import
// (finance-import.js): the opening balances, which build the Opening voucher, or a month-end trial balance, which the
// parallel run sets beside Finance. Importing is the accountant's and the admin's (the import capability, spec §8.1);
// reading is anyone's who reads the book. An import the caller cannot see is a 404, whether or not it is there, as a
// voucher is (finImportBookOf).

// An upload: { book_id, purpose, as_at, file_names, accounts, tb, bills }. The answer is the import as finImportView says
// it: every row with its proposal, the bills, the tie-out. app.js lets the JSON of two paths run to 4 MB, this one and the
// confirmation of its matches below (PUT /finance/imports/:id/matches, which lists every row again; ruling R41); the row
// counts are capped in finance-import.js.
r.post('/finance/imports', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'import', bookId);
    const id = await tx((qc, oc) => finCreateImport(qc, oc, body, finActorOf(req)));
    res.json(await finImportView(id));
  } catch (e) { next(finMapDbError(e)); }
});

// The book's imports, newest first; ?purpose=opening or parallel_tb takes one kind.
r.get('/finance/imports', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query, 'list');
    await finRequire(req, 'view', bookId);
    res.json(await finListImports(bookId, { purpose: req.query.purpose }));
  } catch (e) { next(finMapDbError(e)); }
});

r.get('/finance/imports/:id', async (req, res, next) => {
  try {
    const { id } = await finImportBookOf(req.params.id, req);
    res.json(await finImportView(id));
  } catch (e) { next(finMapDbError(e)); }
});

// The accountant confirms every row of the import, each once (body: { matches: [{ row_id, action, ledger_id, group_id,
// party_type, party_id }] }). The answer is the import as it now stands. Its JSON shares the upload's 4 MB ceiling (app.js).
r.put('/finance/imports/:id/matches', async (req, res, next) => {
  try {
    const { id, bookId } = await finImportBookOf(req.params.id, req);
    await finRequire(req, 'import', bookId);
    const body = finBodyOf(req);
    await tx((qc, oc) => finSaveMatches(qc, oc, id, body.matches, finActorOf(req)));
    res.json(await finImportView(id));
  } catch (e) { next(finMapDbError(e)); }
});

// Build the Opening voucher from a confirmed import, and submit it. The answer is the voucher: waiting for the MD, or
// posted, self-approved, when an Approver builds it.
r.post('/finance/imports/:id/build-opening', async (req, res, next) => {
  try {
    const { id, bookId } = await finImportBookOf(req.params.id, req);
    const grant = await finRequire(req, 'import', bookId);
    res.json({ voucher: await tx((qc, oc) => finBuildOpening(qc, oc, id, { ...finActorOf(req), roles: grant.roles })) });
  } catch (e) { next(finMapDbError(e)); }
});

// The parallel run (spec §9.2, §11.3): a month-end import's Tally closings beside Finance's, ?import=<id>. Only the right
// to view the import's book; the book is the import's own.
r.get('/finance/reports/parallel-run', async (req, res, next) => {
  try {
    if (finIdOf(req.query.import) == null) throw finError(400, 'FIN_BAD_INPUT', 'Say which import this report is for.', { field: 'import' });
    const { id } = await finImportBookOf(req.query.import, req);
    res.json(await finParallelRun(id));
  } catch (e) { next(finMapDbError(e)); }
});

export default r;
