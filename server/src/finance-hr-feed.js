// Finance — HR's staff money in the books (Cash & Bank spec §7.2–§7.8; rulings R18–R28). HR stays the only place staff money is entered
// (§7.1). Each HR money event posts its Finance voucher (one per book it touches), after HR's own transaction has committed, and never
// blocks HR: what Finance cannot post waits as an exception, with its reason. When HR undoes or corrects an event, its voucher is
// reversed, and the corrected entry posted (§7.2). The payroll month and hidden people's combined entries are read in
// finance-hr-payroll.js; this posts them as it posts the rest.
//   • FIN_HR_SOURCES    each event's source key, which its vouchers carry in source_type, with the HR row's id in source_id (H8: one
//                       live posting of each). A voucher in the DP book carries `<key>:DP`.
//   • finHrVoucherFor   what an event posts, worked out from HR's rows and Finance's setup, writing nothing: or why it posts nothing.
//   • finHrPost         makes the books say what HR says of one event, in a transaction of its own, and never throws.
//   • finHrReverse      takes an event's standing vouchers out of the books, in the caller's transaction.
//   • finHrPostHidden   posts hidden people's combined entries for every month that has ended, and never throws.
//   • finHrAfter        posts each event an HR request made, after that request's commit, then the combined entries now due.
//   • finHrRunLines     the payroll month's journal of one book (finance-hr-payroll.js).
// finance-hr-catchup.js (Task 13: what waits, Bring-in, exceptions, the control check) reads with finHrVoucherFor and finHrHiddenDue,
// and judges as this does with FIN_HR_UNDONE and finLeftItsBatch.
//
// The events (§7.2), each named by its HR row, with the business date it is dated by:
//   advance        hr.advance_txns, kind given, source manual: Pay staff, or Give advance on Loans & Advances        txn_date
//                  Dr Staff Advances · Cr the account it was paid from
//   sheet          a POSTING ROUND of an advance sheet (ruling R23): the hr.advance_sheet_lines one post made,       the rows' own date
//                  the same sheet_id and the same posted_at (HR stamps a round inside one transaction). It is named    (the sheet's paid_on
//                  by any of its line ids and kept under the smallest (the round's anchor), which a posted line        when the round posted)
//                  never changes: one entry per round, however many rounds the sheet takes. It is booked from the
//                  advances and loans the round MADE (ruling R25), never from the lines or the sheet as they stand;
//                  a loan HR cancels since leaves it, and the round is posted again without it (ruling R48).
//                  Dr Staff Advances (advance lines) · Dr Staff Loans (loan lines) · Cr the account paid from
//   loan           hr.loans: its disbursal, the 'disbursed' hr.loan_txns row                                         that row's txn_date
//                  Dr Staff Loans · Cr the account
//   prepay         hr.loan_txns, kind prepayment: money coming back                                                  txn_date
//                  Dr the account it came into · Cr Staff Loans
//   batch          hr.payment_batches, confirmed: its lines still paid, but one that left it (below)                 paid_on (else the
//                  Dr Salary Payable · Cr the channel's account, or the cash chosen                                    plant day of confirmed_at)
//   line           hr.run_lines marked paid without a batch, or one that left its batch: paid again on its own      paid_on (else the
//                  from another account than the batch's (ruling R45: finLeftItsBatch)                                 plant day of paid_at)
//                  Dr Salary Payable · Cr the account
//   waiver         hr.advance_txns, kind waived                                                                      txn_date
//                  journal · Dr the advance waiver ledger · Cr Staff Advances
//   run            hr.runs, finalised: the payroll month's journal, one per payroll book (finHrRunLines)              the month end, or the
//                                                                                                                      first payment (§7.8)
//   sheetAdvances  hr.runs, finalised: the advances its payroll sheet gave, as finalise posted them               the day it was finalised
//                  Dr Staff Advances · Cr the CASH channel's account; none for a run whose month comes before the books
//                  (HR dates them at that month's end: the Tally opening holds them, ruling R68)
// An event posts nothing of its own, and is `skipped`, when it is dated before its book's books begin (`before_books`: its effect is in
// the Tally opening, §7.7), when its row is not the event asked for, when HR holds nothing for it now (`not_finalised`, `cancelled`,
// `reversed`, `not_paid`, …), when it is a hidden person's (`hidden`, below), when another entry books it (`in_combined`, below), and
// when it posts with something else: an advance or a loan an advance sheet made posts with its round (`on_sheet`), a line paid in a
// batch with its batch (`in_batch`). A skip is no exception.
//
// HR undoes and corrects (§7.2: "an HR reversal, un-finalise, unpay or correction"). finHrPost makes the books say what HR says NOW:
//   • HR holds nothing for an event that has a standing voucher (FIN_HR_UNDONE: un-finalised, a loan cancelled, an advance a row
//     reverses, a line no longer paid, a batch with nothing still paid): that voucher is reversed (finHrReverse), and every HR draft of
//     the event an Approver sent back, in either book, is discarded (ruling R39): no voucher of any status stays for money HR took back;
//   • HR's figures for a run, a sheetAdvances, a batch, a line or a combined entry changed since its voucher was made, or the rows a
//     sheet's round books (a loan it made cancelled since, ruling R48) (the voucher keeps a fingerprint of HR's figures,
//     source_fingerprint, so a change of Finance's own setup since never counts): the voucher is reversed, and the corrected entry made
//     in the same transaction, if the reversal posts;
//   • a reversal is dated at the voucher it takes out, never today (ruling R67), as the corrected entry is dated by HR back in the same
//     month: so the month holds one entry, and no later month holds the reversal alone. A locked month refuses it, and the event waits as
//     an exception (reopen the month, §7.7);
//   • a reversal posts at once when the HR login doing it is an HR approver (it is approved in HR), else it waits for an Approver under
//     the `reversal` rule (§7.6); while it waits, the old voucher stands (H8), so the corrected entry waits behind it: `reversal_waiting`,
//     and the next post of the event, once the reversal is approved, makes it;
//   • a voucher still waiting for an Approver is never reversed: it is withdrawn (finWithdrawVoucher), never having reached the books;
//   • a reversal is never reversed (ruling: it carries no source, and the next post would book the event twice); the event is posted
//     afresh instead, which H8 allows once its earlier voucher is reversed.
// A pair is judged book by book (ruling R34). For each book an event touches (HR's rows, as Finance's setup posts them now), a voucher
// that stands (posted and not reversed, or waiting for an Approver) is kept, and a book with none (its voucher sent back by an Approver,
// or discarded by hand) has its voucher made again, alone, its sent-back draft discarded first (R22). The event answers `already` only
// when every book it touches stands, and lists its vouchers in book order, CI's first. A voucher is made again alone only when what
// stands is what HR's rows post now in its book (its type, date and lines: finStandsAsBuilt); else Finance's setup, or a person's firm,
// changed since the pair was made, and the event is made again whole once a voucher of it was sent back (the standing half taken out
// first), or left as it stands when none was (a change of Finance's setup never posts an entry again).
//
// The book (§7.2) is the payroll book of the event's people: COLOUR → CI, DARBI → DP, no firm → CI. The account (§7.3) is
// finResolvePaidFrom(the row's paid-from code, its channel), resolved when the event posts; none is FIN_UNMAPPED_CHANNEL. A role the
// voucher needs that has no ledger in the book is FIN_ROLE_MISSING. The staff ledgers are system-only (rulings R20, R20a); the feed's
// vouchers reach them because they carry a source (H6).
//
// The inter-company pair (§7.3; rulings R18, R24). Money that left an account of one book for people of the other posts ONE voucher per
// book, both in the one transaction, each under the event's source in its own book (`<key>`, `<key>:DP`):
//   • the account's book: the account line for the whole amount (Cr for money going out, Dr for money coming in), its own people's
//     lines, and one line on its `intercompany` role ledger for the other book's share;
//   • the other book: a journal of its people's lines and the opposite line on its own `intercompany` role ledger, which the journal rule
//     holds for an Approver unless HR approved the event (§7.6).
// Narrated in the payroll book as the event is, followed by "· paid by <the account's company>", and in the account's book followed by
// "· paid for <the payroll company>" (a batch: "Salary Nov · paid by Darbi Print Pack · CI-PAY-0041" and "Salary Nov · paid for Colour
// Impressions · CI-PAY-0041"); where the account's book holds people of its own too, its voucher keeps the event's own narration.
//
// Approval (§7.6). HR's approval counts, else the book's seeded rules apply (finSubmitVoucher, which this hands the HR approval to):
//   • a batch or a line carries its people's per-person payment approver (hr.run_lines.approved_by), a sheet round its lines' deciding
//     approver (decided_by), a waiver its approver: the latest of them, when every line has one;
//   • an advance, a loan or a prepayment carries its DOER's, the login that made the HR row, when that login is an HR approver or above
//     (ruling R26); a payroll month (and its sheet's advances) its finaliser's, else its approver's, when an HR approver did it;
//   • a reversal the approval of the HR login doing it;
//   • the voucher then posts unapproved when the rule needs no Approver; approved in HR's name when it needs one and HR approved it;
//     otherwise it waits, submitted, and the book's Approvers are told. Whenever HR approved it, its `post` row in the log records
//     approved_in_hr_by (ruling R26b).
// The voucher is made and submitted in the name of the HR login, `<name> (HR)`, with the roles of an accountant: never an Approver's,
// so nothing is ever approved here but by HR's own approval.
//
// Privacy (§7.4). Finance is given totals: a narration counts the people and names none of them, and carries HR's document number; a
// voucher's lines carry no words; its reference is HR's document number and never text a person typed. A single person's event carries
// that person's amount, as it must. People hidden from any login (hr.access_hidden, mode pay or all) are left out of every voucher of
// an event (ruling R21): their single events are skipped as `hidden`, and their lines are left out of batches, rounds and the sheet's
// advances. All their money posts instead in COMBINED entries (finHrPostHidden): per account and calendar month, one entry holding every
// hidden person's payouts, advances, loans and prepayments through it (`hr_hidden:<ledger id>`, source_id YYYYMM), and per month one
// journal of their waivers (`hr_hidden:waiver`), each only once its month has ended. Whether a person is hidden can change (ruling R27):
// an entry that books more HR rows than its own source's lists them (fin_hr_covers), every voucher of it, in both books of a pair, so
// that the half that stands books them while the other waits to be made again (R34); and a row is booked by the live voucher that is
// its own source or lists it. An event never books a row another live entry books (`in_combined`), and an entry keeps the rows it
// booked whoever is hidden now: what is booked keeps its booking (a one-person event whose own voucher stands is no hidden person's
// skip), what is not follows the hidden list as it is when it posts. The payroll month counts everyone (R21, §16).
//
// Transactions (§7.7). finHrPost runs after HR's commit, in a transaction of its own: a lock timeout of five seconds first of all,
// transaction-local, as every feed transaction sets it (ruling R73: finHrFeedTx; finHrReverse in its caller's), so a lock held long
// elsewhere makes the post give up and wait as an exception instead of holding HR's answer; then the feed's own lock,
// pg_advisory_xact_lock(7303, 0), which every feed transaction that books takes next (finHrPost, each combined
// entry of finHrPostHidden, finHrReverse inside its caller's) and nothing else ever takes, so the feed books one entry at a time and
// each reads what the last one committed (ruling R33: whether a person is hidden is read when an entry posts, and two entries posting
// at once, a batch and a combined entry, could otherwise both book one row); then a sheet event named by its round's anchor (ruling
// R28, before anything that can fail but that lock); the event's own lock, pg_advisory_xact_lock(7302, hashtext('<key>:<id>')), so two
// posts of one event go one after the other; HR's facts; the vouchers that stand for the event (H8); what to do, book by book (R34),
// worked out and built before anything is written; then every number series the transaction will take, in one sorted order
// (lockDocNumber), so two posts that each make vouchers in two series never wait for one another in a circle; then the reversals, the
// HR drafts an Approver sent back of the books it makes discarded (ruling R22; all of them when HR holds nothing for it, R39), the new
// vouchers (finCreateBuiltDraft, their cover list, finSubmitVoucher: series → voucher → party → months → ledgers), and the event's open
// exception marked resolved. What stands is marked before anything that can fail (ruling R40), so a failure is never answered as if the
// event stood. A failure rolls all of that back, and the exception is then written in a transaction of its own, under the
// event's lock again (finRecordException: it books nothing, so it needs no feed lock; nor do the feed's reads, finHrVoucherFor and the
// sweep's look for combined entries due, which write nothing). An exception is the event's, one row per (key, HR row id; a round's anchor; a combined
// entry's month), whichever book it would post to. HR's tables are read, never written, and never locked: Finance never holds HR up.

