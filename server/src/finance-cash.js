// Finance — Cash & Bank (Cash & Bank spec §5): one screen for every rupee into and out of cash and bank.
//   • finEnterCash          Receive, Pay or Transfer (§5.1–§5.3), entered and submitted at once: an ordinary receipt, payment or
//                           contra of SP1, which settles a party's bills as it posts, by Auto or Pick (§6, finance-allocations.js),
//                           and says the warnings that never refuse (§5.6);
//   • finCashAccounts       the tiles: every active bank and cash ledger of a book with its balance as at today, a holder's
//                           float and top-up, its last count (§5, §5.4, §5.5), and how much party money waits on account (§6.3);
//   • finCashBook           one account's book in a date window, the current month by default: the opening, the posted entries
//                           with a running balance and what each settled, the closing, and apart, what waits for approval (§5);
//   • finCashUnadjusted     the party money still on account, item by item (§5's "Unadjusted money", §6.3);
//   • finAllocationPreview  what Auto or Pick would settle against the bills open now, writing nothing (§5.1, §6.4), with the party's
//                           cash that day for the warnings (ruling R59); or what a redo of a posted party line would, once its own
//                           allocations are released (§6.5);
//   • finPartyReport        a party's statement: its open items with their age, its money on account, the invariant (§6.7);
//   • finRecordCount        a count of a cash account: the book balance beside the counted amount; it posts nothing (§5.5);
//   • finClearCount         clears a count's difference by a receipt or a payment against the Cash Short & Excess ledger (§5.5);
//   • finCashCounts         an account's counts, newest first;
//   • finCashSwitch         the day the ERP's own receipt and payment doors hand over to Finance (§11, items 4 to 6).
//
// The entry is the only write. It takes the qc / oc of the transaction its route opened, and uses nothing else (the pool is one
// client on Vercel). It builds the lines from the form (client/src/lib/finance/cash.js, which the screen shares), writes the draft
// with its plan (finCreateBuiltDraft) and submits it (finSubmitVoucher), which takes every lock a posting takes, in their order
// (series → voucher → party → months → ledgers, ruling R7): this module takes none of its own. What follows the submit only reads.
// A receipt, a payment or a transfer is never refused for not matching bills (spec §3): money with nothing to settle stays on
// account, and a plan that waits for approval is worked out again when it posts.
//
// The reads go through the pool and open no transaction. Every figure in them is counted in SQL, and every list is windowed or
// capped (spec §3, Vercel Hobby): the tiles and the unadjusted count are aggregates, the book is a date window of at most
// FIN_BOOK_MAX_DAYS on finLedgerStatement, and the unadjusted list stops at FIN_UNADJUSTED_MAX items.
//
// Amounts are whole paise in JS and in the API; dates are 'YYYY-MM-DD'; today is the plant's (plantDateStr).

import { q, one } from './db.js';
import { finAudit } from './finance-audit.js';
import { finError } from './finance-errors.js';
import { finIdOf, finOptionalText } from './finance-masters.js';
import { finAgainst, finLedgerStatement } from './finance-reports.js';
import {
  FIN_NARRATION_MAX, FIN_REFERENCE_MAX, finClientKey, finCleanLines, finCreateBuiltDraft, finGroupKinds, finPartySide, finReplay,
  finSubmitVoucher, finVoucherDate,
} from './finance-vouchers.js';
import {
  finAdjustScope, finAllocate, finCleanAdjust, finLineAllocations, finOnAccountItems, finOnAccountSummary, finOpenItems, finPartyFigures,
  finPlanOf, finRedoPreviewOf, finSettledOf,
} from './finance-allocations.js';
import { plantDateStr } from './plant-calendar.js';
import { finPickOrder } from '../../client/src/lib/finance/allocation.js';
import { finCashLines, finCashWarnings, finLeanBook, finTopUpPaise } from '../../client/src/lib/finance/cash.js';
import { finDayBefore, finIsValidDate } from '../../client/src/lib/finance/fy.js';
import { FIN_MAX_PAISE, finFormatINR, finFromPaise, finToPaise } from '../../client/src/lib/finance/money.js';

// The three entries of the screen, and the voucher type each one is (spec §5.1–§5.3); and back, the entry each type is.
const FIN_ENTRY_VOUCHER = Object.freeze({ receive: 'receipt', pay: 'payment', transfer: 'contra' });
const FIN_VOUCHER_ENTRY = Object.freeze(Object.fromEntries(Object.entries(FIN_ENTRY_VOUCHER).map(([entry, type]) => [type, entry])));
// The roles that make a ledger staff money's, which is entered in HR and nowhere here (spec §5.2, §7.1).
const FIN_STAFF_ROLES = Object.freeze(['staff_advances', 'staff_loans', 'salary_payable', 'salary_expense']);
// TDS is deducted by a customer on a receipt, and from a vendor on a payment (spec §5.1, §5.2), and posts to the book's ledger for it.
const FIN_TDS = Object.freeze({
  receive: Object.freeze({ side: 'customer', role: 'tds_receivable', says: 'TDS is deducted on a receipt from a customer only.',
    missing: 'Set the TDS receivable ledger in Finance Setup → HR & payroll first.' }),
  pay: Object.freeze({ side: 'vendor', role: 'tds_payable', says: 'TDS is deducted on a payment to a vendor only.',
    missing: 'Set the TDS payable ledger in Finance Setup → HR & payroll first.' }),
});
const FIN_KIND_ORDER = Object.freeze({ cash: 0, holder: 1, bank: 2 });   // the tiles: office cash, the holders, then the banks
const FIN_BOOK_MAX_DAYS = 366;          // the widest window the book shows at once: a year, never the whole history
const FIN_UNADJUSTED_MAX = 1000;        // items the unadjusted list sends in one answer; past it, it says so (truncated)
const FIN_DAY_MS = 86_400_000;

const finBad = (message, field) => finError(400, 'FIN_BAD_INPUT', message, field ? { field } : {});

// A figure a person sends: a whole number of paise, nothing or more, under ₹1 lakh crore (money.js refuses a typed amount at that
// size too). A string, a fraction, NaN or a negative is no amount.
const finIsWholePaise = p => Number.isSafeInteger(p) && p >= 0 && p < FIN_MAX_PAISE;

// What a bank or cash ledger is on the screen: 'holder' when a person holds it (spec §5.4), else 'cash' or 'bank' by the group it
// is filed under (finGroupKinds' account_kind); null for a ledger that is neither, which no entry, tile or book takes.
function finAccountKindOf(ledger, kinds) {
  const kind = kinds.get(ledger.group_id)?.account_kind ?? null;
  if (kind == null) return null;
  return ledger.holder_name ? 'holder' : kind;
}

// The whole days from `from` to `to`, two 'YYYY-MM-DD' days; negative when `to` comes first.
const finDaysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / FIN_DAY_MS);

// An item with its age in days as at `today` (spec §6.4, §6.7): the days since its date, and nothing for one dated later.
const finAged = (item, today) => ({ ...item, age_days: Math.max(0, finDaysBetween(item.date, today)) });

