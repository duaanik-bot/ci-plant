// Finance — the reports (spec §9.2): the trial balance, a ledger's statement, the journal register, the list of
// self-approved vouchers, and the activity log (its summaries, and one row opened with its record). All of them only read.
//
// Every function goes through the pool (q / one) and opens no transaction, takes no lock and writes nothing. The
// route has already asked finRequire who may read, for the book the report is about (a ledger statement: the
// ledger's own book), BEFORE it calls in here, and finActivity is handed only the books the login may read.
//
// What every report keeps to:
//   • Only a voucher whose status is 'posted' counts. A reversed original is still posted, and so is its reversal,
//     so the pair nets to zero in every figure; a draft, a voucher waiting for approval and a discarded one count
//     for nothing.
//   • A balance is SIGNED: debit less credit, so positive is Dr and negative is Cr.
//   • "As at a date" is every posted line dated on or before it, with NO lower bound. That includes the Opening
//     voucher, dated the day before the books begin. With a `from`, what is dated before it is the OPENING and what
//     is dated from `from` to `to`, both days included, is the period's movement; with no `from` the opening is
//     nothing and every line up to `to` is movement.
//   • Sums are done in SQL, on NUMERIC: the ledger sums, the roll-up through the group tree, the totals and a
//     statement's running balance. JS only turns each figure it is handed into whole paise with finToPaise (exact
//     for any |v| < 9×10¹³) and adds nothing up.
//   • One statement makes one answer. The trial balance and the statement each build their whole answer in a single
//     SELECT, so the groups, the ledgers and the totals in one response come from one snapshot: a voucher posting
//     while the report runs can never leave a group's figure at odds with its ledgers'.
//
// The dates a report is asked for are the voucher dates ('YYYY-MM-DD' text, which sorts as dates do). The activity
// log is the exception: its rows are stamped with an instant, and its days are the plant's (IST), as the timeline's are.
//
// Each statement is a plain read that names the fin_* tables it reads, which is how the response cache (data-tables.js)
// knows what makes a copy stale and lets a browser keep one. It takes a statement for a write, and stops caching the
// answer, if the statement contains a word like insert, update, delete, into, share or lock; so none does, and
// finance-pg-reports.test.js checks each report's response for the cache header.

import { q, one } from './db.js';
import { finError } from './finance-errors.js';
import { finOptionalText } from './finance-masters.js';
import { FIN_VOUCHER_TYPES } from './finance-rules.js';
import { finIsValidDate } from '../../client/src/lib/finance/fy.js';
import { finToPaise } from '../../client/src/lib/finance/money.js';
import { finActivityTarget } from '../../client/src/lib/finance/setup.js';

const FIN_ACTIVITY_MAX = 500;       // rows the activity log sends in one answer: the newest
const FIN_AGAINST_MAX = 3;          // other ledgers a statement line names before it says there are more
const FIN_USER_MAX = 100;
const FIN_ENTITY_MAX = 40;

// ── What was asked ───────────────────────────────────────────────────────────────────────────

// An optional day: absent, null or empty is no day, otherwise a real date written YYYY-MM-DD.
function finReportDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !finIsValidDate(value)) {
    throw finError(400, 'FIN_BAD_DATE', `${field} isn't a valid date. Write it as YYYY-MM-DD.`, { field });
  }
  return value;
}

// The days a report runs between, both included. A report "as at" a date needs its `to`. A range that ends before
// it starts is refused: a trial balance would read its opening past its own end.
function finRange(from, to, { needTo = false } = {}) {
  const range = { from: finReportDate(from, 'from'), to: finReportDate(to, 'to') };
  if (needTo && range.to === null) throw finError(400, 'FIN_BAD_INPUT', 'Say which date the report runs to.', { field: 'to' });
  if (range.from !== null && range.to !== null && range.from > range.to) {
    throw finError(400, 'FIN_BAD_INPUT', 'The start date comes after the end date.', { field: 'from' });
  }
  return range;
}

// An optional voucher type. Own properties only: 'constructor' is not a type.
function finReportType(type) {
  if (type === undefined || type === null || type === '') return null;
  if (typeof type !== 'string' || !Object.hasOwn(FIN_VOUCHER_TYPES, type)) {
    throw finError(400, 'FIN_BAD_INPUT', `type must be one of: ${Object.keys(FIN_VOUCHER_TYPES).join(', ')}.`, { field: 'type' });
  }
  return type;
}

