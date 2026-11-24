// Finance — HR's staff money in the books, part 2: the payroll month, and hidden people's money (Cash & Bank spec §7.2, §7.4, §7.8,
// §7.9; rulings R21, R24, R27). What this reads, finance-hr-feed.js posts, as it posts part 1's events:
//   • finHrRunLines          the payroll month's journal for one book, from HR's line fields, as totals
//   • finHrRunFacts          the `run` event, a finalised month: one journal per book, dated by the book's payroll setting (§7.8)
//   • finHrSheetAdvanceFacts the `sheetAdvances` event: the advances written on the month's payroll sheet, paid from cash (§7.2)
//   • finHrHiddenRows        hidden people's money, row by row: payouts, advances, loans, prepayments and waivers (§7.4, ruling R21)
//   • finHrHiddenGroups      those rows as their combined entries: per account and calendar month, and a month's waivers
//   • finHrHiddenFacts       one combined entry's facts (finHrHiddenShape: the same, without its approval)
// and the SQL the two files share: a person's payroll book, whether a person is hidden, which live voucher books an HR row (ruling R27).
//
// A reader answers { skip } when the event books nothing now, or its facts (finance-hr-feed.js says their shape): the people of each
// payroll book and what each book posts by role, as totals, with the HR rows it books and a fingerprint of the HR figures, so that a
// change in HR can be told from a change in Finance's setup. Names, codes and per-person amounts never leave these readers; a
// person's id is read only to count people.
//
// The payroll journal (§7.2) of a book is the run's lines of that book's people, every one of them, hidden people included (ruling
// R21: the books carry total salary, §16), summed:
//   Dr  gross, split by fin_hr_expense_map: 'type:<worker_type>' first, then 'dept:<department>', else the salary_expense role,
//       less the arrears earnings a correction carried into the month (below). Hidden people's gross always goes to the salary_expense
//       role (ruling R75): a type's or a department's line carries visible people only, so a hidden person alone in a department with a
//       ledger of its own never shows there as one person's pay (§7.4)
//   Dr  salary_payable    those carried arrears earnings
//   Cr  staff_advances    Σ advance_recovery, and what a main account's pay covered of a sub-account's advance (ADJ:SUB<id>-ADV)
//   Cr  staff_loans       Σ loan_recovery, and what it covered of a sub-account's loan instalments (ADJ:SUB<id>-LN<loan>)
//   Cr  other_deductions  Σ (misc_deduction + adj_deductions), less those sub-account parts, which are recoveries (finalise posts
//                         them to the sub-account's own advance and loan, hr/runs.js), so Staff Advances and Staff Loans stay equal
//                         to HR's balances (§7.5), and less the carried arrears deductions
//   Cr  md_account        Σ paid_separately (the MD pays it from his own money: §16)
//   Cr  salary_payable    Σ payable, and the carried arrears deductions
// and what HR's rupee rounding of the payable leaves, the difference of the two sides, on the `rounding` role, Dr or Cr.
// Carried arrears (ruling R54): when HR corrects a finalised month whose line was PAID already, it settles the difference in the first
// open month as an approved arrears adjustment (hr/correction.js), which the engine puts in that month's line as the component
// `ADJ:<adjustment id>`; the correction's own audit row (run_line / finalised_correction) names the adjustment it made. The corrected
// month's journal is posted again with its corrected payable (ruling R30), so the difference already sits in Salary Payable: an
// earning settles what HR still owed, and a deduction takes back what it overpaid. Neither is this month's expense, nor another
// deduction: both are booked against Salary Payable.

import { createHash } from 'node:crypto';
import { finError } from './finance-errors.js';
import { finResolvePaidFrom } from './finance-hr-setup.js';
import { plantDateStr } from './plant-calendar.js';
import { levelAtLeast } from './hr/access.js';

// ── Shared with the feed ─────────────────────────────────────────────────────────────────────

// The payroll book of a person, on hr.people aliased p (§7.2): DARBI → DP, anything else (COLOUR, no firm) → CI.
export const FIN_HR_BOOK_SQL = `(CASE WHEN upper(btrim(p.firm)) = 'DARBI' THEN 'DP' ELSE 'CI' END)`;
// A person hidden from any login, whatever the mode (both withhold their amounts: ruling R21).
export const finHrHiddenSql = person => `EXISTS (SELECT 1 FROM hr.access_hidden hh WHERE hh.person_id = ${person})`;
// A voucher that stands for its source (H8): posted or waiting for an Approver, not reversed, not a reversal.
export const finHrLiveSql = v => `${v}.status IN ('submitted', 'posted') AND ${v}.reversed_by_id IS NULL AND ${v}.reversal_of_id IS NULL`;
// The live voucher whose cover list holds the HR row (`key`, `id`: SQL expressions), as its source with no book suffix,
// 'hr_batch#12' or 'hr_hidden:57#202701'; NULL when none does (ruling R27).
export const finHrCoveredSql = (key, id) => `(SELECT regexp_replace(cv.source_type, ':DP$', '') || '#' || cv.source_id
    FROM fin_hr_covers c JOIN fin_vouchers cv ON cv.id = c.voucher_id
   WHERE c.source_type = ${key} AND c.source_id = ${id} AND ${finHrLiveSql('cv')} ORDER BY cv.id LIMIT 1)`;