function finToday(today) {
  if (!finIsValidDate(today)) throw new Error(`Cash & Bank needs today as YYYY-MM-DD, got ${today}`);
  return today;
}

// ── Receive, Pay and Transfer (spec §5.1–§5.3) ───────────────────────────────────────────────

// The entry as the form sends it, checked before the database is asked anything:
//   { book_id, entry_type: 'receive' | 'pay' | 'transfer', voucher_date, account_ledger_id, other_ledger_id, amount_paise, tds_paise,
//     reference, narration, adjust: { mode, picks } | null, client_key }
// The account is the bank or cash account the money comes into (receive) or goes out of (pay, and a transfer's "from"); the other
// ledger is who it comes from or goes to (a transfer's "to"). An amount is a whole number of paise above nothing, TDS one of nothing
// or more (Review Focus 1: 400 FIN_BAD_INPUT, naming the field, for 0, -1, 1.5, "100" and the like). A transfer carries no TDS.
function finCleanEntry(input) {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const book_id = finIdOf(raw.book_id);
  if (book_id == null) throw finBad('Say which book this is for.', 'book_id');
  const entry_type = raw.entry_type;
  if (typeof entry_type !== 'string' || !Object.hasOwn(FIN_ENTRY_VOUCHER, entry_type)) {
    throw finBad('An entry is a receive, a pay or a transfer.', 'entry_type');
  }
  const voucher_date = finVoucherDate(raw.voucher_date);
  const account_ledger_id = finIdOf(raw.account_ledger_id);
  if (account_ledger_id == null) throw finBad('Say which bank or cash account.', 'account_ledger_id');
  const other_ledger_id = finIdOf(raw.other_ledger_id);
  if (other_ledger_id == null) {
    throw finBad(entry_type === 'transfer' ? 'Say which account the money goes to.'
      : entry_type === 'receive' ? 'Say who the money is from.' : 'Say who the money goes to.', 'other_ledger_id');
  }
  if (other_ledger_id === account_ledger_id) throw finBad('The money moves between two different ledgers, not one.', 'other_ledger_id');
  const amount_paise = raw.amount_paise;
  if (!finIsWholePaise(amount_paise) || amount_paise === 0) {
    throw finBad('The amount is a whole number of paise above nothing, under ₹1 lakh crore.', 'amount_paise');
  }
  const tds_paise = raw.tds_paise ?? 0;
  if (!finIsWholePaise(tds_paise)) throw finBad('TDS is a whole number of paise, nothing or more.', 'tds_paise');
  if (amount_paise + tds_paise >= FIN_MAX_PAISE) throw finBad('The amount and its TDS come to more than an entry can hold.', 'tds_paise');
  if (tds_paise > 0 && entry_type === 'transfer') throw finBad('A transfer carries no TDS.', 'tds_paise');
  return {
    book_id, entry_type, voucher_date, account_ledger_id, other_ledger_id, amount_paise, tds_paise,
    reference: finOptionalText(raw.reference, 'reference', FIN_REFERENCE_MAX),
    narration: finOptionalText(raw.narration, 'narration', FIN_NARRATION_MAX),
    adjust: raw.adjust == null ? null : finCleanAdjust(raw.adjust),
    client_key: finClientKey(raw.client_key),
  };
}

// The two ledgers an entry names, read without locks and judged, in this order: the account is one of this book's and a bank or
// cash account (400 FIN_BAD_INPUT); the other ledger is one of this book's, and no staff ledger (409 FIN_STAFF_IN_HR: staff money
// is HR's, spec §5.2, §7.1); a transfer's other ledger is a bank or cash account, and a receipt's or a payment's is not (money
// between two of them is a Transfer, under the contra rule, so a receipt can never carry it past that rule's Approver); both are
// switched on and open to hand-typed entries; and TDS only from a customer on a receipt or a vendor on a payment (400), to the
// book's TDS ledger for it (409 FIN_ROLE_MISSING when none is set). The posting check says the ledgers' part again, locked, as it
// posts, and the database at COMMIT. Answers what the entry needs of them: { otherIsParty, tdsLedgerId }.
async function finEntryFacts(qc, entry) {
  const rows = await qc(
    `SELECT l.id, l.book_id, l.name, l.group_id, l.party_type, l.active, l.manual_entry, l.holder_name,
            ARRAY(SELECT r.role FROM fin_ledger_roles r WHERE r.ledger_id = l.id AND r.book_id = l.book_id ORDER BY r.role) AS roles
       FROM fin_ledgers l WHERE l.id = ANY($1::int[])`, [[entry.account_ledger_id, entry.other_ledger_id]]);
  const byId = new Map(rows.map(row => [row.id, row]));
  const kinds = await finGroupKinds(qc, entry.book_id);
  const account = byId.get(entry.account_ledger_id);
  if (!account || account.book_id !== entry.book_id) {
    throw finError(409, 'FIN_WRONG_BOOK', "The account isn't one of this book's ledgers.", { field: 'account_ledger_id' });
  }
  if (finAccountKindOf(account, kinds) == null) {
    throw finBad(`${account.name} isn't a bank or cash account. Money comes into, and goes out of, a bank or cash account.`, 'account_ledger_id');
  }
  const other = byId.get(entry.other_ledger_id);
  if (!other || other.book_id !== entry.book_id) {
    throw finError(409, 'FIN_WRONG_BOOK', "That ledger isn't one of this book's ledgers.", { field: 'other_ledger_id' });
  }
  if (other.roles.some(role => FIN_STAFF_ROLES.includes(role))) throw finError(409, 'FIN_STAFF_IN_HR', undefined, { field: 'other_ledger_id' });
  // Cash Short & Excess is the system's (ruling R10): a difference is cleared from its count, never typed as a receipt or a payment.
  if (other.roles.includes('cash_difference')) throw finError(409, 'FIN_DIFFERENCE_VIA_COUNT', undefined, { field: 'other_ledger_id' });
  const otherIsMoney = finAccountKindOf(other, kinds) != null;
  if (entry.entry_type === 'transfer' && !otherIsMoney) {
    throw finBad(`A transfer moves money between two bank or cash accounts, and ${other.name} isn't one.`, 'other_ledger_id');
  }
  if (entry.entry_type !== 'transfer' && otherIsMoney) {
    throw finBad(`${other.name} is a bank or cash account: money between two of them is a Transfer.`, 'other_ledger_id');
  }
  for (const [ledger, field] of [[account, 'account_ledger_id'], [other, 'other_ledger_id']]) {
    if (!ledger.active) throw finError(409, 'FIN_LEDGER_INACTIVE', `${ledger.name} is switched off and takes no new postings.`, { field });
    if (!ledger.manual_entry) throw finError(409, 'FIN_SYSTEM_LEDGER', `${ledger.name} is kept for system entries only.`, { field });
  }
  const side = finPartySide(other, kinds);
  let tdsLedgerId = null;
  if (entry.tds_paise > 0) {
    const tds = FIN_TDS[entry.entry_type];
    if (side !== tds.side) throw finBad(tds.says, 'tds_paise');
    const role = (await qc('SELECT ledger_id FROM fin_ledger_roles WHERE book_id = $1 AND role = $2', [entry.book_id, tds.role]))[0];
    if (!role) throw finError(409, 'FIN_ROLE_MISSING', tds.missing, { field: 'tds_paise' });
    tdsLedgerId = role.ledger_id;
  }
  return { otherIsParty: side != null, tdsLedgerId };
}