// A figure in the four columns a report shows, from the SQL's NUMERIC to whole paise.
const finAmounts = r => ({
  opening_paise: finToPaise(r.opening), debit_paise: finToPaise(r.debit), credit_paise: finToPaise(r.credit), closing_paise: finToPaise(r.closing),
});

// ── Trial balance ────────────────────────────────────────────────────────────────────────────

// $1 book, $2 from (or NULL), $3 to, $4 whether to list ledgers with no figures.
//   fig        each ledger of the book: its opening (posted lines dated before $2), and the debits and credits of the
//              lines from $2 to $3. A ledger with no lines is there too, with nothing.
//   bal        fig with the closing: opening + debits - credits.
//   under_group  every group paired with each group at or below it. UNION, not UNION ALL: the walk ends even on a loop.
// The groups answer sums each group's ledgers and those of every sub-group below it; the totals split the signed
// balances into the Dr side (positive) and the Cr side (negative, shown positive).
const FIN_TB_SQL = `
WITH RECURSIVE
fig AS (
  SELECT l.id, l.group_id, l.name,
         COALESCE(SUM(p.debit - p.credit) FILTER (WHERE p.voucher_date < $2::text), 0) AS opening,
         COALESCE(SUM(p.debit) FILTER (WHERE $2::text IS NULL OR p.voucher_date >= $2::text), 0) AS debit,
         COALESCE(SUM(p.credit) FILTER (WHERE $2::text IS NULL OR p.voucher_date >= $2::text), 0) AS credit
    FROM fin_ledgers l
    LEFT JOIN (SELECT ln.ledger_id, ln.debit, ln.credit, v.voucher_date
                 FROM fin_voucher_lines ln
                 JOIN fin_vouchers v ON v.id = ln.voucher_id
                WHERE v.book_id = $1 AND v.status = 'posted' AND v.voucher_date <= $3::text) p ON p.ledger_id = l.id
   WHERE l.book_id = $1
   GROUP BY l.id
),
bal AS (
  SELECT id, group_id, name, opening, debit, credit, opening + debit - credit AS closing FROM fig
),
under_group (top_id, id) AS (
  SELECT id, id FROM fin_groups WHERE book_id = $1
  UNION
  SELECT u.top_id, g.id FROM under_group u JOIN fin_groups g ON g.parent_id = u.id AND g.book_id = $1
)
SELECT
  (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM (
     SELECT g.id, g.parent_id, g.name, g.nature, g.sort_order,
            COALESCE(SUM(b.opening), 0) AS opening, COALESCE(SUM(b.debit), 0) AS debit,
            COALESCE(SUM(b.credit), 0) AS credit, COALESCE(SUM(b.closing), 0) AS closing
       FROM fin_groups g
       LEFT JOIN under_group u ON u.top_id = g.id
       LEFT JOIN bal b ON b.group_id = u.id
      WHERE g.book_id = $1
      GROUP BY g.id) x) AS groups,
  (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY lower(x.name), x.id), '[]'::jsonb) FROM (
     SELECT id, group_id, name, opening, debit, credit, closing FROM bal
      WHERE $4::boolean OR opening <> 0 OR debit <> 0 OR credit <> 0) x) AS ledgers,
  (SELECT to_jsonb(t) FROM (
     SELECT COALESCE(SUM(GREATEST(opening, 0)), 0) AS opening_dr, COALESCE(SUM(GREATEST(-opening, 0)), 0) AS opening_cr,
            COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit,
            COALESCE(SUM(GREATEST(closing, 0)), 0) AS closing_dr, COALESCE(SUM(GREATEST(-closing, 0)), 0) AS closing_cr
       FROM bal) t) AS totals`;