import { tx } from './db.js';
import { lockDocNumber } from './helpers.js';
import { FIN_SENTENCES, finError, finMapDbError } from './finance-errors.js';
import { finResolvePaidFrom } from './finance-hr-setup.js';
import { finIdOf } from './finance-masters.js';
import { finPrefix } from './finance-rules.js';
import {
  finCleanLines, finCreateBuiltDraft, finDiscardDraft, finReverseVoucher, finSubmitVoucher, finVoucherCtx, finWithdrawVoucher,
} from './finance-vouchers.js';
import {
  FIN_HR_BOOK_SQL, finByBook, finHrBookedSql, finHrCoveredSql, finHrDoerApproves, finHrFingerprint, finHrHiddenFacts, finHrHiddenGroups,
  finHrHiddenRows, finHrHiddenShape, finHrHiddenSql, finHrLiveSql, finHrMonthWord, finHrPeople, finHrRunFacts, finHrRunLines,
  finHrSheetAdvanceFacts, finHrUserOf, finPrint,
} from './finance-hr-payroll.js';
import { plantDateStr } from './plant-calendar.js';

export { finHrRunLines };

// The source key of each kind of HR event (plan, Task 10). The source_id is the HR row's id, but for hr_sheet, where it is a posting
// round's anchor, the smallest hr.advance_sheet_lines id of the round (R23), and for hr_run and hr_sheet_adv, the hr.runs id. Hidden
// people's combined entries carry `hr_hidden:<the account's ledger id>` or `hr_hidden:waiver`, with the month as YYYYMM (ruling R21).
// `intercompany` (hr_ic) is no longer used: each voucher of an inter-company pair carries its event's own key in its book (ruling R24:
// hr_ic with one integer id would collide across event types, and catch-up looks only at <key> and <key>:DP). It stays in the frozen map.
export const FIN_HR_SOURCES = Object.freeze({
  advance: 'hr_advance', sheet: 'hr_sheet', loan: 'hr_loan', prepay: 'hr_prepay', sheetAdvances: 'hr_sheet_adv',
  batch: 'hr_batch', line: 'hr_line_pay', run: 'hr_run', waiver: 'hr_waiver', hidden: 'hr_hidden', intercompany: 'hr_ic',
});

const FIN_HR_FEED_LOCK = Object.freeze([7303, 0]);   // pg_advisory_xact_lock(7303, 0): the feed books one entry at a time (ruling R33)
const FIN_HR_EVENT_LOCK = 7302;        // pg_advisory_xact_lock(7302, hashtext('<key>:<id>')): one HR event at a time
export const FIN_HR_HOME_BOOK = 'CI';  // the book whose HR vouchers carry the bare key; DP's carry `<key>:DP`; an unplaced exception's
// What HR holds nothing for any more: a voucher that stands for such an event is taken out of the books.
export const FIN_HR_UNDONE = new Set(['not_finalised', 'cancelled', 'reversed', 'not_paid', 'not_confirmed', 'nothing_paid']);
// The narration's word for why a row posts nothing of its own: the kind of live entry that books it (ruling R27).
const finCoveredReason = by => (by.startsWith('hr_hidden') ? 'in_combined' : by.startsWith('hr_batch') ? 'in_batch' : 'on_sheet');
const finSourceIn = (key, bookCode) => (bookCode === FIN_HR_HOME_BOOK ? key : `${key}:${bookCode}`);
// A one-person event's person is hidden (ruling R21) and no live voucher books its row: skipped as `hidden`, its money left to a combined
// entry. One its own live voucher books keeps that booking whoever is hidden now (R27), so a half of it an Approver sent back is made
// again (R34) rather than left out; one another live entry books is skipped before this is asked (`covered`).
const finHiddenUnbookedSql = (person, key, id) => `(${finHrHiddenSql(person)} AND ${finHrBookedSql(key, id)} IS NULL)`;

// A pay channel as a narration names it: its label, lower-cased ("cash", "colour bank"); its code when it has no label.
const finChannelWord = (label, code) => String(label || code || '').trim().toLowerCase();
// A run's salary as a narration names it: "Salary Jan · cash", or "Salary Jan" for a line paid with no channel.
const finSalaryOf = (month, label, code) => [`Salary ${finHrMonthWord(month)}`, finChannelWord(label, code)].filter(Boolean).join(' · ');

// ── What each event is, read from HR ────────────────────────────────────────────────────────
//
// Each reader takes the transaction's qc and the event, and answers { skip } when HR holds nothing for it to post now, or its facts:
//   { date, heldOn: HR's own date for the rows, when it comes before `date` (ruling R68: the books' start is judged by it), paid: the
//     account's { code, channel } or null (a journal), account: an account already resolved ({ book_id, ledger_id }),
//     parts: [{ book, people, postings: [{ role, side, paise }] }] (one per payroll book), covers: [{ book, source_type, source_id }] (the
//     HR rows it books beyond its own source's, ruling R27), narrate: people => its narration, pair: a batch's own pair narrations,
//     reference, approver, change: whether a change in HR's figures posts it again, fingerprint: of those figures }
// or, for an event booked by book apart (a run, a month's hidden waivers), { perBook: true, units: [{ book, people, date, fingerprint,
// runId | parts, covers, awaiting }], narrate, approver, change }.

// An event of one person's (§7.2): one part, in its payroll book.
function finOnePerson({ book, date, paid, postings, narrate, reference = null, approver, change = false, event }) {
  const parts = [{ book, people: 1, postings }];
  return {
    date, paid, parts, covers: [], narrate, reference, approver, change,
    fingerprint: finHrFingerprint({ event, date, paid, parts: finPrint(parts) }),
  };
}

async function finAdvanceEvent(qc, ev) {
  const [row] = await qc(
    `SELECT t.kind, t.source, t.reverses_id, t.txn_date::text AS txn_date, round(t.amount * 100)::bigint AS paise, t.paid_via, t.created_by,
            ${FIN_HR_BOOK_SQL} AS book, ${finHiddenUnbookedSql('t.person_id', `'hr_advance'`, 't.id')} AS hidden,
            ${finHrCoveredSql(`'hr_advance'`, 't.id')} AS covered,
            EXISTS (SELECT 1 FROM hr.advance_sheet_lines sl WHERE sl.advance_txn_id = t.id) AS on_sheet,
            EXISTS (SELECT 1 FROM hr.advance_txns r WHERE r.reverses_id = t.id) AS reversed,
            (SELECT a.detail->>'via' FROM hr.audit_log a
              WHERE a.entity = 'advance' AND a.entity_id = t.person_id::text AND a.action = 'give' AND a.detail->>'txn_id' = t.id::text
              ORDER BY a.id LIMIT 1) AS door
       FROM hr.advance_txns t JOIN hr.people p ON p.id = t.person_id
      WHERE t.id = $1`, [ev.id]);
  if (!row) return { skip: 'not_found' };
  if (row.kind !== 'given' || row.source !== 'manual' || row.reverses_id != null) return { skip: 'not_this_event' };
  if (row.reversed) return { skip: 'reversed' };                       // taken back in HR: a voucher that stood for it is reversed
  if (row.covered) return { skip: finCoveredReason(row.covered) };     // another live entry books it (ruling R27)
  if (row.hidden) return { skip: 'hidden' };
  if (row.on_sheet || row.door === 'advance_sheet') return { skip: 'on_sheet' };
  // HR's own trail says which door it came through: Pay staff writes via 'staff_payment'; Give advance on Loans & Advances writes none.
  const door = row.door === 'staff_payment' ? 'Pay staff' : 'Loans & Advances';
  return finOnePerson({
    event: 'advance', book: row.book, date: row.txn_date, paid: { code: row.paid_via, channel: null },
    postings: [{ role: 'staff_advances', side: 'debit', paise: row.paise }],
    narrate: n => `Advance · ${door} · ${finHrPeople(n)}`, approver: await finHrDoerApproves(qc, row.created_by),
  });
}

async function finWaiverEvent(qc, ev) {
  const [row] = await qc(
    `SELECT t.kind, t.reverses_id, t.txn_date::text AS txn_date, round(t.amount * 100)::bigint AS paise, t.created_by, ${FIN_HR_BOOK_SQL} AS book,
            ${finHiddenUnbookedSql('t.person_id', `'hr_waiver'`, 't.id')} AS hidden, ${finHrCoveredSql(`'hr_waiver'`, 't.id')} AS covered,
            EXISTS (SELECT 1 FROM hr.advance_txns r WHERE r.reverses_id = t.id) AS reversed
       FROM hr.advance_txns t JOIN hr.people p ON p.id = t.person_id
      WHERE t.id = $1`, [ev.id]);
  if (!row) return { skip: 'not_found' };
  if (row.kind !== 'waived' || row.reverses_id != null) return { skip: 'not_this_event' };
  if (row.reversed) return { skip: 'reversed' };
  if (row.covered) return { skip: finCoveredReason(row.covered) };
  if (row.hidden) return { skip: 'hidden' };
  return finOnePerson({
    event: 'waiver', book: row.book, date: row.txn_date, paid: null,
    postings: [{ role: 'advance_waiver', side: 'debit', paise: row.paise }, { role: 'staff_advances', side: 'credit', paise: row.paise }],
    narrate: n => `Advance waived · ${finHrPeople(n)}`, approver: await finHrUserOf(qc, row.created_by),
  });
}