// The cash ledgers of a book, a holder's included, as the ids of the groups they are filed under (finGroupKinds' account_kind).
const finCashGroups = kinds => [...kinds].filter(([, kind]) => kind.account_kind === 'cash').map(([id]) => id);

// What one party has given or been paid in cash on a day, for the cash warnings of spec §5.6: the cash ledgers' debits in the receipts it
// is credited in (`receive`), or their credits in the payments it is debited in, in the book's entries of that day that are neither
// reversed nor a reversal, of the `statuses` asked for. One voucher is left out, by its id (`exceptId`) or by its save key (`exceptKey`):
// the entry the caller is about to add itself.
//   • an entry's own answer (finCashOutcome) counts the posted entries, the entry itself left out by its id, posted or waiting;
//   • the form's preview (ruling R59, finPreviewCashDay) counts the posted and the waiting, the entry being typed left out by its save key
//     (nothing of it is saved yet, unless a save whose answer was lost made it).
async function finPartyCash(qx, { bookId, day, partyId, receive, kinds, statuses, exceptId = 0, exceptKey = null }) {
  const [row] = await qx(
    `SELECT COALESCE(sum(CASE WHEN $4::boolean THEN cl.debit ELSE cl.credit END), 0) AS cash
       FROM fin_vouchers v
       JOIN fin_voucher_lines cl ON cl.voucher_id = v.id
       JOIN fin_ledgers fl ON fl.id = cl.ledger_id AND fl.group_id = ANY($5::int[])
      WHERE v.book_id = $1 AND v.voucher_date = $2 AND v.status = ANY($7::text[]) AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
        AND v.id <> $6 AND ($8::uuid IS NULL OR v.client_key IS DISTINCT FROM $8::uuid)
        AND EXISTS (SELECT 1 FROM fin_voucher_lines pl
                     WHERE pl.voucher_id = v.id AND pl.ledger_id = $3 AND CASE WHEN $4::boolean THEN pl.credit > 0 ELSE pl.debit > 0 END)`,
    [bookId, day, partyId, receive, finCashGroups(kinds), exceptId, statuses, exceptKey]);
  return finToPaise(row.cash);
}

// An account's balance on the entry's day, from its posted lines dated then or before, the entry itself left out (`voucherId`).
async function finBalanceThatDay(oc, entry, voucherId) {
  const row = await oc(
    `SELECT COALESCE(sum(l.debit - l.credit), 0) AS balance
       FROM fin_voucher_lines l JOIN fin_vouchers v ON v.id = l.voucher_id
      WHERE l.ledger_id = $1 AND v.status = 'posted' AND v.voucher_date <= $2 AND v.id <> $3`,
    [entry.account_ledger_id, entry.voucher_date, voucherId]);
  return finToPaise(row.balance);
}

// What the entry's party line settled, or will: { allocations, on_account_paise }. Posted, the allocations are read back (the
// posting worked them out, and finPostLocked keeps finApplyPlan's answer to itself), each { line_id: the bill, amount_paise }, and
// what is left of the line is on account. Waiting for approval, nothing is settled yet (allocations null) and on_account_paise is
// what the plan would leave against the bills open now; the posting works it out again then. No party line, or a voucher that is
// neither (a draft sent back, one discarded): both null.
async function finSettledNow(qc, oc, voucher) {
  const none = { allocations: null, on_account_paise: null };
  const plan = finPlanOf((await oc('SELECT allocation_plan FROM fin_vouchers WHERE id = $1', [voucher.id]))?.allocation_plan);
  if (!plan || plan.line_no == null) return none;
  const line = await oc('SELECT id, ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 AND line_no = $2', [voucher.id, plan.line_no]);
  if (!line) return none;
  const money = finToPaise(line.debit) + finToPaise(line.credit);
  if (voucher.status === 'posted') {
    const allocations = await finLineAllocations(qc, line.id);
    return { allocations, on_account_paise: money - allocations.reduce((sum, a) => sum + a.amount_paise, 0) };
  }
  if (voucher.status !== 'submitted') return none;
  // A retry of an entry that waits, whose ledger has been filed out of the party groups since: there is nothing to foresee, and
  // what the answer foresees never refuses the entry.
  const open = await finOpenItems(qc, line.ledger_id).catch(e => {
    if (e?.body?.code === 'FIN_NOT_PARTY_LINE') return null;
    throw e;
  });
  if (!open) return none;
  const against = finToPaise(line.credit) > 0 ? open.debits : open.credits;
  return { allocations: null, on_account_paise: finAllocate(against, plan, money).on_account_paise };
}

// The answer to an entry: { voucher, allocations, on_account_paise, warnings }. The warnings never refuse (spec §5.6,
// client/src/lib/finance/cash.js finCashWarnings): money left on account; cash from one party reaching ₹2,00,000 in a day (s.269ST)
// or cash to one party over ₹10,000 in a day (s.40A(3)), this entry included, and only for a cash account, a holder's included;
// and a cash account or a holder going below zero, its balance on the entry's day once this entry is in it, and only for money
// going out (a bank may run an overdraft). `entry` is the entry the voucher IS: the request's own on a first save, which is what was
// written; on a retry, the one rebuilt from the stored voucher (finStoredEntry, ruling R11), never the body sent again, which may
// carry edits made since. A stored voucher that is no entry (null) has no warnings to say.
async function finCashOutcome(qc, oc, entry, voucher) {
  if (!entry) return { voucher, ...(await finSettledNow(qc, oc, voucher)), warnings: [] };
  const kinds = await finGroupKinds(qc, entry.book_id);
  const account = await oc('SELECT id, name, group_id, holder_name FROM fin_ledgers WHERE id = $1', [entry.account_ledger_id]);
  const kind = account ? finAccountKindOf(account, kinds) : null;
  const isCash = kind === 'cash' || kind === 'holder';
  const { allocations, on_account_paise } = await finSettledNow(qc, oc, voucher);
  const partyCash = isCash && entry.entry_type !== 'transfer'
    ? await finPartyCash(qc, {
      bookId: entry.book_id, day: entry.voucher_date, partyId: entry.other_ledger_id, receive: entry.entry_type === 'receive', kinds,
      statuses: ['posted'], exceptId: voucher.id,
    }) + entry.amount_paise : 0;
  const balanceAfter = isCash && entry.entry_type !== 'receive'
    ? await finBalanceThatDay(oc, entry, voucher.id) - entry.amount_paise : null;
  const warnings = finCashWarnings({
    entry_type: entry.entry_type, is_cash: isCash, is_holder: kind === 'holder',
    account_name: kind === 'holder' ? account.holder_name : account?.name, amount_paise: entry.amount_paise,
    party_cash_today_paise: partyCash, balance_after_paise: balanceAfter, on_account_paise,
  });
  return { voucher, allocations, on_account_paise, warnings };
}