// The groups in tree order, each with its depth: a group, then its sub-groups (by sort_order, then id), then the next
// group beside it. For the template this is sort_order itself; a sub-group someone adds later takes the book's last
// sort_order, and this still sets it under its parent, where the screen wants it. Every group comes out exactly once.
// A group whose parent is not one of the book's groups is a top group. A loop would leave its groups unreachable
// from the top (the app never makes one), so whatever is left over is listed last, at the top, and not lost.
function finGroupTree(groups) {
  const known = new Set(groups.map(g => g.id));
  const below = new Map();                         // parent id, or null for the top -> its sub-groups in order
  for (const g of groups) {
    const parent = known.has(g.parent_id) ? g.parent_id : null;
    if (!below.has(parent)) below.set(parent, []);
    below.get(parent).push(g);
  }
  const inOrder = (a, b) => a.sort_order - b.sort_order || a.id - b.id;
  for (const list of below.values()) list.sort(inOrder);

  const out = [];
  const listed = new Set();
  const walk = (list, depth) => {
    for (const g of list) {
      if (listed.has(g.id)) continue;
      listed.add(g.id);
      out.push({ ...g, depth });
      walk(below.get(g.id) ?? [], depth + 1);
    }
  };
  walk(below.get(null) ?? [], 0);
  walk(groups.filter(g => !listed.has(g.id)).sort(inOrder), 0);
  return out;
}

// The trial balance of a book as at `to`, or for the range `from` to `to` with everything before `from` as the opening.
// A ledger with no figures at all (opening, debit, credit all nothing) is left out unless `all`. Every group is listed.
export async function finTrialBalance(bookId, { from = null, to, all = false } = {}) {
  const range = finRange(from, to, { needTo: true });
  const row = await one(FIN_TB_SQL, [bookId, range.from, range.to, all === true]);
  const t = row.totals;
  return {
    book_id: bookId,
    from: range.from,
    to: range.to,
    groups: finGroupTree(row.groups).map(g => ({
      id: g.id, parent_id: g.parent_id, name: g.name, nature: g.nature, depth: g.depth, sort_order: g.sort_order, ...finAmounts(g),
    })),
    ledgers: row.ledgers.map(l => ({ id: l.id, group_id: l.group_id, name: l.name, ...finAmounts(l) })),
    totals: {
      opening_dr: finToPaise(t.opening_dr), opening_cr: finToPaise(t.opening_cr),
      debit: finToPaise(t.debit), credit: finToPaise(t.credit),
      closing_dr: finToPaise(t.closing_dr), closing_cr: finToPaise(t.closing_cr),
    },
  };
}

// ── Ledger statement ─────────────────────────────────────────────────────────────────────────

// $1 ledger, $2 from (or NULL), $3 to.
//   posted   every posted line of the ledger dated up to $3, each with the balance after it: a running sum over ALL of
//            them in voucher date, posting, voucher and line order, so the balance of the first line shown already
//            carries the opening.
//   shown    the lines from $2 on: the entries.
// `others` is each entry's voucher's other ledgers, each once, in the order their lines come.
const FIN_STATEMENT_SQL = `
WITH me AS (
  SELECT l.id, l.name, l.book_id, g.name AS group_name
    FROM fin_ledgers l
    JOIN fin_groups g ON g.id = l.group_id AND g.book_id = l.book_id
   WHERE l.id = $1
),
posted AS (
  SELECT ln.voucher_id, ln.line_no, ln.debit, ln.credit,
         v.number, v.voucher_date, v.voucher_type, v.narration, v.posted_at,
         SUM(ln.debit - ln.credit) OVER (ORDER BY v.voucher_date, v.posted_at, v.id, ln.line_no ROWS UNBOUNDED PRECEDING) AS balance
    FROM fin_voucher_lines ln
    JOIN fin_vouchers v ON v.id = ln.voucher_id
   WHERE ln.ledger_id = $1 AND v.status = 'posted' AND v.voucher_date <= $3::text
),
shown AS (
  SELECT * FROM posted WHERE $2::text IS NULL OR voucher_date >= $2::text
)
SELECT
  (SELECT to_jsonb(me) FROM me) AS ledger,
  (SELECT COALESCE(SUM(debit - credit), 0) FROM posted WHERE voucher_date < $2::text) AS opening,
  (SELECT COALESCE(SUM(debit), 0) FROM shown) AS total_debit,
  (SELECT COALESCE(SUM(credit), 0) FROM shown) AS total_credit,
  (SELECT COALESCE(SUM(debit - credit), 0) FROM posted) AS closing,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'voucher_id', s.voucher_id, 'number', s.number, 'voucher_date', s.voucher_date, 'voucher_type', s.voucher_type,
            'narration', s.narration, 'debit', s.debit, 'credit', s.credit, 'balance', s.balance,
            'others', (SELECT COALESCE(jsonb_agg(o.name ORDER BY o.first_line), '[]'::jsonb)
                         FROM (SELECT fl.name, MIN(x.line_no) AS first_line
                                 FROM fin_voucher_lines x
                                 JOIN fin_ledgers fl ON fl.id = x.ledger_id
                                WHERE x.voucher_id = s.voucher_id AND x.ledger_id <> $1
                                GROUP BY fl.id, fl.name) o))
          ORDER BY s.voucher_date, s.posted_at, s.voucher_id, s.line_no), '[]'::jsonb)
     FROM shown s) AS entries`;

