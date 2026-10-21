// Finance — the Tally import (spec §11). How the accountant's Tally balances become Finance's Opening voucher on the day
// before the books begin, and how Tally's month-end trial balances are set beside Finance's during the parallel run.
//
// The browser reads Tally's Excel exports (client/src/lib/finance/tally.js) and sends their rows. An import is one upload:
//   opening      the List of Accounts (every ledger, with its Tally group), the Trial Balance as at the day before the
//                books begin, and the bills outstanding, bill by bill. Every account becomes a row, a zero balance too
//                (ruling R36), each with a proposal: match an existing ledger, or create one under the Finance group of
//                its Tally group's name (linked, under Sundry Debtors or Sundry Creditors, to the ERP customer or vendor
//                with its GSTIN, else its name: ruling R32), or unmatched.
//   parallel_tb  a month-end Trial Balance (ruling R34: from the day the books begin). Every row that is not a group's
//                subtotal or the grand total is kept and matched to a ledger of the book, or left unmatched. Nothing is
//                made from it; the parallel run (finParallelRun) compares it with Finance as at its date.
// Its life: draft (uploaded, with proposals) → matched (the accountant has confirmed every row, PUT matches: nothing is
// matched silently, ruling R33) → used (its Opening voucher is built and submitted). A used import is never changed: after
// a rejected Opening voucher the accountant uploads again (ruling R37).
//
// Before the Opening voucher is built the import ties out (finTieOut): the trial balance balances, every row is matched or
// made, every row of the trial balance is in the List of Accounts, and each party's bills add up to its balance. The
// Opening voucher then holds one line per ledger with a balance, or a line per bill for a party with bills, so the trial
// balance as at its date is Tally's, ledger by ledger, to the paisa.
//
// The writes (finCreateImport, finSaveMatches, finBuildOpening) take the `qc` / `oc` of the transaction their route opened
// and use nothing else: the pool is one client on Vercel. The route has asked finRequire who may BEFORE the transaction.
// Each writes ONE audit row for the import (entity 'import': upload, match, build) in the same transaction (spec §8.3).
// The ledgers and the voucher a build makes write their own rows, as they do wherever they are made.
// The reads (finImportView, finListImports, finParallelRun, finImportBookOf) go through the pool.
//
// Locks. A confirmation takes the import FOR UPDATE first. A build takes the Opening voucher's number series first (it
// submits, and a submit may post), then the import FOR UPDATE, then makes the ledgers, the voucher and its lines, submits,
// and marks the import used: the order of every Finance transaction that may post (spec §7.4). Two builds of one book
// meet at the series, and a confirmation and a build of one import meet at the import, so the second always finds what
// the first left: the book's Opening voucher, or a used import. Anything refused rolls the whole build back, the ledgers
// it made included.
//
// Amounts are WHOLE PAISE in JS and in the API, NUMERIC in the staging tables. A bill's amount is SIGNED (Dr positive,
// Cr negative) everywhere, and its side says the same (ruling R38).

import { q, one } from './db.js';
import { lockDocNumber } from './helpers.js';
import { finAudit } from './finance-audit.js';
import { finSeenBookOf } from './finance-access.js';
import { FIN_SENTENCES, finError } from './finance-errors.js';
import { FIN_PARTY_GROUPS } from './finance-groups.js';
import { FIN_NAME_MAX, finCreateLedger, finIdOf, finOptionalText, finRequiredName } from './finance-masters.js';
import { finTrialBalance } from './finance-reports.js';
import { finPrefix } from './finance-rules.js';
import {
  FIN_BILL_REF_MAX, finBillDate, finCleanLines, finCreateBuiltDraft, finGroupKinds, finIsPartyLedger, finLiveOpeningProblem, finSubmitVoucher,
} from './finance-vouchers.js';
import { finDayBefore, finFyOf, finIsValidDate } from '../../client/src/lib/finance/fy.js';
import { FIN_MAX_PAISE, finFormatINR, finFromPaise, finToPaise } from '../../client/src/lib/finance/money.js';

// The most rows one upload takes (ruling R35). app.js lets this route's JSON, and its confirmation's, run to 4 MB (ruling
// R41); these are the real guard.
const FIN_IMPORT_MAX = Object.freeze({ accounts: 5000, tb: 10000, bills: 5000 });
const FIN_OPENING_MAX_LINES = 5000;   // the Opening voucher's own cap: a typed voucher's 200 (finCleanLines) is too few
const FIN_GSTIN_MAX = 50;
const FIN_FILE_NAMES_MAX = 20;

const FIN_PURPOSES = ['opening', 'parallel_tb'];
const FIN_PARTY_TYPES = ['customer', 'vendor'];
// A confirmation's action, and the match_status a row keeps for it.
const FIN_STATUS_OF = Object.freeze({ match: 'matched', create: 'create', unmatched: 'unmatched' });
const FIN_ACTION_OF = Object.freeze({ matched: 'match', create: 'create', unmatched: 'unmatched' });

const FIN_IMPORT_COLS = 'id, book_id, purpose, as_at, status, file_names, uploaded_by, uploaded_at, opening_voucher_id, summary';

// ── Small pieces ─────────────────────────────────────────────────────────────────────────────

const finBad = (message, field) => finError(400, 'FIN_BAD_INPUT', message, field ? { field } : {});
const finMissing = () => finError(404, 'FIN_NOT_FOUND');
const finDrCr = p => finFormatINR(p, { drcr: true });
const finCount = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const finSum = values => values.reduce((total, v) => total + v, 0);

// Who is acting. An import write with nobody to blame is a bug in the caller.
function finActing(actor) {
  const name = typeof actor?.name === 'string' ? actor.name.trim() : '';
  if (!Number.isSafeInteger(actor?.id) || !name) throw new Error('An import write needs to know who is acting: pass { id, name }');
  return { id: actor.id, name };
}

// A Map of key -> every item with that key, in the order they came. Items with no key are left out.
function finIndex(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// ── Matching (PURE) ──────────────────────────────────────────────────────────────────────────

// A name as matching reads it: lower case, trimmed, every run of whitespace one space, and no dots at the end, so
// 'Alpha Bank.' and '  alpha   BANK' are one name.
export function finNormName(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.\s]+$/, '') : '';
}

// A GSTIN as matching reads it: upper case with no spaces, and only when it then has a GSTIN's shape, two digits (the
// state's code) and thirteen letters and digits. 'NA', 'URP' and the like are no GSTIN: the name decides instead.
const FIN_GSTIN_SHAPE = /^\d{2}[A-Z0-9]{13}$/;
const finGstinKey = g => {
  const key = typeof g === 'string' ? g.replace(/\s+/g, '').toUpperCase() : '';
  return FIN_GSTIN_SHAPE.test(key) ? key : '';
};

// Several rows wanting one thing (a ledger, a party): the row that wants it most keeps it, lower ranks first. A tie at
// the best rank is no answer, so nobody keeps it. Claims are { index, key, rank }; returns the indexes that keep theirs.
function finSettle(claims) {
  const keep = new Set();
  for (const contest of finIndex(claims, c => c.key).values()) {
    const best = Math.min(...contest.map(c => c.rank));
    const top = contest.filter(c => c.rank === best);
    if (top.length === 1) keep.add(top[0].index);
  }
  return keep;
}

