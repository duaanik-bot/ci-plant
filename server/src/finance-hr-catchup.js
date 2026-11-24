// Finance — catching up with HR (Cash & Bank spec §5's header line "HR entries waiting · Exceptions · Staff advances vs HR", §7.5,
// §7.6, §7.7, §9.5; plan Task 13; rulings R36, R36a, R37, R37b, R38, R38a, R38b, R45, R50, R52, R52a, R53). HR's staff money reaches
// the books through the call after each HR request's commit (finHrAfter, finance-hr-feed.js). This is the safety net behind that call,
// for a book:
//   • finHrPending          the HR events whose entry in the book is not posted yet, each once (what "HR entries waiting" counts)
//   • finHrStatus           the header line's three figures: entries waiting, open exceptions, and the control check as at today
//   • finBringInFromHr      "Bring in from HR": posts what waits, tries the open exceptions again, posts the hidden months due, and
//                           repairs what the call after commit missed lately, within a budget
//   • finHrExceptionsOf     the book's open exceptions, newest first, each with its event, its reason and its fix (§7.7)
//   • finHrRetryException   one exception tried again, answered as it now stands
//   • finHrControl          Staff Advances, Staff Loans and Salary Payable in Finance against HR's own figures, as at a day (§7.5, §9.5)
// All of it posts through the feed (finHrPost, finHrPostHidden) and reads HR's rows the way the feed reads them: HR's tables are read,
// never written and never locked. What it answers is counts, totals, HR's document numbers and sentences, never a person (§7.4).
//
// What waits (ruling R36). An HR event waits in a book when its entry there is not posted yet:
//   (a) finHrPending's events: no voucher of the event is posted in the book, it has no open exception, and finHrPost would do
//       something for it in that book: post or submit its voucher there (finHrVoucherFor builds one in the book), record an exception
//       placed in the book (the book its exception would name, CI's for none), withdraw or discard what HR has taken back (a voucher of
//       it waiting for an Approver, or a draft an Approver sent back, ruling R39), or leave it waiting for its Approver (a voucher of it
//       submitted there: §7.6, "both show"). What finHrPost skips for good is never listed: before_books, on_sheet, in_batch,
//       in_combined, a hidden person's own event (their combined entry books it), an opening or cancelled loan with nothing standing,
//       a run not finalised or awaiting its first payment, nothing_paid, and the rest of the feed's skips. Hidden people's money waits as
//       one { type: 'hidden', id: YYYYMM } for each month that has ended whose combined entries do not all stand in the book
//       (finHrHiddenDue, which finHrPostHidden posts by), or of which one waits there for an Approver. A line that left its batch (ruling
//       R45: paid again on its own from another account than its batch's) waits as a `line` event while its batch's old entry still
//       holds it, never as part of the batch. An event that writes to both books (ruling R24) waits in each it writes to. And an event
//       whose voucher posted in the book has a reversal an Approver sent back (ruling R36a), when finHrPost would take that voucher out
//       again: HR has undone the event, or changed what it posts there since; Bring-in discards the sent-back reversal and makes it
//       afresh.
//   (b) the events whose voucher posted in the book has its reversal waiting for an Approver, or sent back by one (ruling R36a): an undo
//       or a correction waits for the MD, and the corrected entry behind it (§7.6, "both show"). finHrStatus counts (a) and (b), each
//       event once.
// Finding (a) is one SQL read of the HR events that could post (each type's own rows, cheaply narrowed by the feed's own rules, and
// those with a voucher waiting or sent back in the book whatever the rules say), and the feed's own reader (finHrVoucherFor) for each
// of those, so the list never disagrees with what finHrPost does.
//
// Bring-in (§7.7; rulings R38, R38a, R38b, R53) posts, in the name of the Finance login asking (who needs `enter` on the book; an
// event's voucher in the other book is written with it, as the call after commit writes it), each event once, by finHrPost, in this
// order:
//   (1) the events that wait (finHrPending's), batches before lines and rounds before the rows they made; a line that left its batch
//       (ruling R45) after that batch, so it is free to post once its batch is posted again without it;
//   (2) the book's open exceptions, least recently tried first (ruling R38b), each tried again with Retry's routing (ruling R53):
//       hidden people's (`hr_hidden:…`) by their combined entries, any other by finHrPost of its own event. One that fails again keeps
//       its row, last tried now, and so goes to the back of the next press's list: a press that runs out of time among them does not
//       try the same ones first again;
//   (3) hidden people's combined entries, by finHrPostHidden with retry, unless (2) ran them;
//   (4) drift repair: the events of the vouchers posted in the book and not reversed, dated in the calendar month of today or the one
//       before, in a month that is not locked, newest first (hidden people's combined entries apart: (3) compares them). finHrPost
//       makes the books say what HR says now, and answers `already` for what stands as HR says it should (H8), so re-running a posted
//       event repairs an undo or a correction the call after commit missed (the process stopping between HR's commit and the feed
//       leaves no exception) and is otherwise a read. Older drift is left as it stands. The status count leaves drift out: it is found
//       only by trying.
// One Bring-in stops between two pieces of work once its budget (20 s, counted from its start) is spent, the first piece always done,
// and answers `more: true` (ruling R38a), only then: work it did not reach remains. Stopped in the drift, it keeps the voucher it
// stopped after (fin_book_settings.hr_drift_cursor, ruling R38b), and the next press goes on with the older ones; one that goes through
// to the end of the window starts the next from the newest again.
//
// The control check (§7.5, §9.5; rulings R37, R37b, R52, R52a), as at a day: Finance's balance of each staff ledger (the book's
// staff_advances, staff_loans and salary_payable roles: posted lines dated that day or before) against HR's own figure for the book's
// people (its payroll book, §7.2), from HR's rows counted on the day Finance books them, that day or before:
//   advances        opening + given + adjustment − recovered − waived (hr.advance_txns, HR's balance rule, hr/ledger.js)
//   loans           disbursed + opening + adjustment − payroll_recovery − prepayment − waiver (hr.loan_txns, hr/loans.js)
//   salary_payable  Σ payable of the finalised runs' lines not paid by then, each run from the day its journal is dated in the book
//                   (ruling R52a: the journal that stands, else the month end), and what a correction of a paid month carried into a
//                   later month that no journal books yet (an earning adds, a deduction takes off); only with the month_end setting
//                   (§7.8): with when_paid it is null
// A row a payroll run made (its run_id, whatever its own date) counts on the day Finance books it (ruling R52): its recoveries (an
// advance's `recovered`, a sub-account's included, and a loan's `payroll_recovery`) on the day the run's journal is dated in the book
// (the journal's own date where one stands; else the month end, or with when_paid the book's first payment in the run), and the
// advances its payroll sheet gave on the day the run was finalised: but for a run whose month is before the books begin, whose sheet
// advances are the Tally opening's (the feed books none of them, ruling R68), on HR's own date for them, that month's end. Every other
// row counts on its own date. Two kinds of money are not
// due in Finance yet: recoveries whose journal is not dated yet (when_paid, nothing of the book's paid in the run; counted once their
// month has ended), and hidden people's money that no live voucher books yet, of a month that has not ended as of today (their combined
// entry posts once the month ends, ruling R21). Both are left out of hr_paise, silently (ruling R37b): no figure says what is not due,
// as one would move by a single hidden person's money, and a reading of the header could tell a payout or an advance as it happens.
// Hidden people's money shows only within the totals, once its month has ended. So gap_paise = hr_paise − finance_paise is a real gap:
// what HR holds that Finance does not. `matches` is every gap present being 0. Finance's books hold nothing before their opening day,
// the day before they begin: a check asked as at an earlier day is the cut-over check, as at the opening day (§9.5), and `as_at` says
// which day it is.