// The other side of an entry: at most three names, comma-joined, then an ellipsis when there are more.
const finAgainst = names => names.slice(0, FIN_AGAINST_MAX).join(', ') + (names.length > FIN_AGAINST_MAX ? '…' : '');

// A ledger's statement from `from` to `to`: the opening, each posted line with its running balance, and the closing,
// which is the trial balance's closing for the ledger as at `to`. Debit positive, credit negative, as everywhere.
export async function finLedgerStatement(ledgerId, { from = null, to } = {}) {
  const range = finRange(from, to, { needTo: true });
  const row = await one(FIN_STATEMENT_SQL, [ledgerId, range.from, range.to]);
  if (!row.ledger) throw finError(404, 'FIN_NOT_FOUND');
  return {
    ledger: { id: row.ledger.id, name: row.ledger.name, book_id: row.ledger.book_id, group_name: row.ledger.group_name },
    opening_paise: finToPaise(row.opening),
    entries: row.entries.map(e => ({
      voucher_id: e.voucher_id, number: e.number, voucher_date: e.voucher_date, voucher_type: e.voucher_type, narration: e.narration,
      against: finAgainst(e.others), debit_paise: finToPaise(e.debit), credit_paise: finToPaise(e.credit), balance_paise: finToPaise(e.balance),
    })),
    total_debit_paise: finToPaise(row.total_debit),
    total_credit_paise: finToPaise(row.total_credit),
    closing_paise: finToPaise(row.closing),
  };
}

// ── Journal register and self-approved ───────────────────────────────────────────────────────

// $1 book, $2 from, $3 to: the posted vouchers of the book dated in the range, either end left open when it is NULL.
const FIN_IN_RANGE = `v.book_id = $1 AND v.status = 'posted'
  AND ($2::text IS NULL OR v.voucher_date >= $2::text) AND ($3::text IS NULL OR v.voucher_date <= $3::text)`;

// Voucher date, then the order they were posted in, then the id. The total is the voucher's own (the sum of its debits,
// which the database re-checks when it posts and a posted voucher can never change).
const FIN_REGISTER_SQL = `
SELECT v.id, v.number, v.voucher_date, v.voucher_type, v.narration, v.total,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object('ledger_name', fl.name, 'debit', ln.debit, 'credit', ln.credit) ORDER BY ln.line_no), '[]'::jsonb)
          FROM fin_voucher_lines ln
          JOIN fin_ledgers fl ON fl.id = ln.ledger_id
         WHERE ln.voucher_id = v.id) AS lines
  FROM fin_vouchers v
 WHERE ${FIN_IN_RANGE} AND ($4::text IS NULL OR v.voucher_type = $4::text)
 ORDER BY v.voucher_date, v.posted_at, v.id`;

const FIN_SELF_APPROVED_SQL = `
SELECT v.id, v.number, v.voucher_date, v.voucher_type, v.narration, v.total
  FROM fin_vouchers v
 WHERE ${FIN_IN_RANGE} AND v.self_approved
 ORDER BY v.voucher_date, v.posted_at, v.id`;

const finVoucherHead = v => ({
  id: v.id, number: v.number, voucher_date: v.voucher_date, voucher_type: v.voucher_type, narration: v.narration, total_paise: finToPaise(v.total),
});

// The posted vouchers of a book in a range, each with its lines, oldest first; `type` narrows it to one voucher type.
export async function finJournalRegister(bookId, { from = null, to = null, type = null } = {}) {
  const range = finRange(from, to);
  const rows = await q(FIN_REGISTER_SQL, [bookId, range.from, range.to, finReportType(type)]);
  return {
    vouchers: rows.map(v => ({
      ...finVoucherHead(v),
      lines: v.lines.map(l => ({ ledger_name: l.ledger_name, debit_paise: finToPaise(l.debit), credit_paise: finToPaise(l.credit) })),
    })),
  };
}