// What each Tally row should be, proposed for the accountant to confirm (spec §11.2 step 2):
//   { tally_name, action: 'match' | 'create' | 'unmatched', ledger_id, group_id, party_type, party_id } (unused ones null)
//   • match   an existing ledger of the book whose Tally name is the row's, else one whose name is (normalised names);
//   • create  otherwise, under the book's group whose name is the row's Tally group, and under a party group linked to
//             the ERP customer or vendor with the row's GSTIN, else its name (ruling R32);
//   • unmatched when there is no such group, or no single answer.
// `rows` are { tally_name, tally_group, gstin? }; `ledgers` are the book's { id, name, tally_name, party_type, party_id };
// `groups` are { id, name, is_party, party_type? }, where is_party marks a party group (finGroupKinds) and party_type says
// which ERP party a ledger under it is first taken to be, customer under Sundry Debtors and vendor under Sundry Creditors;
// `parties` are the ERP's { party_type, id, name, gstin, active }: only an active one is proposed, so a closed twin never
// turns a clean hit into an ambiguous one (M2).
// No proposal sets up a build that would fail (ruling R32):
//   • A stage at which two ledgers answer is no answer. A ledger two rows want goes to the one that found it by its Tally
//     name; a tie goes to neither. A row that does not get a ledger of its name is left unmatched, never proposed as a new
//     ledger: the name is taken in the book.
//   • Several parties answering is no proposal. A GSTIN that answers decides, and a name is not asked after it; only a
//     value of a GSTIN's shape is one (M3). A name that is both a customer and a vendor is the one of the group's
//     party_type. A party already linked to a ledger in the book is never proposed, and one party is never proposed for
//     two rows: a GSTIN beats a name and the group's own type beats the other; a tie goes to neither.
export function finProposeMatches({ rows = [], ledgers = [], groups = [], parties = [] } = {}) {
  const byTallyName = finIndex(ledgers, l => finNormName(l.tally_name));
  const byName = finIndex(ledgers, l => finNormName(l.name));
  const groupsByName = finIndex(groups, g => finNormName(g.name));
  const linked = new Set(ledgers.filter(l => l.party_type != null && l.party_id != null).map(l => `${l.party_type}:${l.party_id}`));
  const open = parties.filter(p => p.active !== false);
  const byGstin = finIndex(open, p => finGstinKey(p.gstin));
  const partiesByName = finIndex(open, p => finNormName(p.name));

  // The ledgers. Each row is 'claim' (one ledger answered), 'taken' (its name is in the book, but not one answer) or 'free'.
  const ledgerClaims = [];
  const found = rows.map((row, index) => {
    const key = finNormName(row.tally_name);
    const byTally = byTallyName.get(key) ?? [];
    const answer = byTally.length ? byTally : (byName.get(key) ?? []);
    if (answer.length === 1) {
      ledgerClaims.push({ index, key: answer[0].id, rank: byTally.length ? 0 : 1 });
      return 'claim';
    }
    return answer.length ? 'taken' : 'free';
  });
  const keptLedgers = finSettle(ledgerClaims);
  const claimOf = new Map(ledgerClaims.map(c => [c.index, c]));
  const out = rows.map((row, index) => {
    const none = { tally_name: row.tally_name, action: 'unmatched', ledger_id: null, group_id: null, party_type: null, party_id: null };
    if (found[index] === 'claim') return keptLedgers.has(index) ? { ...none, action: 'match', ledger_id: claimOf.get(index).key } : none;
    const group = found[index] === 'free' ? groupsByName.get(finNormName(row.tally_group)) ?? [] : [];
    return group.length === 1 ? { ...none, action: 'create', group_id: group[0].id } : none;
  });

  // The parties, for a new ledger under a party group.
  const groupById = new Map(groups.map(g => [g.id, g]));
  const partyClaims = [];
  out.forEach((proposal, index) => {
    const group = proposal.action === 'create' ? groupById.get(proposal.group_id) : null;
    if (!group?.is_party) return;
    const gstin = finGstinKey(rows[index].gstin);
    const byTax = gstin ? byGstin.get(gstin) : undefined;
    const hits = byTax ?? partiesByName.get(finNormName(rows[index].tally_name)) ?? [];
    const own = hits.filter(p => p.party_type === group.party_type);
    const candidates = own.length ? own : hits;
    if (candidates.length !== 1) return;
    const key = `${candidates[0].party_type}:${candidates[0].id}`;
    if (linked.has(key)) return;
    partyClaims.push({ index, key, rank: (byTax ? 0 : 2) + (own.length ? 0 : 1), party: candidates[0] });
  });
  const keptParties = finSettle(partyClaims);
  for (const claim of partyClaims) {
    if (keptParties.has(claim.index)) Object.assign(out[claim.index], { party_type: claim.party.party_type, party_id: claim.party.id });
  }
  return out;
}

// ── The tie-out (PURE) ───────────────────────────────────────────────────────────────────────

// The lines the Opening voucher holds for an import's rows (spec §11.2 step 4), in the rows' order: for a party's ledger
// with bills, a line per bill, Dr or Cr as the bill is; for any other row with a balance, one line for it, Dr if
// positive, Cr if negative; for a zero balance, none. Each is { row, debit_paise, credit_paise, bill_ref, bill_date,
// due_date }, with the row it is for. ONE definition: the tie-out counts these lines, and the build writes them.
function finOpeningLines(ledgers, bills) {
  const billsOf = finIndex(bills, b => finNormName(b.tally_ledger_name));
  const lines = [];
  for (const row of ledgers) {
    const own = row.is_party ? billsOf.get(finNormName(row.tally_name)) ?? [] : [];
    if (own.length) {
      for (const b of own) {
        lines.push({ row, debit_paise: Math.max(b.amount_paise, 0), credit_paise: Math.max(-b.amount_paise, 0),
          bill_ref: b.bill_ref ?? null, bill_date: b.bill_date ?? null, due_date: b.due_date ?? null });
      }
    } else if (row.debit_paise !== row.credit_paise) {
      const net = row.debit_paise - row.credit_paise;
      lines.push({ row, debit_paise: Math.max(net, 0), credit_paise: Math.max(-net, 0), bill_ref: null, bill_date: null, due_date: null });
    }
  }
  return lines;
}

// A row's figures in a sentence: its balance, Dr or Cr, or both sides when it carries both (a Grand Total row does).
const finFiguresOf = r => (r.debit_paise && r.credit_paise
  ? `${r.tally_name} debits ${finFormatINR(r.debit_paise)}, credits ${finFormatINR(r.credit_paise)}`
  : `${r.tally_name} ${finDrCr(r.debit_paise - r.credit_paise)}`);