// ── A retry (ruling R11) ─────────────────────────────────────────────────────────────────────
// SP1's form makes one save key per opened form and sends it again after a lost answer, with whatever is on screen by then, so a
// retry's body may carry edits. A retry is never refused: it answers the voucher its key saved, as it now stands, with the figures
// and the warnings of THAT entry, read back from the voucher itself, and says it is a retry; and says too when its body asks for
// another entry, so the screen can tell the accountant the entry was saved already and the changes since were not.

// The entry a stored voucher is, read back from it as finEnterCash writes one: its type, date, lines and plan. { book_id, entry_type,
// voucher_date, account_ledger_id, other_ledger_id, amount_paise, tds_paise, adjust, settles }, where a
//   receive   is one debit on a bank or cash account (the amount), one credit on another ledger (who the money is from), and at most
//             one more debit, on another ledger (the TDS);
//   pay       is the mirror image; and a
//   transfer  is one credit and one debit, each on a bank or cash account (from, and to).
// `adjust` is its plan's { mode, picks }, or null when the plan chooses nothing; `settles` says it carries a plan at all. null for a
// voucher that is none of these: another type, or lines edited past that shape in the voucher form after an Approver sent it back.
async function finStoredEntry(qc, oc, voucher, kinds) {
  const entry_type = Object.hasOwn(FIN_VOUCHER_ENTRY, voucher.voucher_type) ? FIN_VOUCHER_ENTRY[voucher.voucher_type] : null;
  if (!entry_type) return null;
  const lines = (await qc(
    `SELECT l.ledger_id, l.debit, l.credit, fl.group_id, fl.holder_name
       FROM fin_voucher_lines l JOIN fin_ledgers fl ON fl.id = l.ledger_id
      WHERE l.voucher_id = $1 ORDER BY l.line_no`, [voucher.id]))
    .map(line => ({ ledger_id: line.ledger_id, debit: finToPaise(line.debit), credit: finToPaise(line.credit), money: finAccountKindOf(line, kinds) != null }));
  const on = (side, money) => lines.filter(line => line[side] > 0 && line.money === money);
  // The account's side: money comes into it on a receive, and goes out of it on a pay or a transfer.
  const [accountSide, otherSide] = entry_type === 'receive' ? ['debit', 'credit'] : ['credit', 'debit'];
  const account = on(accountSide, true);
  const other = on(otherSide, entry_type === 'transfer');
  const tds = entry_type === 'transfer' ? [] : on(accountSide, false);
  if (account.length !== 1 || other.length !== 1 || tds.length > 1 || lines.length !== 2 + tds.length) return null;
  const plan = finPlanOf((await oc('SELECT allocation_plan FROM fin_vouchers WHERE id = $1', [voucher.id]))?.allocation_plan);
  return {
    book_id: voucher.book_id, entry_type, voucher_date: voucher.voucher_date,
    account_ledger_id: account[0].ledger_id, other_ledger_id: other[0].ledger_id,
    amount_paise: account[0][accountSide], tds_paise: tds.length ? tds[0][accountSide] : 0,
    adjust: plan?.mode ? { mode: plan.mode, picks: plan.mode === 'pick' ? plan.picks : [] } : null, settles: plan != null,
  };
}

// Whether a retry's body asks for another entry than the one its key saved: another type, account, other ledger, date, amount or
// TDS, or, for an entry that settles bills (one whose voucher carries a plan), another adjustment. A reference or a narration is no
// figure of the entry. A stored voucher that is no entry (finStoredEntry's null) is another entry, whatever the body.
function finRetryDiffers(asked, stored) {
  if (!stored) return true;
  for (const field of ['entry_type', 'account_ledger_id', 'other_ledger_id', 'voucher_date', 'amount_paise', 'tds_paise']) {
    if (asked[field] !== stored[field]) return true;
  }
  if (!stored.settles) return false;
  const [a, b] = [asked.adjust, stored.adjust];
  if (a == null || b == null) return a !== b;
  return a.mode !== b.mode || a.picks.length !== b.picks.length
    || a.picks.some((pick, i) => pick.line_id !== b.picks[i].line_id || pick.amount_paise !== b.picks[i].amount_paise);
}

// The answer to a retry: the voucher its key saved, with that entry's figures and warnings (finStoredEntry), `replayed: true`, and
// `replay_differs: true` when the body asked for another entry (finRetryDiffers). It writes nothing.
async function finReplayOutcome(qc, oc, asked, voucher) {
  const stored = await finStoredEntry(qc, oc, voucher, await finGroupKinds(qc, asked.book_id));
  const answer = { ...(await finCashOutcome(qc, oc, stored, voucher)), replayed: true };
  return finRetryDiffers(asked, stored) ? { ...answer, replay_differs: true } : answer;
}

// Receive, Pay or Transfer (spec §5.1–§5.3): one receipt, payment or contra, made and submitted in the route's transaction.
//   receive   Dr the account (the amount) · Dr the TDS receivable ledger (the TDS, if any) · Cr the other ledger (both)
//   pay       Dr the other ledger (the amount and the TDS) · Cr the account (the amount) · Cr the TDS payable ledger (the TDS)
//   transfer  Dr the other account · Cr the account
// When the other ledger is a party's, the voucher carries the plan its party line settles bills by: { line_no, mode, picks },
// `adjust` as the form chose it, Auto or Pick (spec §6.3, §6.4). With no choice (adjust null) the money goes on account: that is
// no refusal. The draft is submitted at once (finSubmitVoucher): it posts, and its plan settles bills as it posts; or, when the
// book's rule asks an Approver (a payment or a transfer above ₹1,00,000, say), it waits with its plan, which settles bills when
// it is approved. The answer says `replayed: false`. A save key already used by this login in this book is a retry (ruling R11): it
// answers with the voucher the first save made, as it now stands (finReplay; anyone else's key is 409 FIN_DUPLICATE_KEY), with that
// entry's own figures and warnings, `replayed: true`, and `replay_differs: true` when the body asks for another entry
// (finReplayOutcome). `actor` carries the login's roles on the book, which decide whether an entry that needs approval posts
// self-approved.
export async function finEnterCash(qc, oc, input, actor) {
  if (!Number.isSafeInteger(actor?.id)) throw new Error('A Cash & Bank entry needs to know who is acting: pass { id, name, roles }');
  const entry = finCleanEntry(input);
  const again = entry.client_key ? await finReplay(oc, entry.client_key, actor, entry.book_id) : null;
  if (again) return finReplayOutcome(qc, oc, entry, again);

  const facts = await finEntryFacts(qc, entry);
  const lines = finCashLines({ ...entry, tds_ledger_id: facts.tdsLedgerId });
  // The party's own line: its credit on a receipt, its debit on a payment. A transfer moves money between two accounts and
  // settles no bills, whatever its ledgers are linked to.
  const party = entry.entry_type === 'receive' ? 'credit_paise' : 'debit_paise';
  const lineNo = facts.otherIsParty && entry.entry_type !== 'transfer'
    ? lines.findIndex(line => line.ledger_id === entry.other_ledger_id && line[party] > 0) + 1 : 0;
  const draft = await finCreateBuiltDraft(qc, oc, {
    book_id: entry.book_id, voucher_type: FIN_ENTRY_VOUCHER[entry.entry_type], voucher_date: entry.voucher_date,
    narration: entry.narration, reference: entry.reference, client_key: entry.client_key,
    allocation_plan: lineNo > 0 ? { line_no: lineNo, ...(entry.adjust ?? {}) } : null,
  }, finCleanLines(lines), actor);
  if (!draft) {
    // The key was taken between the look above and the insert, by a save that has now settled: this is a retry of it.
    const first = await finReplay(oc, entry.client_key, actor, entry.book_id);
    if (!first) throw finError(409, 'FIN_DUPLICATE_KEY');
    return finReplayOutcome(qc, oc, entry, first);
  }
  const voucher = await finSubmitVoucher(qc, oc, draft.id, actor);
  return { ...(await finCashOutcome(qc, oc, entry, voucher)), replayed: false };
}