// The posted vouchers an Approver passed on their own authority (spec §7.1: `self_approved`), as the register lists them
// but without the lines. A voucher that was later reversed is still on it.
export async function finSelfApproved(bookId, { from = null, to = null } = {}) {
  const range = finRange(from, to);
  const rows = await q(FIN_SELF_APPROVED_SQL, [bookId, range.from, range.to]);
  return { vouchers: rows.map(finVoucherHead) };
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────

// What a log row is about, in a word or two (finActivityTarget, the client's ONE definition: a ledger's or group's name, a
// month's label, a voucher's number, whose access it was), read from the few fields of the record it needs. They are picked
// out in SQL, so the record itself, which for a voucher holds every line, never leaves the database for the list (ruling R71).
const FIN_ACTIVITY_ABOUT = `jsonb_build_object(
  'name', COALESCE(a.after, a.before) -> 'name', 'label', COALESCE(a.after, a.before) -> 'label',
  'number', COALESCE(a.after, a.before) -> 'number', 'status', COALESCE(a.after, a.before) -> 'status',
  'rule_key', COALESCE(a.after, a.before) -> 'rule_key', 'user_name', COALESCE(a.after, a.before) -> 'user_name') AS about`;
const finActivitySummary = ({ about, ...row }) => ({ ...row, label: finActivityTarget({ ...row, after: about }) });

// The audit log, newest first, at most FIN_ACTIVITY_MAX rows, and only rows of the books in `bookIds`: the books the
// login may read, which the route works out (finBookIdsFor). `book` narrows it to one of them; a book that is not one
// of them gives nothing, never somebody else's rows.
//   from / to   the plant's days (IST), both included: the instant's range, so the (book_id, at) index is used.
//   user        part of the name of whoever did it, whatever the capitals; % and _ are only themselves.
//   entity      voucher, ledger, group, period, rule, access, import, book, year ... exactly.
// Each row is a summary (ruling R71): id, at, book_id, user_name, entity, entity_id, action, reason and `label`, what it is
// about. The record before and after is one row's, opened (finActivityRow): a voucher's holds every line, and a list of
// them ran to megabytes with a real Opening voucher, past what the ERP's host sends in one answer.
export async function finActivity(bookIds, { book = null, from = null, to = null, user = null, entity = null } = {}) {
  const range = finRange(from, to);
  const who = finOptionalText(user, 'user', FIN_USER_MAX);
  const what = finOptionalText(entity, 'entity', FIN_ENTITY_MAX);
  const ids = book == null ? bookIds : bookIds.filter(id => id === book);
  if (!ids.length) return { rows: [] };

  const args = [ids];
  const arg = value => { args.push(value); return `$${args.length}`; };
  const where = ['a.book_id = ANY($1::int[])'];
  if (range.from) where.push(`a.at >= (${arg(range.from)}::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (range.to) where.push(`a.at < ((${arg(range.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (what) where.push(`a.entity = ${arg(what)}::text`);
  if (who) where.push(`a.user_name ILIKE ${arg(`%${who.replace(/[!%_]/g, '!$&')}%`)} ESCAPE '!'`);
  const rows = await q(
    `SELECT a.id, a.at, a.book_id, a.user_name, a.entity, a.entity_id, a.action, a.reason, ${FIN_ACTIVITY_ABOUT}
       FROM fin_audit_log a
      WHERE ${where.join(' AND ')}
      ORDER BY a.at DESC, a.id DESC
      LIMIT ${arg(FIN_ACTIVITY_MAX)}`, args);
  return { rows: rows.map(finActivitySummary) };
}

// One row of the log, opened: the summary the list sends, with the record before and after. The route has already asked
// whether the caller may see the row's book (finSeenBookOf: 404 when not), so a row that is not there here is the same 404.
export async function finActivityRow(id) {
  const row = await one(
    `SELECT a.id, a.at, a.book_id, a.user_name, a.entity, a.entity_id, a.action, a.reason, ${FIN_ACTIVITY_ABOUT}, a.before, a.after
       FROM fin_audit_log a
      WHERE a.id = $1`, [id]);
  if (!row) throw finError(404, 'FIN_NOT_FOUND');
  const { before, after, ...rest } = row;
  return { row: { ...finActivitySummary(rest), before, after } };
}