// Whether an import's figures may become the Opening voucher (spec §11.2 steps 3 and 4): { ok, problems, warnings, totals }.
// `ledgers` are the import's rows { tally_name, debit_paise, credit_paise, action, is_party }, action as a confirmation
// says it; `bills` are { tally_ledger_name, amount_paise, side }, signed; `unknown` are the trial balance's rows that are
// in no List of Accounts (ruling R36), and `ignored` the rows read as groups' totals that carried an amount (ruling R43),
// both from the import's summary. Problems, each { code, message }, in this order:
//   TB_UNBALANCED       the rows' debits are not their credits
//   TB_NOT_IN_ACCOUNTS  a trial balance row with an amount that is not in the List of Accounts: the voucher would leave it
//                       out, so the books would not be Tally's
//   UNMATCHED           a row neither matched to a ledger nor to be made
//   BILLS_MISMATCH      a party's bills do not add up to its trial balance figure: "<party>: bills ₹X, trial balance ₹Y."
//   BILLS_NO_LEDGER     bills that name no row of the import (ruling R38): they are never dropped silently
//   TOO_MANY_LINES      more lines (finOpeningLines) than the Opening voucher takes, FIN_OPENING_MAX_LINES (M4)
// Warnings, sentences that do not stop the build: when the trial balance doesn't balance, the rows read as groups' totals
// that carried an amount, by name, in case one of them was a ledger; a party with a balance and no bills goes in as one
// line; bills on a ledger that is not a party's are left out, and it goes in as one line. totals are the rows' debits and
// credits. Bills meet their ledger by normalised name. Every figure is whole paise, so every sum here is exact.
export function finTieOut({ ledgers = [], bills = [], unknown = [], ignored = [] } = {}) {
  const problems = [];
  const warnings = [];
  const dr = finSum(ledgers.map(r => r.debit_paise));
  const cr = finSum(ledgers.map(r => r.credit_paise));
  if (dr !== cr) {
    problems.push({ code: 'TB_UNBALANCED',
      message: `The trial balance doesn't balance: debits ${finFormatINR(dr)}, credits ${finFormatINR(cr)} — a difference of ${finFormatINR(Math.abs(dr - cr))}.` });
    if (ignored.length) {
      warnings.push(`These rows were read as groups' totals and left out of the trial balance: ${ignored.map(finFiguresOf).join('; ')}. `
        + 'If one of them is a ledger, its figure is what is missing.');
    }
  }
  for (const row of unknown) {
    const net = row.debit_paise - row.credit_paise;
    if (net !== 0) {
      problems.push({ code: 'TB_NOT_IN_ACCOUNTS', message: `${row.tally_name} is in the trial balance with ${finDrCr(net)}, but it isn't in the List of Accounts.` });
    }
  }
  for (const row of ledgers) {
    if (row.action === 'unmatched') {
      problems.push({ code: 'UNMATCHED', message: `${row.tally_name} isn't matched to a Finance ledger, and no ledger is to be made for it.` });
    }
  }
  const billsOf = finIndex(bills, b => finNormName(b.tally_ledger_name));
  for (const row of ledgers) {
    const own = billsOf.get(finNormName(row.tally_name)) ?? [];
    const net = row.debit_paise - row.credit_paise;
    if (!row.is_party) {
      if (own.length) {
        warnings.push(`${row.tally_name} isn't a party's ledger, so its ${finCount(own.length, 'bill')} ${own.length === 1 ? 'is' : 'are'} left out and it goes in `
          + (net === 0 ? 'with no line: it has no balance.' : `as one line of ${finDrCr(net)}.`));
      }
    } else if (!own.length) {
      if (net !== 0) warnings.push(`${row.tally_name} has no bills, so its balance of ${finDrCr(net)} goes in as one line.`);
    } else {
      const billed = finSum(own.map(b => b.amount_paise));
      if (billed !== net) problems.push({ code: 'BILLS_MISMATCH', message: `${row.tally_name}: bills ${finDrCr(billed)}, trial balance ${finDrCr(net)}.` });
    }
  }
  const named = new Set(ledgers.map(r => finNormName(r.tally_name)));
  for (const [key, own] of billsOf) {
    if (named.has(key)) continue;
    const name = own[0].tally_ledger_name;
    problems.push({ code: 'BILLS_NO_LEDGER',
      message: `${name}: ${finCount(own.length, 'bill')} of ${finDrCr(finSum(own.map(b => b.amount_paise)))}, but ${name} isn't a ledger in this import.` });
  }
  const lines = finOpeningLines(ledgers, bills).length;
  if (lines > FIN_OPENING_MAX_LINES) {
    problems.push({ code: 'TOO_MANY_LINES',
      message: `The Opening voucher would have ${lines.toLocaleString('en-IN')} lines, and it can have ${FIN_OPENING_MAX_LINES.toLocaleString('en-IN')} at most.` });
  }
  return { ok: problems.length === 0, problems, warnings, totals: { dr, cr } };
}

// ── The upload, checked (PURE) ───────────────────────────────────────────────────────────────

// A row's name: a name as a ledger's is (finRequiredName: trimmed, runs of spaces made one, 255 characters, no control
// character), refused under the row's own field. A name that normalises to nothing ('...') is no name either.
function finRowName(value, field, where) {
  let name;
  try { name = finRequiredName(value, where); } catch (e) { throw finBad(e.message, field); }
  if (!finNormName(name)) throw finBad(`${where} needs a name.`, field);
  return name;
}

// An amount: whole paise under ₹1 lakh crore (FIN_MAX_PAISE), not below zero unless `signed`. Absent is nothing.
function finPaiseOf(value, field, where, { signed = false } = {}) {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || Math.abs(value) >= FIN_MAX_PAISE || (!signed && value < 0)) {
    throw finError(400, 'FIN_BAD_AMOUNT',
      `${where}: an amount is a whole number of paise${signed ? '' : ', not below zero,'} under ₹1 lakh crore.`, { field });
  }
  return value + 0;   // + 0: a -0 is 0
}

// One of the upload's lists. `need` is 'required' (at least one row), 'optional' or 'none' (this kind of import has no
// such list: absent or empty, or refused, so nothing sent is dropped silently).
const FIN_LIST_LABEL = { accounts: 'The List of Accounts', tb: 'The trial balance', bills: 'The bills' };
function finListOf(value, field, need) {
  if (need === 'none') {
    if (value == null || (Array.isArray(value) && value.length === 0)) return [];
    throw finBad(`A month-end trial balance is the trial balance alone: it takes no ${field === 'bills' ? 'bills' : 'List of Accounts'}.`, field);
  }
  if (value == null && need === 'optional') return [];
  if (!Array.isArray(value)) throw finBad(`${FIN_LIST_LABEL[field]} must be a list of rows.`, field);
  if (need === 'required' && value.length === 0) throw finBad(`${FIN_LIST_LABEL[field]} has no rows.`, field);
  if (value.length > FIN_IMPORT_MAX[field]) {
    throw finBad(`${FIN_LIST_LABEL[field]} has ${value.length} rows; an import takes ${FIN_IMPORT_MAX[field]} at most.`, field);
  }
  return value;
}

const finRowObject = (raw, at) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw finBad(`${at} must be an object.`, at);
  return raw;
};

// A name twice in one list is refused, naming it (ruling R36): which row is which ledger would be a guess.
function finOnce(seen, name, list, field) {
  const key = finNormName(name);
  if (key === 'grand total') return;
  if (seen.has(key)) {
    throw finBad(`"${name}" is in ${list} twice: names are compared ignoring capitals, spaces and a closing dot.`, field);
  }
  seen.add(key);
}

// The running total of a list stays where a double adds exactly, so every total made from these rows is exact.
const finSafeTotal = (total, field) => {
  if (!Number.isSafeInteger(total)) throw finError(400, 'FIN_BAD_AMOUNT', 'These figures add up to more than the books can hold.', { field });
  return total;
};