import { q, one } from './db.js';
import { finError } from './finance-errors.js';
import { finIdOf } from './finance-masters.js';
import { finResolvePaidFrom } from './finance-hr-setup.js';
import {
  FIN_HR_HOME_BOOK, FIN_HR_SOURCES, FIN_HR_UNDONE, finHrFeedTx, finHrHiddenDue, finHrPost, finHrPostHidden, finHrVoucherFor, finLeftItsBatch,
} from './finance-hr-feed.js';
import {
  FIN_HR_BOOK_SQL, finHrBookedSql, finHrCoveredSql, finHrFirstPaymentSql, finHrHiddenSql, finHrLiveSql, finHrMonthEndSql,
} from './finance-hr-payroll.js';
import { plantDateStr } from './plant-calendar.js';
import { finDayBefore, finIsValidDate } from '../../client/src/lib/finance/fy.js';

const FIN_HIDDEN = FIN_HR_SOURCES.hidden;
// The event type of a voucher's or an exception's source key (stored bare): FIN_HR_SOURCES read backwards; `hidden` for a combined entry.
const FIN_TYPE_OF = new Map(Object.entries(FIN_HR_SOURCES).filter(([type]) => type !== 'hidden' && type !== 'intercompany')
  .map(([type, key]) => [key, type]));
const finTypeOfSource = key => (key.startsWith(`${FIN_HIDDEN}:`) ? 'hidden' : FIN_TYPE_OF.get(key) ?? null);
// The order Bring-in posts in, and finHrPending lists in: what books rows first, then the rows of one person each, the hidden months last.
const FIN_EVENT_ORDER = ['run', 'sheetAdvances', 'batch', 'sheet', 'line', 'advance', 'loan', 'prepay', 'waiver', 'hidden'];
const finByOrder = (a, b) => FIN_EVENT_ORDER.indexOf(a.type) - FIN_EVENT_ORDER.indexOf(b.type) || a.id - b.id;
const finKeyOf = ev => `${ev.type}#${ev.id}`;

// The fix an exception's screen offers (§7.7): map the channel (Finance Setup → HR & payroll, where a missing staff ledger is set too),
// reopen the month, try it again (Finance was busy, ruling R73: nothing to fix), or ask the MD (anything else).
const FIN_HR_FIX = Object.freeze({
  FIN_UNMAPPED_CHANNEL: 'map_channel',
  FIN_ROLE_MISSING: 'map_channel',
  FIN_PERIOD_LOCKED: 'reopen_month',
  FIN_PERIOD_CLOSING: 'reopen_month',
  FIN_NO_PERIOD: 'reopen_month',
  FIN_BUSY: 'retry',
});
const finFixOf = code => (Object.hasOwn(FIN_HR_FIX, code) ? FIN_HR_FIX[code] : 'ask_md');

// The book an exception lists under, on fin_hr_exceptions aliased e: its own, or CI's when it names none (an event that failed before
// its book was known). The route that retries one asks for the right to enter on this book.
export const FIN_HR_EXCEPTION_BOOK_SQL = `COALESCE(e.book_id, (SELECT hb.id FROM fin_books hb WHERE hb.code = '${FIN_HR_HOME_BOOK}'))`;

const finPlantDay = moment => `((${moment}) AT TIME ZONE 'Asia/Kolkata')::date`;
// A hidden person's row that no live voucher books (the feed's own test, ruling R21/R27): skipped as `hidden`, its money left to a
// combined entry.
const finHiddenUnbooked = (person, key, id) => `(${finHrHiddenSql(person)} AND ${finHrBookedSql(key, id)} IS NULL)`;

// The book, or FIN_NOT_FOUND.
async function finCatchupBook(qx, bookId) {
  const id = finIdOf(bookId);
  const book = id == null ? null : (await qx('SELECT id, code, books_begin FROM fin_books WHERE id = $1', [id]))[0];
  if (!book) throw finError(404, 'FIN_NOT_FOUND');
  return book;
}
const finHomeBookId = async qx => (await qx('SELECT id FROM fin_books WHERE code = $1', [FIN_HR_HOME_BOOK]))[0]?.id ?? null;

// ── What waits (ruling R36) ───────────────────────────────────────────────────────────────────