// …or the live voucher of the row's own source, an event of its own (a line paid on its own, an advance, a loan): the row is booked.
export const finHrBookedSql = (key, id) => `COALESCE(
    (SELECT regexp_replace(bv.source_type, ':DP$', '') || '#' || bv.source_id FROM fin_vouchers bv
      WHERE bv.source_type IN (${key}, ${key} || ':DP') AND bv.source_id = ${id} AND ${finHrLiveSql('bv')} ORDER BY bv.id LIMIT 1),
    ${finHrCoveredSql(key, id)})`;
// An HR approver (approver or admin, a switched-on login), or NULL: the doer's approval (ruling R26), read as HR's own guard reads it.
const finApproverSql = user => `(SELECT au.id FROM public.users au JOIN hr.access aa ON aa.user_id = au.id
   WHERE au.id = ${user} AND au.active = 1 AND aa.level IN ('approver', 'admin'))`;
// A moment's plant day, as plantDateStr says it.
const finPlantDaySql = moment => `((${moment}) AT TIME ZONE 'Asia/Kolkata')::date`;
// The last day of a run's month (an SQL expression of hr.runs.month, 'YYYY-MM'), a date.
export const finHrMonthEndSql = month => `(date_trunc('month', to_date(${month}, 'YYYY-MM')) + interval '1 month - 1 day')::date`;
// The first payment of payroll book `book`'s people in run `run` (SQL expressions), a date, NULL while none is paid: a confirmed batch
// paying any of them (its paid_on, else the plant day of its confirmation), or a line of theirs paid on its own (its paid_on, else the
// plant day it was paid). A when_paid book dates the run's journal on it (§7.8; ruling R32), and the control check counts the run's
// recoveries on that journal's day (ruling R52).
export const finHrFirstPaymentSql = (run, book) => `(SELECT min(x.d) FROM (
    SELECT COALESCE(fb.paid_on, ${finPlantDaySql('fb.confirmed_at')}) AS d FROM hr.payment_batches fb
     WHERE fb.run_id = ${run} AND fb.status = 'confirmed'
       AND EXISTS (SELECT 1 FROM hr.run_lines fl JOIN hr.people p ON p.id = fl.person_id WHERE fl.payment_batch_id = fb.id AND ${FIN_HR_BOOK_SQL} = ${book})
    UNION ALL
    SELECT COALESCE(fl.paid_on, ${finPlantDaySql('fl.paid_at')}) FROM hr.run_lines fl JOIN hr.people p ON p.id = fl.person_id
     WHERE fl.run_id = ${run} AND fl.payment_status = 'paid' AND fl.payment_batch_id IS NULL AND ${FIN_HR_BOOK_SQL} = ${book}) x)`;