// The upload as the browser sent it, checked and cleaned before the database is asked anything.
function finCleanUpload(input) {
  const body = input ?? {};
  const bookId = finIdOf(body.book_id);
  if (bookId == null) throw finBad('Say which book this import is for.', 'book_id');
  if (!FIN_PURPOSES.includes(body.purpose)) {
    throw finBad('An import is the opening balances (opening) or a month-end trial balance (parallel_tb).', 'purpose');
  }
  if (typeof body.as_at !== 'string' || !finIsValidDate(body.as_at)) {
    throw finError(400, 'FIN_BAD_DATE', "The date the import is as at isn't a valid date. Write it as YYYY-MM-DD.", { field: 'as_at' });
  }
  const opening = body.purpose === 'opening';

  let fileNames = [];
  if (body.file_names != null) {
    if (!Array.isArray(body.file_names) || body.file_names.length > FIN_FILE_NAMES_MAX) {
      throw finBad(`file_names must be a list of at most ${FIN_FILE_NAMES_MAX} file names.`, 'file_names');
    }
    fileNames = body.file_names.map((name, i) => {
      const text = finOptionalText(name, `file_names[${i}]`, FIN_NAME_MAX);
      if (!text) throw finBad('A file name cannot be blank.', `file_names[${i}]`);
      return text;
    });
  }

  const seenAccounts = new Set();
  const accounts = finListOf(body.accounts, 'accounts', opening ? 'required' : 'none').map((raw, i) => {
    const at = `accounts[${i}]`;
    finRowObject(raw, at);
    const tally_name = finRowName(raw.tally_name, `${at}.tally_name`, `Row ${i + 1} of the List of Accounts`);
    finOnce(seenAccounts, tally_name, 'the List of Accounts', `${at}.tally_name`);
    return {
      tally_name,
      tally_group: finOptionalText(raw.tally_group, `${at}.tally_group`, FIN_NAME_MAX),
      gstin: finOptionalText(raw.gstin, `${at}.gstin`, FIN_GSTIN_MAX),
    };
  });

  const seenTb = new Set();
  let dr = 0;
  let cr = 0;
  const tb = finListOf(body.tb, 'tb', 'required').map((raw, i) => {
    const at = `tb[${i}]`;
    finRowObject(raw, at);
    const tally_name = finRowName(raw.tally_name, `${at}.tally_name`, `Row ${i + 1} of the trial balance`);
    finOnce(seenTb, tally_name, 'the trial balance', `${at}.tally_name`);
    const debit_paise = finPaiseOf(raw.debit_paise, `${at}.debit_paise`, tally_name);
    const credit_paise = finPaiseOf(raw.credit_paise, `${at}.credit_paise`, tally_name);
    dr = finSafeTotal(dr + debit_paise, 'tb');
    cr = finSafeTotal(cr + credit_paise, 'tb');
    return { tally_name, debit_paise, credit_paise };
  });

  let zeroBills = 0;
  let billed = 0;
  const bills = [];
  finListOf(body.bills, 'bills', opening ? 'optional' : 'none').forEach((raw, i) => {
    const at = `bills[${i}]`;
    finRowObject(raw, at);
    const tally_ledger_name = finRowName(raw.tally_ledger_name, `${at}.tally_ledger_name`, `Bill ${i + 1}`);
    const amount_paise = finPaiseOf(raw.amount_paise, `${at}.amount_paise`, `${tally_ledger_name}'s bill`, { signed: true });
    if (amount_paise === 0) { zeroBills += 1; return; }   // a bill of nothing carries nothing: counted, and left (ruling R38)
    const side = amount_paise > 0 ? 'dr' : 'cr';
    if (raw.side !== side) {
      throw finBad(`${tally_ledger_name}'s bill of ${finDrCr(amount_paise)} is a ${side} bill, and it says ${JSON.stringify(raw.side ?? null)}.`, `${at}.side`);
    }
    billed = finSafeTotal(billed + Math.abs(amount_paise), 'bills');
    bills.push({
      tally_ledger_name, amount_paise, side,
      // A voucher line's own rules for a bill (finance-vouchers.js), so a bill staged here is one the Opening voucher takes.
      bill_ref: finOptionalText(raw.bill_ref, `${at}.bill_ref`, FIN_BILL_REF_MAX),
      bill_date: finBillDate(raw.bill_date, `${at}.bill_date`, `${tally_ledger_name}'s bill date`),
      due_date: finBillDate(raw.due_date, `${at}.due_date`, `${tally_ledger_name}'s due date`),
    });
  });

  return { bookId, purpose: body.purpose, as_at: body.as_at, fileNames, accounts, tb, bills, zeroBills };
}

// ── Reading an import ────────────────────────────────────────────────────────────────────────

const finImportOut = row => ({
  id: row.id, book_id: row.book_id, purpose: row.purpose, as_at: row.as_at, status: row.status, file_names: row.file_names,
  uploaded_by: row.uploaded_by, uploaded_at: row.uploaded_at, opening_voucher_id: row.opening_voucher_id, summary: row.summary,
});

const finBillOut = b => ({
  id: b.id, tally_ledger_name: b.tally_ledger_name, bill_ref: b.bill_ref, bill_date: b.bill_date, due_date: b.due_date,
  amount_paise: finToPaise(b.amount), side: b.side,
});

// A row as the tie-out reads it.
const finTieRow = r => ({
  tally_name: r.tally_name, debit_paise: r.debit_paise, credit_paise: r.credit_paise, action: FIN_ACTION_OF[r.match_status], is_party: r.is_party,
});

// The summary a list of imports carries: its counts, and none of the lists of names behind them (M7), which one import's
// own view has.
const finSlimSummary = summary => Object.fromEntries(Object.entries(summary ?? {}).filter(([, value]) => typeof value === 'number'));

// The import a request names, and its book, for the routes that name an import and not a book. A pool read, made before
// any transaction. An import the caller cannot see, whether it does not exist or lives in a book the caller holds no view
// on, is FIN_NOT_FOUND, one answer for both (finSeenBookOf, which answers for a voucher the same way). What the caller
// may do with an import it can see is finRequire's to say next, for the book this returns.
export async function finImportBookOf(value, req) {
  const id = finIdOf(value);
  return { id, bookId: await finSeenBookOf('import', id, req) };
}

// An import's rows and bills as they stand, and its tie-out: ONE computation, which finImportView shows and
// finBuildOpening builds from, so the screen and the build never disagree (M6). Whether a row's ledger is a party's is
// worked out here, every time, from the book as it is now: the matched ledger's own group and party link, or the group a
// new one goes under and the party it is to be linked to (finIsPartyLedger, ruling R23). The rows come in the order they
// were uploaded, each with the names it points at (ledger, group, party). A month-end import has no tie-out (null): it is
// compared, never built from. `qx` is the pool's q for a view, and the transaction's qc for a build.
async function finImportFigures(qx, imp) {
  const rows = await qx(
    `SELECT r.id, r.tally_name, r.tally_group, r.debit, r.credit, r.match_status, r.ledger_id, l.name AS ledger_name,
            l.book_id AS ledger_book_id, l.group_id AS ledger_group_id, l.party_type AS ledger_party_type,
            r.group_id, g.name AS group_name, r.party_type, r.party_id, COALESCE(c.name, v.name) AS party_name
       FROM fin_import_ledgers r
       LEFT JOIN fin_ledgers l ON l.id = r.ledger_id
       LEFT JOIN fin_groups g ON g.id = r.group_id
       LEFT JOIN customers c ON r.party_type = 'customer' AND c.id = r.party_id
       LEFT JOIN vendors v ON r.party_type = 'vendor' AND v.id = r.party_id
      WHERE r.import_id = $1
      ORDER BY r.id`, [imp.id]);
  const bills = (await qx(
    'SELECT id, tally_ledger_name, bill_ref, bill_date, due_date, amount, side FROM fin_import_bills WHERE import_id = $1 ORDER BY id', [imp.id]))
    .map(finBillOut);
  const kinds = await finGroupKinds(qx, imp.book_id);
  const partyNow = r => (r.match_status === 'matched'
    ? r.ledger_book_id === imp.book_id && finIsPartyLedger({ party_type: r.ledger_party_type, group_id: r.ledger_group_id }, kinds)
    : r.match_status === 'create' && finIsPartyLedger(r, kinds));
  const ledgers = rows.map(r => ({
    id: r.id, tally_name: r.tally_name, tally_group: r.tally_group, debit_paise: finToPaise(r.debit), credit_paise: finToPaise(r.credit),
    match_status: r.match_status, ledger_id: r.ledger_id, ledger_name: r.ledger_name, ledger_book_id: r.ledger_book_id,
    group_id: r.group_id, group_name: r.group_name, party_type: r.party_type, party_id: r.party_id, party_name: r.party_name,
    is_party: partyNow(r),
  }));
  const tie_out = imp.purpose !== 'opening' ? null : finTieOut({
    ledgers: ledgers.map(finTieRow), bills, unknown: imp.summary?.unknown ?? [], ignored: imp.summary?.ignored_with_amounts ?? [],
  });
  return { ledgers, bills, tie_out };
}

// One import for its screen: { import, ledgers, bills, tie_out }, as finImportFigures works them out. The caller has asked
// who may (finImportBookOf).
export async function finImportView(importId) {
  const id = finIdOf(importId);
  if (id == null) throw finMissing();
  const imp = await one(`SELECT ${FIN_IMPORT_COLS} FROM fin_imports WHERE id = $1`, [id]);
  if (!imp) throw finMissing();
  const { ledgers, bills, tie_out } = await finImportFigures(q, imp);
  return { import: finImportOut(imp), ledgers: ledgers.map(({ ledger_book_id, ...row }) => row), bills, tie_out };
}

// A book's imports, newest first, `purpose` to take one kind, each with a slim summary. The caller has asked finRequire
// for the book.
export async function finListImports(bookId, { purpose } = {}) {
  let kind = null;
  if (purpose !== undefined && purpose !== '') {
    if (!FIN_PURPOSES.includes(purpose)) throw finBad(`purpose must be one of: ${FIN_PURPOSES.join(', ')}.`, 'purpose');
    kind = purpose;
  }
  const rows = await q(
    `SELECT ${FIN_IMPORT_COLS} FROM fin_imports WHERE book_id = $1 AND ($2::text IS NULL OR purpose = $2::text) ORDER BY id DESC`, [bookId, kind]);
  return { imports: rows.map(row => ({ ...finImportOut(row), summary: finSlimSummary(row.summary) })) };
}