// The HR events that may wait in book $1 (code $2), the books' first day $3: every HR row of a type the feed posts, each with
// `may_post`, a test the feed's own reader passes for any event it posts or fails on (its rules for what it skips for good, as far as
// SQL reads them cheaply: before the books (a run's payroll-sheet advances by HR's own date for them, its month's end when it was
// finalised later: ruling R68), a reversed or reversing advance, a sheet's advance or loan, an opening or cancelled loan, a
// hidden person's own row, one another live entry books, a line in its batch, a run not finalised or with nobody of the book), and
// what Finance holds of it in the book. Kept: no open exception (a round's under any of its lines), and either no posted voucher in the
// book and a voucher of it waiting for an Approver or sent back in the book, or `may_post` with no posted voucher anywhere (a run, whose
// books each post a journal of their own, with none in this book); or a posted voucher in the book whose reversal an Approver sent
// back (ruling R36a). An event with a voucher posted in the other book alone posted whole (its pair is made in one transaction); its
// half here, if sent back or waiting, is found by that voucher.
const FIN_PENDING_SQL = `
  WITH rounds AS (
    SELECT min(sl.id) AS id, array_agg(sl.id ORDER BY sl.id) AS ids
      FROM hr.advance_sheet_lines sl WHERE sl.posted_at IS NOT NULL GROUP BY sl.sheet_id, sl.posted_at),
  events AS (
    SELECT 'advance' AS type, 'hr_advance' AS key, t.id, ARRAY[t.id] AS ids,
           (t.txn_date >= $3::date AND NOT EXISTS (SELECT 1 FROM hr.advance_txns x WHERE x.reverses_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM hr.advance_sheet_lines sl WHERE sl.advance_txn_id = t.id)
            AND ${finHrCoveredSql(`'hr_advance'`, 't.id')} IS NULL AND NOT ${finHiddenUnbooked('t.person_id', `'hr_advance'`, 't.id')}) AS may_post
      FROM hr.advance_txns t WHERE t.kind = 'given' AND t.source = 'manual' AND t.reverses_id IS NULL
    UNION ALL
    SELECT 'waiver', 'hr_waiver', t.id, ARRAY[t.id],
           (t.txn_date >= $3::date AND NOT EXISTS (SELECT 1 FROM hr.advance_txns x WHERE x.reverses_id = t.id)
            AND ${finHrCoveredSql(`'hr_waiver'`, 't.id')} IS NULL AND NOT ${finHiddenUnbooked('t.person_id', `'hr_waiver'`, 't.id')})
      FROM hr.advance_txns t WHERE t.kind = 'waived' AND t.reverses_id IS NULL
    UNION ALL
    SELECT 'loan', 'hr_loan', l.id, ARRAY[l.id],
           (NOT l.is_opening AND l.status <> 'cancelled' AND d.txn_date >= $3::date
            AND NOT EXISTS (SELECT 1 FROM hr.advance_sheet_lines sl WHERE sl.loan_id = l.id)
            AND ${finHrCoveredSql(`'hr_loan'`, 'l.id')} IS NULL AND NOT ${finHiddenUnbooked('l.person_id', `'hr_loan'`, 'l.id')})
      FROM hr.loans l
      LEFT JOIN LATERAL (SELECT txn_date FROM hr.loan_txns WHERE loan_id = l.id AND kind = 'disbursed' ORDER BY id LIMIT 1) d ON true
    UNION ALL
    SELECT 'prepay', 'hr_prepay', t.id, ARRAY[t.id],
           (t.txn_date >= $3::date AND ${finHrCoveredSql(`'hr_prepay'`, 't.id')} IS NULL
            AND NOT ${finHiddenUnbooked('l.person_id', `'hr_prepay'`, 't.id')})
      FROM hr.loan_txns t JOIN hr.loans l ON l.id = t.loan_id WHERE t.kind = 'prepayment'
    UNION ALL
    SELECT 'sheet', 'hr_sheet', rd.id, rd.ids,
           EXISTS (SELECT 1 FROM hr.advance_sheet_lines sl
                     LEFT JOIN hr.advance_txns t ON t.id = sl.advance_txn_id
                     LEFT JOIN hr.loans ln ON ln.id = sl.loan_id
                    WHERE sl.id = ANY(rd.ids)
                      AND (t.txn_date >= $3::date
                           OR (ln.status <> 'cancelled' AND COALESCE(
                                (SELECT x.txn_date FROM hr.loan_txns x WHERE x.loan_id = ln.id AND x.kind = 'disbursed' ORDER BY x.id LIMIT 1),
                                ln.issued_on) >= $3::date)))
      FROM rounds rd
    UNION ALL
    SELECT 'batch', 'hr_batch', b.id, ARRAY[b.id],
           (b.status = 'confirmed' AND COALESCE(COALESCE(b.paid_on, ${finPlantDay('b.confirmed_at')}) >= $3::date, true)
            AND EXISTS (SELECT 1 FROM hr.run_lines l WHERE l.payment_batch_id = b.id AND l.payment_status = 'paid'))
      FROM hr.payment_batches b
    UNION ALL
    SELECT 'line', 'hr_line_pay', l.id, ARRAY[l.id],
           (l.payment_status = 'paid' AND l.paid_amount > 0 AND COALESCE(COALESCE(l.paid_on, ${finPlantDay('l.paid_at')}) >= $3::date, true)
            AND NOT ${finHiddenUnbooked('l.person_id', `'hr_line_pay'`, 'l.id')})
      FROM hr.run_lines l WHERE l.payment_batch_id IS NULL OR l.paid_from IS NOT NULL
    UNION ALL
    SELECT 'run', 'hr_run', r.id, ARRAY[r.id],
           (r.status = 'finalised'
            AND EXISTS (SELECT 1 FROM hr.run_lines l JOIN hr.people p ON p.id = l.person_id WHERE l.run_id = r.id AND ${FIN_HR_BOOK_SQL} = $2)
            AND (r.month >= to_char($3::date, 'YYYY-MM')
                 OR EXISTS (SELECT 1 FROM hr.payment_batches b WHERE b.run_id = r.id AND b.status = 'confirmed'
                               AND COALESCE(b.paid_on, ${finPlantDay('b.confirmed_at')}) >= $3::date)
                 OR EXISTS (SELECT 1 FROM hr.run_lines l WHERE l.run_id = r.id AND l.payment_status = 'paid' AND l.payment_batch_id IS NULL
                               AND COALESCE(l.paid_on, ${finPlantDay('l.paid_at')}) >= $3::date)))
      FROM hr.runs r
    UNION ALL
    SELECT 'sheetAdvances', 'hr_sheet_adv', r.id, ARRAY[r.id],
           (r.status = 'finalised' AND ${finPlantDay('r.finalised_at')} >= $3::date AND ${finHrMonthEndSql('r.month')} >= $3::date
            AND EXISTS (SELECT 1 FROM hr.advance_txns t WHERE t.run_id = r.id AND t.source = 'payroll' AND t.kind = 'given' AND t.reverses_id IS NULL))
      FROM hr.runs r),
  unposted AS (
    SELECT regexp_replace(v.source_type, ':DP$', '') AS key, v.source_id AS id, v.status
      FROM fin_vouchers v
     WHERE v.book_id = $1 AND v.status IN ('submitted', 'draft') AND v.reversal_of_id IS NULL AND v.source_type LIKE 'hr\\_%'),
  reversals_sent_back AS (
    SELECT regexp_replace(v.source_type, ':DP$', '') AS key, v.source_id AS id
      FROM fin_vouchers r JOIN fin_vouchers v ON v.id = r.reversal_of_id
     WHERE r.status = 'draft' AND v.book_id = $1 AND v.status = 'posted' AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
       AND v.source_type LIKE 'hr\\_%'),
  judged AS (
    SELECT e.type, e.id, e.may_post,
           EXISTS (SELECT 1 FROM fin_vouchers v WHERE v.source_type IN (e.key, e.key || ':DP') AND v.source_id = e.id AND v.book_id = $1
                      AND v.status = 'posted' AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL) AS posted_here,
           EXISTS (SELECT 1 FROM fin_vouchers v WHERE v.source_type IN (e.key, e.key || ':DP') AND v.source_id = e.id
                      AND v.status = 'posted' AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL) AS posted_anywhere,
           EXISTS (SELECT 1 FROM unposted u WHERE u.key = e.key AND u.id = e.id AND u.status = 'submitted') AS waiting_here,
           EXISTS (SELECT 1 FROM unposted u WHERE u.key = e.key AND u.id = e.id AND u.status = 'draft') AS sent_back_here,
           EXISTS (SELECT 1 FROM reversals_sent_back s WHERE s.key = e.key AND s.id = e.id) AS reversal_sent_back_here,
           EXISTS (SELECT 1 FROM fin_hr_exceptions x WHERE x.source_type = e.key AND x.source_id = ANY(e.ids) AND x.resolved_at IS NULL) AS failing
      FROM events e)
  SELECT type, id, waiting_here, sent_back_here, reversal_sent_back_here FROM judged
   WHERE NOT failing AND (NOT posted_here OR reversal_sent_back_here)
     AND (waiting_here OR sent_back_here OR reversal_sent_back_here OR (may_post AND (type = 'run' OR NOT posted_anywhere)))`;