const FIN_MONTH_WORDS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const finHrPeople = n => (n === 1 ? '1 person' : `${n} people`);
export const finHrMonthWord = month => FIN_MONTH_WORDS[Number(String(month).slice(5, 7)) - 1];
const finHrMonthEnd = month => {
  const [y, m] = String(month).split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
// A 'YYYY-MM-DD' day's calendar month as YYYYMM, the source_id of a combined entry (ruling R21).
export const finHrMonthOf = day => Number(`${day.slice(0, 4)}${day.slice(5, 7)}`);

// A fingerprint of what HR says an entry is, kept on the voucher (source_fingerprint): the same HR figures make the same print
// whatever Finance's setup says since, so only a change in HR posts an entry again. Totals and row ids only, as the entry itself.
export const finHrFingerprint = value => `hr1:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

// The HR approval a login gives, { id, name } or null: the doer's, when that login is an HR approver or above now (ruling R26).
export async function finHrDoerApproves(qc, userId) {
  if (!Number.isSafeInteger(userId)) return null;
  const [doer] = await qc(
    'SELECT u.id, u.name, a.level FROM public.users u JOIN hr.access a ON a.user_id = u.id WHERE u.id = $1 AND u.active = 1', [userId]);
  return doer && levelAtLeast(doer.level, 'approver') ? { id: doer.id, name: doer.name } : null;
}

// A public.users login as an approval: { id, name }, or null for none.
export async function finHrUserOf(qc, userId) {
  if (!Number.isSafeInteger(userId)) return null;
  const [user] = await qc('SELECT id, name FROM public.users WHERE id = $1', [userId]);
  return user ? { id: user.id, name: user.name } : null;
}

// ── The payroll month (§7.2, §7.8, §7.9) ─────────────────────────────────────────────────────

// What a main account's pay covered for its sub-accounts, by the codes hr/runs.js gives those deductions, in paise (from breakdown, a
// line field: only a component above 0 is posted at finalise).
const FIN_SUB_PARTS_SQL = `SELECT
    COALESCE(round(sum((b->>'amount')::numeric) FILTER (WHERE b->>'code' ~ '^ADJ:SUB[0-9]+-ADV$' AND (b->>'amount')::numeric > 0) * 100), 0)::bigint AS sub_advance,
    COALESCE(round(sum((b->>'amount')::numeric) FILTER (WHERE b->>'code' ~ '^ADJ:SUB[0-9]+-LN[0-9]+$' AND (b->>'amount')::numeric > 0) * 100), 0)::bigint AS sub_loan
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.breakdown) = 'array' THEN l.breakdown ELSE '[]'::jsonb END) b`;
// The adjustments a correction of a paid finalised month carried into a later month (ruling R54), by the correction's own audit row: its
// detail's adjustment_id. Never by an adjustment's words.
const FIN_CARRIED_IDS_SQL = `SELECT DISTINCT a.detail->>'adjustment_id' AS id FROM hr.audit_log a
  WHERE a.entity = 'run_line' AND a.action = 'finalised_correction' AND a.detail->>'adjustment_id' IS NOT NULL`;
// A line's components of those adjustments (`ADJ:<adjustment id>`, as hr/engine.js names an adjustment), earnings and deductions, in paise
// (`carried` is FIN_CARRIED_IDS_SQL, the query's own CTE).
const FIN_CARRIED_PARTS_SQL = `SELECT
    COALESCE(round(sum((b->>'amount')::numeric) FILTER (WHERE b->>'kind' = 'earning') * 100), 0)::bigint AS carried_earning,
    COALESCE(round(sum((b->>'amount')::numeric) FILTER (WHERE b->>'kind' = 'deduction') * 100), 0)::bigint AS carried_deduction
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.breakdown) = 'array' THEN l.breakdown ELSE '[]'::jsonb END) b
  WHERE b->>'code' ~ '^ADJ:[0-9]+$' AND (b->>'amount')::numeric > 0 AND substr(b->>'code', 5) IN (SELECT id FROM carried)`;
const finPaiseSum = col => `COALESCE(round(sum(${col}) * 100), 0)::bigint`;

// A run's lines, summed in paise, by payroll book (one book only, `book`), and with `split` by person type and department too, hidden
// people apart (`hidden`: ruling R75, they book to salary_expense whatever their type or department).
async function finRunSums(qc, runId, { book = null, split = false } = {}) {
  const group = split
    ? `${FIN_HR_BOOK_SQL}, lower(btrim(p.worker_type)), lower(btrim(COALESCE(p.department, ''))), ${finHrHiddenSql('p.id')}` : FIN_HR_BOOK_SQL;
  return qc(
    `WITH carried AS (${FIN_CARRIED_IDS_SQL})
     SELECT ${FIN_HR_BOOK_SQL} AS book,
            ${split ? `lower(btrim(p.worker_type)) AS type, lower(btrim(COALESCE(p.department, ''))) AS dept, ${finHrHiddenSql('p.id')} AS hidden,` : ''}
            count(*)::int AS people, ${finPaiseSum('l.gross')} AS gross, ${finPaiseSum('l.advance_recovery')} AS advance_recovery,
            ${finPaiseSum('l.loan_recovery')} AS loan_recovery, ${finPaiseSum('l.misc_deduction')} AS misc_deduction,
            ${finPaiseSum('l.adj_deductions')} AS adj_deductions, ${finPaiseSum('l.paid_separately')} AS paid_separately,
            ${finPaiseSum('l.payable')} AS payable, COALESCE(sum(s.sub_advance), 0)::bigint AS sub_advance,
            COALESCE(sum(s.sub_loan), 0)::bigint AS sub_loan, COALESCE(sum(c.carried_earning), 0)::bigint AS carried_earning,
            COALESCE(sum(c.carried_deduction), 0)::bigint AS carried_deduction
       FROM hr.run_lines l JOIN hr.people p ON p.id = l.person_id CROSS JOIN LATERAL (${FIN_SUB_PARTS_SQL}) s
       CROSS JOIN LATERAL (${FIN_CARRIED_PARTS_SQL}) c
      WHERE l.run_id = $1 AND ($2::text IS NULL OR ${FIN_HR_BOOK_SQL} = $2)
      GROUP BY ${group} ORDER BY 1${split ? ', 2, 3, 4' : ''}`, [runId, book]);
}

// The credits of a book's payroll journal, by role, in paise, from its sums (the header's table): a carried arrears deduction is credited
// to Salary Payable, not to the other deductions (ruling R54).
const finRunCredits = t => [
  ['staff_advances', t.advance_recovery + t.sub_advance],
  ['staff_loans', t.loan_recovery + t.sub_loan],
  ['other_deductions', t.misc_deduction + t.adj_deductions - t.sub_advance - t.sub_loan - t.carried_deduction],
  ['md_account', t.paid_separately],
  ['salary_payable', t.payable + t.carried_deduction],
];

// The payroll month's journal of one book, from HR's line fields, as totals: [{ ledger_id, debit_paise, credit_paise }], the debits
// first, a ledger once a side. Gross is split by the book's expense map, 'type:<person type>' before 'dept:<department>' (§7.9), a
// key matching whatever its capitals; the rest goes to the salary_expense role, and so does every hidden person's gross (ruling R75:
// the map's lines carry visible people only). A role a line needs, with an amount, that has no
// ledger in the book is FIN_ROLE_MISSING; so is a rounding remainder with no rounding ledger. A book none of whose people is on the
// run has no journal: []. `qc` is any query function; this writes nothing.
export async function finHrRunLines(qc, runId, bookId) {
  const [book] = await qc('SELECT id, code FROM fin_books WHERE id = $1', [bookId]);
  if (!book) throw finError(404, 'FIN_NOT_FOUND');
  const groups = await finRunSums(qc, runId, { book: book.code, split: true });
  if (!groups.length) return [];
  const map = new Map((await qc('SELECT hr_key, ledger_id FROM fin_hr_expense_map WHERE book_id = $1', [book.id]))
    .map(r => [r.hr_key.trim().toLowerCase().replace(/^(type|dept):\s*/, '$1:'), r.ledger_id]));
  const roles = new Map((await qc('SELECT role, ledger_id FROM fin_ledger_roles WHERE book_id = $1', [book.id])).map(r => [r.role, r.ledger_id]));
  const roleLedger = role => {
    if (!roles.has(role)) throw finError(409, 'FIN_ROLE_MISSING');
    return roles.get(role);
  };
  const debits = new Map();
  const credits = new Map();
  const add = (into, ledgerId, paise) => { if (paise !== 0) into.set(ledgerId, (into.get(ledgerId) ?? 0) + paise); };
  const totals = {
    advance_recovery: 0, loan_recovery: 0, misc_deduction: 0, adj_deductions: 0, paid_separately: 0, payable: 0, sub_advance: 0, sub_loan: 0,
    carried_earning: 0, carried_deduction: 0,
  };
  let gross = 0;
  for (const g of groups) {
    for (const k of Object.keys(totals)) totals[k] += g[k];
    gross += g.gross;
    const expense = g.gross - g.carried_earning;   // a carried arrears earning is no expense of this month (ruling R54)
    if (expense === 0) continue;
    const ledgerId = (g.hidden ? undefined : map.get(`type:${g.type}`) ?? (g.dept ? map.get(`dept:${g.dept}`) : undefined))
      ?? roleLedger('salary_expense');
    add(debits, ledgerId, expense);
  }
  // …it settles the Salary Payable the corrected month left owing.
  if (totals.carried_earning !== 0) add(debits, roleLedger('salary_payable'), totals.carried_earning);
  let credited = 0;
  for (const [role, paise] of finRunCredits(totals)) {
    if (paise === 0) continue;
    add(credits, roleLedger(role), paise);
    credited += paise;
  }
  const remainder = gross - credited;
  if (remainder > 0) add(credits, roleLedger('rounding'), remainder);
  if (remainder < 0) add(debits, roleLedger('rounding'), -remainder);
  const line = (ledgerId, debit, credit) => ({ ledger_id: ledgerId, debit_paise: debit, credit_paise: credit });
  return [
    ...[...debits].sort((a, b) => a[0] - b[0]).map(([id, p]) => line(id, p, 0)),
    ...[...credits].sort((a, b) => a[0] - b[0]).map(([id, p]) => line(id, 0, p)),
  ];
}

// The HR approval of a payroll month: its finaliser's, when an HR approver finalised it (the doer, ruling R26), else its approver's, when
// an HR approver approved the month in HR (§7.6, "done or approved by an HR approver"); else none, and the book's rules decide.
const finRunApproval = async (qc, run) => (await finHrDoerApproves(qc, run.finalised_by)) ?? finHrDoerApproves(qc, run.approved_by);

// The `run` event (§7.2, §7.8): a finalised month, one journal per payroll book (`units`, each judged on its own: a book's journal may
// stand while another waits for its first payment). Dated, per the book's setting (fin_book_settings.payroll_booking): the month end; or,
// `when_paid`, the first payment of that book's people in the run (a confirmed batch's paid_on, else the plant day of its confirmation;
// a line paid on its own, its paid_on), and `awaiting_first_payment` until there is one. A run that is not finalised (never yet, or
// un-finalised since) books nothing: `not_finalised`, which reverses a journal that stood (finance-hr-feed.js).
export async function finHrRunFacts(qc, ev) {
  const [run] = await qc('SELECT id, month, status, finalised_by, approved_by FROM hr.runs WHERE id = $1', [ev.id]);
  if (!run) return { skip: 'not_found' };
  if (run.status !== 'finalised') return { skip: 'not_finalised' };
  const sums = await finRunSums(qc, run.id);
  if (!sums.length) return { skip: 'nothing_paid' };
  const settings = new Map((await qc(
    `SELECT b.code, COALESCE(s.payroll_booking, 'month_end') AS booking FROM fin_books b LEFT JOIN fin_book_settings s ON s.book_id = b.id`))
    .map(r => [r.code, r.booking]));
  const units = [];
  for (const t of sums) {
    let date = finHrMonthEnd(run.month);
    if (settings.get(t.book) === 'when_paid') {
      const [first] = await qc(`SELECT ${finHrFirstPaymentSql('$1::int', '$2::text')}::text AS day`, [run.id, t.book]);
      date = first?.day ?? null;
    }
    // A carried arrears earning moves a debit (ruling R54): in the print when there is one, so a month with none prints as it always has.
    const figures = { gross: t.gross, ...Object.fromEntries(finRunCredits(t)), ...(t.carried_earning ? { carried_earning: t.carried_earning } : {}) };
    units.push({
      book: t.book, people: t.people, date, awaiting: date == null ? 'awaiting_first_payment' : null, runId: run.id,
      fingerprint: finHrFingerprint({ event: 'run', book: t.book, people: t.people, figures }),
    });
  }
  return {
    perBook: true, units, change: true, reference: null, covers: [], approver: await finRunApproval(qc, run),
    narrate: n => `Payroll ${finHrMonthWord(run.month)} ${run.month.slice(0, 4)} · ${finHrPeople(n)}`,
  };
}

// The `sheetAdvances` event (§7.2): the advances written on the month's payroll sheet, which finalise posts as advance rows (kind given,
// source payroll), booked from those rows (as a sheet round is from the rows it made: ruling R25), as one payment from the CASH
// channel's account (HR learns of the cash only at payroll), dated the day the month was finalised. Hidden people's rows are left out
// and go into the cash account's combined entry (ruling R21); a row booked by a live entry other than this event's stays there (R27).
// Whether they come before the books is judged by HR's own date for them, `heldOn` (ruling R68): finalise dates them LEAST(the month
// end, the day it finalised) (hr/runs.js), so a run whose month is before the books begin has them in the Tally opening, however late it
// was finalised, and finBuild skips them as before_books. A run of a month inside the books keeps §7.2's finalise-day date.
export async function finHrSheetAdvanceFacts(qc, ev) {
  const [run] = await qc('SELECT id, month, status, finalised_at, finalised_by, approved_by FROM hr.runs WHERE id = $1', [ev.id]);
  if (!run) return { skip: 'not_found' };
  if (run.status !== 'finalised' || !run.finalised_at) return { skip: 'not_finalised' };
  const rows = await qc(
    `SELECT t.id, t.person_id, ${FIN_HR_BOOK_SQL} AS book, ${finHrHiddenSql('t.person_id')} AS hidden, round(t.amount * 100)::bigint AS paise,
            ${finHrBookedSql(`'hr_advance'`, 't.id')} AS booked_by
       FROM hr.advance_txns t JOIN hr.people p ON p.id = t.person_id
      WHERE t.run_id = $1 AND t.source = 'payroll' AND t.kind = 'given' AND t.reverses_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM hr.advance_txns x WHERE x.reverses_id = t.id)
      ORDER BY t.id`, [run.id]);
  const own = `${ev.key}#${ev.id}`;
  const booked = rows.filter(r => r.booked_by === own || (!r.hidden && r.booked_by == null));
  if (!booked.length) return { skip: rows.some(r => r.hidden && r.booked_by == null) ? 'hidden' : rows.length ? 'in_combined' : 'nothing_paid' };
  const parts = finByBook(booked, () => [{ role: 'staff_advances', side: 'debit' }]);
  const date = plantDateStr(run.finalised_at);
  const monthEnd = finHrMonthEnd(run.month);
  return {
    date, heldOn: monthEnd < date ? monthEnd : date, paid: { code: 'cash', channel: null }, parts, change: true, reference: null,
    approver: await finRunApproval(qc, run),
    covers: booked.map(r => ({ book: r.book, source_type: 'hr_advance', source_id: r.id })),
    narrate: n => `Advances on the ${finHrMonthWord(run.month)} payroll sheet · ${finHrPeople(n)}`,
    fingerprint: finHrFingerprint({ event: 'sheetAdvances', date, parts: finPrint(parts), rows: booked.map(r => r.id) }),
  };
}