// ── The upload ───────────────────────────────────────────────────────────────────────────────

// The groups as finProposeMatches takes them. Whether a group is a party group is finGroupKinds' answer (ruling R23,
// the ONE definition); which of the two it sits under, Sundry Debtors (a customer) or Sundry Creditors (a vendor), is
// found by walking up to the nearer of them. It only decides between a customer and a vendor of one name (ruling R32).
// FIN_PARTY_GROUPS (finance-groups.js) names the two in that order: debtors, then creditors.
const [FIN_DEBTORS, FIN_CREDITORS] = FIN_PARTY_GROUPS;
const FIN_PARTY_SIDE = Object.freeze({ [FIN_DEBTORS.toLowerCase()]: 'customer', [FIN_CREDITORS.toLowerCase()]: 'vendor' });
function finProposalGroups(groups, kinds) {
  const byId = new Map(groups.map(g => [g.id, g]));
  const sideOf = group => {
    for (let at = group, seen = new Set(); at && !seen.has(at.id); seen.add(at.id), at = byId.get(at.parent_id)) {
      const side = FIN_PARTY_SIDE[at.name.toLowerCase()];
      if (side) return side;
    }
    return null;
  };
  return groups.map(g => {
    const isParty = kinds.get(g.id)?.is_party === true;
    return { id: g.id, name: g.name, is_party: isParty, party_type: isParty ? sideOf(g) : null };
  });
}

// The date an import is as at (ruling R34). The opening balances are as at the day before the books begin, the date of
// the Opening voucher, so a trial balance from any other day cannot become it. A month-end trial balance is as at a day
// the books keep: the day they begin, or later. Either is a day one of the book's financial years covers (M9), which is
// also a month end's latest date: a year not added yet is said the way posting says it (409 FIN_NO_PERIOD).
async function finCheckAsAt(oc, { purpose, as_at }, book) {
  if (purpose === 'opening') {
    const day = finDayBefore(book.books_begin);
    if (as_at !== day) {
      throw finError(400, 'FIN_BAD_DATE',
        `The opening balances are as at ${day}, the day before the books begin on ${book.books_begin}, not ${as_at}.`, { field: 'as_at' });
    }
  } else if (as_at < book.books_begin) {
    throw finError(400, 'FIN_BAD_DATE',
      `A month-end trial balance is as at a day the books keep: ${book.books_begin}, when they begin, or later — not ${as_at}.`, { field: 'as_at' });
  }
  const year = await oc('SELECT id FROM fin_years WHERE book_id = $1 AND start_date <= $2 AND end_date >= $2', [book.id, as_at]);
  if (!year) {
    throw finError(409, 'FIN_NO_PERIOD', `No financial year covers ${as_at} — add it in Finance → Setup → Months & Years.`, { field: 'as_at' });
  }
}

// Stage an upload and propose a match for every row; returns the new import's id. `input` is the upload:
// { book_id, purpose, as_at, file_names, accounts, tb, bills }, with the rows as finRowsFromSheet makes them.
//   • An opening import keeps EVERY row of the List of Accounts, a zero balance too, so each is matched or made now
//     (ruling R36). The trial balance's figures join their account by normalised name. A trial balance row that is the
//     name of one of the book's groups (a group's subtotal, as Tally prints it among the ledgers), or the grand total, is
//     counted in summary.ignored_rows and not kept; a List of Accounts row that names a group, likewise. A trial balance
//     row that names neither an account nor a group is listed in summary.unknown with its figures (and counted in
//     summary.unknown_rows), which the tie-out refuses while it carries an amount: it is never dropped silently.
//   • A month-end import keeps every trial balance row that is not a group or the grand total, matched to a ledger of the
//     book where one answers, else unmatched. Nothing is made from it, so nothing is proposed as new.
//   • Either way, a row left out as a group's total that carried an amount is listed in summary.ignored_with_amounts, by
//     name and figures (ruling R43), so a gap in the trial balance can be traced to it.
//   • Bills (an opening import's alone) are kept but for a bill of nothing, which summary.zero_bills counts (ruling R38).
// Refusals, before anything is written: the body (400 FIN_BAD_INPUT, FIN_BAD_AMOUNT, FIN_BAD_DATE naming the field); a
// name twice in one list; more rows than FIN_IMPORT_MAX; the date the import is as at (finCheckAsAt).
export async function finCreateImport(qc, oc, input, actor) {
  const by = finActing(actor);
  const up = finCleanUpload(input);
  const book = await oc('SELECT id, code, books_begin FROM fin_books WHERE id = $1', [up.bookId]);
  if (!book) throw finBad("That book couldn't be found.", 'book_id');
  await finCheckAsAt(oc, up, book);
  const opening = up.purpose === 'opening';

  const groups = await qc('SELECT id, parent_id, name FROM fin_groups WHERE book_id = $1', [book.id]);
  const groupNames = new Set(groups.map(g => finNormName(g.name)));
  const isIgnored = name => finNormName(name) === 'grand total' || groupNames.has(finNormName(name));
  let ignoredRows = 0;
  const ignoredWithAmounts = [];
  // Left out as a group's total: counted, and listed with its figures when it carried any (ruling R43).
  const ignore = r => {
    ignoredRows += 1;
    if (r.debit_paise || r.credit_paise) ignoredWithAmounts.push({ tally_name: r.tally_name, debit_paise: r.debit_paise, credit_paise: r.credit_paise });
  };
  const kept = list => list.filter(r => (isIgnored(r.tally_name) ? (ignore(r), false) : true));

  let rows;
  const unknown = [];
  if (opening) {
    const byKey = new Map(kept(up.accounts).map(a => [finNormName(a.tally_name), { ...a, debit_paise: 0, credit_paise: 0 }]));
    for (const t of up.tb) {
      const account = byKey.get(finNormName(t.tally_name));
      if (account) Object.assign(account, { debit_paise: t.debit_paise, credit_paise: t.credit_paise });
      else if (isIgnored(t.tally_name)) ignore(t);
      else unknown.push({ tally_name: t.tally_name, debit_paise: t.debit_paise, credit_paise: t.credit_paise });
    }
    rows = [...byKey.values()];
  } else {
    rows = kept(up.tb).map(t => ({ ...t, tally_group: null, gstin: null }));
  }

  const ledgers = await qc('SELECT id, name, tally_name, group_id, party_type, party_id FROM fin_ledgers WHERE book_id = $1', [book.id]);
  const kinds = await finGroupKinds(qc, book.id);
  const parties = opening
    ? await qc(`SELECT 'customer' AS party_type, id, name, gstin, active = 1 AS active FROM customers
                UNION ALL SELECT 'vendor' AS party_type, id, name, gstin, active = 1 AS active FROM vendors`)
    : [];
  const proposals = finProposeMatches({ rows, ledgers, groups: finProposalGroups(groups, kinds), parties });

  // The counts first (a list of imports carries those alone: finSlimSummary), then the rows behind two of them.
  const summary = {
    accounts_rows: up.accounts.length, tb_rows: up.tb.length, bills_rows: up.bills.length + up.zeroBills,
    ledger_rows: rows.length, bill_rows: up.bills.length, zero_bills: up.zeroBills, ignored_rows: ignoredRows, unknown_rows: unknown.length,
    unknown, ignored_with_amounts: ignoredWithAmounts,
  };
  const imp = await oc(
    `INSERT INTO fin_imports (book_id, purpose, as_at, file_names, uploaded_by, summary)
     VALUES ($1, $2, $3, $4::text[], $5, $6::jsonb) RETURNING ${FIN_IMPORT_COLS}`,
    [book.id, up.purpose, up.as_at, up.fileNames, by.name, JSON.stringify(summary)]);

  // Every row and every bill in one statement each (column arrays, so no count of rows meets Postgres' limit on
  // parameters), in the order they came, so their ids keep it.
  await qc(
    `INSERT INTO fin_import_ledgers (import_id, tally_name, tally_group, debit, credit, ledger_id, match_status, group_id, party_type, party_id)
     SELECT $1, u.tally_name, u.tally_group, u.debit, u.credit, u.ledger_id, u.match_status, u.group_id, u.party_type, u.party_id
       FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::int[], $7::text[], $8::int[], $9::text[], $10::int[])
            WITH ORDINALITY AS u(tally_name, tally_group, debit, credit, ledger_id, match_status, group_id, party_type, party_id, n)
      ORDER BY u.n`,
    [imp.id, rows.map(r => r.tally_name), rows.map(r => r.tally_group), rows.map(r => finFromPaise(r.debit_paise)),
     rows.map(r => finFromPaise(r.credit_paise)), proposals.map(p => p.ledger_id), proposals.map(p => FIN_STATUS_OF[p.action]),
     proposals.map(p => p.group_id), proposals.map(p => p.party_type), proposals.map(p => p.party_id)]);
  if (up.bills.length) {
    await qc(
      `INSERT INTO fin_import_bills (import_id, tally_ledger_name, bill_ref, bill_date, due_date, amount, side)
       SELECT $1, u.tally_ledger_name, u.bill_ref, u.bill_date, u.due_date, u.amount, u.side
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[])
              WITH ORDINALITY AS u(tally_ledger_name, bill_ref, bill_date, due_date, amount, side, n)
        ORDER BY u.n`,
      [imp.id, up.bills.map(b => b.tally_ledger_name), up.bills.map(b => b.bill_ref), up.bills.map(b => b.bill_date),
       up.bills.map(b => b.due_date), up.bills.map(b => finFromPaise(b.amount_paise)), up.bills.map(b => b.side)]);
  }
  await finAudit(qc, { bookId: book.id, entity: 'import', entityId: imp.id, action: 'upload', userId: by.id, userName: by.name, after: finImportOut(imp) });
  return imp.id;
}