// A line linked to a batch, paid again on its own from another account than its batch's (ruling R45: finLeftItsBatch, the feed's own
// test), while its batch's old entry still books it, waits as a `line` event in the books its own voucher writes to: its person's
// payroll book, and its account's. Not a hidden person's: once out of the batch, their combined entry books it.
async function finLeftLineWaitsIn(qc, book, lineId) {
  const [line] = await qc(
    `SELECT l.paid_from, l.pay_channel, b.paid_from AS batch_paid_from, b.pay_channel AS batch_channel, ${FIN_HR_BOOK_SQL} AS book,
            ${finHrHiddenSql('l.person_id')} AS hidden
       FROM hr.run_lines l JOIN hr.people p ON p.id = l.person_id JOIN hr.payment_batches b ON b.id = l.payment_batch_id
      WHERE l.id = $1 AND l.payment_status = 'paid' AND l.paid_from IS NOT NULL`, [lineId]);
  if (!line || line.hidden) return false;
  if (!(await finLeftItsBatch(qc, line, await finResolvePaidFrom(qc, line.batch_paid_from, line.batch_channel)))) return false;
  return line.book === book.code || (await finResolvePaidFrom(qc, line.paid_from, line.pay_channel))?.book_id === book.id;
}

// A voucher of the event posted in `book` whose reversal an Approver sent back (ruling R36a): finHrPost takes it out again, discarding
// that reversal and making a new one, when HR has undone the event, or changed what it posts here since the voucher was made (a type
// whose change posts it again, its fingerprint not the one that stands). As HR put it back, finHrPost answers that it stands, and the
// sent-back reversal is a person's to discard: it still counts as waiting (finReversalsWaitingIn), but Bring-in cannot clear it.
async function finRemakesReversal(qc, book, c) {
  let built;
  try {
    built = await finHrVoucherFor(qc, { type: c.type, id: c.id }, { prints: true });
  } catch {
    return true;   // what it posts now is refused: Bring-in tries it, and the refusal is its exception
  }
  if (FIN_HR_UNDONE.has(built.skip)) return true;
  if (built.skip) return false;
  const [stood] = await qc(
    `SELECT source_fingerprint FROM fin_vouchers WHERE book_id = $1 AND source_type IN ($2, $2 || ':DP') AND source_id = $3
        AND status = 'posted' AND reversed_by_id IS NULL AND reversal_of_id IS NULL ORDER BY id LIMIT 1`,
    [book.id, FIN_HR_SOURCES[c.type], c.id]);
  return (built.vouchers ?? [built]).some(v => v.book_id === book.id && v.change && v.fingerprint !== stood?.source_fingerprint);
}

// Whether a candidate of FIN_PENDING_SQL waits in `book` (the header's (a)): what finHrPost would do for it there.
async function finWaitsIn(qc, book, homeId, c) {
  if (c.reversal_sent_back_here) return finRemakesReversal(qc, book, c);
  if (c.waiting_here) return true;   // its voucher here waits for an Approver: posted then, or withdrawn by Bring-in if HR took it back
  const seen = {};
  let built;
  try {
    built = await finHrVoucherFor(qc, { type: c.type, id: c.id }, { seen });
  } catch {
    return (seen.book_id ?? homeId) === book.id;   // Bring-in makes it an exception, listed in this book
  }
  if (!built.skip) return (built.vouchers ?? [built]).some(v => v.book_id === book.id);
  if (FIN_HR_UNDONE.has(built.skip)) return c.sent_back_here === true;   // HR took it back: its sent-back draft here is discarded (R39)
  if (c.type === 'line' && built.skip === 'in_batch') return finLeftLineWaitsIn(qc, book, c.id);
  return false;
}

// Hidden people's months that wait in `book` as at `asOf`: an ended month with a combined entry due that touches the book (an unmapped
// one is listed under CI, as its exception is), or with one waiting for an Approver there and no open exception.
async function finHiddenMonthsWaitingIn(qc, book, asOf) {
  const months = new Set();
  for (const due of await finHrHiddenDue(qc, asOf, { retry: false })) {
    if ((due.key === `${FIN_HIDDEN}:unmapped` ? [FIN_HR_HOME_BOOK] : due.books).includes(book.code)) months.add(due.id);
  }
  const submitted = await qc(
    `SELECT DISTINCT v.source_id AS month FROM fin_vouchers v
      WHERE v.book_id = $1 AND v.source_type LIKE 'hr\\_hidden:%' AND v.status = 'submitted' AND v.reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fin_hr_exceptions x WHERE x.source_type = regexp_replace(v.source_type, ':DP$', '')
                          AND x.source_id = v.source_id AND x.resolved_at IS NULL)`, [book.id]);
  for (const s of submitted) months.add(s.month);
  return [...months].sort((a, b) => a - b);
}

// The HR events of a book whose entry there is not posted yet (the header's (a), ruling R36), each once, in the order Bring-in posts
// them: [{ type, id }], `type` a key of FIN_HR_SOURCES and `id` the HR row the event is kept by (a sheet round's anchor), and hidden
// people's ended months last as { type: 'hidden', id: YYYYMM }. `asOf` is the plant's today, when a month has ended. `qc` is any query
// function (the pool's q, or a transaction's qc); this writes nothing.
export async function finHrPending(qc, bookId, { asOf = plantDateStr() } = {}) {
  if (!finIsValidDate(asOf)) throw finError(400, 'FIN_BAD_DATE');
  const book = await finCatchupBook(qc, bookId);
  const [{ begin }] = await qc('SELECT min(books_begin) AS begin FROM fin_books');
  const homeId = await finHomeBookId(qc);
  const events = [];
  for (const c of await qc(FIN_PENDING_SQL, [book.id, book.code, begin])) {
    if (await finWaitsIn(qc, book, homeId, c)) events.push({ type: c.type, id: c.id });
  }
  events.sort(finByOrder);
  for (const month of await finHiddenMonthsWaitingIn(qc, book, asOf)) events.push({ type: 'hidden', id: month });
  return events;
}

// The header's (b): the events whose voucher posted in the book has a reversal waiting for an Approver, or sent back by one (ruling
// R36a: a draft), as [{ type, id }] (a combined entry as its month, { type: 'hidden', id: YYYYMM }).
async function finReversalsWaitingIn(qx, bookId) {
  const rows = await qx(
    `SELECT DISTINCT regexp_replace(v.source_type, ':DP$', '') AS key, v.source_id AS id
       FROM fin_vouchers v
      WHERE v.book_id = $1 AND v.source_type LIKE 'hr\\_%' AND v.status = 'posted' AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
        AND EXISTS (SELECT 1 FROM fin_vouchers r WHERE r.reversal_of_id = v.id AND r.status IN ('submitted', 'draft'))`, [bookId]);
  return rows.map(r => ({ type: finTypeOfSource(r.key), id: r.id })).filter(ev => ev.type != null);
}