// Rows of one event, as its parts: per payroll book, its people (rows that carry a person id count each person once; others count a
// person a row) and its postings, each role and side once, in the order `postingsOf(row)` names them first.
export function finByBook(rows, postingsOf) {
  const books = new Map();
  for (const r of rows) {
    if (!books.has(r.book)) books.set(r.book, { book: r.book, persons: new Set(), postings: [] });
    const part = books.get(r.book);
    part.persons.add(r.person_id ?? `row:${r.id}`);
    for (const { role, side, paise = r.paise } of postingsOf(r)) {
      const found = part.postings.find(p => p.role === role && p.side === side);
      if (found) found.paise += paise;
      else part.postings.push({ role, side, paise });
    }
  }
  return [...books.values()].sort((a, b) => (a.book < b.book ? -1 : 1))
    .map(({ book, persons, postings }) => ({ book, people: persons.size, postings }));
}
// Parts as a fingerprint takes them: totals only.
export const finPrint = parts => parts.map(p => [p.book, p.people, p.postings.map(x => [x.role, x.side, x.paise])]);

// ── Hidden people's money (§7.4; rulings R21, R27) ───────────────────────────────────────────

// The roles a hidden row posts to, in the order a combined entry lists them: payouts, advances and loans going out, prepayments coming in.
const FIN_HIDDEN_POSTINGS = Object.freeze({
  payout: [{ role: 'salary_payable', side: 'debit' }],
  advance: [{ role: 'staff_advances', side: 'debit' }],
  loan: [{ role: 'staff_loans', side: 'debit' }],
  prepay: [{ role: 'staff_loans', side: 'credit' }],
  waiver: [{ role: 'advance_waiver', side: 'debit' }, { role: 'staff_advances', side: 'credit' }],
});
const FIN_ROLE_ORDER = ['salary_payable', 'staff_advances', 'staff_loans', 'advance_waiver'];

