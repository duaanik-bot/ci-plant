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
// Cash & Bank (finance-cash.js, finance-allocations.js): the tiles, an account's book, the party money on account, a party's open
// items and its statement, and a preview of an adjustment, all reads (the preview a POST, for its list of ticks); a receipt, payment
// or transfer entered and submitted at once, which can post and so is in MINTING_POSTS; and a redo of a line's adjustment, which
// mints nothing. The day the ERP's own receipt doors hand over to Finance is the one route any login may read.
// Opening corrections (finance-corrections.js): a book's list of them with "Opening + corrections" for each ledger, a read; and one
// entered and submitted at once, which can post and so is in MINTING_POSTS.
// HR & payroll setup (finance-hr-setup.js): a book's channel map, ledger roles, expense map and payroll setting, a read; the Admin's
// save of them, and the Admin's "create the staff ledgers". Neither write posts or mints anything, so neither is joined.
// HR's entries in the books (finance-hr-catchup.js): the header line's counts and the control check, and a book's open exceptions,
// two reads; "Bring in from HR" and an exception tried again, which post through the HR feed and so mint, and are in MINTING_POSTS.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { markUncacheable } from '../data-tables.js';
import { finBookIdsFor, finForgetAccess, finRequire, finSeenBookOf } from '../finance-access.js';
import { finCan } from '../finance-rules.js';
import { finError, finMapDbError } from '../finance-errors.js';
import {
  finIdOf, finCreateGroup, finUpdateGroup, finDeleteGroup, finCreateLedger, finUpdateLedger, finAddYear, finSetPeriodStatus,
} from '../finance-masters.js';
import { finListRules, finUpdateRule, finListAccess, finGrantAccess, finRevokeAccess } from '../finance-admin.js';
import {
  finCreateDraft, finUpdateDraft, finDiscardDraft, finVoucherBookOf, finVoucherView, finListVouchers,
  finSubmitVoucher, finApproveVoucher, finRejectVoucher, finReverseVoucher, finGroupKinds, finIsPartyLedger, finPartySide,
} from '../finance-vouchers.js';
import { finTrialBalance, finLedgerStatement, finJournalRegister, finSelfApproved, finActivity, finActivityRow } from '../finance-reports.js';
import {
  finImportBookOf, finCreateImport, finListImports, finImportView, finSaveMatches, finBuildOpening, finParallelRun,
} from '../finance-import.js';
import { finToPaise } from '../../../client/src/lib/finance/money.js';
import { finLeanRowsAsked } from '../../../client/src/lib/finance/cash.js';
import { finOpenItems, finPartyFigures, finRedoAllocations } from '../finance-allocations.js';
import {
  finEnterCash, finRecordCount, finClearCount, finCashCounts, finCashAccounts, finCashBook, finCashUnadjusted, finAllocationPreview, finPartyReport, finCashSwitch,
} from '../finance-cash.js';
import { finCreateOpeningCorrection, finOpeningCorrections } from '../finance-corrections.js';
import { finEnsureStaffLedgers, finHrSetupOf, finSaveHrSetup } from '../finance-hr-setup.js';
import {
  FIN_HR_EXCEPTION_BOOK_SQL, finBringInFromHr, finHrExceptionsOf, finHrRetryException, finHrStatus,
} from '../finance-hr-catchup.js';

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
//   • is_cash: the group is, or descends from, Cash-in-Hand (finGroupKinds' account_kind 'cash', Cash & Bank spec §5.4): a ledger
//     there may have a holder, so the ledger form offers a holder's name and float under such a group, and under no other.
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
      is_cash: kinds.get(g.id)?.account_kind === 'cash',
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
//   • party_side (Cash & Bank spec §5.1, §5.2, §6.1): 'customer' or 'vendor' for a party ledger, by its party group or else its ERP
//     link, and null for any other: finPartySide's answer, the one the Cash & Bank entries and the allocation engine ask. The entry
//     form lists the customers first on Receive and the vendors first on Pay, and offers TDS on that side only.
//   • notes: the edit form needs it.
//   • holder_name and float_paise (Cash & Bank spec §5.4): a cash holder's name and float in whole paise, else null.
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
              l.manual_entry, l.is_system, l.active, l.holder_name, l.float_amount
         FROM fin_ledgers l
         JOIN fin_groups g ON g.id = l.group_id AND g.book_id = l.book_id
         LEFT JOIN customers c ON l.party_type = 'customer' AND c.id = l.party_id
         LEFT JOIN vendors v ON l.party_type = 'vendor' AND v.id = l.party_id
        WHERE l.book_id = $1 AND ($2::boolean OR l.active)
        ORDER BY lower(l.name), l.id`,
      [bookId, withInactive]);
    const kinds = await finGroupKinds(q, bookId);
    res.json({ ledgers: ledgers.map(({ float_amount, ...l }) => ({
      ...l, float_paise: float_amount == null ? null : finToPaise(float_amount), is_bank_cash: kinds.get(l.group_id)?.is_bank_cash === true, is_party: finIsPartyLedger(l, kinds),
      party_side: finPartySide(l, kinds),
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
  line: 'SELECT book_id FROM fin_voucher_lines WHERE id = $1',
  count: 'SELECT book_id FROM fin_cash_counts WHERE id = $1',
  exception: `SELECT ${FIN_HR_EXCEPTION_BOOK_SQL} AS book_id FROM fin_hr_exceptions e WHERE e.id = $1`,   // one with no book is CI's
};
async function finRequireRow(req, cap, what) {
  const id = finIdOf(req.params.id);
  if (id == null) throw finError(404, 'FIN_NOT_FOUND');
  const row = await one(FIN_BOOK_OF_ROW[what], [id]);
  const grant = await finRequire(req, cap, row?.book_id);
  return { id, grant };
}

// The ledger a request names in its query or its body (?ledger=, ledger_id), and the book it lives in, for finRequire to judge
// next. Read before any transaction, as finRequireRow reads. A ledger that is not there comes back with no book, which finRequire
// refuses with the same 403 as a book the caller holds nothing on; an id that cannot be a ledger's is a 400 naming the field.
async function finLedgerBookOf(value, field, what) {
  const id = finIdOf(value);
  if (id == null) throw finError(400, 'FIN_BAD_INPUT', `Say which ${what} this is for.`, { field });
  const row = await one(FIN_BOOK_OF_ROW.ledger, [id]);
  return { id, bookId: row?.book_id };
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

// ── Opening corrections (Cash & Bank spec §9.4) ──────────────────────────────────────────────
// A wrong figure in the Opening, put right by a journal dated the Opening's own date (finance-corrections.js). Reading is anyone's
// who reads the book; entering one is an accountant's or an Approver's (enter).

// ?book=: the book's corrections, and "Opening + corrections" for each ledger a posted one touched.
r.get('/finance/opening-corrections', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query, 'list');
    await finRequire(req, 'view', bookId);
    res.json(await finOpeningCorrections(bookId));
  } catch (e) { next(finMapDbError(e)); }
});

// Enter one (body: { book_id, lines, narration, client_key }), submitted at once: an accountant's waits for an Approver, an
// Approver's posts self-approved, and posting mints its number, so it is in client/src/lib/writeOnce.js MINTING_POSTS. The same
// save key from the same login answers with the correction the first save made. The answer is { voucher }.
r.post('/finance/opening-corrections', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    const grant = await finRequire(req, 'enter', bookId);
    res.json(await tx((qc, oc) => finCreateOpeningCorrection(qc, oc, body, { ...finActorOf(req), roles: grant.roles })));
  } catch (e) { next(finMapDbError(e)); }
});

// ── HR & payroll setup (Cash & Bank spec §7.2, §7.3, §7.8, §7.9) ─────────────────────────────
// How HR's staff money reaches the books (finance-hr-setup.js): the account each HR pay channel pays from, the ledger of each role,
// where the payroll expense goes, and when the payroll month is booked. Reading is anyone's who reads the book; changing it is the
// Admin's (admin). The channel map is one for both books: each answer lists the channels that pay from a book the caller may read,
// and a channel is pointed at, or moved away from, another book's ledger only by an admin of that book too; one sent back as it stands
// is left as it is, so a form may save its whole state.

// ?book=: the book's setup, { channels, cash_default, roles, expense_map, payroll_booking }, and what its form chooses from (ruling
// R55): hr_channels, HR's pay channels ({ code, name, kind }), and expense_keys, the keys the expense map can take ({ key, label }, from
// HR's people's types and departments). Neither says anything of a person: no name, code, count or amount. Those two are HR's rows,
// which change with no announcement to Finance's screens and which the response cache cannot see, so no copy of this answer is kept
// (markUncacheable, as the HR header line's).
r.get('/finance/hr-setup', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query, 'setup');
    await finRequire(req, 'view', bookId);
    const setup = await finHrSetupOf(bookId, { seeBookIds: await finBookIdsFor(req) });
    markUncacheable();
    res.json(setup);
  } catch (e) { next(finMapDbError(e)); }
});

// The Admin saves any of it (body: { book_id, channels: [{ channel_code, ledger_id }], roles: { [role]: ledger_id }, expense_map:
// [{ hr_key, ledger_id }], payroll_booking }; a part left out is left as it is, and null takes one away). The answer is the setup as
// it now stands.
r.put('/finance/hr-setup', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'admin', bookId);
    const adminBookIds = await finBookIdsFor(req, 'admin');
    const seeBookIds = await finBookIdsFor(req);
    await tx((qc, oc) => finSaveHrSetup(qc, oc, body, { ...finActorOf(req), adminBookIds, seeBookIds }));
    res.json(await finHrSetupOf(bookId, { seeBookIds }));
  } catch (e) { next(finMapDbError(e)); }
});

// The Admin makes the staff ledgers the book lacks and sets their roles (body: { book_id }). The answer is { created, found, system_only }:
// the names of the ledgers made, of those found by their name and given their role, and of those now kept for the system's entries
// (finEnsureStaffLedgers), with the setup as it now stands.
r.post('/finance/hr-setup/ledgers', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'admin', bookId);
    const seeBookIds = await finBookIdsFor(req);
    const made = await tx((qc, oc) => finEnsureStaffLedgers(qc, oc, bookId, finActorOf(req)));
    res.json({ ...made, ...(await finHrSetupOf(bookId, { seeBookIds })) });
  } catch (e) { next(finMapDbError(e)); }
});

// ── HR's entries in the books (Cash & Bank spec §5, §7.5, §7.7) ──────────────────────────────
// What of HR's staff money is not in the books yet, what could not be posted, and the check of the staff ledgers against HR
// (finance-hr-catchup.js). Reading is anyone's who reads the book; bringing entries in, or trying an exception again, is an
// accountant's or an Approver's (enter). Each post goes through the HR feed in the caller's name, outside any transaction of the route
// (each event is a transaction of its own), and writes the event's voucher in the other book too where it has one there (§7.3).

// ?book=: the header line, { waiting, exceptions, control }, counts and totals only, the control check as at the plant's today. HR's
// rows change with no announcement to Finance's screens, so no copy of this answer is kept (markUncacheable).
r.get('/finance/hr/status', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query, 'status');
    await finRequire(req, 'view', bookId);
    markUncacheable();
    res.json(await finHrStatus(bookId));
  } catch (e) { next(finMapDbError(e)); }
});

// "Bring in from HR" (body: { book_id }): posts what waits, repairs what the call after HR's commit missed, and the hidden months due.
// It mints Finance's voucher numbers, so it is in client/src/lib/writeOnce.js MINTING_POSTS; a second copy finds it all standing and
// posts nothing (H8). The answer is { posted, submitted, skipped, exceptions: [codes] }.
r.post('/finance/hr/bring-in', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'enter', bookId);
    res.json(await finBringInFromHr(bookId, finActorOf(req)));
  } catch (e) { next(finMapDbError(e)); }
});

// ?book=: the book's open exceptions, newest first, { exceptions }: each its event, reason and fix, never a person.
r.get('/finance/hr/exceptions', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query, 'list');
    await finRequire(req, 'view', bookId);
    res.json(await finHrExceptionsOf(bookId));
  } catch (e) { next(finMapDbError(e)); }
});

// Try an exception's event again (no body). The book is the exception's own, CI's for one with none. It can post, and posting mints,
// so it is in MINTING_POSTS. The answer is { exception }, as it now stands: resolved with its voucher, or its reason now.
r.post('/finance/hr/exceptions/:id/retry', async (req, res, next) => {
  try {
    const { id } = await finRequireRow(req, 'enter', 'exception');
    res.json(await finHrRetryException(id, finActorOf(req)));
  } catch (e) { next(finMapDbError(e)); }
});

// ── Cash & Bank (Cash & Bank spec §5, §6) ────────────────────────────────────────────────────
// The accountant's screen for cash and bank (finance-cash.js) and the bill-wise adjustment behind its receipts and payments
// (finance-allocations.js). Reading is anyone's who reads the book; an entry and a redo are an accountant's or an Approver's
// (enter). The book is the one the route names, or the book of the ledger or line it names, never one the body merely claims.

// The day the ERP's own receipt and payment doors hand over to Finance (spec §11): { date }. Any login may ask, with a Finance grant
// or none, because the ERP's Invoices and Accounts pages ask it for every login, and it says nothing about any book's figures.
r.get('/finance/cash/switch', async (req, res, next) => {
  try {
    res.json(await finCashSwitch());
  } catch (e) { next(finMapDbError(e)); }
});

// The tiles: every active bank and cash account of ?book with its balance as at today, and the party money on account.
r.get('/finance/cash/accounts', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query, 'list');
    await finRequire(req, 'view', bookId);
    res.json(await finCashAccounts(bookId));
  } catch (e) { next(finMapDbError(e)); }
});

// One account's book, ?ledger=, from ?from to ?to (the current month when neither is given). The book is the ledger's own. With
// ?rows=lean (ruling R65), as the Cash & Bank page asks, its entries and pending lines come as their column names once and one array
// per line, which the page puts back as the objects before it keeps the answer; asked for nothing, the objects.
r.get('/finance/cash/book', async (req, res, next) => {
  try {
    const { id, bookId } = await finLedgerBookOf(req.query.ledger, 'ledger', 'account');
    await finRequire(req, 'view', bookId);
    res.json(await finCashBook(id, { from: req.query.from, to: req.query.to, lean: finLeanRowsAsked(req.query) }));
  } catch (e) { next(finMapDbError(e)); }
});

// Receive, Pay or Transfer (body: { book_id, entry_type, voucher_date, account_ledger_id, other_ledger_id, amount_paise, tds_paise,
// reference, narration, adjust, client_key }). It is submitted at once and may post, and posting mints the voucher's number, so it
// is in client/src/lib/writeOnce.js MINTING_POSTS. A retry with the same client_key answers with the voucher the first one made, as
// that entry, never as the body sent again: replayed, and replay_differs when the body asked for another entry (ruling R11).
r.post('/finance/cash/entries', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    const grant = await finRequire(req, 'enter', bookId);
    res.json(await tx((qc, oc) => finEnterCash(qc, oc, body, { ...finActorOf(req), roles: grant.roles })));
  } catch (e) { next(finMapDbError(e)); }
});

// Count a cash account (body: { book_id, ledger_id, count_date, counted_paise, note }): the book balance beside the counted amount.
// It posts nothing and mints nothing.
r.post('/finance/cash/counts', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const bookId = finBodyBook(body);
    await finRequire(req, 'enter', bookId);
    res.json(await tx((qc, oc) => finRecordCount(qc, oc, body, finActorOf(req))));
  } catch (e) { next(finMapDbError(e)); }
});

// An account's counts, ?ledger=, newest first. The book is the ledger's own.
r.get('/finance/cash/counts', async (req, res, next) => {
  try {
    const { id, bookId } = await finLedgerBookOf(req.query.ledger, 'ledger', 'account');
    await finRequire(req, 'view', bookId);
    res.json(await finCashCounts(id));
  } catch (e) { next(finMapDbError(e)); }
});

// Clear a count's difference: a receipt (excess) or payment (shortage) against Cash Short & Excess, submitted at once. It always
// waits for an Approver unless an Approver makes it, and posting mints its number, so it is in MINTING_POSTS. The book is the count's own.
r.post('/finance/cash/counts/:id/clear', async (req, res, next) => {
  try {
    const { id, grant } = await finRequireRow(req, 'enter', 'count');
    res.json(await tx((qc, oc) => finClearCount(qc, oc, id, { ...finActorOf(req), roles: grant.roles })));
  } catch (e) { next(finMapDbError(e)); }
});

// The party money still on account in ?book, item by item (spec §6.3): each waits for its own Adjust.
r.get('/finance/cash/unadjusted', async (req, res, next) => {
  try {
    const bookId = finQueryBook(req.query, 'list');
    await finRequire(req, 'view', bookId);
    res.json(await finCashUnadjusted(bookId));
  } catch (e) { next(finMapDbError(e)); }
});

// A party's open items, each side, with its balance (finOpenItems), and its standing worked out from those very items (finPartyFigures):
// outstanding_paise, what is still owed on its bills, and on_account_paise, the money it already holds on account, which the Cash & Bank
// form shows beside its Auto / I'll pick choice (spec §6.7, ruling R58). A ledger that is no party's is 409 FIN_NOT_PARTY_LINE.
r.get('/finance/ledgers/:id/open-items', async (req, res, next) => {
  try {
    const { id } = await finRequireRow(req, 'view', 'ledger');
    const open = await finOpenItems(q, id);
    const { outstanding_paise, on_account_paise } = finPartyFigures(open);
    res.json({ ...open, outstanding_paise, on_account_paise });
  } catch (e) { next(finMapDbError(e)); }
});

// What an adjustment would settle now, before an entry is saved (body: { ledger_id, side, amount_paise, mode, picks, reference }):
// { allocations, on_account_paise, items }. Asked with the entry's day and account too ({ voucher_date, account_ledger_id, client_key }),
// it also answers party_cash_day_paise, the party's cash that day for the s.269ST / s.40A(3) warnings (ruling R59; null for a bank).
// Or what a redo of one of the party's posted lines would settle (body: { ledger_id, line_id,
// mode, picks, reference, scope }; the Cash & Bank screen's Redo and Adjust): the same, worked out as the redo would, once the line's
// own allocations are released (a Redo, scope 'line', the default), or with them kept, spending only what the line still holds on
// account (an Adjust, scope 'open': ruling R71), with the line's `side`, `amount_paise` and `scope`. It writes nothing, so it asks only the right to view the
// party's book, which is the ledger's own. A POST because a Pick's ticks are a list.
r.post('/finance/allocations/preview', async (req, res, next) => {
  try {
    const body = finBodyOf(req);
    const { id, bookId } = await finLedgerBookOf(body.ledger_id, 'ledger_id', 'party');
    await finRequire(req, 'view', bookId);
    res.json(await finAllocationPreview(id, body));
  } catch (e) { next(finMapDbError(e)); }
});

// Redo the adjustment of a posted party line (body: { mode, picks, scope }), in a month of any status: it changes no balance (spec
// §6.5). scope 'line' (the default) works the whole line again, its allocations released first (the book's Redo); 'open' settles only
// what the line still holds on account and keeps what it settles (an Adjust, from the Unadjusted money list: ruling R71). The book is
// the line's own. It mints nothing and is never joined.
r.put('/finance/lines/:id/allocations', async (req, res, next) => {
  try {
    const { id } = await finRequireRow(req, 'enter', 'line');
    const body = finBodyOf(req);
    res.json(await tx((qc, oc) => finRedoAllocations(qc, oc, id, body, finActorOf(req))));
  } catch (e) { next(finMapDbError(e)); }
});

// A party's statement (spec §6.7), ?ledger=: its open items with their age, its money on account, and the invariant beside its
// balance. The book is the ledger's own.
r.get('/finance/reports/party', async (req, res, next) => {
  try {
    const { id, bookId } = await finLedgerBookOf(req.query.ledger, 'ledger', 'party');
    await finRequire(req, 'view', bookId);
    res.json(await finPartyReport(id));
  } catch (e) { next(finMapDbError(e)); }
});

export default r;