// The header line of a book (spec §5): { waiting, exceptions, control }. `waiting` counts each HR event whose entry in the book is not
// posted yet once (the header's (a) and (b)); `exceptions` the book's open exceptions (finHrExceptionsOf's); `control` the control check
// as at `today`, the plant's date (finHrControl). Counts and totals only: read through the pool.
export async function finHrStatus(bookId, { today = plantDateStr() } = {}) {
  const book = await finCatchupBook(q, bookId);
  const waiting = new Set((await finHrPending(q, book.id, { asOf: today })).map(finKeyOf));
  for (const ev of await finReversalsWaitingIn(q, book.id)) waiting.add(finKeyOf(ev));
  const [{ n }] = await q(
    `SELECT count(*)::int AS n FROM fin_hr_exceptions e WHERE e.resolved_at IS NULL AND ${FIN_HR_EXCEPTION_BOOK_SQL} = $1`, [book.id]);
  return { waiting: waiting.size, exceptions: n, control: await finHrControl(q, book.id, today, { today }) };
}

// ── Bring-in (spec §7.7; rulings R38, R38a, R53) ─────────────────────────────────────────────

// How long one Bring-in may go on (ruling R38a): it stops between two pieces of work once this is spent, and says there is more.
const FIN_BRING_IN_BUDGET_MS = 20000;

// The first day of the calendar month before `day`'s, and the last day of `day`'s: the window drift repair looks in (ruling R38a).
const finMonthBeforeStart = day => {
  const [y, m] = day.split('-').map(Number);
  return m === 1 ? `${String(y - 1).padStart(4, '0')}-12-01` : `${day.slice(0, 4)}-${String(m - 1).padStart(2, '0')}-01`;
};
const finMonthEndOf = day => {
  const [y, m] = day.split('-').map(Number);
  return finDayBefore(m === 12 ? `${String(y + 1).padStart(4, '0')}-01-01` : `${day.slice(0, 4)}-${String(m + 1).padStart(2, '0')}-01`);
};

// Bring-in's repair of what the call after commit missed (rulings R38, R38a, R38b): the events of the vouchers posted in the book, not
// reversed, in a month that is not locked, dated in the calendar month of `asOf` or the one before, newest first (by voucher id), and
// after `cursor` when there is one (older than that voucher): where the last press stopped. Each with `voucher`, its voucher's id, which
// is where a press that stops after it goes on from. Hidden people's combined entries are finHrPostHidden's, which compares them itself.
async function finDriftIn(qx, bookId, asOf, cursor) {
  const rows = await qx(
    `SELECT regexp_replace(v.source_type, ':DP$', '') AS key, v.source_id AS id, max(v.id) AS voucher
       FROM fin_vouchers v JOIN fin_periods p ON p.id = v.period_id
      WHERE v.book_id = $1 AND v.status = 'posted' AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
        AND v.source_type LIKE 'hr\\_%' AND v.source_type NOT LIKE 'hr\\_hidden:%' AND p.status <> 'locked'
        AND v.voucher_date >= $2 AND v.voucher_date <= $3 AND ($4::int IS NULL OR v.id < $4)
      GROUP BY 1, 2 ORDER BY voucher DESC`, [bookId, finMonthBeforeStart(asOf), finMonthEndOf(asOf), cursor]);
  return rows.map(r => ({ type: FIN_TYPE_OF.get(r.key) ?? null, id: r.id, voucher: r.voucher })).filter(ev => ev.type != null);
}

// Where drift repair goes on in a book (ruling R38b, fin_book_settings.hr_drift_cursor): a voucher id, or null for the newest; and
// saved. Written only when it moves (each write pings the book's screens), in a feed transaction (finHrFeedTx: its lock timeout first,
// ruling R73), the one write Bring-in makes of its own: everything else it does goes through finHrPost and finHrPostHidden.
const finDriftCursorOf = async (qx, bookId) => (await qx('SELECT hr_drift_cursor FROM fin_book_settings WHERE book_id = $1', [bookId]))[0]
  ?.hr_drift_cursor ?? null;
const finSaveDriftCursor = (bookId, cursor) => finHrFeedTx(qc => qc(
  `INSERT INTO fin_book_settings (book_id, hr_drift_cursor) VALUES ($1, $2)
   ON CONFLICT (book_id) DO UPDATE SET hr_drift_cursor = EXCLUDED.hr_drift_cursor`, [bookId, cursor]));

// The book's open exceptions as the events they are of (rulings R53, R38b), least recently tried first, so one that fails again goes to
// the back of the next press's list: each tried again as its Retry would (finHrRetryException): hidden people's (`hr_hidden:…`) as
// { type: 'hidden' }, their combined entries (finHrPostHidden with retry), any other by finHrPost of its own event.
async function finFailingIn(qx, bookId) {
  const rows = await qx(
    `SELECT e.source_type AS key, e.source_id AS id FROM fin_hr_exceptions e
      WHERE e.resolved_at IS NULL AND ${FIN_HR_EXCEPTION_BOOK_SQL} = $1
      ORDER BY e.last_tried_at ASC NULLS FIRST, e.id`, [bookId]);
  return rows.map(r => (finTypeOfSource(r.key) === 'hidden' ? { type: 'hidden' } : { type: FIN_TYPE_OF.get(r.key) ?? null, id: r.id }))
    .filter(ev => ev.type != null);
}

// The batches whose live voucher still books a line (its cover list): a line that left its batch (ruling R45) posts only once its batch
// is posted again without it, so Bring-in posts that batch first.
const finBatchesHolding = async (qx, lineId) => (await qx(
  `SELECT DISTINCT cv.source_id AS id FROM fin_hr_covers c JOIN fin_vouchers cv ON cv.id = c.voucher_id
    WHERE c.source_type = 'hr_line_pay' AND c.source_id = $1 AND cv.source_type IN ('hr_batch', 'hr_batch:DP')
      AND cv.status IN ('submitted', 'posted') AND cv.reversed_by_id IS NULL AND cv.reversal_of_id IS NULL ORDER BY 1`, [lineId]))
  .map(r => ({ type: 'batch', id: r.id }));

// What one post came to, as Bring-in counts it (and finHrPostHidden counts its own): `already` (it stood as HR says it should) is
// skipped; a voucher made and posted is posted; one waiting for an Approver, or a reversal that waits, submitted; an exception its code.
function finTally(out, answer) {
  if (answer.already) out.skipped += 1;
  else if (answer.result === 'posted') out.posted += 1;
  else if (answer.result === 'submitted' || answer.reversal?.result === 'submitted') out.submitted += 1;
  else if (answer.result === 'exception') out.exceptions.push(answer.reason_code);
  else out.skipped += 1;
}

const finWhoOf = who => {
  if (!Number.isSafeInteger(who?.id) || typeof who?.name !== 'string' || !who.name.trim()) {
    throw new Error('Bring-in posts in the name of the login asking for it: pass { id, name }');
  }
  return { id: who.id, name: who.name };
};