// Every money row of a hidden person, and every row a live combined entry books (a person un-hidden since keeps what was booked: R27),
// dated from `from` (the books' first day) to before `before`, or in the one calendar month `month` (YYYYMM): { kind, cover_type,
// cover_id, person_id, book, hidden, date, month, paise, code, channel (the account to resolve; none for a waiver), approver_id (the
// HR approval of the row, or null), booked_by (the live voucher that books it, or null) }. The rows, as part 1's events read them:
//   payout   a run line paid, in a confirmed batch (the batch's account and date) or on its own (the line's)
//   advance  given and standing (no row reverses it): Pay staff, Loans & Advances, an advance sheet's (its row's account, else the
//            sheet's: ruling R25), or the month's payroll sheet's (the CASH channel's account, the day the month was finalised; for a
//            run whose month is before the books, HR's own date for it, at that month's end: the Tally opening's, ruling R68)
//   loan     disbursed, not an opening balance, not cancelled
//   prepay   money coming back on a loan
//   waiver   waived and standing
export async function finHrHiddenRows(qc, { from, before = null, month = null }) {
  const union = `
    SELECT 'payout' AS kind, 'hr_line_pay' AS cover_type, l.id AS cover_id, l.person_id, ${FIN_HR_BOOK_SQL} AS book,
           ${finHrHiddenSql('l.person_id')} AS hidden,
           CASE WHEN l.payment_batch_id IS NULL THEN COALESCE(l.paid_on, ${finPlantDaySql('l.paid_at')})
                ELSE COALESCE(b.paid_on, ${finPlantDaySql('b.confirmed_at')}) END AS day,
           round(l.paid_amount * 100)::bigint AS paise,
           CASE WHEN l.payment_batch_id IS NULL THEN l.paid_from ELSE b.paid_from END AS code,
           CASE WHEN l.payment_batch_id IS NULL THEN l.pay_channel ELSE b.pay_channel END AS channel,
           l.approved_by AS approver_id
      FROM hr.run_lines l JOIN hr.people p ON p.id = l.person_id LEFT JOIN hr.payment_batches b ON b.id = l.payment_batch_id
     WHERE l.payment_status = 'paid' AND (l.payment_batch_id IS NULL OR b.status = 'confirmed')
    UNION ALL
    SELECT 'advance', 'hr_advance', t.id, t.person_id, ${FIN_HR_BOOK_SQL}, ${finHrHiddenSql('t.person_id')},
           CASE WHEN t.source = 'payroll' AND ${finHrMonthEndSql('r.month')} >= $1::date THEN ${finPlantDaySql('r.finalised_at')} ELSE t.txn_date END,
           round(t.amount * 100)::bigint,
           CASE WHEN t.source = 'payroll' THEN 'cash' ELSE COALESCE(t.paid_via, sh.paid_via) END, NULL,
           CASE WHEN sh.decided_by IS NOT NULL THEN sh.decided_by
                WHEN t.source = 'payroll' THEN COALESCE(${finApproverSql('r.finalised_by')}, ${finApproverSql('r.approved_by')})
                ELSE ${finApproverSql('t.created_by')} END
      FROM hr.advance_txns t JOIN hr.people p ON p.id = t.person_id LEFT JOIN hr.runs r ON r.id = t.run_id
      LEFT JOIN LATERAL (SELECT s.paid_via, sl.decided_by FROM hr.advance_sheet_lines sl JOIN hr.advance_sheets s ON s.id = sl.sheet_id
                          WHERE sl.advance_txn_id = t.id ORDER BY sl.id LIMIT 1) sh ON true
     WHERE t.kind = 'given' AND t.reverses_id IS NULL AND t.source IN ('manual', 'payroll')
       AND NOT EXISTS (SELECT 1 FROM hr.advance_txns x WHERE x.reverses_id = t.id)
       AND (t.source = 'manual' OR (r.status = 'finalised' AND r.finalised_at IS NOT NULL))
    UNION ALL
    SELECT 'loan', 'hr_loan', ln.id, ln.person_id, ${FIN_HR_BOOK_SQL}, ${finHrHiddenSql('ln.person_id')}, d.txn_date,
           round(d.principal_amount * 100)::bigint, COALESCE(d.paid_via, ln.paid_via), NULL,
           COALESCE((SELECT sl.decided_by FROM hr.advance_sheet_lines sl WHERE sl.loan_id = ln.id ORDER BY sl.id LIMIT 1),
                    ${finApproverSql('ln.created_by')})
      FROM hr.loans ln JOIN hr.people p ON p.id = ln.person_id
      JOIN LATERAL (SELECT txn_date, principal_amount, paid_via FROM hr.loan_txns WHERE loan_id = ln.id AND kind = 'disbursed'
                     ORDER BY id LIMIT 1) d ON true
     WHERE NOT ln.is_opening AND ln.status <> 'cancelled'
    UNION ALL
    SELECT 'prepay', 'hr_prepay', t.id, ln.person_id, ${FIN_HR_BOOK_SQL}, ${finHrHiddenSql('ln.person_id')}, t.txn_date,
           round(t.principal_amount * 100)::bigint, t.paid_via, NULL, ${finApproverSql('t.created_by')}
      FROM hr.loan_txns t JOIN hr.loans ln ON ln.id = t.loan_id JOIN hr.people p ON p.id = ln.person_id
     WHERE t.kind = 'prepayment'
    UNION ALL
    SELECT 'waiver', 'hr_waiver', t.id, t.person_id, ${FIN_HR_BOOK_SQL}, ${finHrHiddenSql('t.person_id')}, t.txn_date,
           round(t.amount * 100)::bigint, NULL, NULL, t.created_by
      FROM hr.advance_txns t JOIN hr.people p ON p.id = t.person_id
     WHERE t.kind = 'waived' AND t.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM hr.advance_txns x WHERE x.reverses_id = t.id)`;
  const rows = await qc(
    `SELECT x.kind, x.cover_type, x.cover_id, x.person_id, x.book, x.hidden, x.day::text AS date, x.paise, x.code, x.channel, x.approver_id,
            ${finHrBookedSql('x.cover_type', 'x.cover_id')} AS booked_by
       FROM (${union}) x
      WHERE x.day IS NOT NULL AND x.day >= $1::date AND ($2::date IS NULL OR x.day < $2::date)
        AND ($3::int IS NULL OR (extract(year FROM x.day) * 100 + extract(month FROM x.day))::int = $3::int)
        AND (x.hidden OR ${finHrCoveredSql('x.cover_type', 'x.cover_id')} LIKE 'hr\\_hidden:%')
      ORDER BY x.day, x.cover_type, x.cover_id`, [from, before, month]);
  return rows.map(r => ({ ...r, month: finHrMonthOf(r.date) }));
}