// ── The accountant's confirmation ────────────────────────────────────────────────────────────

// A link to a customer or vendor on a new ledger: a type and an id together, or neither (finance-masters.js finPartyOf
// keeps the same rule for a ledger), refused under the row's own field.
function finPartyPair(type, id, where, at) {
  const noType = type == null || type === '';
  const noId = id == null || id === '';
  if (noType && noId) return { party_type: null, party_id: null };
  if (noType || noId) {
    throw finBad(`${where}: a link to a customer or vendor needs both, which kind and which one.`, `${at}.${noType ? 'party_type' : 'party_id'}`);
  }
  if (!FIN_PARTY_TYPES.includes(type)) throw finBad(`${where}: a ledger links to a customer or a vendor.`, `${at}.party_type`);
  const partyId = finIdOf(id);
  if (partyId == null) throw finBad(`${where}: that isn't a customer or vendor id.`, `${at}.party_id`);
  return { party_type: type, party_id: partyId };
}

// The confirmation as sent, each entry checked against the import's own rows: [{ at, row, action, ledger_id, group_id,
// party_type, party_id }]. Every row of the import exactly once (ruling R33). An action names what it needs and nothing
// else: a match its ledger (the ledger keeps its own group and party), a new ledger its group and, if it is a party's,
// the party, an unmatched row nothing. A month-end import makes no ledgers.
function finCleanMatches(matches, rows, purpose) {
  if (!Array.isArray(matches)) throw finBad('matches must be a list, one entry for every row of the import.', 'matches');
  const rowById = new Map(rows.map(r => [r.id, r]));
  const seen = new Set();
  const decided = matches.map((raw, i) => {
    const at = `matches[${i}]`;
    finRowObject(raw, at);
    const rowId = finIdOf(raw.row_id);
    const row = rowId == null ? undefined : rowById.get(rowId);
    if (!row) throw finBad(`${at} names a row that isn't one of this import's rows.`, `${at}.row_id`);
    if (seen.has(row.id)) throw finBad(`${row.tally_name} is in the list twice. Confirm each row once.`, `${at}.row_id`);
    seen.add(row.id);
    const where = row.tally_name;
    const stray = keys => keys.find(key => raw[key] != null && raw[key] !== '');
    const plain = { at, row, ledger_id: null, group_id: null, party_type: null, party_id: null };
    if (raw.action === 'match') {
      const ledgerId = finIdOf(raw.ledger_id);
      if (ledgerId == null) throw finBad(`${where}: say which Finance ledger it is.`, `${at}.ledger_id`);
      const extra = stray(['group_id', 'party_type', 'party_id']);
      if (extra) throw finBad(`${where}: a match names its ledger and nothing else; the ledger keeps its own group and party.`, `${at}.${extra}`);
      return { ...plain, action: 'match', ledger_id: ledgerId };
    }
    if (raw.action === 'create') {
      if (purpose !== 'opening') {
        throw finBad(`${where}: a month-end trial balance is compared with the ledgers the book has; no ledger is made from it.`, `${at}.action`);
      }
      if (stray(['ledger_id'])) throw finBad(`${where}: a ledger still to be made has no ledger id.`, `${at}.ledger_id`);
      const groupId = finIdOf(raw.group_id);
      if (groupId == null) throw finBad(`${where}: say which group the new ledger goes under.`, `${at}.group_id`);
      return { ...plain, action: 'create', group_id: groupId, ...finPartyPair(raw.party_type, raw.party_id, where, at) };
    }
    if (raw.action === 'unmatched') {
      const extra = stray(['ledger_id', 'group_id', 'party_type', 'party_id']);
      if (extra) throw finBad(`${where}: a row left unmatched names nothing.`, `${at}.${extra}`);
      return { ...plain, action: 'unmatched' };
    }
    throw finBad(`${where}: the action is match, create or unmatched.`, `${at}.action`);
  });
  const missing = rows.filter(r => !seen.has(r.id));
  if (missing.length) {
    throw finBad(`Confirm every row of the import: ${finCount(missing.length, 'row')} ${missing.length === 1 ? 'is' : 'are'} not in the list, ${missing[0].tally_name} among them.`, 'matches');
  }
  return decided;
}