// ── Counting cash and clearing a difference (spec §5.5) ──────────────────────────────────────

const FIN_COUNT_COLS = 'id, book_id, ledger_id, count_date, counted, book_balance, note, counted_by_id, counted_by, counted_at, cleared_voucher_id';
const FIN_NOTE_MAX = 500;

// A count as the API says it: whole paise, and the difference counted less the book.
function finCountOut(row) {
  const counted_paise = finToPaise(row.counted);
  const book_balance_paise = finToPaise(row.book_balance);
  return {
    id: row.id, book_id: row.book_id, ledger_id: row.ledger_id, count_date: row.count_date, counted_paise, book_balance_paise,
    difference_paise: counted_paise - book_balance_paise, note: row.note ?? null, counted_by: row.counted_by ?? null,
    counted_at: row.counted_at, cleared_voucher_id: row.cleared_voucher_id ?? null,
  };
}

// Count a cash account (spec §5.5): { ledger_id, count_date, counted_paise, note }, plus the book the form says it is for
// (book_id; when sent it must be the ledger's own). The book balance is the ledger's posted lines dated on or before the count's
// day, read now; the difference is the counted amount less it. A cash account, a holder's included, is counted; a bank is not (400).
// It posts nothing. Answers { count }.
export async function finRecordCount(qc, oc, input, actor) {
  if (!Number.isSafeInteger(actor?.id)) throw new Error('A cash count needs to know who counted: pass { id, name }');
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ledgerId = finIdOf(raw.ledger_id);
  if (ledgerId == null) throw finBad('Say which cash account was counted.', 'ledger_id');
  if (typeof raw.count_date !== 'string' || !finIsValidDate(raw.count_date)) {
    throw finError(400, 'FIN_BAD_DATE', 'The count date is not a valid date. Write it as YYYY-MM-DD.', { field: 'count_date' });
  }
  if (!finIsWholePaise(raw.counted_paise)) throw finBad('The counted amount is a whole number of paise, nothing or more.', 'counted_paise');
  const note = finOptionalText(raw.note, 'note', FIN_NOTE_MAX);

  const ledger = await oc('SELECT id, book_id, name, group_id, holder_name FROM fin_ledgers WHERE id = $1', [ledgerId]);
  if (!ledger) throw finError(404, 'FIN_NOT_FOUND');
  if (raw.book_id != null && finIdOf(raw.book_id) !== ledger.book_id) {
    throw finError(409, 'FIN_WRONG_BOOK', "The account isn't one of this book's ledgers.", { field: 'ledger_id' });
  }
  const kind = finAccountKindOf(ledger, await finGroupKinds(qc, ledger.book_id));
  if (kind !== 'cash' && kind !== 'holder') throw finBad(`${ledger.name} isn't a cash account. Only cash is counted.`, 'ledger_id');

  const balance = await oc(
    `SELECT COALESCE(sum(l.debit - l.credit), 0) AS balance
       FROM fin_voucher_lines l JOIN fin_vouchers v ON v.id = l.voucher_id
      WHERE l.ledger_id = $1 AND v.status = 'posted' AND v.voucher_date <= $2`, [ledgerId, raw.count_date]);
  const row = await oc(
    `INSERT INTO fin_cash_counts (book_id, ledger_id, count_date, counted, book_balance, note, counted_by_id, counted_by)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8) RETURNING ${FIN_COUNT_COLS}`,
    [ledger.book_id, ledgerId, raw.count_date, finFromPaise(raw.counted_paise), balance.balance, note, actor.id, actor.name ?? null]);
  const count = finCountOut(row);
  await finAudit(qc, {
    bookId: ledger.book_id, entity: 'cash_count', entityId: count.id, action: 'create', userId: actor.id, userName: actor.name ?? 'unknown', after: count,
  });
  return { count };
}

// An account's counts, newest first (at most FIN_COUNTS_MAX): { counts }. The account is the ledger's own.
const FIN_COUNTS_MAX = 100;
export async function finCashCounts(ledgerId) {
  const id = finIdOf(ledgerId);
  if (id == null) throw finBad('Say which cash account.', 'ledger');
  const rows = await q(`SELECT ${FIN_COUNT_COLS} FROM fin_cash_counts WHERE ledger_id = $1 ORDER BY count_date DESC, id DESC LIMIT $2`, [id, FIN_COUNTS_MAX]);
  return { counts: rows.map(finCountOut) };
}

// Clear a count's difference (spec §5.5, rulings R10): one voucher, made and submitted at once, from the count.
//   an excess (counted above the book)    a receipt: Dr the cash account · Cr the book's Cash Short & Excess ledger
//   a shortage (counted below the book)   a payment: Dr the Cash Short & Excess ledger · Cr the cash account
// The voucher is the count's own: source_type 'cash_count' and source_id the count, so the database allows one standing clearing
// per count (H8), and the rule that judges it is cash_difference, 'always': an Accountant's waits for an Approver, an Approver's
// posts self-approved. The count is marked cleared when the voucher POSTS (finPostLocked), so an Accountant's clearing leaves it
// uncleared until it is approved, and a reversal of the posted voucher makes it uncleared again. A count already cleared, or whose
// clearing waits, is refused 409 FIN_SOURCE_POSTED; one with no difference, 400; a book with no Cash Short & Excess ledger set, 409
// FIN_ROLE_MISSING. `actor` carries the login's roles on the book. Answers { voucher, count }.
export async function finClearCount(qc, oc, countId, actor) {
  if (!Number.isSafeInteger(actor?.id)) throw new Error('Clearing a count needs to know who is acting: pass { id, name, roles }');
  const id = finIdOf(countId);
  const row = id == null ? null : await oc(`SELECT ${FIN_COUNT_COLS} FROM fin_cash_counts WHERE id = $1`, [id]);
  if (!row) throw finError(404, 'FIN_NOT_FOUND');
  const count = finCountOut(row);
  const standing = await oc(
    `SELECT 1 AS one FROM fin_vouchers WHERE source_type = 'cash_count' AND source_id = $1 AND status IN ('submitted', 'posted')
        AND reversed_by_id IS NULL AND reversal_of_id IS NULL`, [count.id]);
  if (count.cleared_voucher_id != null || standing) throw finError(409, 'FIN_SOURCE_POSTED');
  if (count.difference_paise === 0) throw finBad('This count has no difference to clear.', 'id');
  const role = await oc(`SELECT ledger_id FROM fin_ledger_roles WHERE book_id = $1 AND role = 'cash_difference'`, [count.book_id]);
  if (!role) throw finError(409, 'FIN_ROLE_MISSING', 'Set the Cash Short & Excess ledger in Finance Setup first.');

  const excess = count.difference_paise > 0;
  const amount = Math.abs(count.difference_paise);
  const lines = excess
    ? [{ ledger_id: count.ledger_id, debit_paise: amount, credit_paise: 0 }, { ledger_id: role.ledger_id, debit_paise: 0, credit_paise: amount }]
    : [{ ledger_id: role.ledger_id, debit_paise: amount, credit_paise: 0 }, { ledger_id: count.ledger_id, debit_paise: 0, credit_paise: amount }];
  const draft = await finCreateBuiltDraft(qc, oc, {
    book_id: count.book_id, voucher_type: excess ? 'receipt' : 'payment', voucher_date: count.count_date,
    narration: `Cash ${excess ? 'excess' : 'short'} on the count of ${count.count_date}${count.note ? `: ${count.note}` : ''}`.slice(0, FIN_NARRATION_MAX),
    source_type: 'cash_count', source_id: count.id, source_fingerprint: `cash_count:${count.id}:${count.difference_paise}`,
  }, finCleanLines(lines), actor);
  const voucher = await finSubmitVoucher(qc, oc, draft.id, actor);
  const after = await oc(`SELECT ${FIN_COUNT_COLS} FROM fin_cash_counts WHERE id = $1`, [count.id]);
  return { voucher, count: finCountOut(after) };
}