async function finLoanEvent(qc, ev) {
  const [row] = await qc(
    `SELECT l.loan_no, l.is_opening, l.status, l.paid_via, l.created_by, ${FIN_HR_BOOK_SQL} AS book,
            ${finHiddenUnbookedSql('l.person_id', `'hr_loan'`, 'l.id')} AS hidden,
            ${finHrCoveredSql(`'hr_loan'`, 'l.id')} AS covered,
            d.txn_date::text AS disbursed_on, round(d.principal_amount * 100)::bigint AS paise, d.paid_via AS disbursed_via,
            EXISTS (SELECT 1 FROM hr.advance_sheet_lines sl WHERE sl.loan_id = l.id) AS on_sheet,
            (SELECT a.detail->>'via' FROM hr.audit_log a
              WHERE a.entity = 'loan' AND a.entity_id = l.id::text AND a.action = 'create' ORDER BY a.id LIMIT 1) AS door
       FROM hr.loans l JOIN hr.people p ON p.id = l.person_id
       LEFT JOIN LATERAL (SELECT txn_date, principal_amount, paid_via FROM hr.loan_txns
                           WHERE loan_id = l.id AND kind = 'disbursed' ORDER BY id LIMIT 1) d ON true
      WHERE l.id = $1`, [ev.id]);
  if (!row) return { skip: 'not_found' };
  if (row.is_opening) return { skip: 'opening_balance' };   // a balance brought into HR, in the Tally opening: no money given
  if (row.disbursed_on == null) return { skip: 'not_this_event' };
  // Cancelled as a mistake before anything was taken back (an adjustment cancels it in HR): a voucher that stood for it is reversed.
  if (row.status === 'cancelled') return { skip: 'cancelled' };
  if (row.covered) return { skip: finCoveredReason(row.covered) };
  if (row.hidden) return { skip: 'hidden' };
  // A loan an advance sheet made posts with its round, never on its own, even once no line of the sheet links it any more (ruling R25):
  // HR's own trail says where it came from, as it does for an advance (its 'create' row, via 'advance_sheet').
  if (row.on_sheet || row.door === 'advance_sheet') return { skip: 'on_sheet' };
  return finOnePerson({
    event: 'loan', book: row.book, date: row.disbursed_on, paid: { code: row.disbursed_via ?? row.paid_via, channel: null },
    postings: [{ role: 'staff_loans', side: 'debit', paise: row.paise }], reference: row.loan_no,
    narrate: n => `Loan · ${row.loan_no} · ${finHrPeople(n)}`, approver: await finHrDoerApproves(qc, row.created_by),
  });
}

async function finPrepayEvent(qc, ev) {
  const [row] = await qc(
    `SELECT t.kind, t.txn_date::text AS txn_date, round(t.principal_amount * 100)::bigint AS paise, t.paid_via, t.created_by, l.loan_no,
            ${FIN_HR_BOOK_SQL} AS book, ${finHiddenUnbookedSql('l.person_id', `'hr_prepay'`, 't.id')} AS hidden, ${finHrCoveredSql(`'hr_prepay'`, 't.id')} AS covered
       FROM hr.loan_txns t JOIN hr.loans l ON l.id = t.loan_id JOIN hr.people p ON p.id = l.person_id
      WHERE t.id = $1`, [ev.id]);
  if (!row) return { skip: 'not_found' };
  if (row.kind !== 'prepayment') return { skip: 'not_this_event' };
  if (row.covered) return { skip: finCoveredReason(row.covered) };
  if (row.hidden) return { skip: 'hidden' };
  return finOnePerson({
    event: 'prepay', book: row.book, date: row.txn_date, paid: { code: row.paid_via, channel: null },
    postings: [{ role: 'staff_loans', side: 'credit', paise: row.paise }], reference: row.loan_no,
    narrate: () => `Loan repaid · ${row.loan_no}`, approver: await finHrDoerApproves(qc, row.created_by),
  });
}

// Rows an event books (ruling R27): those its own live voucher already books, whoever is hidden now, and those no live entry books, of
// people not hidden now. A row another live entry books stays there.
const finBookable = (rows, own) => rows.filter(r => r.booked_by === own || (!r.hidden && r.booked_by == null));
// Why an event with rows books none of them: hidden people's, or booked elsewhere.
const finNoneBookable = rows => (rows.some(r => r.hidden && r.booked_by == null) ? 'hidden' : rows.length ? finCoveredReason(rows.find(r => r.booked_by).booked_by) : 'nothing_paid');
// Postings in the order a voucher lists them.
const FIN_ROLE_ORDER = ['salary_payable', 'staff_advances', 'staff_loans'];
const finOrdered = parts => parts.map(p => ({ ...p, postings: [...p.postings].sort((a, b) => FIN_ROLE_ORDER.indexOf(a.role) - FIN_ROLE_ORDER.indexOf(b.role)) }));