// Hidden rows into their combined entries (ruling R21), as { key, month, rows } by 'key#month': a row a live combined entry books stays
// with that entry, whoever is hidden now and whatever its account resolves to now (ruling R27); a row another live voucher books (one
// posted for the row's own event before its person was hidden, or a batch that paid them) is left where it is; any other row of a
// hidden person goes to its account's entry for its month (`hr_hidden:<ledger id>`), a waiver to its month's waivers
// (`hr_hidden:waiver`), and one whose account resolves to nothing to `hr_hidden:unmapped`, which cannot post (FIN_UNMAPPED_CHANNEL).
export async function finHrHiddenGroups(qc, rows) {
  const accounts = new Map();
  const groups = new Map();
  const put = (key, month, row) => {
    const k = `${key}#${month}`;
    if (!groups.has(k)) groups.set(k, { key, month, rows: [] });
    groups.get(k).rows.push(row);
  };
  for (const r of rows) {
    if (r.booked_by != null) {
      if (!r.booked_by.startsWith('hr_hidden:')) continue;
      const at = r.booked_by.lastIndexOf('#');
      put(r.booked_by.slice(0, at), Number(r.booked_by.slice(at + 1)), r);
      continue;
    }
    if (!r.hidden) continue;
    if (r.kind === 'waiver') { put('hr_hidden:waiver', r.month, r); continue; }
    const code = `${r.code ?? ''}\u0000${r.channel ?? ''}`;
    if (!accounts.has(code)) accounts.set(code, await finResolvePaidFrom(qc, r.code ?? null, r.channel ?? null));
    const account = accounts.get(code);
    put(account ? `hr_hidden:${account.ledger_id}` : 'hr_hidden:unmapped', r.month, r);
  }
  return groups;
}