// ── The tiles (spec §5, §5.4, §5.5) ──────────────────────────────────────────────────────────

// $1 the book, $2 the groups of its bank and cash ledgers, $3 the day. Each active ledger filed under one of them, with its balance
// from the posted lines dated that day or before, and its latest count by then, the difference being counted less the book.
const FIN_TILES_SQL = `
  SELECT l.id, l.name, l.group_id, l.holder_name, l.float_amount,
         (SELECT COALESCE(sum(ln.debit - ln.credit), 0)
            FROM fin_voucher_lines ln JOIN fin_vouchers v ON v.id = ln.voucher_id
           WHERE ln.ledger_id = l.id AND v.status = 'posted' AND v.voucher_date <= $3::text) AS balance,
         c.count_date, c.difference, c.cleared_voucher_id, c.clearing_waiting
    FROM fin_ledgers l
    LEFT JOIN LATERAL (
      SELECT cc.count_date, cc.counted - cc.book_balance AS difference, cc.cleared_voucher_id,
             EXISTS (SELECT 1 FROM fin_vouchers cv WHERE cv.source_type = 'cash_count' AND cv.source_id = cc.id AND cv.status = 'submitted'
                       AND cv.reversal_of_id IS NULL) AS clearing_waiting
        FROM fin_cash_counts cc
       WHERE cc.ledger_id = l.id AND cc.count_date <= $3::text
       ORDER BY cc.count_date DESC, cc.id DESC
       LIMIT 1) c ON true
   WHERE l.book_id = $1 AND l.active AND l.group_id = ANY($2::int[])`;

// A book's bank and cash accounts as at `today`, one tile each: { as_at, accounts, unadjusted }. An account is { ledger_id, name,
// account_kind: 'cash' | 'holder' | 'bank', balance_paise, holder_name, float_paise, top_up_paise, last_count: { count_date,
// difference_paise, cleared_voucher_id (the posted clearing, or null), clearing_waiting (a clearing waits for an Approver) } | null }: office cash first, then the holders, then the banks, each by name. top_up_paise is what brings a
// holder back to the float (finTopUpPaise: nothing without a float). `unadjusted` is the party money on account, { count,
// amount_paise }, counted in SQL (finOnAccountSummary). Both are aggregate reads: no line leaves the database.
export async function finCashAccounts(bookId, { today = plantDateStr() } = {}) {
  const asAt = finToday(today);
  const kinds = await finGroupKinds(q, bookId);
  const groups = [...kinds].filter(([, kind]) => kind.account_kind != null).map(([id]) => id);
  const rows = await q(FIN_TILES_SQL, [bookId, groups, asAt]);
  const accounts = rows.map(row => {
    const balance_paise = finToPaise(row.balance);
    const float_paise = row.float_amount == null ? null : finToPaise(row.float_amount);
    return {
      ledger_id: row.id, name: row.name, account_kind: finAccountKindOf(row, kinds), balance_paise,
      holder_name: row.holder_name ?? null, float_paise, top_up_paise: finTopUpPaise({ float_paise, holds_paise: balance_paise }),
      last_count: row.count_date == null ? null : {
        count_date: row.count_date, difference_paise: finToPaise(row.difference),
        cleared_voucher_id: row.cleared_voucher_id ?? null, clearing_waiting: row.clearing_waiting === true,
      },
    };
  }).sort((a, b) => FIN_KIND_ORDER[a.account_kind] - FIN_KIND_ORDER[b.account_kind]
    || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.ledger_id - b.ledger_id);
  return { as_at: asAt, accounts, unadjusted: await finOnAccountSummary(q, bookId) };
}

// ── The book (spec §5) ───────────────────────────────────────────────────────────────────────

const finMonthStart = date => `${date.slice(0, 7)}-01`;
function finMonthEnd(date) {
  const [year, month] = date.split('-').map(Number);
  const next = month === 12 ? `${String(year + 1).padStart(4, '0')}-01-01` : `${date.slice(0, 4)}-${String(month + 1).padStart(2, '0')}-01`;
  return finDayBefore(next);
}

// The days the book runs between, both included (spec §5: the current month by default). Both given, as given; one given, its
// month, from it or to it; neither, the month `today` falls in. A window that ends before it starts, or runs past
// FIN_BOOK_MAX_DAYS, is refused (400): the book is always a window, never the whole history (spec §3).
function finBookWindow(from, to, today) {
  const day = (value, field) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !finIsValidDate(value)) {
      throw finError(400, 'FIN_BAD_DATE', `${field} isn't a valid date. Write it as YYYY-MM-DD.`, { field });
    }
    return value;
  };
  let start = day(from, 'from');
  let end = day(to, 'to');
  if (start == null && end == null) [start, end] = [finMonthStart(today), finMonthEnd(today)];
  else if (start == null) start = finMonthStart(end);
  else if (end == null) end = finMonthEnd(start);
  if (start > end) throw finBad('The start date comes after the end date.', 'from');
  if (finDaysBetween(start, end) + 1 > FIN_BOOK_MAX_DAYS) {
    throw finBad(`The book shows ${FIN_BOOK_MAX_DAYS} days at a time at most. Ask for a shorter window.`, 'to');
  }
  return { from: start, to: end };
}

// Rupees as the book's adjustment says them: a whole number of rupees without its paise ("₹0", "₹5,000"), any other amount to the paisa.
const FIN_RUPEES = new Intl.NumberFormat('en-IN');
const finRupees = p => (p % 100 === 0 ? `₹${FIN_RUPEES.format(p / 100)}` : finFormatINR(p));