// "Bring in from HR" for a book (the header comment; rulings R38a, R38b, R53): `who` is the Finance login asking ({ id, name }), with
// `enter` on the book (the route asks), in whose name the entries are made, `<name> (HR)`, and whose HR approval, if it is an HR
// approver, a reversal carries. In this order, each event once: (1) what waits (finHrPending; a line that left its batch after that
// batch, R45); (2) the book's open exceptions, least recently tried first (R53, R38b; hidden people's as their combined entries); (3)
// hidden people's combined entries (finHrPostHidden, retry), unless (2) ran them; (4) drift repair in the month of `asOf` and the one
// before, newest first, going on after where the last press stopped (finDriftIn). What is worked on is read once, at the start. It
// stops between two pieces of work once `budgetMs` has gone by (20 s; the first piece always runs) and answers `more: true`: work this
// press did not reach remains. Stopped in the drift, it saves the voucher it stopped after, and the next press goes on from there; gone
// through to the end, it starts the next from the newest. `asOf` is the plant's today; it, the budget and `clock` (the milliseconds now)
// are for tests, and a route passes none. Never throws for an event: each one that cannot post is an exception. Answers { posted,
// submitted, skipped, exceptions: [their codes], more }, hidden people's combined entries counted in.
export async function finBringInFromHr(bookId, who, { asOf = plantDateStr(), budgetMs = FIN_BRING_IN_BUDGET_MS, clock = Date.now } = {}) {
  const started = clock();
  const by = finWhoOf(who);
  if (!finIsValidDate(asOf)) throw finError(400, 'FIN_BAD_DATE');
  const book = await finCatchupBook(q, bookId);
  const work = [];
  const queued = new Set();
  const queue = ev => {
    if (queued.has(finKeyOf(ev))) return;
    queued.add(finKeyOf(ev));
    work.push(ev);
  };
  for (const ev of await finHrPending(q, book.id, { asOf })) {
    if (ev.type === 'hidden') continue;   // (3) posts them
    if (ev.type === 'line') for (const batch of await finBatchesHolding(q, ev.id)) queue(batch);
    queue(ev);
  }
  for (const ev of await finFailingIn(q, book.id)) queue(ev);
  queue({ type: 'hidden' });
  const cursor = await finDriftCursorOf(q, book.id);
  for (const ev of await finDriftIn(q, book.id, asOf, cursor)) queue(ev);

  const out = { posted: 0, submitted: 0, skipped: 0, exceptions: [], more: false };
  let after = null;   // the drift voucher checked last
  for (const [i, ev] of work.entries()) {
    if (i > 0 && clock() - started >= budgetMs) {
      out.more = true;
      break;
    }
    if (ev.type !== 'hidden') {
      finTally(out, await finHrPost(ev, by));
      if (ev.voucher != null) after = ev.voucher;
      continue;
    }
    const hidden = await finHrPostHidden(by, { asOf, retry: true });
    out.posted += hidden.posted;
    out.submitted += hidden.submitted;
    out.skipped += hidden.skipped;
    out.exceptions.push(...hidden.exceptions);
  }
  // Where the next press goes on (ruling R38b): after the drift voucher this one checked last, if it stopped in the drift; from the
  // newest, if it went through to the end; else where this one would have started.
  const next = !out.more ? null : after ?? cursor;
  if (next !== cursor) await finSaveDriftCursor(book.id, next);
  return out;
}

// ── Exceptions (spec §7.7) ────────────────────────────────────────────────────────────────────

// An exception's row, with its event's HR document number where the row has one: a batch's CI-PAY-…, a round's sheet CI-ADV-…, a
// loan's (or a prepayment's loan's) CI-LN-….
const FIN_EXCEPTION_SQL = `
  SELECT e.id, e.source_type, e.source_id, e.reason_code, e.reason, e.first_seen_at, e.last_tried_at, e.resolved_at, e.voucher_id,
         CASE e.source_type
           WHEN 'hr_batch' THEN (SELECT b.batch_no FROM hr.payment_batches b WHERE b.id = e.source_id)
           WHEN 'hr_sheet' THEN (SELECT s.sheet_no FROM hr.advance_sheet_lines sl JOIN hr.advance_sheets s ON s.id = sl.sheet_id
                                  WHERE sl.id = e.source_id)
           WHEN 'hr_loan' THEN (SELECT l.loan_no FROM hr.loans l WHERE l.id = e.source_id)
           WHEN 'hr_prepay' THEN (SELECT l.loan_no FROM hr.loan_txns t JOIN hr.loans l ON l.id = t.loan_id WHERE t.id = e.source_id)
         END AS document_no
    FROM fin_hr_exceptions e`;

// An exception as the screen gets it: the event (`type`, a key of FIN_HR_SOURCES or `hidden`; `hr_id`, its HR row id, a round's line
// or a hidden month's YYYYMM; `document_no`, HR's document number or null), the reason (`reason_code`, `reason` its sentence), when it
// was first seen and last tried, the fix (FIN_HR_FIX: map_channel, reopen_month, retry, ask_md), and once resolved when and by which voucher.
const finExceptionOut = row => ({
  id: row.id, type: finTypeOfSource(row.source_type), hr_id: row.source_id, document_no: row.document_no ?? null,
  reason_code: row.reason_code, reason: row.reason, fix: finFixOf(row.reason_code),
  first_seen_at: row.first_seen_at, last_tried_at: row.last_tried_at, resolved_at: row.resolved_at, voucher_id: row.voucher_id,
});

// A book's open exceptions, newest first: { exceptions: [finExceptionOut] }. One that names no book lists under CI's.
export async function finHrExceptionsOf(bookId) {
  const book = await finCatchupBook(q, bookId);
  const rows = await q(
    `${FIN_EXCEPTION_SQL} WHERE e.resolved_at IS NULL AND ${FIN_HR_EXCEPTION_BOOK_SQL} = $1 ORDER BY e.first_seen_at DESC, e.id DESC`, [book.id]);
  return { exceptions: rows.map(finExceptionOut) };
}

// Try an exception's event again, in the name of `who` (the Finance login, { id, name }), and answer the exception as it now stands:
// { exception: finExceptionOut }, resolved with its voucher when the event posts, else its reason now, last tried now. Hidden people's
// (`hr_hidden:…`) is tried with their combined entries (finHrPostHidden, as at `asOf`); any other by finHrPost of its own event, the type
// whose FIN_HR_SOURCES key is its source_type. One resolved already is answered as it is. FIN_NOT_FOUND when there is none.
export async function finHrRetryException(exceptionId, who, { asOf = plantDateStr() } = {}) {
  const by = finWhoOf(who);
  const id = finIdOf(exceptionId);
  const read = async () => (id == null ? null : one(`${FIN_EXCEPTION_SQL} WHERE e.id = $1`, [id]));
  const row = await read();
  if (!row) throw finError(404, 'FIN_NOT_FOUND');
  if (row.resolved_at == null) {
    const type = finTypeOfSource(row.source_type);
    if (type === 'hidden') await finHrPostHidden(by, { asOf, retry: true });
    else if (type != null) await finHrPost({ type, id: row.source_id }, by);
  }
  return { exception: finExceptionOut(await read()) };
}

// ── The control check (spec §7.5, §9.5; ruling R37) ──────────────────────────────────────────