// Names as a sentence lists them: 'A', 'A and B', 'A, B and C'.
const finAnd = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// The accountant confirms what every row of an import is (spec §11.2 step 2; ruling R33): `matches` is
// [{ row_id, action: 'match' | 'create' | 'unmatched', ledger_id?, group_id?, party_type?, party_id? }], one entry for
// EVERY row, each once. The import becomes `matched`, which a build needs. Checked whole, against the import's own book,
// before a row is written; refused:
//   400 FIN_BAD_INPUT    the list (finCleanMatches); a ledger or group that isn't the book's; a customer or vendor that
//                        isn't there; two rows on one ledger, or two rows linked to one party, naming them
//   400 FIN_BAD_INPUT    a ledger to be made whose name the book has, or another new one's, as names are compared (M13)
//   409 FIN_LEDGER_INACTIVE  an opening row with a balance matched to a ledger switched off: posting would refuse it
//   409 FIN_PARTY_LINKED     a party the book has linked to a ledger already
//   409 FIN_BAD_INPUT    a used import (upload again after a rejected Opening voucher, ruling R37)
// A confirmation that changes nothing writes nothing.
export async function finSaveMatches(qc, oc, importId, matches, actor) {
  const by = finActing(actor);
  const id = finIdOf(importId);
  if (id == null) throw finMissing();
  const imp = await oc(`SELECT ${FIN_IMPORT_COLS} FROM fin_imports WHERE id = $1 FOR UPDATE`, [id]);
  if (!imp) throw finMissing();
  if (imp.status === 'used') {
    throw finError(409, 'FIN_BAD_INPUT', 'This import has built its Opening voucher, so its matches stay as they are. To change one, upload the files again.');
  }
  if (imp.status !== 'draft' && imp.status !== 'matched') throw finError(409, 'FIN_BAD_INPUT', `This import is ${imp.status}.`);
  const rows = await qc(
    `SELECT id, tally_name, debit, credit, match_status, ledger_id, group_id, party_type, party_id
       FROM fin_import_ledgers WHERE import_id = $1 ORDER BY id`, [id]);
  const decided = finCleanMatches(matches, rows, imp.purpose);
  const bookId = imp.book_id;

  const ids = action => [...new Set(decided.filter(d => d.action === action).map(d => (action === 'match' ? d.ledger_id : d.group_id)))];
  const ledgers = new Map((await qc(
    'SELECT id, name, group_id, party_type, party_id, active FROM fin_ledgers WHERE book_id = $1 AND id = ANY($2::int[])',
    [bookId, ids('match')])).map(l => [l.id, l]));
  const groups = new Set((await qc('SELECT id FROM fin_groups WHERE book_id = $1 AND id = ANY($2::int[])', [bookId, ids('create')])).map(g => g.id));
  const partyIds = type => [...new Set(decided.filter(d => d.party_type === type).map(d => d.party_id))];
  const parties = new Map([
    ...(await qc('SELECT id, name FROM customers WHERE id = ANY($1::int[])', [partyIds('customer')])).map(p => [`customer:${p.id}`, p.name]),
    ...(await qc('SELECT id, name FROM vendors WHERE id = ANY($1::int[])', [partyIds('vendor')])).map(p => [`vendor:${p.id}`, p.name]),
  ]);
  for (const d of decided) {
    const where = d.row.tally_name;
    if (d.action === 'match') {
      const ledger = ledgers.get(d.ledger_id);
      if (!ledger) throw finBad(`${where}: that ledger isn't one of this book's ledgers.`, `${d.at}.ledger_id`);
      if (imp.purpose === 'opening' && !ledger.active && finToPaise(d.row.debit) !== finToPaise(d.row.credit)) {
        throw finError(409, 'FIN_LEDGER_INACTIVE', `${where}: ${ledger.name} is switched off and takes no new postings. Switch it on, or match another ledger.`);
      }
    } else if (d.action === 'create') {
      if (!groups.has(d.group_id)) throw finBad(`${where}: that group isn't one of this book's groups.`, `${d.at}.group_id`);
      if (d.party_type && !parties.has(`${d.party_type}:${d.party_id}`)) throw finBad(`${where}: that ${d.party_type} couldn't be found.`, `${d.at}.party_id`);
    }
  }

  // One Finance ledger for one Tally row, and one party for one ledger.
  for (const [ledgerId, list] of finIndex(decided.filter(d => d.action === 'match'), d => d.ledger_id)) {
    if (list.length > 1) {
      throw finBad(`${finAnd(list.map(d => d.row.tally_name))} ${list.length === 2 ? 'both' : 'all'} point at ${ledgers.get(ledgerId).name}. `
        + 'One Finance ledger takes one Tally row: match the others to their own ledgers, or make ledgers for them.', 'matches');
    }
  }
  const linking = decided.filter(d => d.party_type);
  for (const [key, list] of finIndex(linking, d => `${d.party_type}:${d.party_id}`)) {
    if (list.length > 1) {
      throw finBad(`${finAnd(list.map(d => d.row.tally_name))} are ${list.length === 2 ? 'both' : 'all'} linked to ${parties.get(key)}. `
        + `One ${list[0].party_type} goes with one ledger.`, 'matches');
    }
  }
  if (linking.length) {
    const owners = new Map((await qc(
      'SELECT name, party_type, party_id FROM fin_ledgers WHERE book_id = $1 AND party_id IS NOT NULL', [bookId])).map(l => [`${l.party_type}:${l.party_id}`, l.name]));
    for (const d of linking) {
      const key = `${d.party_type}:${d.party_id}`;
      if (owners.has(key)) {
        throw finError(409, 'FIN_PARTY_LINKED', `${d.row.tally_name}: ${parties.get(key)} is linked to the ledger ${owners.get(key)} in this book already.`);
      }
    }
  }
  // A new ledger's name, as names are compared (finNormName: capitals, runs of spaces and a closing dot aside), is none the
  // book has and no other new one's (M13). One the book has would fail the build at the unique index, or stand beside the
  // old ledger as its near twin.
  const making = decided.filter(d => d.action === 'create');
  if (making.length) {
    const inBook = finIndex(await qc('SELECT name FROM fin_ledgers WHERE book_id = $1', [bookId]), l => finNormName(l.name));
    const fresh = new Map();
    for (const d of making) {
      const key = finNormName(d.row.tally_name);
      const twin = inBook.get(key)?.[0];
      if (twin) {
        throw finBad(`${d.row.tally_name} would make a ledger of the same name as ${twin.name}, which this book has already (capitals, `
          + 'spaces and a closing dot make no difference). Match the row to it rather than make another.', `${d.at}.action`);
      }
      if (fresh.has(key)) {
        throw finBad(`${fresh.get(key).row.tally_name} and ${d.row.tally_name} would make two ledgers of one name. Make one, and match the other to it.`, 'matches');
      }
      fresh.set(key, d);
    }
  }

  const next = decided.map(d => ({
    id: d.row.id, tally_name: d.row.tally_name, match_status: FIN_STATUS_OF[d.action], ledger_id: d.ledger_id, group_id: d.group_id,
    party_type: d.party_type, party_id: d.party_id,
  }));
  const KEYS = ['match_status', 'ledger_id', 'group_id', 'party_type', 'party_id'];
  const rowById = new Map(rows.map(r => [r.id, r]));
  const changed = next.filter(n => KEYS.some(key => n[key] !== rowById.get(n.id)[key]));
  if (!changed.length && imp.status === 'matched') return finImportOut(imp);

  if (changed.length) {
    const col = key => changed.map(n => n[key]);
    await qc(
      `UPDATE fin_import_ledgers r
          SET match_status = u.match_status, ledger_id = u.ledger_id, group_id = u.group_id,
              party_type = u.party_type, party_id = u.party_id
         FROM unnest($2::int[], $3::text[], $4::int[], $5::int[], $6::text[], $7::int[])
              AS u(id, match_status, ledger_id, group_id, party_type, party_id)
        WHERE r.id = u.id AND r.import_id = $1`,
      [id, col('id'), col('match_status'), col('ledger_id'), col('group_id'), col('party_type'), col('party_id')]);
  }
  const after = await oc(`UPDATE fin_imports SET status = 'matched' WHERE id = $1 RETURNING ${FIN_IMPORT_COLS}`, [id]);
  const decision = r => ({ row_id: r.id, tally_name: r.tally_name, ...Object.fromEntries(KEYS.map(key => [key, r[key]])) });
  await finAudit(qc, {
    bookId, entity: 'import', entityId: id, action: 'match', userId: by.id, userName: by.name,
    before: { status: imp.status, rows: changed.map(n => decision(rowById.get(n.id))) },
    after: { status: after.status, rows: changed.map(decision) },
  });
  return finImportOut(after);
}

// ── The Opening voucher ──────────────────────────────────────────────────────────────────────