// The shape of one combined entry (ruling R21), from its rows, without its approval: what finHrHiddenFacts answers, so that whether an
// entry changed can be told without asking the database anything. An account's: every row through `account` ({ book_id, ledger_id })
// that month, netted on the account line (a payment when more went out, a receipt when more came in: finance-hr-feed.js), dated the last
// of them, narrated "Salary · combined · N people" when it holds payouts only, else "Staff money · combined · N people", N the distinct
// people in it. A month's waivers (`account` null): one journal per payroll book, "Advance waived · combined · N people", each dated its
// own last waiver. Its fingerprint is its rows and its totals.
export function finHrHiddenShape(rows, { account = null, month }) {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : a.cover_type < b.cover_type ? -1 : a.cover_type > b.cover_type ? 1 : a.cover_id - b.cover_id));
  const postingsOf = r => FIN_HIDDEN_POSTINGS[r.kind];
  const ordered = parts => parts.map(p => ({
    ...p, postings: [...p.postings].sort((a, b) => (a.side === b.side ? FIN_ROLE_ORDER.indexOf(a.role) - FIN_ROLE_ORDER.indexOf(b.role)
      : a.side === 'debit' ? -1 : 1)),
  }));
  const covers = sorted.map(r => ({ book: r.book, source_type: r.cover_type, source_id: r.cover_id }));
  if (account == null) {
    const units = ordered(finByBook(sorted, postingsOf)).map(part => {
      const mine = sorted.filter(r => r.book === part.book);
      const date = mine[mine.length - 1].date;
      return {
        book: part.book, people: part.people, parts: [part], date, covers: covers.filter(c => c.book === part.book),
        fingerprint: finHrFingerprint({ event: 'hidden_waiver', month, date, parts: finPrint([part]), rows: mine.map(r => [r.cover_type, r.cover_id]) }),
      };
    });
    return { perBook: true, units, change: true, reference: null, covers, rows: sorted, narrate: n => `Advance waived · combined · ${finHrPeople(n)}` };
  }
  const parts = ordered(finByBook(sorted, postingsOf));
  const last = sorted[sorted.length - 1];
  const payoutsOnly = sorted.every(r => r.kind === 'payout');
  return {
    date: last.date, account, parts, covers, change: true, reference: null, rows: sorted,
    narrate: n => `${payoutsOnly ? 'Salary' : 'Staff money'} · combined · ${finHrPeople(n)}`,
    fingerprint: finHrFingerprint({ event: 'hidden', month, ledger: account.ledger_id, date: last.date, parts: finPrint(parts),
      rows: sorted.map(r => [r.cover_type, r.cover_id]) }),
  };
}

// The facts of one combined entry: its shape, and its HR approval, which it has when every row has one (that of the latest row), as a
// batch has its lines'.
export async function finHrHiddenFacts(qc, rows, opts) {
  const shape = finHrHiddenShape(rows, opts);
  const last = shape.rows[shape.rows.length - 1];
  const approver = shape.rows.every(r => r.approver_id != null) ? await finHrUserOf(qc, last.approver_id) : null;
  return { ...shape, approver };
}