// Finance's balance of each staff role ledger of book $1, from its posted lines dated $2 or before, as debit − credit in paise.
const FIN_STAFF_BALANCES_SQL = `
  SELECT r.role, (SELECT COALESCE(round(sum(ln.debit - ln.credit) * 100), 0)::bigint
                    FROM fin_voucher_lines ln JOIN fin_vouchers v ON v.id = ln.voucher_id
                   WHERE ln.ledger_id = r.ledger_id AND v.status = 'posted' AND v.voucher_date <= $2) AS net
    FROM fin_ledger_roles r
   WHERE r.book_id = $1 AND r.role IN ('staff_advances', 'staff_loans', 'salary_payable')`;

// The day Finance books each finalised run's payroll journal in book $4 (code $1), and the run's month end (ruling R52): the journal's own
// date where one stands (posted, or waiting for an Approver), else the day the book's payroll setting dates it (§7.8): the month end, or
// with when_paid the book's first payment in the run, NULL while nothing of the book's is paid.
const FIN_JOURNAL_DAYS_SQL = `journal AS (
    SELECT r.id AS run_id, (date_trunc('month', to_date(r.month, 'YYYY-MM')) + interval '1 month - 1 day')::date AS month_end,
           COALESCE(
             (SELECT v.voucher_date::date FROM fin_vouchers v
               WHERE v.book_id = $4 AND v.source_type IN ('hr_run', 'hr_run:DP') AND v.source_id = r.id AND ${finHrLiveSql('v')}
               ORDER BY v.id LIMIT 1),
             CASE WHEN COALESCE((SELECT s.payroll_booking FROM fin_book_settings s WHERE s.book_id = $4), 'month_end') = 'month_end'
                  THEN (date_trunc('month', to_date(r.month, 'YYYY-MM')) + interval '1 month - 1 day')::date
                  ELSE ${finHrFirstPaymentSql('r.id', '$1')} END) AS day
      FROM hr.runs r WHERE r.status = 'finalised')`;

// HR's figures for the people of payroll book $1 (id $4) as at $2: each row counted on the day Finance books it (ruling R52). A row a
// payroll run made (its run_id; whatever its own date, as hr/correction.js dates the rows it adds at the month end): its recoveries
// (`recovered`, a sub-account's included; a loan's `payroll_recovery`) on that run's journal day in the book, and the advances its
// payroll sheet gave (`given`) on the day it was finalised, but for a run whose month is before the books begin, whose sheet advances
// are the Tally opening's and count on HR's own date for them, that month's end (ruling R68); every other row on its own date. Recoveries whose journal is not dated yet
// (when_paid, nothing paid) are not due: in HR's own figure once their month has ended, and in not_due. So are hidden people's rows that
// their combined entries book only once their month ends (ruling R37): Finance books them on or after $3 (the later of the books' first
// day and the first day of today's month), and no live voucher books them yet.
const FIN_HR_ADVANCES_SQL = `
  WITH ${FIN_JOURNAL_DAYS_SQL}
  SELECT COALESCE(round(sum(x.signed) * 100), 0)::bigint AS hr_paise,
         COALESCE(round(sum(x.signed) FILTER (WHERE x.not_due) * 100), 0)::bigint AS not_due_paise
    FROM (SELECT CASE WHEN t.kind IN ('opening', 'given', 'adjustment') THEN t.amount ELSE -t.amount END AS signed,
                 d.day, d.awaiting, j.month_end,
                 (d.awaiting OR (t.kind IN ('given', 'waived') AND t.reverses_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM hr.advance_txns x WHERE x.reverses_id = t.id)
                  AND (t.kind = 'waived' OR t.source = 'manual' OR (t.source = 'payroll' AND r.status = 'finalised' AND r.finalised_at IS NOT NULL))
                  AND ${finHiddenUnbooked('t.person_id', `(CASE WHEN t.kind = 'waived' THEN 'hr_waiver' ELSE 'hr_advance' END)`, 't.id')}
                  AND d.day >= $3::date)) AS not_due
            FROM hr.advance_txns t JOIN hr.people p ON p.id = t.person_id LEFT JOIN hr.runs r ON r.id = t.run_id
            LEFT JOIN journal j ON j.run_id = t.run_id
            CROSS JOIN LATERAL (
              SELECT CASE WHEN t.run_id IS NULL OR t.source <> 'payroll' THEN t.txn_date
                          WHEN t.kind = 'given' AND ${finHrMonthEndSql('r.month')} < (SELECT bb.books_begin FROM fin_books bb WHERE bb.id = $4)::date
                            THEN t.txn_date
                          WHEN t.kind = 'given' THEN ${finPlantDay('r.finalised_at')}
                          WHEN t.kind = 'recovered' THEN j.day
                          ELSE t.txn_date END AS day,
                     (t.run_id IS NOT NULL AND t.source = 'payroll' AND t.kind = 'recovered' AND j.run_id IS NOT NULL AND j.day IS NULL) AS awaiting) d
           WHERE ${FIN_HR_BOOK_SQL} = $1) x
   WHERE (x.day IS NOT NULL AND x.day <= $2::date) OR (x.awaiting AND x.month_end <= $2::date)`;
const FIN_HR_LOANS_SQL = `
  WITH ${FIN_JOURNAL_DAYS_SQL}
  SELECT COALESCE(round(sum(x.signed) * 100), 0)::bigint AS hr_paise,
         COALESCE(round(sum(x.signed) FILTER (WHERE x.not_due) * 100), 0)::bigint AS not_due_paise
    FROM (SELECT CASE WHEN t.kind IN ('disbursed', 'opening', 'adjustment') THEN t.principal_amount ELSE -t.principal_amount END AS signed,
                 d.day, d.awaiting, j.month_end,
                 (d.awaiting OR (${finHrHiddenSql('l.person_id')} AND t.txn_date >= $3::date
                  AND ((t.kind = 'disbursed' AND NOT l.is_opening AND l.status <> 'cancelled'
                        AND t.id = (SELECT min(dd.id) FROM hr.loan_txns dd WHERE dd.loan_id = l.id AND dd.kind = 'disbursed')
                        AND ${finHrBookedSql(`'hr_loan'`, 'l.id')} IS NULL)
                    OR (t.kind = 'prepayment' AND ${finHrBookedSql(`'hr_prepay'`, 't.id')} IS NULL)))) AS not_due
            FROM hr.loan_txns t JOIN hr.loans l ON l.id = t.loan_id JOIN hr.people p ON p.id = l.person_id
            LEFT JOIN journal j ON j.run_id = t.run_id
            CROSS JOIN LATERAL (
              SELECT CASE WHEN t.kind = 'payroll_recovery' AND t.run_id IS NOT NULL THEN j.day ELSE t.txn_date END AS day,
                     (t.kind = 'payroll_recovery' AND t.run_id IS NOT NULL AND j.run_id IS NOT NULL AND j.day IS NULL) AS awaiting) d
           WHERE ${FIN_HR_BOOK_SQL} = $1) x
   WHERE (x.day IS NOT NULL AND x.day <= $2::date) OR (x.awaiting AND x.month_end <= $2::date)`;