// What a party line settled, as the book says it beside the party (spec §5): "Auto: 3 bills, ₹0 on account", "Pick: 1 bill, ₹5,000
// on account", or "₹5,000 on account" when it settled nothing. A line whose bills were paired by Auto and by Pick (a later redo of
// a bill can pair it) says "Adjusted".
function finAdjustmentText({ amount_paise, settled_paise, bills, modes }) {
  const onAccount = finRupees(amount_paise - settled_paise);
  if (bills === 0) return `${onAccount} on account`;
  const how = modes.length !== 1 ? 'Adjusted' : modes[0] === 'pick' ? 'Pick' : 'Auto';
  return `${how}: ${bills} bill${bills === 1 ? '' : 's'}, ${onAccount} on account`;
}

// One account's book (spec §5), built on its ledger statement (finLedgerStatement): { ledger, from, to, opening_paise, entries,
// total_in_paise, total_out_paise, closing_paise, pending }.
//   ledger    { id, name, book_id, group_name, account_kind, holder_name }; a ledger that is no bank or cash account is refused
//             (400: its statement is the ledger report's);
//   entries   its posted lines from `from` to `to`, in the statement's order, each { date, voucher_id, number, voucher_type,
//             particulars, narration, adjustment, in_paise, out_paise, balance_paise }: particulars names the other side of the
//             entry (the ledgers on the opposite side of the voucher, finAgainst), the running balance carries the opening, and
//             adjustment says what the voucher's party line settled (finAdjustmentText), or null when it has none, or more than
//             one, or the voucher no longer stands (ruling R9);
//   pending   apart and outside every balance: the vouchers waiting for approval that touch the account, dated in the window,
//             each { date, voucher_id, voucher_type, particulars, narration, in_paise, out_paise, submitted_by }.
// The window (finBookWindow) is the current month when no dates are given. Read in this order, the posted lines first, so an entry
// approved while the book is read is never in both lists (at worst it is in neither, until the next refresh). With `lean` (ruling R65:
// the page asks for lean rows), `entries` and `pending` are each { columns, rows }: their keys once and one array per line
// (client/src/lib/finance/cash.js finLeanBook), which finRehydrateBook puts back as these very objects.
export async function finCashBook(ledgerId, { from = null, to = null, today = plantDateStr(), lean = false } = {}) {
  const id = finIdOf(ledgerId);
  const ledger = id == null ? null : await one('SELECT id, book_id, name, group_id, holder_name FROM fin_ledgers WHERE id = $1', [id]);
  if (!ledger) throw finError(404, 'FIN_NOT_FOUND');
  const kinds = await finGroupKinds(q, ledger.book_id);
  const kind = finAccountKindOf(ledger, kinds);
  if (kind == null) throw finBad(`${ledger.name} isn't a bank or cash account. Its statement is in Reports, under Ledger.`, 'ledger');
  const range = finBookWindow(from, to, finToday(today));
  const statement = await finLedgerStatement(id, range);
  const waiting = await q(
    `SELECT v.id AS voucher_id, v.voucher_type, v.voucher_date, v.narration, v.submitted_by, v.submitted_at,
            SUM(ln.debit) AS debit, SUM(ln.credit) AS credit
       FROM fin_vouchers v JOIN fin_voucher_lines ln ON ln.voucher_id = v.id
      WHERE ln.ledger_id = $1 AND v.status = 'submitted' AND v.voucher_date >= $2 AND v.voucher_date <= $3
      GROUP BY v.id
      ORDER BY v.voucher_date, v.submitted_at, v.id`, [id, range.from, range.to]);

  const postedIds = [...new Set(statement.entries.map(e => e.voucher_id))];
  const voucherIds = [...new Set([...postedIds, ...waiting.map(w => w.voucher_id)])];
  const lines = voucherIds.length ? await q(
    `SELECT ln.voucher_id, ln.line_no, ln.ledger_id, fl.name, ln.debit > 0 AS is_debit
       FROM fin_voucher_lines ln JOIN fin_ledgers fl ON fl.id = ln.ledger_id
      WHERE ln.voucher_id = ANY($1::int[])
      ORDER BY ln.voucher_id, ln.line_no`, [voucherIds]) : [];
  const linesOf = new Map();
  for (const line of lines) {
    if (!linesOf.has(line.voucher_id)) linesOf.set(line.voucher_id, []);
    linesOf.get(line.voucher_id).push(line);
  }
  // The other side of an entry on this account: the voucher's ledgers on the opposite side, each once, in line order.
  const particulars = (voucherId, inSide, fallback = '') => {
    const names = [];
    for (const line of linesOf.get(voucherId) ?? []) {
      if (line.ledger_id !== id && line.is_debit !== inSide && !names.includes(line.name)) names.push(line.name);
    }
    return names.length ? finAgainst(names) : fallback;
  };
  const partyLines = new Map();
  for (const row of await finSettledOf(q, ledger.book_id, postedIds)) {
    if (!row.live) continue;
    if (!partyLines.has(row.voucher_id)) partyLines.set(row.voucher_id, []);
    partyLines.get(row.voucher_id).push(row);
  }
  const adjustmentOf = voucherId => {
    const rows = partyLines.get(voucherId);
    return rows?.length === 1 ? finAdjustmentText(rows[0]) : null;
  };

  const book = {
    ledger: {
      id: ledger.id, name: ledger.name, book_id: ledger.book_id, group_name: statement.ledger.group_name, account_kind: kind,
      holder_name: ledger.holder_name ?? null,
    },
    from: range.from,
    to: range.to,
    opening_paise: statement.opening_paise,
    entries: statement.entries.map(e => ({
      date: e.voucher_date, voucher_id: e.voucher_id, number: e.number, voucher_type: e.voucher_type,
      particulars: particulars(e.voucher_id, e.debit_paise > 0, e.against), narration: e.narration, adjustment: adjustmentOf(e.voucher_id),
      in_paise: e.debit_paise, out_paise: e.credit_paise, balance_paise: e.balance_paise,
    })),
    total_in_paise: statement.total_debit_paise,
    total_out_paise: statement.total_credit_paise,
    closing_paise: statement.closing_paise,
    pending: waiting.map(w => {
      const in_paise = finToPaise(w.debit);
      return {
        date: w.voucher_date, voucher_id: w.voucher_id, voucher_type: w.voucher_type, particulars: particulars(w.voucher_id, in_paise > 0),
        narration: w.narration, in_paise, out_paise: finToPaise(w.credit), submitted_by: w.submitted_by,
      };
    }),
  };
  return lean ? finLeanBook(book) : book;
}

// ── Money on account, previews, the party's statement (spec §5, §6.3, §6.4, §6.7) ──────────────

// The party money still on account in a book, oldest first (spec §5's "Unadjusted money", §6.3: each waits for its own Adjust):
// { items, truncated }, each item one of finOpenItems' with its ledger_id and the party's name, at most FIN_UNADJUSTED_MAX of them.
export async function finCashUnadjusted(bookId) {
  return finOnAccountItems(q, bookId, { max: FIN_UNADJUSTED_MAX });
}