// Build the book's Opening voucher from a confirmed opening import, and submit it (spec §11.2 step 4): ONE transaction,
// the route's, in the order of every Finance transaction that may post (see the header):
//   1. Unlocked, the import's kind and book: only an opening import builds (409 FIN_BAD_INPUT). The voucher is dated the
//      day before the books begin, and its number series (CI-OB-2627-) is locked; then the import, FOR UPDATE.
//   2. The import must be confirmed and not used (409 FIN_BAD_INPUT). The book must have no Opening voucher waiting for
//      approval, and none posted that a posted reversal dated on its own day has not undone (409 FIN_OPENING_EXISTS,
//      rulings R37 and R42): asked before the tie-out.
//   3. The tie-out, on the rows as they stand now, each row's party-ness worked out afresh (409 FIN_TIE_OUT, body.problems).
//   4. A ledger for every row to be made (finCreateLedger: its Tally name kept, linked to its party), in the rows' order.
//   5. The voucher: one line per ledger with a balance (Dr if positive, Cr if negative), or a line per bill for a party
//      ledger with bills; up to FIN_OPENING_MAX_LINES lines. A zero balance has no line.
//   6. finSubmitVoucher: the book's `opening` rule (always, by default) makes it wait for the MD, who is told; an Approver
//      who builds it posts it, self-approved, as any entry its Approver submits.
//   7. The import is marked used, with the voucher's id, and its `build` row written.
// Anything refused on the way, by the app or by the database at COMMIT, rolls back all of it, the ledgers included, and
// leaves the import as it was. Returns the voucher as the submit left it.
export async function finBuildOpening(qc, oc, importId, actor) {
  const by = finActing(actor);
  const id = finIdOf(importId);
  if (id == null) throw finMissing();
  const seen = await oc(
    'SELECT i.purpose, b.code, b.books_begin FROM fin_imports i JOIN fin_books b ON b.id = i.book_id WHERE i.id = $1', [id]);
  if (!seen) throw finMissing();
  if (seen.purpose !== 'opening') {
    throw finError(409, 'FIN_BAD_INPUT', 'Only the opening balances build the Opening voucher. A month-end trial balance is for the parallel run.');
  }
  const day = finDayBefore(seen.books_begin);
  await lockDocNumber(finPrefix(seen.code, 'opening', finFyOf(day).short), oc);

  const imp = await oc(`SELECT ${FIN_IMPORT_COLS} FROM fin_imports WHERE id = $1 FOR UPDATE`, [id]);
  if (!imp) throw finMissing();
  if (imp.status === 'used') throw finError(409, 'FIN_BAD_INPUT', 'This import has built its Opening voucher already. Upload the files again to build another.');
  if (imp.status === 'draft') {
    throw finError(409, 'FIN_BAD_INPUT', 'Confirm the matches first: every row, matched, made or left, before the Opening voucher is built.');
  }
  if (imp.status !== 'matched') throw finError(409, 'FIN_BAD_INPUT', `This import is ${imp.status}.`);
  if (imp.as_at !== day) throw finError(409, 'FIN_BAD_DATE', `These balances are as at ${imp.as_at}; the Opening voucher is dated ${day}.`);

  // An Opening voucher holds the book while it waits, and until a reversal of it posts dated on its own day (rulings R37 and
  // R42). The ONE check, which the submit of an Opening draft asks too (finLiveOpeningProblem).
  const held = await finLiveOpeningProblem(oc, imp.book_id, day, { doing: 'build' });
  if (held) throw held;

  // The tie-out the screen shows (finImportFigures), worked out again here, inside the transaction, on the rows as they stand.
  const { ledgers, bills, tie_out: tie } = await finImportFigures(qc, imp);
  const astray = ledgers.find(r => r.match_status === 'matched' && r.ledger_book_id !== imp.book_id);
  if (astray) throw finError(409, 'FIN_WRONG_BOOK', `${astray.tally_name} is matched to a ledger that isn't one of this book's.`);
  if (!tie.ok) {
    const more = tie.problems.length - 1;
    throw finError(409, 'FIN_TIE_OUT',
      `${FIN_SENTENCES.FIN_TIE_OUT} ${tie.problems[0].message}${more ? ` There ${more === 1 ? 'is' : 'are'} ${finCount(more, 'more problem')} besides.` : ''}`,
      { problems: tie.problems });
  }

  const created = [];
  for (const row of ledgers) {
    if (row.match_status !== 'create') continue;
    const ledger = await finCreateLedger(qc, oc, {
      book_id: imp.book_id, group_id: row.group_id, name: row.tally_name, tally_name: row.tally_name,
      party_type: row.party_type, party_id: row.party_id,
    }, by);
    row.ledger_id = ledger.id;
    created.push({ row_id: row.id, ledger_id: ledger.id, name: ledger.name });
  }
  // The lines the tie-out counted (finOpeningLines), each on its row's ledger, matched or just made.
  const lines = finOpeningLines(ledgers, bills).map(({ row, ...line }) => ({ ledger_id: row.ledger_id, ...line }));
  const draft = await finCreateBuiltDraft(qc, oc, {
    book_id: imp.book_id, voucher_type: 'opening', voucher_date: day,
    narration: `Opening balances brought over from Tally, as at ${day}`, reference: `Tally import ${id}`,
  }, finCleanLines(lines, FIN_OPENING_MAX_LINES), by);
  const voucher = await finSubmitVoucher(qc, oc, draft.id, actor);

  const after = await oc(`UPDATE fin_imports SET status = 'used', opening_voucher_id = $2 WHERE id = $1 RETURNING ${FIN_IMPORT_COLS}`, [id, voucher.id]);
  await finAudit(qc, {
    bookId: imp.book_id, entity: 'import', entityId: id, action: 'build', userId: by.id, userName: by.name,
    before: finImportOut(imp), after: { ...finImportOut(after), created_ledgers: created },
  });
  return voucher;
}

// ── The parallel run ─────────────────────────────────────────────────────────────────────────

// A month-end import beside Finance (spec §9.2, §11.3): { import: { id, book_id, as_at }, rows, unmatched, totals }.
//   rows       one per Finance ledger that a Tally row is matched to, and one per Finance ledger with a balance that no
//              Tally row is matched to (its Tally closing is then 0): { ledger_id, ledger_name, tally_name,
//              tally_closing_paise, finance_closing_paise, difference_paise }, by ledger name. Closings are signed, Dr
//              positive; the difference is Tally's less Finance's (ruling R38), so Tally ₹1,000 higher is +100000.
//   unmatched  the Tally rows matched to no ledger, with their closings, in the order they came.
//   totals     { differing }: how many rows differ.
// Finance's closings are the trial balance as at the import's date, every ledger listed (all: true), so a ledger with
// nothing on it still lines up with its Tally row. A pool read; the caller has asked who may (finImportBookOf).
export async function finParallelRun(importId) {
  const id = finIdOf(importId);
  if (id == null) throw finMissing();
  const imp = await one('SELECT id, book_id, purpose, as_at FROM fin_imports WHERE id = $1', [id]);
  if (!imp) throw finMissing();
  if (imp.purpose !== 'parallel_tb') {
    throw finBad('That import is the opening balances. The parallel run compares a month-end trial balance.', 'import');
  }
  const tallyRows = await q(
    'SELECT tally_name, debit, credit, match_status, ledger_id FROM fin_import_ledgers WHERE import_id = $1 ORDER BY id', [id]);
  const finance = new Map((await finTrialBalance(imp.book_id, { to: imp.as_at, all: true })).ledgers.map(l => [l.id, l]));

  const rows = [];
  const unmatched = [];
  const compared = new Set();
  for (const t of tallyRows) {
    const tally = finToPaise(t.debit) - finToPaise(t.credit);
    const ledger = t.match_status === 'matched' ? finance.get(t.ledger_id) : undefined;
    if (!ledger) {
      unmatched.push({ tally_name: t.tally_name, tally_closing_paise: tally });
      continue;
    }
    compared.add(ledger.id);
    rows.push({ ledger_id: ledger.id, ledger_name: ledger.name, tally_name: t.tally_name, tally_closing_paise: tally,
      finance_closing_paise: ledger.closing_paise, difference_paise: tally - ledger.closing_paise });
  }
  for (const ledger of finance.values()) {
    if (compared.has(ledger.id) || ledger.closing_paise === 0) continue;
    rows.push({ ledger_id: ledger.id, ledger_name: ledger.name, tally_name: null, tally_closing_paise: 0,
      finance_closing_paise: ledger.closing_paise, difference_paise: -ledger.closing_paise });
  }
  rows.sort((a, b) => a.ledger_name.toLowerCase().localeCompare(b.ledger_name.toLowerCase()) || a.ledger_id - b.ledger_id);
  return {
    import: { id: imp.id, book_id: imp.book_id, as_at: imp.as_at },
    rows,
    unmatched,
    totals: { differing: rows.filter(r => r.difference_paise !== 0).length },
  };
}