// The day HR paid run line `l` (in batch `b`, LEFT JOINed): its own day for it, else the plant day it was marked paid.
const finPaidDaySql = (l, b) => `COALESCE(${l}.paid_on, ${b}.paid_on, ${finPlantDay(`${l}.paid_at`)}, ${finPlantDay(`${b}.confirmed_at`)})`;
// Whether HR had paid run line `l` by $2: paid, in a confirmed batch or on its own, by that day.
const finPaidBySql = (l, b, day) => `(${l}.payment_status = 'paid' AND (${l}.payment_batch_id IS NULL OR ${b}.status = 'confirmed') AND ${day} <= $2::date)`;
// What a correction of a paid month carried into a later month (ruling R54's adjustments, by the correction's audit row, never by its
// words) that no voucher standing in book $4 dated $2 or before books yet (ruling R52a): an earning HR still owes the person adds to
// HR's Salary Payable, a deduction it will take back lowers it. Counted from the day the corrected line was paid: before that the line
// is unpaid, and its payable, as corrected, is in HR's figure itself.
const FIN_HR_CARRIED_SQL = `
  SELECT COALESCE(round(sum(CASE WHEN a.kind = 'earning' THEN a.amount ELSE -a.amount END) * 100), 0)::bigint
    FROM (SELECT DISTINCT ON (al.detail->>'adjustment_id') (al.detail->>'adjustment_id')::int AS adjustment_id, al.entity_id
            FROM hr.audit_log al
           WHERE al.entity = 'run_line' AND al.action = 'finalised_correction' AND al.detail->>'adjustment_id' ~ '^[0-9]+$'
           ORDER BY al.detail->>'adjustment_id', al.id) c
    JOIN hr.adjustments a ON a.id = c.adjustment_id
    JOIN hr.people p ON p.id = a.person_id
    JOIN hr.run_lines cl ON cl.id::text = c.entity_id
    LEFT JOIN hr.payment_batches cb ON cb.id = cl.payment_batch_id
   WHERE a.status = 'approved' AND ${FIN_HR_BOOK_SQL} = $1 AND ${finPaidBySql('cl', 'cb', finPaidDaySql('cl', 'cb'))}
     AND NOT EXISTS (
       SELECT 1 FROM hr.run_lines bl JOIN fin_vouchers v ON v.source_id = bl.run_id AND v.source_type IN ('hr_run', 'hr_run:DP')
        WHERE bl.person_id = a.person_id AND v.book_id = $4 AND ${finHrLiveSql('v')} AND v.voucher_date::date <= $2::date
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(bl.breakdown) = 'array' THEN bl.breakdown ELSE '[]'::jsonb END) x
                       WHERE x->>'code' = 'ADJ:' || a.id AND (x->>'amount')::numeric > 0))`;
// HR's Salary Payable for the people of payroll book $1 (id $4) as at $2 (ruling R52a): the payable of the finalised runs' lines that
// HR had not paid by then, each run counted from the day Finance books its journal (FIN_JOURNAL_DAYS_SQL: the journal that stands,
// else the month end), and what a correction carried that no journal books yet (FIN_HR_CARRIED_SQL); and what of the lines paid by
// then was paid to hidden people that no live voucher books yet.
const FIN_HR_PAYABLE_SQL = `
  WITH ${FIN_JOURNAL_DAYS_SQL}
  SELECT COALESCE(round(sum(l.payable) FILTER (WHERE NOT x.paid) * 100), 0)::bigint AS unpaid_paise,
         COALESCE(round(sum(l.paid_amount) FILTER (WHERE x.paid AND x.not_due) * 100), 0)::bigint AS not_due_paid_paise,
         (${FIN_HR_CARRIED_SQL}) AS carried_paise
    FROM hr.run_lines l JOIN journal j ON j.run_id = l.run_id JOIN hr.people p ON p.id = l.person_id
    LEFT JOIN hr.payment_batches b ON b.id = l.payment_batch_id
    CROSS JOIN LATERAL (SELECT ${finPaidDaySql('l', 'b')} AS day) d
    CROSS JOIN LATERAL (
      SELECT ${finPaidBySql('l', 'b', 'd.day')} AS paid,
             (${finHiddenUnbooked('l.person_id', `'hr_line_pay'`, 'l.id')} AND d.day >= $3::date) AS not_due) x
   WHERE j.day <= $2::date AND ${FIN_HR_BOOK_SQL} = $1`;

const finLater = (a, b) => (a > b ? a : b);
const finNegated = paise => 0 - paise;   // never a -0, which strict equality tells from 0
// One item of the check: Finance's balance, HR's figure less what is not due in Finance yet, and the gap. What is not due is left out
// silently (ruling R37b): no figure of it is given, as one would move by a single hidden person's money.
const finItem = (financePaise, hrOwnPaise, notDuePaise) => {
  const hr = hrOwnPaise - notDuePaise;
  return { finance_paise: financePaise, hr_paise: hr, gap_paise: hr - financePaise };
};

// The control check of a book as at `asAt` (the header comment): { as_at, advances, loans, salary_payable (null with when_paid),
// matches }, each item { finance_paise, hr_paise, gap_paise }, totals of the book's people only. `today` is the
// plant's date, which says whose month has ended. `qc` is any query function; this writes nothing.
export async function finHrControl(qc, bookId, asAt, { today = plantDateStr() } = {}) {
  if (!finIsValidDate(asAt)) throw finError(400, 'FIN_BAD_DATE', "Say the day the check is as at, written YYYY-MM-DD.", { field: 'as_at' });
  if (!finIsValidDate(today)) throw finError(400, 'FIN_BAD_DATE');
  const book = await finCatchupBook(qc, bookId);
  const day = finLater(asAt, finDayBefore(book.books_begin));   // nothing is kept before the opening day
  const notDueFrom = finLater(book.books_begin, `${today.slice(0, 7)}-01`);
  const params = [book.code, day, notDueFrom];
  const runParams = [...params, book.id];   // with the book's id, for its journal days (ruling R52)
  const [setting] = await qc('SELECT payroll_booking FROM fin_book_settings WHERE book_id = $1', [book.id]);
  const finance = new Map((await qc(FIN_STAFF_BALANCES_SQL, [book.id, day])).map(r => [r.role, r.net]));
  const net = role => finance.get(role) ?? 0;
  const [advances] = await qc(FIN_HR_ADVANCES_SQL, runParams);
  const [loans] = await qc(FIN_HR_LOANS_SQL, runParams);
  const accrues = (setting?.payroll_booking ?? 'month_end') === 'month_end';
  const payable = accrues ? (await qc(FIN_HR_PAYABLE_SQL, runParams))[0] : null;
  const out = {
    as_at: day,
    advances: finItem(net('staff_advances'), advances.hr_paise, advances.not_due_paise),
    loans: finItem(net('staff_loans'), loans.hr_paise, loans.not_due_paise),
    // A liability: its balance is credit − debit, and a payout paid that Finance does not book yet lowers HR's figure.
    salary_payable: payable && finItem(finNegated(net('salary_payable')), payable.unpaid_paise + payable.carried_paise,
      finNegated(payable.not_due_paid_paise)),
  };
  return { ...out, matches: [out.advances, out.loans, out.salary_payable].every(item => item == null || item.gap_paise === 0) };
}