// What an adjustment would settle now, writing nothing (spec §5.1: the preview before saving; §6.4: the Pick list):
// { allocations, on_account_paise, items }. The body is { side, amount_paise, mode, picks, reference }: `side` is the side of the
// party's ledger the money goes on, 'credit' for money received (it settles the open debits: a customer's bills) and 'debit' for
// money paid (it settles the open credits: a vendor's bills); amount_paise is that line's whole amount (the amount and its TDS);
// mode is Auto or Pick, or none yet (nothing settled, all on account). `items` are the open items it is worked against, in the Pick
// list's order (finPickOrder: a bill whose reference the typed one names first), each with its age in days as at `today`.
// With `line_id`, the preview is a redo's (spec §6.5; the screen's Redo and, with scope 'open', its Adjust): finRedoPreview. Asked with the entry's day and
// account as well, it answers the party's cash that day too (ruling R59, finPreviewCashDay).
export async function finAllocationPreview(ledgerId, input, { today = plantDateStr() } = {}) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  if (raw.line_id != null) return finRedoPreview(ledgerId, raw, today);
  if (raw.side !== 'credit' && raw.side !== 'debit') {
    throw finBad("Say which side of the party's ledger the money goes on: credit for money received, debit for money paid.", 'side');
  }
  if (!finIsWholePaise(raw.amount_paise)) throw finBad('The amount is a whole number of paise, nothing or more.', 'amount_paise');
  const how = raw.mode == null ? { mode: null, picks: [] } : finCleanAdjust({ mode: raw.mode, picks: raw.picks });
  const reference = finOptionalText(raw.reference, 'reference', FIN_REFERENCE_MAX);
  const asAt = finToday(today);
  const open = await finOpenItems(q, ledgerId);
  const against = raw.side === 'credit' ? open.debits : open.credits;
  const { allocations, on_account_paise } = finAllocate(against, how, raw.amount_paise);
  return {
    allocations, on_account_paise, items: finPickOrder(against, reference).map(item => finAged(item, asAt)),
    ...(await finPreviewCashDay(open.ledger_id, raw)),
  };
}

// The party's cash on the day of the entry being typed (ruling R59; spec §5.6's s.269ST and s.40A(3)), for the form's warnings before it
// saves: { party_cash_day_paise }, the party's cash receipts (money received: side 'credit') or cash payments (side 'debit') that day in
// the party's book, posted and waiting for approval, the entry the form's save key made already left out (the form adds the entry
// itself). The body names the entry's day (voucher_date) and account (account_ledger_id), and may carry its save key (client_key). null
// when the account is no cash account of that book: a bank has no cash limit, and another book's ledger is none of this one's. Nothing
// at all ({}) when neither the day nor the account is asked; either without the other is refused (400).
async function finPreviewCashDay(partyLedgerId, raw) {
  if (raw.voucher_date == null && raw.account_ledger_id == null) return {};
  const day = finVoucherDate(raw.voucher_date);
  const accountId = finIdOf(raw.account_ledger_id);
  if (accountId == null) throw finBad('Say which bank or cash account the entry is made in.', 'account_ledger_id');
  const exceptKey = finClientKey(raw.client_key);
  const party = await one('SELECT book_id FROM fin_ledgers WHERE id = $1', [partyLedgerId]);
  const account = await one('SELECT id, book_id, group_id, holder_name FROM fin_ledgers WHERE id = $1', [accountId]);
  const kinds = await finGroupKinds(q, party.book_id);
  const kind = account && account.book_id === party.book_id ? finAccountKindOf(account, kinds) : null;
  if (kind !== 'cash' && kind !== 'holder') return { party_cash_day_paise: null };
  return {
    party_cash_day_paise: await finPartyCash(q, {
      bookId: party.book_id, day, partyId: partyLedgerId, receive: raw.side === 'credit', kinds, statuses: ['posted', 'submitted'], exceptKey,
    }),
  };
}

// A redo's preview (spec §6.5): what PUT /finance/lines/:id/allocations would settle with `mode`, `picks` and `scope`, writing nothing.
// A Redo (scope 'line', the default) deletes the line's allocations and settles all of the line again, so the bills it settles now count
// as open; an Adjust (scope 'open', ruling R71) keeps them, and settles only what the line still holds on account (finRedoPreviewOf).
// The money and its side are the line's own: { allocations, on_account_paise, items, side, amount_paise, scope }, the body's side and
// amount not read. `line_id` must be a posted line of a live voucher on this party's ledger (409 FIN_NOT_PARTY_LINE otherwise, there or
// not).
async function finRedoPreview(ledgerId, raw, today) {
  const lineId = finIdOf(raw.line_id);
  if (lineId == null) throw finBad('Say which entry of the party is adjusted again.', 'line_id');
  const how = raw.mode == null ? { mode: null, picks: [] } : finCleanAdjust({ mode: raw.mode, picks: raw.picks });
  const scope = finAdjustScope(raw.scope);
  const reference = finOptionalText(raw.reference, 'reference', FIN_REFERENCE_MAX);
  const asAt = finToday(today);
  const redo = await finRedoPreviewOf(q, ledgerId, lineId, { scope });
  const { allocations, on_account_paise } = finAllocate(redo.against, how, redo.money_paise);
  return {
    allocations, on_account_paise, items: finPickOrder(redo.against, reference).map(item => finAged(item, asAt)),
    side: redo.side, amount_paise: redo.money_paise, scope,
  };
}

// A party's statement (spec §6.7): { ledger: { id, name, book_id, side }, as_at, open_items, on_account, check }. open_items are
// what is outstanding (a customer's open debits, a vendor's open credits) and on_account the money paid ahead (the other side),
// each item with what is still open of it and its age in days as at `today`. check is the invariant's two sides beside the ledger's
// balance (finPartyFigures), worked out from the very items listed: one read (finOpenItems), so the figures and the lists agree.
// A ledger that is no party's is refused, 409 FIN_NOT_PARTY_LINE.
export async function finPartyReport(ledgerId, { today = plantDateStr() } = {}) {
  const asAt = finToday(today);
  const open = await finOpenItems(q, ledgerId);
  const ledger = await one('SELECT id, name, book_id FROM fin_ledgers WHERE id = $1', [open.ledger_id]);
  const [owed, held] = open.side === 'vendor' ? [open.credits, open.debits] : [open.debits, open.credits];
  return {
    ledger: { id: ledger.id, name: ledger.name, book_id: ledger.book_id, side: open.side },
    as_at: asAt,
    open_items: owed.map(item => finAged(item, asAt)),
    on_account: held.map(item => finAged(item, asAt)),
    check: finPartyFigures(open),
  };
}

// The day the ERP's own Record Payment and vendor-payment doors hand over to Finance (spec §11, items 4 to 6): the earliest day an
// active book begins on (2027-01-01), or null while there is none. Any login may ask: it says nothing about any book's figures.
export async function finCashSwitch() {
  const row = await one('SELECT MIN(books_begin) AS date FROM fin_books WHERE active');
  return { date: row?.date ?? null };
}