// A sheet's posting round (ruling R23), named by its anchor (finAnchorOf). It is booked from the rows the round MADE (ruling R25): each
// hr.advance_txns row (advance_txn_id) or loan (loan_id, with its disbursal) of the lines posted with it, the same sheet and the same
// posted_at, and each row its own live entry books (its cover list) whose line is gone since; never from the lines and the sheet as they
// stand: HR lets a sheet a round has posted from go back to draft, its paid_on and paid_via changed, so only those rows say what was paid.
// The amounts and the date are theirs; the account is the paid-from code one of them stores (one post pays every row of a round from one
// account; a loan keeps it on hr.loans; the anchor's row first, a loan cancelled since among them), else the sheet's paid_via. A line
// linked to no row books nothing, and a loan HR has cancelled since books nothing (ruling R48): HR holds nothing for it. The sheet's own
// status does not matter. Hidden people's rows are left out (R21), a row another live entry books too (R27). Approval is the round's
// lines' deciders. Its fingerprint is the rows it books (R48), so a loan cancelled since posts the round again without it, and a change
// to the sheet or its lines never does (R25).
async function finSheetEvent(qc, ev) {
  const made = await qc(
    `WITH posted AS (
       SELECT sl.id AS line_id, sl.decided_by, sl.decided_at, sl.advance_txn_id, sl.loan_id
         FROM hr.advance_sheet_lines a
         JOIN hr.advance_sheet_lines sl ON sl.sheet_id = a.sheet_id AND sl.posted_at = a.posted_at
        WHERE a.id = $1),
     gone AS (
       SELECT DISTINCT c.source_type, c.source_id
         FROM fin_hr_covers c JOIN fin_vouchers v ON v.id = c.voucher_id
        WHERE v.source_type IN ('hr_sheet', 'hr_sheet:DP') AND v.source_id = $1 AND ${finHrLiveSql('v')}
          AND (c.source_type = 'hr_advance' AND c.source_id NOT IN (SELECT advance_txn_id FROM posted WHERE advance_txn_id IS NOT NULL)
            OR c.source_type = 'hr_loan' AND c.source_id NOT IN (SELECT loan_id FROM posted WHERE loan_id IS NOT NULL))),
     made AS (
       SELECT line_id, decided_by, decided_at, advance_txn_id, loan_id FROM posted
       UNION ALL
       SELECT NULL, NULL, NULL, CASE WHEN source_type = 'hr_advance' THEN source_id END, CASE WHEN source_type = 'hr_loan' THEN source_id END
         FROM gone)
     SELECT made.line_id, s.sheet_no, s.paid_via AS sheet_via, made.decided_by, made.decided_at, paid.kind, paid.row_id AS id,
            paid.person_id, round(paid.amount * 100)::bigint AS paise, paid.paid_on, paid.paid_via, paid.cancelled, ${FIN_HR_BOOK_SQL} AS book,
            ${finHrHiddenSql('p.id')} AS hidden, ${finHrBookedSql('paid.cover_type', 'paid.row_id')} AS booked_by, paid.cover_type
       FROM made
       CROSS JOIN (SELECT sh.sheet_no, sh.paid_via FROM hr.advance_sheet_lines a JOIN hr.advance_sheets sh ON sh.id = a.sheet_id
                    WHERE a.id = $1) s
       CROSS JOIN LATERAL (
         SELECT 'advance' AS kind, 'hr_advance' AS cover_type, t.id AS row_id, t.person_id, t.amount, t.txn_date::text AS paid_on, t.paid_via,
                false AS cancelled
           FROM hr.advance_txns t WHERE t.id = made.advance_txn_id
         UNION ALL
         SELECT 'loan', 'hr_loan', ln.id, ln.person_id, COALESCE(d.principal_amount, ln.principal), COALESCE(d.txn_date, ln.issued_on)::text,
                COALESCE(d.paid_via, ln.paid_via), ln.status = 'cancelled'
           FROM hr.loans ln
           LEFT JOIN LATERAL (SELECT txn_date, principal_amount, paid_via FROM hr.loan_txns
                               WHERE loan_id = ln.id AND kind = 'disbursed' ORDER BY id LIMIT 1) d ON true
          WHERE ln.id = made.loan_id) paid
       JOIN hr.people p ON p.id = paid.person_id
      ORDER BY made.line_id NULLS LAST, paid.cover_type, paid.row_id`, [ev.id]);
  const rows = made.filter(r => !r.cancelled);   // HR holds nothing for a loan it cancelled (ruling R48)
  if (!rows.length) return { skip: 'nothing_paid' };   // a round that made nothing, or nothing HR still holds
  const booked = finBookable(rows, `${ev.key}#${ev.id}`);
  if (!booked.length) return { skip: finNoneBookable(rows) };
  const parts = finOrdered(finByBook(booked, r => [{ role: r.kind === 'advance' ? 'staff_advances' : 'staff_loans', side: 'debit' }]));
  if (parts.every(p => p.postings.every(x => x.paise === 0))) return { skip: 'nothing_paid' };
  const { sheet_no: sheetNo, sheet_via: sheetVia } = made[0];
  const date = booked.map(r => r.paid_on).sort()[0];
  const code = made.find(r => r.paid_via != null)?.paid_via ?? sheetVia;
  const decided = booked.every(r => r.decided_by != null)
    ? [...booked].sort((x, y) => (y.decided_at ?? 0) - (x.decided_at ?? 0) || y.line_id - x.line_id)[0].decided_by : null;
  const ids = booked.map(r => [r.cover_type, r.id]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
  return {
    date, paid: { code, channel: null }, parts, reference: sheetNo, change: true,
    covers: booked.map(r => ({ book: r.book, source_type: r.cover_type, source_id: r.id })),
    narrate: n => `Advances · sheet ${sheetNo} · ${finHrPeople(n)}`, approver: decided == null ? null : await finHrUserOf(qc, decided),
    fingerprint: finHrFingerprint({ event: 'sheet', rows: ids }),
  };
}

// A line its batch paid, that failed and was paid again on its own (HR keeps the batch link), carries a paid-from code of its own
// (ruling R45). When that names another account than its batch's, the line has left the batch: the batch leaves it out, and the line
// is booked as an event of its own, from its own account. With no code of its own, or one naming the batch's account, it stays in
// the batch. Both accounts are resolved as Finance's setup stands (finResolvePaidFrom); `batchAccount` is the batch's.
export async function finLeftItsBatch(qc, line, batchAccount) {
  if (line.paid_from == null) return false;
  const own = await finResolvePaidFrom(qc, line.paid_from, line.pay_channel);
  return (own?.ledger_id ?? null) !== (batchAccount?.ledger_id ?? null);
}

async function finBatchEvent(qc, ev) {
  const [batch] = await qc(
    `SELECT b.status, b.batch_no, b.paid_on::text AS paid_on, b.confirmed_at, b.paid_from, b.pay_channel, r.month, c.label
       FROM hr.payment_batches b JOIN hr.runs r ON r.id = b.run_id LEFT JOIN hr.pay_channels c ON c.code = b.pay_channel
      WHERE b.id = $1`, [ev.id]);
  if (!batch) return { skip: 'not_found' };
  if (batch.status !== 'confirmed') return { skip: 'not_confirmed' };
  // Its lines still paid, as totals: hidden people's left out (R21), a line another live entry books (R27), and a line that left the
  // batch (R45), which is booked on its own.
  const stillPaid = await qc(
    `SELECT l.id, l.person_id, round(l.paid_amount * 100)::bigint AS paise, l.approved_by, l.approved_at, l.paid_from, l.pay_channel,
            ${FIN_HR_BOOK_SQL} AS book, ${finHrHiddenSql('l.person_id')} AS hidden, ${finHrBookedSql(`'hr_line_pay'`, 'l.id')} AS booked_by
       FROM hr.run_lines l JOIN hr.people p ON p.id = l.person_id
      WHERE l.payment_batch_id = $1 AND l.payment_status = 'paid'
      ORDER BY l.id`, [ev.id]);
  const batchAccount = stillPaid.some(r => r.paid_from != null) ? await finResolvePaidFrom(qc, batch.paid_from, batch.pay_channel) : null;
  const rows = [];
  for (const r of stillPaid) if (!(await finLeftItsBatch(qc, r, batchAccount))) rows.push(r);
  const booked = finBookable(rows, `${ev.key}#${ev.id}`);
  if (rows.length && !booked.length) return { skip: finNoneBookable(rows) };
  const parts = finByBook(booked, () => [{ role: 'salary_payable', side: 'debit' }]);
  if (!booked.length || parts.every(p => p.postings[0].paise === 0)) return { skip: 'nothing_paid' };
  const approved = booked.every(r => r.approved_by != null)
    ? [...booked].sort((x, y) => (y.approved_at ?? 0) - (x.approved_at ?? 0) || y.id - x.id)[0].approved_by : null;
  const date = batch.paid_on ?? (batch.confirmed_at ? plantDateStr(batch.confirmed_at) : null);
  const paid = { code: batch.paid_from, channel: batch.pay_channel };
  const pairWords = word => [`Salary ${finHrMonthWord(batch.month)}`, word, batch.batch_no].filter(Boolean).join(' · ');
  return {
    date, paid, parts, reference: batch.batch_no, change: true,
    covers: booked.map(r => ({ book: r.book, source_type: 'hr_line_pay', source_id: r.id })),
    narrate: n => [finSalaryOf(batch.month, batch.label, batch.pay_channel), batch.batch_no, finHrPeople(n)].filter(Boolean).join(' · '),
    pair: { by: company => pairWords(`paid by ${company}`), for: company => pairWords(`paid for ${company}`) },
    approver: approved == null ? null : await finHrUserOf(qc, approved),
    fingerprint: finHrFingerprint({ event: 'batch', date, paid, parts: finPrint(parts), rows: booked.map(r => r.id) }),
  };
}

async function finLineEvent(qc, ev) {
  const [line] = await qc(
    `SELECT l.payment_status, l.payment_batch_id, round(l.paid_amount * 100)::bigint AS paise, l.paid_on::text AS paid_on, l.paid_at,
            l.paid_from, l.pay_channel, l.approved_by, r.month, c.label, ${FIN_HR_BOOK_SQL} AS book,
            b.paid_from AS batch_paid_from, b.pay_channel AS batch_channel,
            ${finHiddenUnbookedSql('l.person_id', `'hr_line_pay'`, 'l.id')} AS hidden,
            ${finHrCoveredSql(`'hr_line_pay'`, 'l.id')} AS covered
       FROM hr.run_lines l JOIN hr.runs r ON r.id = l.run_id JOIN hr.people p ON p.id = l.person_id
       LEFT JOIN hr.pay_channels c ON c.code = l.pay_channel LEFT JOIN hr.payment_batches b ON b.id = l.payment_batch_id
      WHERE l.id = $1`, [ev.id]);
  if (!line) return { skip: 'not_found' };
  if (line.payment_status !== 'paid') return { skip: 'not_paid' };     // marked failed, reversed or unpaid since: reversed
  // A line in a batch posts with it, unless it was paid again on its own from another account (ruling R45).
  if (line.payment_batch_id != null) {
    const left = line.paid_from != null
      && await finLeftItsBatch(qc, line, await finResolvePaidFrom(qc, line.batch_paid_from, line.batch_channel));
    if (!left) return { skip: 'in_batch' };
  }
  if (line.covered) return { skip: finCoveredReason(line.covered) };
  if (line.hidden) return { skip: 'hidden' };
  if (!(line.paise > 0)) return { skip: 'nothing_paid' };
  return finOnePerson({
    event: 'line', book: line.book, date: line.paid_on ?? (line.paid_at ? plantDateStr(line.paid_at) : null),
    paid: { code: line.paid_from, channel: line.pay_channel }, postings: [{ role: 'salary_payable', side: 'debit', paise: line.paise }],
    narrate: n => `${finSalaryOf(line.month, line.label, line.pay_channel)} · ${finHrPeople(n)}`, change: true,
    approver: await finHrUserOf(qc, line.approved_by),
  });
}

// The events of finHrPost, by type: part 1's here, the payroll month's in finance-hr-payroll.js.
const FIN_HR_EVENTS = Object.freeze({
  advance: finAdvanceEvent, sheet: finSheetEvent, loan: finLoanEvent, prepay: finPrepayEvent,
  batch: finBatchEvent, line: finLineEvent, waiver: finWaiverEvent, run: finHrRunFacts, sheetAdvances: finHrSheetAdvanceFacts,
});

// An event as asked: { type, id, key, ids, anchored } of a type finHrPost posts and a row id, or null. `ids` are the ids an exception of
// it may be kept under (its own; for a sheet round, every line of the round, finAnchorOf), and `anchored` whether `id` is the id the
// event is kept by: only a sheet event's needs finding (R23).
function finEventOf(event) {
  const type = event?.type;
  const id = finIdOf(event?.id);
  if (typeof type !== 'string' || !Object.hasOwn(FIN_HR_EVENTS, type) || id == null) return null;
  return { type, id, key: FIN_HR_SOURCES[type], ids: [id], anchored: type !== 'sheet' };
}

// The event under the id it is kept by (rulings R23, R28). A sheet event names a posting round by any of its line ids: it is kept under
// the round's anchor, the smallest id among the lines of that sheet posted at that same moment (a posted line never changes, so the anchor
// does not either), and an exception of the round may sit under any of its line ids (`ids`, the round's lines, smallest first). A line
// that is not there, or not posted, is no round: { …, skip }. Every other event is kept by its own row's id.
async function finAnchorOf(qc, ev) {
  if (ev.type !== 'sheet') return ev;
  const [line] = await qc(
    `SELECT a.posted_at IS NOT NULL AS posted,
            (SELECT array_agg(sl.id ORDER BY sl.id) FROM hr.advance_sheet_lines sl
              WHERE sl.sheet_id = a.sheet_id AND sl.posted_at = a.posted_at) AS ids
       FROM hr.advance_sheet_lines a WHERE a.id = $1`, [ev.id]);
  if (!line) return { ...ev, skip: 'not_found' };
  if (!line.posted) return { ...ev, skip: 'not_posted' };
  return { ...ev, id: line.ids[0], ids: line.ids, anchored: true };
}

// ── The vouchers an event posts ──────────────────────────────────────────────────────────────

// The books an event names, by code: { id, code, name, books_begin }. A payroll book that is not set up is FIN_NOT_FOUND.
async function finHrBooksOf(qc, codes) {
  const wanted = [...new Set(codes)];
  const books = new Map((await qc('SELECT id, code, name, books_begin FROM fin_books WHERE code = ANY($1::text[]) ORDER BY id', [wanted]))
    .map(b => [b.code, b]));
  const absent = wanted.find(code => !books.has(code));
  if (absent) throw finError(409, 'FIN_NOT_FOUND', `The ${absent} book isn't set up in Finance yet.`);
  return books;
}

// A book's ledgers for the roles its voucher names, or FIN_ROLE_MISSING (`seen` is told the book, so the exception names it).
async function finHrRolesOf(qc, book, roles, seen) {
  const wanted = [...new Set(roles)];
  if (!wanted.length) return new Map();
  const found = new Map((await qc('SELECT role, ledger_id FROM fin_ledger_roles WHERE book_id = $1 AND role = ANY($2::text[])', [book.id, wanted]))
    .map(r => [r.role, r.ledger_id]));
  if (wanted.some(role => !found.has(role))) {
    seen.book_id = book.id;
    throw finError(409, 'FIN_ROLE_MISSING');
  }
  return found;
}

const finNet = part => part.postings.reduce((t, x) => t + (x.side === 'debit' ? x.paise : -x.paise), 0);
const finLine = e => ({ ledger_id: e.ledger_id, debit_paise: e.side === 'debit' ? e.paise : 0, credit_paise: e.side === 'credit' ? e.paise : 0 });

// The vouchers of one unit of an event (the event whole, or one book of a run or of a month's hidden waivers), from its facts: the
// book, the date against the books' start, the account, the pair, the roles, the lines. `seen` is told the book as soon as it is known,
// so an exception can name it. Answers { vouchers: [{ book_id, voucher_type, voucher_date, narration, reference, lines, source_type,
// source_id, hr_approved_by, covers, fingerprint }] } in book order, or { skip }. Throws the refusal an exception records.
async function finBuild(qc, ev, facts, unit, seen) {
  if (unit.runId != null) {
    const book = (await finHrBooksOf(qc, [unit.book])).get(unit.book);
    seen.book_id = book.id;
    if (unit.date < book.books_begin) return { skip: 'before_books' };
    const lines = await finHrRunLines(qc, unit.runId, book.id);
    if (!lines.length) return { skip: 'nothing_paid' };
    return { vouchers: [{
      book_id: book.id, voucher_type: 'journal', voucher_date: unit.date, narration: facts.narrate(unit.people), reference: null, lines,
      source_type: finSourceIn(ev.key, book.code), source_id: ev.id, hr_approved_by: facts.approver, covers: [], fingerprint: unit.fingerprint,
    }] };
  }
  const parts = (unit.parts ?? facts.parts).map(p => ({ ...p, postings: p.postings.filter(x => x.paise > 0) })).filter(p => p.postings.length);
  if (!parts.length) return { skip: 'nothing_paid' };
  const books = await finHrBooksOf(qc, parts.map(p => p.book));
  if (parts.length === 1) seen.book_id = books.get(parts[0].book).id;
  const date = unit.date ?? facts.date;
  if (date == null) throw finError(409, 'FIN_BAD_DATE', 'HR has no date for this payment.');
  // Before the books begin (§7.7): the opening holds it already. Asked before anything else of Finance, so it is never an exception.
  // Judged by the event's own date, or by HR's own date for its rows where that is earlier than the voucher's (`heldOn`: the advances on
  // a payroll sheet, dated in HR at the month end when finalised later, ruling R68).
  const held = unit.heldOn ?? facts.heldOn ?? date;
  if (held < [...books.values()].map(b => b.books_begin).sort()[0]) return { skip: 'before_books' };
  let account = facts.account ?? null;
  if (!account && facts.paid) {
    account = await finResolvePaidFrom(qc, facts.paid.code ?? null, facts.paid.channel ?? null);
    if (!account) throw finError(409, 'FIN_UNMAPPED_CHANNEL');
  }
  const byId = new Map([...books.values()].map(b => [b.id, b]));
  if (account && !byId.has(account.book_id)) {
    const [b] = await qc('SELECT id, code, name, books_begin FROM fin_books WHERE id = $1', [account.book_id]);
    byId.set(b.id, b);
    if (held < b.books_begin) return { skip: 'before_books' };
  }
  seen.book_id ??= account ? account.book_id : null;
  const covers = unit.covers ?? facts.covers ?? [];
  const people = list => list.reduce((t, p) => t + p.people, 0);
  const plans = [];   // { book, entries: [{ role | ledger_id, side, paise }], narration, type }
  if (!account) {
    for (const part of parts) plans.push({ book: books.get(part.book), entries: part.postings, narration: facts.narrate(part.people), type: 'journal' });
  } else {
    // The account's book: its own people's lines, the other book's share on its inter-company ledger, the account for the whole amount.
    const home = byId.get(account.book_id);
    const own = parts.find(p => p.book === home.code) ?? null;
    const others = parts.filter(p => p.book !== home.code);
    const entries = own ? [...own.postings] : [];
    for (const o of others) {
      const n = finNet(o);
      if (n !== 0) entries.push({ role: 'intercompany', side: n > 0 ? 'debit' : 'credit', paise: Math.abs(n) });
    }
    const total = parts.reduce((t, p) => t + finNet(p), 0);
    if (total !== 0) entries.push({ ledger_id: account.ledger_id, side: total > 0 ? 'credit' : 'debit', paise: Math.abs(total) });
    const payrollNames = others.map(o => books.get(o.book).name).join(' and ');
    plans.push({
      book: home, entries, type: total > 0 ? 'payment' : total < 0 ? 'receipt' : 'journal',
      narration: own || !others.length ? facts.narrate(people(parts))
        : facts.pair ? facts.pair.for(payrollNames) : `${facts.narrate(people(others))} · paid for ${payrollNames}`,
    });
    // The other book: a journal of its people's lines, and the opposite line on its own inter-company ledger.
    for (const o of others) {
      const n = finNet(o);
      const mine = [...o.postings];
      if (n !== 0) mine.push({ role: 'intercompany', side: n > 0 ? 'credit' : 'debit', paise: Math.abs(n) });
      plans.push({
        book: books.get(o.book), entries: mine, type: 'journal',
        narration: facts.pair ? facts.pair.by(home.name) : `${facts.narrate(o.people)} · paid by ${home.name}`,
      });
    }
  }
  plans.sort((a, b) => a.book.id - b.book.id);
  const vouchers = [];
  for (const plan of plans) {
    const roles = await finHrRolesOf(qc, plan.book, plan.entries.filter(e => e.role).map(e => e.role), seen);
    const entries = plan.entries.map(e => ({ ...e, ledger_id: e.ledger_id ?? roles.get(e.role) }));
    vouchers.push({
      book_id: plan.book.id, voucher_type: plan.type, voucher_date: date, narration: plan.narration, reference: facts.reference ?? null,
      lines: [...entries.filter(e => e.side === 'debit'), ...entries.filter(e => e.side === 'credit')].map(finLine),
      source_type: finSourceIn(ev.key, plan.book.code), source_id: ev.id, hr_approved_by: facts.approver ?? null,
      covers, fingerprint: unit.fingerprint ?? facts.fingerprint,   // every row the event books, on each voucher of it (ruling R27)
    });
  }
  return { vouchers };
}

// A built voucher as finHrVoucherFor answers it: what it is, without the list of rows it books or its fingerprint; with `prints`, its
// fingerprint and whether a change of it posts the event again (`change`), as finHrPost compares them with what stands.
const finShown = ({ covers, fingerprint, ...voucher }) => voucher;
const finShownWithPrint = change => built => ({ ...finShown(built), fingerprint: built.fingerprint ?? null, change });

// What an HR event posts, worked out from HR's rows and Finance's setup, writing nothing, in the transaction of `qc`: { book_id,
// voucher_type, voucher_date, narration, reference, lines, source_type, source_id, hr_approved_by: { id, name } | null } for an event of
// one voucher; { vouchers: [those] } for one that posts in both books (an inter-company pair, a run of both books' people); or { skip, … }
// when it posts nothing of its own (an unknown event is skipped too). It says what HR's rows post now, whatever stands in the books.
// `event` is { type, id }: the id of its HR row, or for a sheet ANY line id of the posting round, whose voucher is kept under the round's
// anchor (source_id, ruling R23). Throws the refusal finHrPost records as an exception: FIN_UNMAPPED_CHANNEL, FIN_ROLE_MISSING, ….
// `seen`, when given, is told the book as finHrPost's own build tells it (`book_id`), so a refusal can be placed in the book its
// exception will name (finance-hr-catchup.js counts what waits in each book). `prints` keeps each voucher's fingerprint and `change`
// (finShownWithPrint), for a caller that compares it with the voucher standing (ruling R36a).
export async function finHrVoucherFor(qc, event, { seen = {}, prints = false } = {}) {
  const asked = finEventOf(event);
  if (!asked) return { skip: 'unknown_event', source_type: null, source_id: finIdOf(event?.id) };
  const ev = await finAnchorOf(qc, asked);
  const skipped = reason => ({ skip: reason, source_type: ev.key, source_id: ev.id });
  if (ev.skip) return skipped(ev.skip);
  const facts = await FIN_HR_EVENTS[ev.type](qc, ev);
  if (facts.skip) return skipped(facts.skip);
  const vouchers = [];
  let skip = null;
  for (const unit of facts.perBook ? facts.units : [facts]) {
    if (unit.awaiting) { skip ??= unit.awaiting; continue; }
    const built = await finBuild(qc, ev, facts, unit, seen);
    if (built.skip) skip ??= built.skip;
    else vouchers.push(...built.vouchers);
  }
  if (!vouchers.length) return skipped(skip ?? 'nothing_paid');
  const shown = prints ? finShownWithPrint(facts.change === true) : finShown;
  return vouchers.length === 1 ? shown(vouchers[0]) : { vouchers: vouchers.map(shown) };
}

// ── Posting it ───────────────────────────────────────────────────────────────────────────────

// The HR login an event posts in the name of: `<name> (HR)`, with an accountant's roles (plan, Task 10). A post with nobody to blame is
// a bug in the caller, which the event's exception then says.
function finHrActor(who) {
  const name = typeof who?.name === 'string' ? who.name.trim() : '';
  if (!Number.isSafeInteger(who?.id) || !name) throw new Error('An HR event posts in the name of the HR login that made it: pass { id, name, hrLevel }');
  return { id: who.id, name: `${name} (HR)`, roles: ['accountant'] };
}

// How long a feed transaction waits for any lock (ruling R73), set as the first statement of every one of them, before the feed's own
// lock: transaction-local (set_config's third argument), never a session SET, which would stay on a pooled connection past this
// transaction (PgBouncer's transaction pooling hands the connection on). A lock waited for longer gives up (55P03, FIN_BUSY), so a long
// Bring-in holding the feed lock holds HR's answer up for about five seconds at most (§7.7: it never blocks HR, and a stalled answer
// invites a second HR action): a post that gave up is the event's exception, or, if even that could not be written, `recorded: false`,
// and Bring-in posts it either way.
const FIN_FEED_LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', '5s', true)";
const finFeedTimeout = qc => qc(FIN_FEED_LOCK_TIMEOUT_SQL);
// A transaction of the feed's: the lock timeout first, then `work(qc, oc)`. Every transaction the feed opens is one (finHrPost's, each
// combined entry's, an exception's, the reads that pick what is due); finHrReverse runs in its caller's and sets it there itself.
// finance-hr-catchup.js writes through it too.
export const finHrFeedTx = work => tx(async (qc, oc) => {
  await finFeedTimeout(qc);
  return work(qc, oc);
});

// The feed's own lock, the first statement of every feed transaction that books (ruling R33), after the lock timeout (R73); no
// transaction outside the feed takes it, so it adds no circle to any lock order. A transaction that holds it already takes it again at
// no cost (advisory locks re-enter).
const finLockFeed = qc => qc('SELECT pg_advisory_xact_lock($1::int, $2::int)', FIN_HR_FEED_LOCK);
const finLockEvent = (qc, ev) => qc('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [FIN_HR_EVENT_LOCK, `${ev.key}:${ev.id}`]);

// The vouchers that stand for an event (H8), in either book: posted or waiting for an Approver, and not reversed, each with the reversal
// of it on its way, if any (a draft an Approver sent back, or submitted). Its reversals carry no source of their own, so they are never it.
const finStandingOf = (qc, ev) => qc(
  `SELECT v.id, v.status, v.book_id, b.code AS book_code, v.voucher_type, v.voucher_date, v.source_fingerprint,
          r.id AS reversal_id, r.status AS reversal_status, r.voucher_date AS reversal_date
     FROM fin_vouchers v JOIN fin_books b ON b.id = v.book_id
     LEFT JOIN LATERAL (SELECT id, status, voucher_date FROM fin_vouchers
                         WHERE reversal_of_id = v.id AND status IN ('draft', 'submitted') ORDER BY id LIMIT 1) r ON true
    WHERE v.source_type = ANY($1::text[]) AND v.source_id = $2 AND v.status IN ('submitted', 'posted')
      AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
    ORDER BY v.book_id, v.id`, [[ev.key, `${ev.key}:DP`], ev.id]);

const finStood = standing => ({
  result: standing.some(s => s.status !== 'posted') ? 'submitted' : 'posted', voucher_id: standing[0].id,
  ...(standing.length > 1 ? { voucher_ids: standing.map(s => s.id) } : {}), already: true,
});

// The event's open exception, closed: it has a voucher now (`voucherId`), or nothing to post (null). For a sheet round, one kept under any
// line of the round is closed too (ruling R28: an exception recorded when its round could not be read sits under the line that named it).
const finCloseException = (qc, ev, voucherId) => qc(
  `UPDATE fin_hr_exceptions SET resolved_at = now(), last_tried_at = now(), voucher_id = $3
    WHERE source_type = $1 AND source_id = ANY($2::int[]) AND resolved_at IS NULL`, [ev.key, ev.ids, voucherId]);

// The HR drafts of an event an Approver sent back, in either book (ruling R22): discarded before a new voucher is made for their book, so
// at most one HR voucher of a source stands outside reversals, and the new one is HR's rows as they are now. A reversal's draft carries
// no source.
const finSentBackOf = (qc, ev) => qc(
  `SELECT v.id, v.book_id, b.code AS book_code, v.voucher_type, v.voucher_date FROM fin_vouchers v JOIN fin_books b ON b.id = v.book_id
    WHERE v.source_type = ANY($1::text[]) AND v.source_id = $2 AND v.status = 'draft' AND v.reversal_of_id IS NULL ORDER BY v.id`,
  [[ev.key, `${ev.key}:DP`], ev.id]);

// Whether the vouchers that stand are what HR's rows post now in their books (`vouchers`, built): the same type, date and lines, so that
// a voucher made again alone for a book that does not stand pairs with them (ruling R34). Asked only when a book of the event does not stand.
async function finStandsAsBuilt(qc, standing, vouchers) {
  const lines = await qc(
    `SELECT voucher_id, ledger_id, round(debit * 100)::bigint AS debit_paise, round(credit * 100)::bigint AS credit_paise
       FROM fin_voucher_lines WHERE voucher_id = ANY($1::int[])`, [standing.map(s => s.id)]);
  const shape = list => list.map(l => `${l.ledger_id}:${l.debit_paise}:${l.credit_paise}`).sort().join(' ');
  return standing.every(s => {
    const v = vouchers.find(b => b.book_id === s.book_id);
    return v != null && v.voucher_type === s.voucher_type && v.voucher_date === s.voucher_date
      && shape(v.lines) === shape(lines.filter(l => l.voucher_id === s.id));
  });
}

// Each through the discard path (finDiscardDraft: its audited `discard`), the feed standing in for the maker whose event it is (`isAdmin`);
// finVoucherCtx first takes the draft's number series and then the draft, the order every posting locks in.
async function finDiscardDrafts(qc, oc, ids, actor) {
  for (const id of ids) {
    await finVoucherCtx(qc, oc, id);
    await finDiscardDraft(qc, oc, id, actor, { isAdmin: true });
  }
}

// The number series a transaction will take, locked up front in one sorted order (lockDocNumber; each posting takes its own again, which
// it then holds already): [{ book_id, type, date }]. A date no month holds names no series, and its posting refuses it FIN_NO_PERIOD.
async function finLockSeries(qc, oc, series) {
  if (!series.length) return;
  const rows = await qc(
    `SELECT DISTINCT b.code, y.short, x.type FROM unnest($1::int[], $2::text[], $3::text[]) AS x(book_id, type, day)
       JOIN fin_books b ON b.id = x.book_id
       JOIN fin_periods p ON p.book_id = x.book_id AND p.start_date <= x.day AND p.end_date >= x.day
       JOIN fin_years y ON y.id = p.year_id`,
    [series.map(s => s.book_id), series.map(s => s.type), series.map(s => s.date)]);
  for (const prefix of [...new Set(rows.map(r => finPrefix(r.code, r.type, r.short)))].sort()) await lockDocNumber(prefix, oc);
}

// The day an HR reversal is dated (ruling R67): the day of the voucher it takes out, never today. HR dates the entry that corrects it back
// in that same month (the payroll journal at its month end, a batch at its paid_on), so a reversal dated today would leave the month
// holding both the old entry and the corrected one for good, and a later month the reversal alone. Dated so, the pair mirrors the
// original in its own month; a month that is locked (its own, or a later one it carries into, SP1's rulings R70/R73) refuses it, and the
// event waits as an exception to reopen the month (§7.7). No clock is read here: nothing the feed makes or takes out is dated by today.
const finReversalDate = s => s.voucher_date;
// What taking a standing voucher out will lock: its reversal's journal series, on that day, and a sent-back reversal's draft's; or, for
// one still waiting, its own series.
const finUndoSeries = s => (s.status === 'submitted' ? [{ book_id: s.book_id, type: s.voucher_type, date: s.voucher_date }]
  : s.reversal_status === 'submitted' ? []
    : [{ book_id: s.book_id, type: 'journal', date: finReversalDate(s) },
      ...(s.reversal_status === 'draft' ? [{ book_id: s.book_id, type: 'journal', date: s.reversal_date }] : [])]);

// Takes standing vouchers out of the books, in this transaction, whose series are locked: one posted is reversed (fromHr), dated its own
// date (ruling R67), approved in HR by `approval` (the HR approver doing the HR action: it posts at once), else under the reversal
// rule, waiting for an Approver; one whose reversal waits already is left to it; one whose reversal an Approver sent back has that draft
// discarded and a new reversal made; one still waiting for an Approver itself is withdrawn (finWithdrawVoucher), never having posted.
// Never a reversal: a standing voucher is never one. Answers { result: 'posted' (every one reversed now, any waiting one withdrawn),
// 'submitted' (a reversal waits for an Approver), 'withdrawn' (only waiting ones, withdrawn) or 'none' (nothing stood), voucher_ids: the
// reversals made or waiting, withdrawn_ids }.
async function finHrUndo(qc, oc, standing, actor, approval, reason) {
  const posted = [];
  const waiting = [];
  const withdrawn = [];
  for (const s of standing) {
    if (s.status === 'submitted') {
      await finWithdrawVoucher(qc, oc, s.id, actor, reason);
      withdrawn.push(s.id);
      continue;
    }
    if (s.reversal_status === 'submitted') {
      waiting.push(s.reversal_id);
      continue;
    }
    if (s.reversal_status === 'draft') await finDiscardDrafts(qc, oc, [s.reversal_id], actor);
    const reversal = await finReverseVoucher(qc, oc, s.id, actor, { date: finReversalDate(s), reason, fromHr: true, approvedInHr: approval });
    (reversal.status === 'posted' ? posted : waiting).push(reversal.id);
  }
  const result = waiting.length ? 'submitted' : posted.length ? 'posted' : withdrawn.length ? 'withdrawn' : 'none';
  return { result, voucher_ids: [...posted, ...waiting], ...(withdrawn.length ? { withdrawn_ids: withdrawn } : {}) };
}

// Take an HR event's standing vouchers out of the books (§7.2, §7.6), in the caller's transaction: `sourceType` its source key (either
// book's: both books' vouchers of the event are reversed), `sourceId` its HR row id, `who` the HR login doing it ({ id, name }). A posted
// voucher is reversed with fromHr, dated its own date (ruling R67), and posts at once when `who` is an HR approver now (approved
// in HR in that name), else waits for an Approver under the `reversal` rule; while it waits the voucher stands (H8), and the event's
// corrected entry waits behind it (finHrPost answers `reversal_waiting`). One still waiting for an Approver is withdrawn. A reversal is
// never reversed. Throws what the reversal refuses (a locked month, say), which rolls the caller's transaction back.
// Answers { result: 'posted' | 'submitted' | 'withdrawn' | 'none', voucher_ids, withdrawn_ids? } (finHrUndo).
export async function finHrReverse(qc, oc, sourceType, sourceId, who) {
  const actor = finHrActor(who);
  const key = typeof sourceType === 'string' ? sourceType.replace(/:DP$/, '') : '';
  const id = finIdOf(sourceId);
  if (!key.startsWith('hr_') || id == null) throw finError(400, 'FIN_BAD_INPUT', "Say which HR entry to take back: its source key and its HR row's id.");
  const ev = { key, id };
  // First of all, in the caller's transaction: the lock timeout (ruling R73), which holds for the rest of that transaction too, and the
  // feed's lock (R33). Call this before taking any row lock of its own.
  await finFeedTimeout(qc);
  await finLockFeed(qc);
  await finLockEvent(qc, ev);
  const standing = await finStandingOf(qc, ev);
  await finLockSeries(qc, oc, standing.flatMap(finUndoSeries));
  return finHrUndo(qc, oc, standing, actor, await finHrDoerApproves(qc, actor.id), 'Undone in HR');
}

// What one unit of an event comes to, before anything is written: { state: 'waiting', reversal } (a reversal of its voucher waits for an
// Approver), 'stood' (it stands, in every book it touches, as HR says it should), 'skip' (nothing to post, nothing standing), or 'make'
// ({ vouchers, undo, discard, kept }: the vouchers to make, after taking out `undo`, what stands and HR has changed since, and discarding
// `discard`, the drafts an Approver sent back of the books it makes; `kept`, what stands and is kept). `draftsOf()` reads the unit's
// sent-back drafts, only when they are wanted. Judged book by book (ruling R34): a voucher that stands is kept, and a book of the event
// with none (its voucher sent back by an Approver, or discarded by hand) has its voucher made again, alone, when what stands is what
// HR's rows post now (finStandsAsBuilt); else Finance's setup, or a person's firm, changed since the pair was made, and the event is
// made again whole once a voucher of it was sent back (the standing half taken out first), or left as it stands when none was.
async function finHrPlanUnit(qc, ev, facts, unit, standing, draftsOf, seen) {
  const waiting = standing.filter(s => s.reversal_status === 'submitted');
  if (waiting.length) return { state: 'waiting', reversal: { result: 'submitted', voucher_ids: waiting.map(s => s.reversal_id) } };
  if (unit.awaiting) return standing.length ? { state: 'stood', standing } : { state: 'skip', reason: unit.awaiting };
  const print = unit.fingerprint ?? facts.fingerprint;
  if (facts.change && standing.some(s => s.source_fingerprint != null && s.source_fingerprint !== print)) {
    // HR's figures changed since: what stands comes out, and the event is made afresh. A refusal of the new entry is the event's
    // exception: what stands is no answer for it (finHrSettle marked it, ruling R40).
    const built = await finBuild(qc, ev, facts, unit, seen);
    if (built.skip) return { state: 'make', vouchers: [], undo: standing, discard: [] };
    return { state: 'make', vouchers: built.vouchers, undo: standing, discard: await draftsOf() };
  }
  if (!standing.length) {
    const built = await finBuild(qc, ev, facts, unit, seen);
    if (built.skip) return { state: 'skip', reason: built.skip };
    return { state: 'make', vouchers: built.vouchers, undo: [], discard: await draftsOf() };
  }
  // It stands, and HR has not changed it. A unit of one book (a run's, a month's waivers'), or an event standing in both books (CI and
  // DP: finStandingOf reads no other), stands in every book it touches.
  const stoodIn = new Set(standing.map(s => s.book_id));
  if (facts.perBook || stoodIn.size > 1) return { state: 'stood', standing };
  // One book of an event that may touch both: HR's rows, as Finance's setup posts them now, say which books it touches. Asked only to
  // find a book that does not stand, a refusal is the event's exception only once a voucher of it was sent back (a book waits to be
  // made again, and cannot be); else the event stands as it is (a change of Finance's setup never posts it again).
  let built;
  try {
    built = await finBuild(qc, ev, facts, unit, seen);
  } catch (e) {
    if (e?.body?.code && !(await draftsOf()).length) return { state: 'stood', standing };
    throw e;
  }
  const missing = built.skip ? [] : built.vouchers.filter(v => !stoodIn.has(v.book_id));
  if (!missing.length) return { state: 'stood', standing };
  const drafts = await draftsOf();
  if (await finStandsAsBuilt(qc, standing, built.vouchers)) {
    // Kept as it stands: a refusal of the book made again is the event's exception (the kept voucher is no answer for it: R40), and
    // names that book.
    seen.book_id = missing[0].book_id;
    const making = new Set(missing.map(v => v.book_id));
    return { state: 'make', vouchers: missing, undo: [], kept: standing, discard: drafts.filter(d => making.has(d.book_id)) };
  }
  if (!drafts.length) return { state: 'stood', standing };
  return { state: 'make', vouchers: built.vouchers, undo: standing, discard: drafts };
}

// Make the books say what HR says of one event (the header): `facts` its reader's answer, in the transaction that holds its lock.
async function finHrSettle(qc, oc, ev, facts, actor, seen) {
  const standing = await finStandingOf(qc, ev);
  // What stands is marked before anything that can fail (ruling R40): should this post fail, whether in a plan or before its first
  // reversal, none of it is an answer that the event stands, and the failure is the event's exception; only a voucher another post of
  // it makes meanwhile is (finRecordException).
  seen.judged = standing.map(s => s.id);
  let sentBack = null;   // the event's sent-back drafts, read once, when they are asked for
  const draftsOf = book => async () => (sentBack ??= await finSentBackOf(qc, ev)).filter(d => book == null || d.book_code === book);
  let plans;
  if (facts.skip && !FIN_HR_UNDONE.has(facts.skip)) {
    // It posts nothing of its own now, and HR has not undone it: a hidden person's, or one booked elsewhere, keeps its booking (ruling
    // R27), and anything else that stands answers as it stands.
    if (standing.length) {
      await finCloseException(qc, ev, standing[0].id);
      return finStood(standing);
    }
    await finCloseException(qc, ev, null);
    return { result: 'skipped', reason_code: facts.skip };
  }
  if (facts.skip) {
    // HR holds nothing for it now: what stands comes out of the books, and every draft of it an Approver sent back, in each book, is
    // discarded (ruling R39), so no voucher of any status stays for money HR took back, and none can be sent on again.
    const drafts = await draftsOf(null)();
    if (!standing.length && !drafts.length) {
      await finCloseException(qc, ev, null);
      return { result: 'skipped', reason_code: facts.skip };
    }
    plans = [{ state: 'make', vouchers: [], undo: standing, discard: drafts, undone: true, why: 'Undone in HR' }];
  } else if (facts.perBook) {
    plans = [];
    for (const unit of facts.units) {
      plans.push(await finHrPlanUnit(qc, ev, facts, unit, standing.filter(s => s.book_code === unit.book), draftsOf(unit.book), seen));
    }
    // A book with a voucher standing and nobody of it in the event any more: taken out.
    const gone = standing.filter(s => !facts.units.some(u => u.book === s.book_code));
    if (gone.length) plans.push({ state: 'make', vouchers: [], undo: gone, discard: [] });
  } else {
    plans = [await finHrPlanUnit(qc, ev, facts, facts, standing, draftsOf(null), seen)];
  }
  // An exception of taking a voucher out names the book it stands in, whatever fails first (ruling R40).
  seen.book_id ??= plans.flatMap(p => p.undo ?? [])[0]?.book_id ?? null;

  // Everything this transaction will lock is known: lock its series in one order, then take out, discard and make.
  await finLockSeries(qc, oc, [
    ...plans.flatMap(p => (p.undo ?? []).flatMap(finUndoSeries)),
    ...plans.flatMap(p => p.discard ?? []).map(d => ({ book_id: d.book_id, type: d.voucher_type, date: d.voucher_date })),
    ...plans.flatMap(p => p.vouchers ?? []).map(v => ({ book_id: v.book_id, type: v.voucher_type, date: v.voucher_date })),
  ]);
  const approval = plans.some(p => p.undo?.length) ? await finHrDoerApproves(qc, actor.id) : null;
  for (const p of plans) {
    if (p.state !== 'make' || !p.undo.length) continue;
    p.reversal = await finHrUndo(qc, oc, p.undo, actor, approval, p.why ?? 'Corrected in HR');
    if (p.reversal.result === 'submitted') p.state = 'waiting';
  }
  // A book's sent-back draft is discarded when its new voucher is made (ruling R22), and whenever HR holds nothing for it (R39),
  // whether or not the reversal of what stood waits for an Approver.
  await finDiscardDrafts(qc, oc,
    plans.filter(p => p.undone || (p.state === 'make' && p.vouchers.length)).flatMap(p => p.discard).map(d => d.id), actor);
  const made = [];
  for (const p of plans) {
    if (p.state !== 'make') continue;
    for (const v of p.vouchers) {
      const draft = await finCreateBuiltDraft(qc, oc, {
        book_id: v.book_id, voucher_type: v.voucher_type, voucher_date: v.voucher_date, narration: v.narration, reference: v.reference,
        source_type: v.source_type, source_id: v.source_id, source_fingerprint: v.fingerprint,
      }, finCleanLines(v.lines), actor);
      if (v.covers.length) {
        await qc(`INSERT INTO fin_hr_covers (voucher_id, source_type, source_id) SELECT $1, t, i FROM unnest($2::text[], $3::int[]) AS c(t, i)`,
          [draft.id, v.covers.map(c => c.source_type), v.covers.map(c => c.source_id)]);
      }
      made.push(await finSubmitVoucher(qc, oc, draft.id, actor, { approvedInHr: v.hr_approved_by }));
    }
  }

  // What it came to.
  const reversals = plans.map(p => p.reversal).filter(r => r && r.result !== 'none');
  const reversal = reversals.length ? {
    result: reversals.some(r => r.result === 'submitted') ? 'submitted' : reversals.some(r => r.result === 'posted') ? 'posted' : 'withdrawn',
    voucher_ids: reversals.flatMap(r => r.voucher_ids),
    ...(reversals.some(r => r.withdrawn_ids) ? { withdrawn_ids: reversals.flatMap(r => r.withdrawn_ids ?? []) } : {}),
  } : null;
  const withReversal = answer => (reversal ? { ...answer, reversal } : answer);
  const inBookOrder = list => [...list].sort((a, b) => a.book_id - b.book_id || a.id - b.id);
  if (made.length) {
    // Every voucher that stands for the event now (ruling R34): those made, and those kept or standing as they were, CI's first.
    const now = inBookOrder([...plans.flatMap(p => (p.state === 'stood' ? p.standing : p.kept ?? [])), ...made]);
    await finCloseException(qc, ev, made[0].id);
    return withReversal({
      result: now.some(v => v.status !== 'posted') ? 'submitted' : 'posted', voucher_id: now[0].id,
      ...(now.length > 1 ? { voucher_ids: now.map(v => v.id) } : {}),
    });
  }
  if (plans.some(p => p.state === 'waiting')) {
    await finCloseException(qc, ev, null);
    return withReversal({ result: 'skipped', reason_code: facts.skip ?? 'reversal_waiting' });
  }
  const stood = inBookOrder(plans.flatMap(p => (p.state === 'stood' ? p.standing : [])));
  if (stood.length) {
    await finCloseException(qc, ev, stood[0].id);
    return finStood(stood);
  }
  await finCloseException(qc, ev, null);
  return withReversal({ result: 'skipped', reason_code: facts.skip ?? plans.find(p => p.reason)?.reason ?? 'nothing_paid' });
}

// The event as an exception (§7.7), in a transaction of its own, under the event's lock: one row per event, its reason the refusal's
// own sentence. Tried again, the row says when it was last tried and keeps when it was first seen; one resolved and failing again is
// open again, first seen now. A voucher that stands for the event by now (another post of it got there first) is the answer instead,
// unless every voucher that stands is one the failed post had found standing (`judged`, ruling R40: one it was taking out, one it kept
// while it made the other book again, R34, or one beside a book whose plan failed): then the failure is the event's exception.
// A sheet event is kept under its round's anchor (ruling R28): one the failed post never got to name by it is named here, in a
// transaction of its own first; if even that cannot be read, the exception is kept under the line it was asked by, and its reason says
// so (the round's posting closes it all the same: finCloseException). When even the exception cannot be written, the answer says so,
// `recorded: false`, and the log says which code went unrecorded, by its code alone (Task 10's M1): the event is then found again only
// by the catch-up (finance-hr-catchup.js), which counts it as waiting.
async function finRecordException(asked, refusal, bookId, judged = []) {
  const code = refusal?.body?.code ?? 'FIN_SERVER_ERROR';
  let reason = typeof refusal?.message === 'string' && refusal.message ? refusal.message : FIN_SENTENCES.FIN_SERVER_ERROR;
  let ev = asked;
  if (!asked.anchored) {
    try {
      ev = await finHrFeedTx(qc => finAnchorOf(qc, asked));
      if (ev.skip) return { result: 'skipped', reason_code: ev.skip };
    } catch {
      ev = asked;
      reason = `${reason} It is kept under sheet line ${asked.id}, as the posting round of that line could not be read.`;
    }
  }
  try {
    return await finHrFeedTx(async qc => {
      await finLockEvent(qc, ev);
      const standing = await finStandingOf(qc, ev);
      if (standing.some(s => !judged.includes(s.id))) {
        await finCloseException(qc, ev, standing[0].id);
        return finStood(standing);
      }
      await qc(
        `INSERT INTO fin_hr_exceptions (source_type, source_id, book_id, reason_code, reason, last_tried_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (source_type, source_id) DO UPDATE SET
           book_id = COALESCE(EXCLUDED.book_id, fin_hr_exceptions.book_id), reason_code = EXCLUDED.reason_code, reason = EXCLUDED.reason,
           last_tried_at = now(),
           first_seen_at = CASE WHEN fin_hr_exceptions.resolved_at IS NULL THEN fin_hr_exceptions.first_seen_at ELSE now() END,
           resolved_at = NULL, voucher_id = NULL`,
        [ev.key, ev.id, bookId ?? null, code, reason]);
      return { result: 'exception', reason_code: code };
    });
  } catch {
    // Even the exception could not be written (the database is away): the answer still says what happened, and that it is not on the
    // exceptions list; the log names the code and nothing of the event.
    console.warn(`[finance-hr] ${code} not recorded`);
    return { result: 'exception', reason_code: code, recorded: false };
  }
}

// One event, settled in a transaction of its own (the header's order), its facts read by `read(qc, ev)`; never throws.
async function finHrPostEvent(asked, who, read) {
  let ev = asked;
  const seen = { book_id: null };
  try {
    return await finHrFeedTx(async (qc, oc) => {
      await finLockFeed(qc);   // the feed's lock first of all, after the lock timeout (rulings R33, R73)
      const anchored = await finAnchorOf(qc, ev);
      if (anchored.skip) return { result: 'skipped', reason_code: anchored.skip };
      ev = anchored;   // the id the event is kept by, which its lock, its vouchers and its exception all name (ruling R28: first of all)
      const actor = finHrActor(who);
      await finLockEvent(qc, ev);
      return finHrSettle(qc, oc, ev, await read(qc, ev), actor, seen);
    });
  } catch (e) {
    return finRecordException(ev, finMapDbError(e), seen.book_id, seen.judged ?? []);
  }
}

// Post one HR event (§7.2), after HR's commit: `event` is { type, id }, the type a key of FIN_HR_SOURCES this file posts (all but hidden
// and intercompany) and the id its HR row's (for a sheet, any line id of a posting round: ruling R23; for a run and its sheet's advances,
// the hr.runs id); `who` is the login posting it ({ id, name, hrLevel }), the vouchers' actor, and the HR approval of a reversal it makes
// when it is an HR approver (a vouchers' own approval is HR's: ruling R26). It makes the books say what HR says of the event now (the
// header): it posts it, reverses what stands for it when HR has undone or corrected it, or leaves it as it stands.
// Answers, and never throws:
//   { result: 'posted', voucher_id }      posted now (`already: true`: it stood before, in every book it touches)
//   { result: 'submitted', voucher_id }   waiting for an Approver, in a book at least (`already: true`: it was waiting before)
// where `voucher_id` is the first, and `voucher_ids` (when it is in both books) every voucher that stands for it now, made by this post
// or kept, in book order, CI's first (ruling R34);
//   { result: 'skipped', reason_code }    it posts nothing of its own: before_books, on_sheet, in_batch, hidden, in_combined,
//                                         not_finalised, awaiting_first_payment, reversal_waiting, …, unknown_event
//   { result: 'exception', reason_code }  it could not post, and fin_hr_exceptions says why (a FIN_ code)
// with `reversal: { result, voucher_ids, withdrawn_ids? }` when it took a standing voucher out (finHrReverse's answer).
export function finHrPost(event, who) {
  const ev = finEventOf(event);
  if (!ev) return Promise.resolve({ result: 'skipped', reason_code: 'unknown_event' });
  return finHrPostEvent(ev, who, FIN_HR_EVENTS[ev.type]);
}

// ── Hidden people's combined entries (§7.4; rulings R21, R27) ─────────────────────────────────

const FIN_HIDDEN = FIN_HR_SOURCES.hidden;
// The first day of `asOf`'s month: a month that ends before it has ended (a combined entry posts only then).
const finMonthStart = asOf => `${String(asOf).slice(0, 7)}-01`;
const finEnded = (month, asOf) => {
  const y = Math.floor(month / 100);
  const m = month % 100;
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01` <= finMonthStart(asOf);
};
const finBooksBegin = async qc => (await qc('SELECT min(books_begin) AS begin FROM fin_books'))[0]?.begin ?? null;

// The facts of one combined entry, `ev` { key: hr_hidden:<ledger id> | hr_hidden:waiver | hr_hidden:unmapped, id: YYYYMM }, read afresh
// under its lock: the month's hidden rows, grouped as finHrHiddenGroups groups them, and this entry's. Rows whose account resolves to
// nothing can post nowhere: FIN_UNMAPPED_CHANNEL, kept under `hr_hidden:unmapped`. Nothing left in an entry that stood takes it out.
async function finHiddenFacts(qc, ev, asOf) {
  if (!finEnded(ev.id, asOf)) return { skip: 'month_not_ended' };
  const from = await finBooksBegin(qc);
  if (from == null) return { skip: 'nothing_paid' };
  const group = (await finHrHiddenGroups(qc, await finHrHiddenRows(qc, { from, month: ev.id }))).get(`${ev.key}#${ev.id}`);
  if (ev.key === `${FIN_HIDDEN}:unmapped`) {
    if (group?.rows.length) throw finError(409, 'FIN_UNMAPPED_CHANNEL');
    return { skip: 'nothing_paid' };
  }
  if (!group?.rows.length) return { skip: 'nothing_paid' };
  if (ev.key === `${FIN_HIDDEN}:waiver`) return finHrHiddenFacts(qc, group.rows, { month: ev.id });
  const [ledger] = await qc('SELECT id, book_id FROM fin_ledgers WHERE id = $1', [Number(ev.key.slice(FIN_HIDDEN.length + 1))]);
  if (!ledger) return { skip: 'not_found' };
  return finHrHiddenFacts(qc, group.rows, { account: { book_id: ledger.book_id, ledger_id: ledger.id }, month: ev.id });
}

// The combined entries that may have something to do as at `asOf`, read in one go without a lock: every entry of an ended month (from the
// books' first) whose rows differ from what its live vouchers were made from, or with a book it touches where none of them stands (one an
// Approver sent back, ruling R34), one that stands with no rows left, and, with `retry`, one with an open exception. One whose live
// vouchers match its rows, in every book, is left out, so a sweep with nothing to do writes nothing and opens no
// transaction; without `retry`, one with an open exception waits for Bring-in or its retry (Task 13), so a month that cannot post (a
// locked month, an unmapped channel) is not tried again at every HR request. Each says the books it touches, `books` (their codes,
// as R34 judges them: its people's and its account's, or its units'; one that stands with no rows left, the books its vouchers stand
// in; none for `hr_hidden:unmapped`, which posts nowhere, nor for one due only for its open exception), which finance-hr-catchup.js
// counts it in.
export async function finHrHiddenDue(qc, asOf, { retry }) {
  const from = await finBooksBegin(qc);
  const before = finMonthStart(asOf);
  if (from == null || before <= from) return [];
  const groups = await finHrHiddenGroups(qc, await finHrHiddenRows(qc, { from, before }));
  const live = await qc(
    `SELECT regexp_replace(v.source_type, ':DP$', '') AS key, v.source_id AS month, v.source_fingerprint AS print, b.code AS book,
            EXISTS (SELECT 1 FROM fin_vouchers r WHERE r.reversal_of_id = v.id AND r.status = 'submitted') AS waiting
       FROM fin_vouchers v JOIN fin_books b ON b.id = v.book_id
      WHERE v.source_type LIKE 'hr\\_hidden:%' AND v.status IN ('submitted', 'posted') AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL`);
  const open = await qc(`SELECT source_type AS key, source_id AS month FROM fin_hr_exceptions WHERE source_type LIKE 'hr\\_hidden:%' AND resolved_at IS NULL`);
  // The book of each account an entry is kept by: its own voucher is in that book.
  const finHiddenLedgerOf = key => (/^hr_hidden:\d+$/.test(key) ? Number(key.slice(FIN_HIDDEN.length + 1)) : null);
  const homes = new Map((await qc('SELECT l.id, b.code FROM fin_ledgers l JOIN fin_books b ON b.id = l.book_id WHERE l.id = ANY($1::int[])',
    [[...groups.values()].map(g => finHiddenLedgerOf(g.key)).filter(id => id != null)])).map(l => [l.id, l.code]));
  const due = new Map();
  const failing = new Set(open.map(x => `${x.key}#${x.month}`));
  const mark = (key, month, books = []) => {
    if (!finEnded(month, asOf) || !(retry || !failing.has(`${key}#${month}`))) return;
    const was = due.get(`${key}#${month}`)?.books ?? [];
    due.set(`${key}#${month}`, { key, month, books: [...new Set([...was, ...books])] });
  };
  for (const { key, month, rows } of groups.values()) {
    const mine = live.filter(v => v.key === key && v.month === month);
    if (mine.some(v => v.waiting)) continue;   // its reversal waits for an Approver: nothing can move until it is decided
    if (key === `${FIN_HIDDEN}:unmapped`) { mark(key, month); continue; }
    const ledgerId = finHiddenLedgerOf(key);
    const shape = finHrHiddenShape(rows, key === `${FIN_HIDDEN}:waiver` ? { month } : { account: { ledger_id: ledgerId }, month });
    const prints = new Set((shape.perBook ? shape.units : [shape]).map(u => u.fingerprint));
    // The books it touches (ruling R34): its units', or its people's and its account's. One with no voucher of it standing is due.
    const books = shape.perBook ? shape.units.map(u => u.book)
      : [...shape.parts.filter(p => p.postings.some(x => x.paise > 0)).map(p => p.book), homes.get(ledgerId)].filter(Boolean);
    if (!mine.length || books.some(b => !mine.some(v => v.book === b)) || mine.some(v => !prints.has(v.print))
      || prints.size > new Set(mine.map(v => v.print)).size) mark(key, month, books);
  }
  for (const v of live) if (!v.waiting && !groups.has(`${v.key}#${v.month}`)) mark(v.key, v.month, [v.book]);
  if (retry) for (const x of open) mark(x.key, x.month);
  return [...due.values()].sort((a, b) => a.month - b.month || (a.key < b.key ? -1 : 1))
    .map(({ key, month, books }) => ({ type: 'hidden', key, id: month, ids: [month], anchored: true, books }));
}

// Post hidden people's combined entries (ruling R21) for every calendar month that has ended as at `asOf` (the plant's today): at Bring-in,
// or at the first HR event after the month's end (finHrAfter, which leaves an entry with an open exception to Bring-in: `retry` false).
// Each entry is settled in a transaction of its own, as an event is: posted, or reversed and posted again when its rows changed since, or
// taken out when none is left; an entry that cannot post is an exception (`hr_hidden:<ledger id>` and the month). `who` is the login it
// posts in the name of, whose HR approval a reversal it makes carries. Never throws.
// Answers { posted, submitted (waiting for an Approver, a reversal included), skipped, exceptions: [their codes] }.
export async function finHrPostHidden(who, { asOf = plantDateStr(), retry = true } = {}) {
  const out = { posted: 0, submitted: 0, skipped: 0, exceptions: [] };
  let due;
  try {
    due = await finHrFeedTx(qc => finHrHiddenDue(qc, String(asOf), { retry: retry !== false }));
  } catch (e) {
    out.exceptions.push(finMapDbError(e).body?.code ?? 'FIN_SERVER_ERROR');
    return out;
  }
  for (const ev of due) {
    const r = await finHrPostEvent(ev, who, (qc, at) => finHiddenFacts(qc, at, String(asOf)));
    if (r.already) out.skipped += 1;   // it stood as it should by the time its turn came (another sweep, or a stale exception)
    else if (r.result === 'posted') out.posted += 1;
    else if (r.result === 'submitted' || r.reversal?.result === 'submitted') out.submitted += 1;
    else if (r.result === 'exception') out.exceptions.push(r.reason_code);
    else out.skipped += 1;
  }
  return out;
}

// After an HR request's transaction has committed (§7.7): post each of its events in turn, `events` [{ type, id }], in the name of the
// request's HR login (req.user, and req.hr.level from the HR guard), then hidden people's combined entries of the months that have
// ended as at `asOf` (the plant's today; the first HR event after a month's end posts them: ruling R21). HR's routes call it with the
// two arguments, after their `await tx(…)` and before they answer; `asOf` is for tests, which have to stand after a month's end. It
// answers nothing and throws nothing: HR's request succeeds whatever Finance makes of it. An event that becomes an exception is logged
// by its code alone, never by what it is or whose it is, and so is an event the feed does not know (`unknown_event`: a slip in an HR
// route's wiring leaves a trace). While Finance has no book at all (before its books are set up) no book has begun, so nothing is
// posted and nothing recorded, as for any event dated before the books (§7.7); catch-up finds HR's rows once the books exist.
export async function finHrAfter(req, events, { asOf } = {}) {
  try {
    if (!(await finHrFeedTx(qc => qc('SELECT 1 AS one FROM fin_books LIMIT 1'))).length) return;
    const who = { id: req?.user?.id, name: req?.user?.name, hrLevel: req?.hr?.level ?? null };
    for (const event of Array.isArray(events) ? events : []) {
      const out = await finHrPost(event, who);
      if (out.result === 'exception' || out.reason_code === 'unknown_event') console.warn(`[finance-hr] ${out.reason_code}`);
    }
    if (Number.isSafeInteger(who.id)) {
      for (const code of (await finHrPostHidden(who, { asOf, retry: false })).exceptions) console.warn(`[finance-hr] ${code}`);
    }
  } catch (e) {
    console.warn(`[finance-hr] ${e?.body?.code ?? 'FIN_SERVER_ERROR'}`);
  }
}
