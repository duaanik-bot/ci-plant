// Finance — vouchers: drafts made, edited, discarded, listed and opened; then submitted, approved, rejected and
// posted; and a posted voucher reversed (spec §6.6, §6.7, §7.1 to §7.5, §8, §9.1).
// A draft is a voucher on its way to the books. It has no number (the number is minted when it posts, and
// never before), it may be unbalanced, short of lines or empty, and only the person who made it edits it.
//
// The writes (finCreateDraft, finUpdateDraft, finDiscardDraft, the posting functions and finReverseVoucher) take the
// `qc` / `oc` of the transaction their route opened, and use nothing else: the pool is one client on Vercel, and a
// pool call made while the transaction holds it would wait for it forever. The route has already asked finRequire
// who may, for the voucher's book, BEFORE opening the transaction. Each write appends its finAudit row (a posting
// that follows an approval appends two, approve then post), with the voucher and its lines before and after, in the
// same transaction, so a change and its record commit or roll back together.
// The reads (finVoucherView, finListVouchers, finVoucherBookOf) go through the pool and take the request.
//
// Amounts are WHOLE PAISE everywhere in JS and in the API. A line carries debit_paise and credit_paise;
// a voucher carries total_paise. Totals are added in paise, in JS, where they are exact, and written to NUMERIC
// with finFromPaise, which refuses anything that is not a whole number. A float never carries an amount.
//
// Lock order (ruling R15). The line trigger fin_line_guard takes FOR SHARE on a line's voucher, so a write of
// lines locks the voucher row FOR UPDATE FIRST, before it deletes or inserts one. Two edits of one draft then
// wait for one another at that first statement and hold nothing while they wait. Taken the other way round,
// each holds the share lock its line write took and waits on the other before it can update the voucher:
// Postgres ends one of them with "deadlock detected" (two edits adding lines to a draft that has none yet), or
// the two rewrite the same lines over each other and collide on (voucher_id, line_no). The order in any Finance
// transaction is: the number's advisory lock (a transaction that may post, and only that), then the voucher FOR
// UPDATE, then line writes, then status changes. A draft takes no number, so the draft writes never reach for one;
// the posting section below says how a posting does.
//
// The save key (client_key). A create carries a key the browser made, so a retry or a double-click answers
// with the draft the first one made. The create is INSERT ... ON CONFLICT (client_key) DO NOTHING and not a
// plain INSERT that is allowed to fail: two saves of one key at the same moment would make the second fail
// with a unique violation, which aborts its transaction and leaves it unable to look the first up, so it
// could only ever answer 500. With DO NOTHING the second waits for the first to settle, finds nothing inserted,
// and reads the draft the first left: it is handed that draft if the key is its own (the same login, the same
// book), and FIN_DUPLICATE_KEY if it is anyone else's.

import { q, one } from './db.js';
import { lockDocNumber, nextNumber, notify } from './helpers.js';
import { finAudit } from './finance-audit.js';
import { finAccessOf, finApproverIds, finBookIdsFor, finRequire, finSeenBookOf } from './finance-access.js';
import { finError } from './finance-errors.js';
import { FIN_BANK_CASH_GROUPS, FIN_PARTY_GROUPS } from './finance-groups.js';
import { finIdOf, finOptionalText } from './finance-masters.js';
import { FIN_VOUCHER_TYPES, finBalanceProblem, finCan, finNeedsApproval, finPrefix, finShapeProblem } from './finance-rules.js';
import { plantDateStr } from './plant-calendar.js';
import { finDayBefore, finIsValidDate } from '../../client/src/lib/finance/fy.js';
import { FIN_MAX_PAISE, finFormatINR, finFromPaise, finToPaise } from '../../client/src/lib/finance/money.js';

const FIN_MAX_LINES = 200;           // a typed voucher; the Opening voucher (built by the import) takes more, by naming its own cap
const FIN_NARRATION_MAX = 2000;
const FIN_REFERENCE_MAX = 255;
const FIN_LINE_NARRATION_MAX = 500;
export const FIN_BILL_REF_MAX = 100;   // a bill reference, on a voucher line and in a Tally import's bills
const FIN_REASON_MAX = 500;          // a rejection's or a reversal's reason, as long as a month's (finance-masters.js)
const FIN_SEARCH_MAX = 100;
const FIN_LIST_MAX = 5000;           // rows the day book will send in one answer; past it, it says so (truncated)
const FIN_FIRST_YEAR = 2000;         // a voucher or bill date is in these years, as a financial year's label is (finance-masters.js)
const FIN_LAST_YEAR = 2099;

const FIN_VIEWS = ['daybook', 'approvals', 'drafts'];
const FIN_STATUSES = ['draft', 'submitted', 'posted', 'discarded'];
const FIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What a voucher is, as the API says it. `total` leaves as total_paise; client_key and source_fingerprint
// are the system's own and are not sent.
const FIN_VOUCHER_COLS = [
  'id', 'book_id', 'voucher_type', 'number', 'voucher_date', 'period_id', 'narration', 'reference', 'status', 'total',
  'reversal_of_id', 'reversed_by_id', 'source_type', 'source_id',
  'created_by_id', 'created_by', 'created_at', 'updated_at', 'submitted_by_id', 'submitted_by', 'submitted_at',
  'approved_by_id', 'approved_by', 'approved_at', 'self_approved', 'posted_by_id', 'posted_by', 'posted_at',
  'last_rejected_by', 'last_rejected_at', 'last_reject_reason',
];
const finCols = alias => FIN_VOUCHER_COLS.map(col => (alias ? `${alias}.${col}` : col)).join(', ');
const FIN_LINE_COLS = 'line_no, ledger_id, debit, credit, narration, bill_ref, bill_date, due_date';

// ── Small pieces ─────────────────────────────────────────────────────────────────────────────

// 400. `field` names what is wrong so a form can say where; it goes in `body`, as every structured field does.
const finBad = (message, field) => finError(400, 'FIN_BAD_INPUT', message, field ? { field } : {});
const finMissing = () => finError(404, 'FIN_NOT_FOUND');

// Who is acting. A write with nobody to blame is a bug in the caller, and a draft with no maker belongs to
// nobody, so unlike a chart-of-accounts write this one needs a user id as well.
function finActing(actor) {
  const name = typeof actor?.name === 'string' ? actor.name.trim() : '';
  if (!Number.isSafeInteger(actor?.id) || !name) {
    throw new Error('A voucher write needs to know who is acting: pass { id, name, roles }');
  }
  return { id: actor.id, name };
}

const finYearOk = date => {
  const year = Number(date.slice(0, 4));
  return year >= FIN_FIRST_YEAR && year <= FIN_LAST_YEAR;
};

// The voucher's date: a real calendar day written YYYY-MM-DD, in 2000 to 2099. A draft may be dated in a month
// no year covers yet (submitting it says so); it may not be dated on a day that is not one.
export function finVoucherDate(value, field = 'voucher_date') {
  if (!finIsValidDate(value) || !finYearOk(value)) {
    throw finError(400, 'FIN_BAD_DATE',
      `The voucher date isn't a valid date. Write it as YYYY-MM-DD, in ${FIN_FIRST_YEAR} to ${FIN_LAST_YEAR}.`, { field });
  }
  return value;
}

// A bill's date or due date: blank is none, anything else is a real day, as above. The Tally import checks its bills' dates
// with this too, so a bill it stages is one a voucher line takes.
export function finBillDate(value, field, what) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (!finIsValidDate(value) || !finYearOk(value)) {
    throw finError(400, 'FIN_BAD_DATE', `${what} isn't a valid date. Write it as YYYY-MM-DD, in ${FIN_FIRST_YEAR} to ${FIN_LAST_YEAR}.`, { field });
  }
  return value;
}

// The save key: none, or a UUID (kept in lower case, which is how Postgres reads it). Anything else would
// reach Postgres as "invalid input syntax for type uuid", which is a 500.
export function finClientKey(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !FIN_UUID.test(value)) throw finBad('The save key must be a UUID.', 'client_key');
  return value.toLowerCase();
}

// One side of a line, in paise. A side left out is nothing. Anything else is a whole number of paise, not
// negative and under FIN_MAX_PAISE (money.js refuses a typed amount at that size too): a string, a fraction,
// NaN or an amount past what a double holds exactly is not an amount.
function finSideOf(value, where, field) {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= FIN_MAX_PAISE) {
    throw finError(400, 'FIN_BAD_AMOUNT', `${where}: an amount is a whole number of paise, from zero to under ₹1 lakh crore.`, { field });
  }
  return value;
}

// ── The lines ────────────────────────────────────────────────────────────────────────────────

// A typed voucher's lines, checked before the database is asked anything: { lines, debit_paise, credit_paise },
// the lines as they will be written and the two sides added up in paise. PURE.
//   • At most `max` lines (200 for a typed voucher). A draft may have none, one, or lines that do not balance.
//   • Each line is an object with a ledger id and exactly one positive side (409 FIN_BAD_LINE otherwise; the
//     database's own CHECK says the same). Amounts are whole paise (400 FIN_BAD_AMOUNT).
//   • Text goes through finOptionalText (narration, bill_ref); bill dates must be real days (FIN_BAD_DATE).
//   • Neither side's total may pass what a double holds exactly, so a voucher's sums never lose a paisa.
// Whether the ledgers exist, are in the book, are switched on and may take a typed entry is the database's to
// say (finCheckLedgers).
export function finCleanLines(input, max = FIN_MAX_LINES) {
  if (!Array.isArray(input)) throw finBad('The lines must be a list.', 'lines');
  if (input.length > max) throw finBad(`A voucher can have ${max} lines at most.`, 'lines');
  let debits = 0;
  let credits = 0;
  const lines = input.map((raw, i) => {
    const at = `lines[${i}]`;
    const where = `Line ${i + 1}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw finBad(`${where} must be an object with a ledger and an amount.`, at);
    const ledger_id = finIdOf(raw.ledger_id);
    if (ledger_id == null) throw finBad(`${where} needs a ledger.`, `${at}.ledger_id`);
    const debit_paise = finSideOf(raw.debit_paise, where, `${at}.debit_paise`);
    const credit_paise = finSideOf(raw.credit_paise, where, `${at}.credit_paise`);
    if ((debit_paise > 0) === (credit_paise > 0)) {
      throw finError(409, 'FIN_BAD_LINE', `${where} needs a debit or a credit amount, not both and not neither.`);
    }
    const line = {
      ledger_id, debit_paise, credit_paise,
      narration: finOptionalText(raw.narration, `${at}.narration`, FIN_LINE_NARRATION_MAX),
      bill_ref: finOptionalText(raw.bill_ref, `${at}.bill_ref`, FIN_BILL_REF_MAX),
      bill_date: finBillDate(raw.bill_date, `${at}.bill_date`, `${where}'s bill date`),
      due_date: finBillDate(raw.due_date, `${at}.due_date`, `${where}'s due date`),
    };
    debits += debit_paise;
    credits += credit_paise;
    if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
      throw finError(400, 'FIN_BAD_AMOUNT', 'These lines add up to more than a voucher can hold.', { field: 'lines' });
    }
    return line;
  });
  return { lines, debit_paise: debits, credit_paise: credits };
}

// What each of a book's groups holds (spec §6.4, ruling R23), as a Map of group id -> { is_bank_cash, is_party }:
// bank or cash when the group is, or descends from, one of FIN_BANK_CASH_GROUPS; parties when it is, or descends
// from, Sundry Debtors or Sundry Creditors (FIN_PARTY_GROUPS). The walk starts at the book's primary groups and goes
// down, handing each flag to every group beneath, so a group that no walk from the top reaches (a loop, which the app
// never writes) is neither. System groups are never renamed (ruling R19), so the names hold. The transaction's qc.
export async function finGroupKinds(qc, bookId) {
  const rows = await qc(
    `WITH RECURSIVE walk AS (
       SELECT g.id, lower(g.name) = ANY($2::text[]) AS is_bank_cash, lower(g.name) = ANY($3::text[]) AS is_party
         FROM fin_groups g
        WHERE g.book_id = $1 AND g.parent_id IS NULL
       UNION
       SELECT g.id, w.is_bank_cash OR lower(g.name) = ANY($2::text[]), w.is_party OR lower(g.name) = ANY($3::text[])
         FROM fin_groups g JOIN walk w ON g.parent_id = w.id
        WHERE g.book_id = $1
     )
     SELECT id, is_bank_cash, is_party FROM walk`,
    [bookId, FIN_BANK_CASH_GROUPS.map(name => name.toLowerCase()), FIN_PARTY_GROUPS.map(name => name.toLowerCase())]);
  return new Map(rows.map(r => [r.id, { is_bank_cash: r.is_bank_cash, is_party: r.is_party }]));
}

// A party ledger (ruling R23): one linked to an ERP customer or vendor, wherever it is filed, or one filed under
// Sundry Debtors or Sundry Creditors (or a group beneath either), linked or not, as a Tally creditor brought over
// without its ERP vendor is. The ONE definition: a voucher line's bill details go on a party ledger only, and the Tally
// import asks the same question of its rows. `ledger` carries party_type and group_id; `kinds` is finGroupKinds' map
// for its book. PURE.
export function finIsPartyLedger(ledger, kinds) {
  return ledger.party_type != null || kinds?.get(ledger.group_id)?.is_party === true;
}

// The two ledgers a line may not use, said the same way when a draft is saved and when it posts (spec §7.2 H6).
const finLedgerOff = (where, name) =>
  finError(409, 'FIN_LEDGER_INACTIVE', `${where} uses ${name}, which is switched off and takes no new postings.`);
const finLedgerSystemOnly = (where, name) =>
  finError(409, 'FIN_SYSTEM_LEDGER', `${where} uses ${name}, which is kept for system entries only.`);

// Every ledger the lines use is one of THIS book's, switched on, and open to hand-typed vouchers (spec §7.2 H6
// and H7; the database checks them again when the voucher posts, and this says it first, with the line). A
// ledger that is not in the book is the wrong book's whether it is another book's or nobody's: the foreign key
// reports both the same way, and a refusal here says no more than it does. Bill details go on a party ledger
// only (finIsPartyLedger). Read without locks: a ledger switched off a moment later still lets this draft stand,
// and the posting check is the last word.
async function finCheckLedgers(qc, bookId, lines) {
  const ids = [...new Set(lines.map(line => line.ledger_id))];
  if (!ids.length) return;
  const found = new Map((await qc(
    'SELECT id, name, group_id, active, manual_entry, party_type FROM fin_ledgers WHERE book_id = $1 AND id = ANY($2::int[])',
    [bookId, ids])).map(l => [l.id, l]));
  const billed = line => Boolean(line.bill_ref || line.bill_date || line.due_date);
  const kinds = lines.some(billed) ? await finGroupKinds(qc, bookId) : null;
  lines.forEach((line, i) => {
    const where = `Line ${i + 1}`;
    const ledger = found.get(line.ledger_id);
    if (!ledger) throw finError(409, 'FIN_WRONG_BOOK', `${where} uses a ledger that isn't one of this book's ledgers.`);
    if (!ledger.active) throw finLedgerOff(where, ledger.name);
    if (!ledger.manual_entry) throw finLedgerSystemOnly(where, ledger.name);
    if (billed(line) && !finIsPartyLedger(ledger, kinds)) {
      throw finBad(`${where} has bill details, which go only on a party's ledger (a customer's or a vendor's, or one under `
        + `Sundry Debtors or Sundry Creditors), and ${ledger.name} is not one.`, `lines[${i}].bill_ref`);
    }
  });
}

const finLineOut = row => ({
  line_no: row.line_no, ledger_id: row.ledger_id, debit_paise: finToPaise(row.debit), credit_paise: finToPaise(row.credit),
  narration: row.narration, bill_ref: row.bill_ref, bill_date: row.bill_date, due_date: row.due_date,
});

// A voucher's lines as they stand, in order, in paise: what the log keeps.
async function finLinesOf(qc, voucherId) {
  return (await qc(`SELECT ${FIN_LINE_COLS} FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no`, [voucherId])).map(finLineOut);
}

// Writes lines 1..n of a voucher in ONE statement, and returns them as written. The caller holds the voucher
// FOR UPDATE already (the lock order above).
async function finInsertLines(qc, voucherId, bookId, lines) {
  if (!lines.length) return [];
  const args = [voucherId, bookId];
  const tuples = lines.map((line, i) => {
    const at = args.length;
    args.push(i + 1, line.ledger_id, finFromPaise(line.debit_paise), finFromPaise(line.credit_paise), line.narration, line.bill_ref, line.bill_date, line.due_date);
    return `($1::int, $2::int, $${at + 1}::smallint, $${at + 2}::int, $${at + 3}::numeric, $${at + 4}::numeric, $${at + 5}::text, $${at + 6}::text, $${at + 7}::text, $${at + 8}::text)`;
  });
  const rows = await qc(
    `INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit, narration, bill_ref, bill_date, due_date)
     VALUES ${tuples.join(', ')} RETURNING ${FIN_LINE_COLS}`, args);
  return rows.map(finLineOut).sort((a, b) => a.line_no - b.line_no);
}

// ── The voucher ──────────────────────────────────────────────────────────────────────────────

// A voucher row as the API says it: money in paise.
function finVoucherOut(row) {
  const { total, ...rest } = row;
  return { ...rest, total_paise: finToPaise(total) };
}

// What the log keeps of a voucher: the voucher as the API says it, with its lines.
const finSnapshot = (row, lines) => ({ ...finVoucherOut(row), lines });

// The voucher a save key already names: handed back if the key is this login's own, in this book (a retry, a
// double-click), a conflict if it is anyone else's. null when no voucher has the key.
async function finReplay(oc, key, by, bookId) {
  const found = await oc(`SELECT ${finCols()} FROM fin_vouchers WHERE client_key = $1::uuid`, [key]);
  if (!found) return null;
  if (found.created_by_id === by.id && found.book_id === bookId) return finVoucherOut(found);
  throw finError(409, 'FIN_DUPLICATE_KEY');
}

// Make a draft. Only the four types a person types (journal, receipt, payment, contra) can be made here; the
// rest are made by the app. A repeat of a save key is answered with the draft the first one made (see the
// header). The type's shape rules (a payment needs a bank or cash line, say) and the balance are for submit.
export async function finCreateDraft(qc, oc, input, actor) {
  const by = finActing(actor);
  const { book_id, voucher_type, voucher_date, narration, reference, client_key, lines } = input ?? {};
  const bookId = finIdOf(book_id);
  if (bookId == null) throw finBad('Say which book this voucher is for.', 'book_id');
  if (typeof voucher_type !== 'string' || !Object.hasOwn(FIN_VOUCHER_TYPES, voucher_type) || !FIN_VOUCHER_TYPES[voucher_type].manual) {
    throw finBad('A voucher you type is a journal, a receipt, a payment or a contra.', 'voucher_type');
  }
  const date = finVoucherDate(voucher_date);
  const text = {
    narration: finOptionalText(narration, 'narration', FIN_NARRATION_MAX),
    reference: finOptionalText(reference, 'reference', FIN_REFERENCE_MAX),
  };
  const key = finClientKey(client_key);
  const clean = finCleanLines(lines === undefined ? [] : lines);

  if (key) {
    const again = await finReplay(oc, key, by, bookId);
    if (again) return again;
  }
  await finCheckLedgers(qc, bookId, clean.lines);

  const made = await oc(
    `INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, narration, reference, total, client_key, created_by_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::uuid, $8, $9)
     ON CONFLICT (client_key) DO NOTHING
     RETURNING ${finCols()}`,
    [bookId, voucher_type, date, text.narration, text.reference, finFromPaise(clean.debit_paise), key, by.id, by.name]);
  if (!made) {
    // The key was taken between the look above and the insert, by a save that has now settled.
    const again = await finReplay(oc, key, by, bookId);
    if (again) return again;
    throw finError(409, 'FIN_DUPLICATE_KEY');
  }
  const written = await finInsertLines(qc, made.id, bookId, clean.lines);
  await finAudit(qc, {
    bookId, entity: 'voucher', entityId: made.id, action: 'create', userId: by.id, userName: by.name, after: finSnapshot(made, written),
  });
  return finVoucherOut(made);
}

// A draft the app builds from figures it was handed rather than one a person types: the Opening voucher, which the Tally
// import builds (finance-import.js, spec §11.2). `clean` is finCleanLines' answer for its lines, under the caller's own
// cap: whole paise, one side to a line, bill dates that are real days. Of the ledgers this checks nothing. The build has
// checked that each matched one is of this book and made the others (finCreateLedger); a line on another book's ledger
// cannot be written at all (fin_voucher_lines_ledger_book_fk); and the submit that follows checks the rest before it posts
// (finPostingProblem: every ledger switched on, the lines balanced, the Opening voucher's date), as the database does again
// at COMMIT. This writes the voucher, its lines and the `create` row of the log, as finCreateDraft does, and takes no lock:
// the voucher is new, so nothing else can reach it before COMMIT. There is no save key either: the build's own
// number-series lock is what makes a repeat find its work done. Nobody edits it afterwards (ruling R24): it is submitted,
// or discarded.
export async function finCreateBuiltDraft(qc, oc, { book_id, voucher_type, voucher_date, narration = null, reference = null }, clean, actor) {
  const by = finActing(actor);
  const made = await oc(
    `INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, narration, reference, total, created_by_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8)
     RETURNING ${finCols()}`,
    [book_id, voucher_type, voucher_date, narration, reference, finFromPaise(clean.debit_paise), by.id, by.name]);
  const written = await finInsertLines(qc, made.id, book_id, clean.lines);
  await finAudit(qc, {
    bookId: book_id, entity: 'voucher', entityId: made.id, action: 'create', userId: by.id, userName: by.name, after: finSnapshot(made, written),
  });
  return finVoucherOut(made);
}

// Edit a draft: its date, narration, reference and, when `lines` is sent, ALL its lines, which are replaced
// wholesale (a body without `lines` leaves them be). Its type and book are fixed when it is made. Only the
// maker (403 FIN_NOT_MAKER; not an approver, not an admin: nobody edits someone else's entry), and only while
// it is a draft (409 FIN_NOT_DRAFT). The voucher row is locked FOR UPDATE before anything else, for the
// reason in the header, and the maker and the status are judged on the row the lock returns, which is the
// latest. The whole edit is checked before the first line is deleted.
// Two drafts the app builds are never edited by hand (ruling R24, 409 FIN_BAD_INPUT): the Opening voucher, which
// ties out to the Tally trial balance it is built from, and a reversal, which mirrors its original line for line
// (the database proves that at posting, H11). An edit would break either; the maker may still discard them.
export async function finUpdateDraft(qc, oc, id, input, actor) {
  const by = finActing(actor);
  const voucherId = finIdOf(id);
  if (voucherId == null) throw finMissing();
  const edit = input ?? {};

  const before = await oc(`SELECT ${finCols()} FROM fin_vouchers WHERE id = $1 FOR UPDATE`, [voucherId]);
  if (!before) throw finMissing();
  if (before.created_by_id !== by.id) throw finError(403, 'FIN_NOT_MAKER', 'Only the person who made this entry can edit it.');
  if (before.status !== 'draft') throw finError(409, 'FIN_NOT_DRAFT');
  if (before.voucher_type === 'opening') throw finError(409, 'FIN_BAD_INPUT', 'An opening voucher is rebuilt from the Tally import, not edited.');
  if (before.reversal_of_id != null) throw finError(409, 'FIN_BAD_INPUT', "A reversal can't be edited — discard it and reverse again.");

  const next = {
    voucher_date: edit.voucher_date !== undefined ? finVoucherDate(edit.voucher_date) : before.voucher_date,
    narration: edit.narration !== undefined ? finOptionalText(edit.narration, 'narration', FIN_NARRATION_MAX) : before.narration,
    reference: edit.reference !== undefined ? finOptionalText(edit.reference, 'reference', FIN_REFERENCE_MAX) : before.reference,
  };
  const clean = edit.lines !== undefined ? finCleanLines(edit.lines) : null;
  if (clean) await finCheckLedgers(qc, before.book_id, clean.lines);

  const linesBefore = await finLinesOf(qc, voucherId);
  let linesAfter = linesBefore;
  if (clean) {
    await qc('DELETE FROM fin_voucher_lines WHERE voucher_id = $1', [voucherId]);
    linesAfter = await finInsertLines(qc, voucherId, before.book_id, clean.lines);
  }
  const after = await oc(
    `UPDATE fin_vouchers SET voucher_date = $2, narration = $3, reference = $4, total = $5::numeric, updated_at = now()
      WHERE id = $1 RETURNING ${finCols()}`,
    [voucherId, next.voucher_date, next.narration, next.reference, finFromPaise(clean ? clean.debit_paise : finToPaise(before.total))]);
  await finAudit(qc, {
    bookId: before.book_id, entity: 'voucher', entityId: voucherId, action: 'edit', userId: by.id, userName: by.name,
    before: finSnapshot(before, linesBefore), after: finSnapshot(after, linesAfter),
  });
  return finVoucherOut(after);
}

// Discard a draft: its maker, or a Finance Admin (`isAdmin`, which the route has worked out from the grant),
// and only while it is a draft. The row stays, with its lines, as `discarded`: the trail keeps it, and it
// never gets a number. Locked FOR UPDATE first, like an edit, so an edit and a discard at the same moment go
// one after the other and the second finds the draft as the first left it.
export async function finDiscardDraft(qc, oc, id, actor, { isAdmin = false } = {}) {
  const by = finActing(actor);
  const voucherId = finIdOf(id);
  if (voucherId == null) throw finMissing();

  const before = await oc(`SELECT ${finCols()} FROM fin_vouchers WHERE id = $1 FOR UPDATE`, [voucherId]);
  if (!before) throw finMissing();
  if (before.created_by_id !== by.id && isAdmin !== true) {
    throw finError(403, 'FIN_NOT_MAKER', 'Only the person who made this entry, or a Finance Admin, can discard it.');
  }
  if (before.status !== 'draft') throw finError(409, 'FIN_NOT_DRAFT');

  const lines = await finLinesOf(qc, voucherId);
  const after = await oc(`UPDATE fin_vouchers SET status = 'discarded', updated_at = now() WHERE id = $1 RETURNING ${finCols()}`, [voucherId]);
  await finAudit(qc, {
    bookId: before.book_id, entity: 'voucher', entityId: voucherId, action: 'discard', userId: by.id, userName: by.name,
    before: finSnapshot(before, lines), after: finSnapshot(after, lines),
  });
  return finVoucherOut(after);
}

// ── Posting: submit, approve, reject (spec §7.1, §7.3, §7.4) ─────────────────────────────────
//
// A voucher posts inside ONE transaction, its route's, in this order (spec §7.4; rulings R15 and R5's carry-forward):
//   1. finVoucherCtx reads, without a lock, where the voucher falls: its book, the month that holds its date, that
//      month's year, and so the number series it is minted from (CI-JV-2627-). It locks that series (lockDocNumber),
//      and only then the voucher, FOR UPDATE.
//   2. finPostLocked reads the month FOR SHARE, so a change of the month's status (which takes it FOR UPDATE) waits
//      for this posting, or this posting for it and then sees what it did; it reads every month after its own the same
//      way, since it is carried into each of them (rulings R73 and R70, finPostingFacts). It checks the voucher as the
//      database will, mints the number, and posts: status, number, month, who. A reversal then marks the entry it reverses.
//   3. COMMIT runs the database's deferred checks again (H1, H5, H6, H11). A refusal there rolls back everything, the
//      number included, and the next posting in the series takes that number: the series has no gaps.
// The series is locked before any row, so two postings meet at the series and neither holds a row the other wants.
// Lines are written before a status changes: a line write row-locks its voucher (fin_line_guard takes FOR SHARE),
// and once a voucher is posted no line of it changes again.
//
// Who may: the route has asked finRequire for the capability on the voucher's book (submit and reverse: enter; approve
// and reject: approve) and passes the login's roles there as `actor.roles`. Submit reads those roles to decide whether an
// entry that needs approval waits or posts self-approved, so an actor with no roles never approves anything.

// Where a voucher falls, read without locks: its book, the month that holds its date, that month's year, and the
// number series the three name. No month holds the date: 409 FIN_NO_PERIOD, naming the date.
async function finPlaceOf(oc, { book_id, voucher_type, voucher_date }) {
  const book = await oc('SELECT id, code, books_begin FROM fin_books WHERE id = $1', [book_id]);
  const period = await oc(
    `SELECT id, year_id, label, start_date, end_date, status FROM fin_periods
      WHERE book_id = $1 AND start_date <= $2 AND end_date >= $2`, [book_id, voucher_date]);
  if (!period) {
    throw finError(409, 'FIN_NO_PERIOD', `No financial year covers ${voucher_date} — add it in Finance → Setup → Months & Years.`);
  }
  const year = await oc('SELECT id, label, short FROM fin_years WHERE id = $1', [period.year_id]);
  return { book, period, year, prefix: finPrefix(book.code, voucher_type, year.short) };
}

// The voucher a posting acts on, locked, with where it falls (spec §7.4 steps 1 and 2): { v, book, period, year,
// prefix }. It is read without a lock to name its number series, the series is locked, and then the voucher is
// read again FOR UPDATE, which returns it as it now is. An edit that landed in between (only a draft's date can move)
// may have taken it into another month, which `period` then follows, or into another financial year, whose series
// this transaction does not hold: 409 FIN_CHANGED, to be tried again. A voucher that is not there is a 404.
export async function finVoucherCtx(qc, oc, voucherId) {
  const id = finIdOf(voucherId);
  if (id == null) throw finMissing();
  const seen = await oc('SELECT book_id, voucher_type, voucher_date FROM fin_vouchers WHERE id = $1', [id]);
  if (!seen) throw finMissing();
  let place = await finPlaceOf(oc, seen);
  await lockDocNumber(place.prefix, oc);
  const v = await oc(`SELECT ${finCols()} FROM fin_vouchers WHERE id = $1 FOR UPDATE`, [id]);
  if (!v) throw finMissing();
  if (v.book_id !== seen.book_id || v.voucher_type !== seen.voucher_type || v.voucher_date !== seen.voucher_date) {
    const now = await finPlaceOf(oc, v);
    if (now.prefix !== place.prefix) throw finError(409, 'FIN_CHANGED');
    place = now;
  }
  return { v, ...place };
}

// What decides whether a locked voucher may post: its month, and every month after it, read FOR SHARE (below); its lines in
// paise, each with its ledger's name, switch, system-only flag and whether it is bank or cash; and, for a reversal, the entry it
// reverses.
// The lines' ledgers are read FOR SHARE too, in id order (ruling R27), and their flags come from that locked read.
// The database reads them again at COMMIT (H6), and a ledger switched off in between would refuse the COMMIT after
// the number was minted and the maker's phone told it was approved. A switch-off (finUpdateLedger takes the ledger
// FOR NO KEY UPDATE) now waits for this posting; or this posting waits for it, then sees the ledger off and refuses
// here, before anything is minted or rung. The lines need no lock of their own: the voucher is held FOR UPDATE, and
// a line write locks its voucher first (fin_line_guard).
//
// The months carried into (ruling R73, which R70 is the opening's case of). Every balance from a month on is carried into every
// month after it, so a posting restates its own month and every later month of its book; the Opening voucher and its reversal,
// dated in a month before the books begin that never closes or locks, restate every month of the books. A posting therefore takes
// the most restrictive status among its own month and every later one. Those later months are read FOR SHARE as well, in id
// order, after the voucher's own month and before the ledgers: the global order (series, voucher, months, ledgers, status). A
// month's move (finSetPeriodStatus takes that one month FOR UPDATE, and nothing after it) then waits for this posting, or this
// posting waits for the move and judges the month as it left it, so no cycle can form. `carry` names the first locked and the
// first closing of them all by date, its own month included (or null), which is what finPostingProblem and the approval rule read.
async function finPostingFacts(qc, oc, { v, period }) {
  const month = await oc('SELECT id, label, start_date, status FROM fin_periods WHERE id = $1 FOR SHARE', [period.id]);
  const later = await qc(
    'SELECT id, label, start_date, status FROM fin_periods WHERE book_id = $1 AND start_date > $2 ORDER BY id FOR SHARE',
    [v.book_id, month.start_date]);
  const span = [month, ...later];
  const firstWith = status => span.filter(m => m.status === status).sort((a, b) => (a.start_date < b.start_date ? -1 : 1))[0] ?? null;
  const carry = { locked: firstWith('locked'), closing: firstWith('closing') };
  const rows = await qc('SELECT line_no, ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [v.id]);
  const ledgerIds = [...new Set(rows.map(r => r.ledger_id))];
  const ledgers = new Map(ledgerIds.length ? (await qc(
    'SELECT id, name, group_id, active, manual_entry FROM fin_ledgers WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE',
    [ledgerIds])).map(l => [l.id, l]) : []);
  const kinds = rows.length ? await finGroupKinds(qc, v.book_id) : new Map();
  const lines = rows.map(r => {
    const ledger = ledgers.get(r.ledger_id);
    return {
      line_no: r.line_no, name: ledger.name, active: ledger.active, manual_entry: ledger.manual_entry,
      debit_paise: finToPaise(r.debit), credit_paise: finToPaise(r.credit), is_bank_cash: kinds.get(ledger.group_id)?.is_bank_cash === true,
    };
  });
  const original = v.reversal_of_id == null ? null
    : await oc('SELECT id, book_id, voucher_type, status, reversed_by_id FROM fin_vouchers WHERE id = $1', [v.reversal_of_id]);
  return { month, carry, lines, original };
}

// The status a posting is judged by: the strictest of its own month's and of every month after it, which it is carried into
// (rulings R73 and R70). This is what decides whether an Approver is needed (finNeedsApproval's period_status).
const finStatusFor = ({ month, carry }) => (carry.locked ? 'locked' : carry.closing ? 'closing' : month.status);

// The refusal for a month, `held`, that an entry dated in `month` may not be posted into or carried into: the month itself, or
// a later one (ruling R73), which for the Opening voucher and its reversal is a month the opening carries into (ruling R70).
function finHeldBy(held, month, opening) {
  if (held.status === 'locked') {
    if (held.id === month.id) return finError(409, 'FIN_PERIOD_LOCKED', `${month.label} is locked. Nothing more can be posted to it.`);
    return finError(409, 'FIN_PERIOD_LOCKED', opening
      ? `${held.label} is locked. Nothing more can be posted to it, and the opening carries into it, so the opening can't change until it is unlocked.`
      : `${held.label} is locked. Nothing more can be posted to it, and an entry in ${month.label} carries into it, so ${month.label} can't take `
        + `new entries until ${held.label} is unlocked.`);
  }
  if (held.id === month.id) {
    return finError(409, 'FIN_PERIOD_CLOSING', `${month.label} is closing. Only an entry an Approver has approved can be posted to it.`);
  }
  return finError(409, 'FIN_PERIOD_CLOSING', opening
    ? `${held.label} is closing, and the opening carries into it. Only an entry an Approver has approved can change the opening.`
    : `${held.label} is closing, and an entry in ${month.label} carries into it. Only an entry an Approver has approved can be posted to ${month.label}.`);
}

// Why the voucher may not post into its month now, as the refusal to throw, or null. The database's own hard stops
// said first and in plain words, in the database's order where it has one (spec §7.2: H11 the reversal, H5 the
// month, H6 the ledgers, H1 the balance), and the two rules only the app keeps: the Opening voucher's date (ruling
// R12) and each type's shape (spec §6.5). The database checks again at COMMIT. `approved`: an Approver has passed
// it, which a closing month asks of everything, and a closing month that an entry is carried into asks of it (rulings R73, R70).
function finPostingProblem({ v, book }, { month, carry, lines, original }, { approved }) {
  const isReversal = v.reversal_of_id != null;
  if (isReversal) {
    if (!original || original.id === v.id || original.book_id !== v.book_id || original.status !== 'posted') {
      return finError(409, 'FIN_BAD_REVERSAL');
    }
    if (original.reversed_by_id != null) return finError(409, 'FIN_ALREADY_REVERSED');
  }
  if (v.voucher_type === 'opening') {
    const day = finDayBefore(book.books_begin);
    if (v.voucher_date !== day) {
      return finError(409, 'FIN_BAD_DATE', `The Opening voucher is dated ${day}, the day before the books begin. This one is dated ${v.voucher_date}.`);
    }
  }
  // Before the books begin, only the Opening voucher and its reversal. Said first: a typed entry dated there is told so, whatever
  // the months after it hold.
  const opening = v.voucher_type === 'opening' || original?.voucher_type === 'opening';
  if (month.status === 'before_books' && !opening) {
    return finError(409, 'FIN_BEFORE_BOOKS',
      `${month.label} comes before the books begin on ${book.books_begin}. Only the Opening voucher, or a reversal of it, can be dated there.`);
  }
  // Rulings R73 and R70: the strictest of the voucher's month and every month after it. Locked refuses it, the first by date named;
  // closing asks for an Approver, as of the month's own entries.
  if (carry.locked) return finHeldBy(carry.locked, month, opening);
  if (carry.closing && !approved) return finHeldBy(carry.closing, month, opening);
  // A reversal mirrors history, so it may use a ledger switched off since. A system-only ledger takes the ERP's own
  // postings, the Opening voucher and reversals, and nothing typed.
  const off = isReversal ? null : lines.find(line => !line.active);
  if (off) return finLedgerOff(`Line ${off.line_no}`, off.name);
  const systemOnly = v.source_type == null && v.voucher_type !== 'opening' && !isReversal ? lines.find(line => !line.manual_entry) : null;
  if (systemOnly) return finLedgerSystemOnly(`Line ${systemOnly.line_no}`, systemOnly.name);
  const balance = finBalanceProblem(lines);
  if (balance) return finError(409, balance.code, balance.message);
  const shape = finShapeProblem(v.voucher_type, lines, { isReversal });
  if (shape) return finError(409, shape.code, shape.message);
  return null;
}

// Post a voucher that finVoucherCtx locked in THIS transaction (`ctx` is what it returned), in the name of `actor`
// (spec §7.4). `approvedBy` is the Approver who passed it ({ id, name }), and `selfApproved` says that Approver made
// it. Only a draft or a submitted voucher posts (409 FIN_NOT_DRAFT otherwise). It is checked, its number minted, and
// it is posted. A reversal is posted FIRST and only then marks the entry it reverses, setting reversed_by_id and
// nothing else, not even updated_at: the database lets a posted entry change in that one way, to name its own posted
// reversal (H3), and proves the pair at COMMIT (H11). Zero rows marked means another reversal got there first: 409
// FIN_ALREADY_REVERSED. Appends the `post` audit row; returns the voucher as posted.
export async function finPostLocked(qc, oc, ctx, actor, { approvedBy = null, selfApproved = false } = {}) {
  const by = finActing(actor);
  const approver = approvedBy == null ? null : finActing(approvedBy);
  const { v } = ctx;
  if (v.status !== 'draft' && v.status !== 'submitted') throw finError(409, 'FIN_NOT_DRAFT');
  const facts = await finPostingFacts(qc, oc, ctx);
  const problem = finPostingProblem(ctx, facts, { approved: approver != null });
  if (problem) throw problem;

  const number = await nextNumber(ctx.prefix, 'fin_vouchers', 'number', oc);
  const after = await oc(
    `UPDATE fin_vouchers SET status = 'posted', number = $2, period_id = $3, posted_by_id = $4, posted_by = $5, posted_at = now(),
            approved_by_id = $6::int, approved_by = $7::text, approved_at = CASE WHEN $6::int IS NULL THEN NULL ELSE now() END,
            self_approved = $8, updated_at = now()
      WHERE id = $1 RETURNING ${finCols()}`,
    [v.id, number, facts.month.id, by.id, by.name, approver ? approver.id : null, approver ? approver.name : null, selfApproved === true]);
  if (v.reversal_of_id != null) {
    const marked = await oc('UPDATE fin_vouchers SET reversed_by_id = $1 WHERE id = $2 AND reversed_by_id IS NULL RETURNING id', [v.id, v.reversal_of_id]);
    if (!marked) throw finError(409, 'FIN_ALREADY_REVERSED');
  }
  const lines = await finLinesOf(qc, v.id);
  await finAudit(qc, {
    bookId: v.book_id, entity: 'voucher', entityId: v.id, action: 'post', userId: by.id, userName: by.name,
    before: finSnapshot(v, lines), after: finSnapshot(after, lines),
  });
  return finVoucherOut(after);
}

// Whether the book already holds an Opening voucher, as the refusal to throw (409 FIN_OPENING_EXISTS), or null: the ONE check, for
// the two doors an opening comes in by, a build from the Tally import (finBuildOpening, `doing: 'build'`) and the submit of an
// Opening draft (finSubmitVoucher, `doing: 'submit'`: a rejected one sent again, final review M-5). An Opening voucher holds the
// book while it waits for approval, and once posted until a reversal of it posts dated on its own day (rulings R37 and R42): one
// reversed only from a later date is still the books' opening until then, and a second one would double every balance meanwhile.
// `except` is the voucher being submitted, never counted against itself. The caller holds the book's Opening number series
// (CI-OB-2627-): every way in takes it first, so two can never both pass this. `day` is the opening's date, for the sentence.
export async function finLiveOpeningProblem(oc, bookId, day, { except = null, doing }) {
  const live = await oc(
    `SELECT o.status, o.number FROM fin_vouchers o
      WHERE o.book_id = $1 AND o.voucher_type = 'opening' AND o.id IS DISTINCT FROM $2::int
        AND (o.status = 'submitted'
             OR (o.status = 'posted' AND NOT EXISTS (SELECT 1 FROM fin_vouchers r
                                                      WHERE r.id = o.reversed_by_id AND r.status = 'posted' AND r.voucher_date = o.voucher_date)))
      ORDER BY (o.status = 'posted') DESC, o.id LIMIT 1`, [bookId, except]);
  if (live?.status === 'posted') {
    return finError(409, 'FIN_OPENING_EXISTS', `This book's Opening voucher is ${live.number}, which still holds its balances as at ${day}. `
      + `Reverse it, as at that date, before ${doing === 'submit' ? 'sending another' : 'building another'}.`);
  }
  if (live) {
    return finError(409, 'FIN_OPENING_EXISTS', "This book's Opening voucher is waiting for approval. The MD approves or rejects it before "
      + `another is ${doing === 'submit' ? 'sent' : 'built'}.`);
  }
  return null;
}

// How a bell names a voucher: its book, what it is and how much. "CI Journal ₹2,500.00", "DP Reversal ₹30.00".
const finBellName = (bookCode, v, totalPaise) =>
  `${bookCode} ${v.reversal_of_id != null ? 'Reversal' : FIN_VOUCHER_TYPES[v.voucher_type].label} ${finFormatINR(totalPaise)}`;

// The "waiting for approval" bells an entry rang (fin_approval), answered (final wave item 7). Once one Approver approves or
// rejects it, it waits for nobody, so no Approver who was told is left told: the plant's own flow does the same for an answered
// ask (routes/notifications.js). Only this entry's bells of that kind, and only read_at, the table's one mutable field; a bell
// rung again by a later submit is a new row, unread. The transaction's qc: the bells are answered with the decision, or not at all.
const finAnswerApprovalBells = (qc, voucherId) => qc(
  `UPDATE notifications SET read_at = now()
    WHERE kind = 'fin_approval' AND ref_table = 'fin_vouchers' AND ref_id = $1 AND read_at IS NULL`, [voucherId]);

// Submit a draft (spec §7.1, §7.3): its maker's only (403 FIN_NOT_MAKER), and a draft only (409 FIN_NOT_DRAFT). An
// entry that could never post is refused here, before anything changes, so it never waits in anyone's queue:
// unbalanced or the wrong shape, a locked month, a month before the books begin (but for the Opening voucher or its
// reversal), a ledger switched off since it was saved, and a locked month after its own, which it would be carried into (rulings
// R73 and R70). A closing month is no refusal here: it is what makes an entry need an Approver, and so is a closing month after
// its own. Then the book's rule for the entry (its type's, or 'reversal' for a reversal) and the strictest of those months say
// whether it needs approval:
//   • it does not, and the maker may enter vouchers: it posts now, unapproved;
//   • it does, and the maker is an Approver of the book: it posts now, approved by its maker (self_approved);
//   • otherwise it waits, `submitted`, and the book's other Approvers are told (fin_approval).
export async function finSubmitVoucher(qc, oc, id, actor) {
  const by = finActing(actor);
  const ctx = await finVoucherCtx(qc, oc, id);
  const { v, book } = ctx;
  if (v.created_by_id !== by.id) throw finError(403, 'FIN_NOT_MAKER', 'Only the person who made this entry can submit it.');
  if (v.status !== 'draft') throw finError(409, 'FIN_NOT_DRAFT');
  // An Opening draft sent back and sent again must find the book as a build would (final review M-5): one opening at a time.
  if (v.voucher_type === 'opening') {
    const held = await finLiveOpeningProblem(oc, v.book_id, v.voucher_date, { except: v.id, doing: 'submit' });
    if (held) throw held;
  }
  const facts = await finPostingFacts(qc, oc, ctx);
  const problem = finPostingProblem(ctx, facts, { approved: true });
  if (problem) throw problem;

  // The money that moves is the debits of the lines, in paise. A book with no rule for the entry asks an Approver.
  const totalPaise = facts.lines.reduce((sum, line) => sum + line.debit_paise, 0);
  const rule = await oc('SELECT mode, limit_amount FROM fin_approval_rules WHERE book_id = $1 AND rule_key = $2',
    [v.book_id, v.reversal_of_id != null ? 'reversal' : v.voucher_type]);
  const needs = finNeedsApproval({
    mode: rule ? rule.mode : 'always',
    limit_paise: rule?.limit_amount == null ? null : finToPaise(rule.limit_amount),
    total_paise: totalPaise,
    period_status: finStatusFor(facts),
  });
  if (needs ? finCan(actor.roles, 'approve') : finCan(actor.roles, 'enter')) {
    return finPostLocked(qc, oc, ctx, actor, { approvedBy: needs ? actor : null, selfApproved: needs });
  }

  const after = await oc(
    `UPDATE fin_vouchers SET status = 'submitted', submitted_by_id = $2, submitted_by = $3, submitted_at = now(), updated_at = now()
      WHERE id = $1 RETURNING ${finCols()}`, [v.id, by.id, by.name]);
  const lines = await finLinesOf(qc, v.id);
  await finAudit(qc, {
    bookId: v.book_id, entity: 'voucher', entityId: v.id, action: 'submit', userId: by.id, userName: by.name,
    before: finSnapshot(v, lines), after: finSnapshot(after, lines),
  });
  const approvers = (await finApproverIds(v.book_id, qc)).filter(userId => userId !== by.id);
  await notify(approvers, {
    kind: 'fin_approval', title: 'Finance entry waiting for approval', body: `${finBellName(book.code, v, totalPaise)} — ${by.name}`,
    link: `/finance?tab=approvals&voucher=${v.id}`, refTable: 'fin_vouchers', refId: v.id,
  }, qc);
  return finVoucherOut(after);
}

// Approve a waiting entry (spec §7.1, §8.2): an Approver of its book (403 FIN_FORBIDDEN otherwise; the route asked
// first), who did not make it (403 FIN_OWN_VOUCHER), while it is submitted (409 FIN_NOT_SUBMITTED: a second approve
// finds it posted). The approval goes in the log first (spec §8.3 lists approve and post apart: the approval is the
// decision, and the `post` row after it holds what changed), then the entry posts in the Approver's name, every Approver's
// bell for it is answered (finAnswerApprovalBells), and its maker is told (fin_decision).
export async function finApproveVoucher(qc, oc, id, actor) {
  const by = finActing(actor);
  if (!finCan(actor.roles, 'approve')) throw finError(403, 'FIN_FORBIDDEN');
  const ctx = await finVoucherCtx(qc, oc, id);
  const { v } = ctx;
  if (v.status !== 'submitted') throw finError(409, 'FIN_NOT_SUBMITTED');
  if (v.created_by_id === by.id) throw finError(403, 'FIN_OWN_VOUCHER');
  await finAudit(qc, { bookId: v.book_id, entity: 'voucher', entityId: v.id, action: 'approve', userId: by.id, userName: by.name });
  const posted = await finPostLocked(qc, oc, ctx, actor, { approvedBy: actor });
  await finAnswerApprovalBells(qc, v.id);
  await notify([v.created_by_id], {
    kind: 'fin_decision', title: 'Your Finance entry was approved', body: posted.number,
    link: `/finance?voucher=${v.id}`, refTable: 'fin_vouchers', refId: v.id,
  }, qc);
  return posted;
}

// Reject a waiting entry (spec §7.1): an Approver of its book, with a reason. It goes back to its maker as a draft,
// carrying the reason (last_rejected_*), every Approver's bell for it is answered (finAnswerApprovalBells), and the maker
// is told why (fin_decision). It mints nothing, so it locks the voucher and nothing else of the books. The reason is
// checked as text before the lock (400 FIN_BAD_INPUT); whether the entry is waiting (409 FIN_NOT_SUBMITTED) is judged
// before whether a reason was given (400 FIN_REASON_REQUIRED).
export async function finRejectVoucher(qc, oc, id, actor, reason) {
  const by = finActing(actor);
  if (!finCan(actor.roles, 'approve')) throw finError(403, 'FIN_FORBIDDEN');
  const voucherId = finIdOf(id);
  if (voucherId == null) throw finMissing();
  const why = finOptionalText(reason, 'reason', FIN_REASON_MAX);

  const before = await oc(`SELECT ${finCols()} FROM fin_vouchers WHERE id = $1 FOR UPDATE`, [voucherId]);
  if (!before) throw finMissing();
  if (before.status !== 'submitted') throw finError(409, 'FIN_NOT_SUBMITTED');
  if (!why) throw finError(400, 'FIN_REASON_REQUIRED', 'Say why the entry is rejected: the reason goes back to the person who made it.');

  const lines = await finLinesOf(qc, voucherId);
  const after = await oc(
    `UPDATE fin_vouchers SET status = 'draft', last_rejected_by = $2, last_rejected_at = now(), last_reject_reason = $3, updated_at = now()
      WHERE id = $1 RETURNING ${finCols()}`, [voucherId, by.name, why]);
  await finAudit(qc, {
    bookId: before.book_id, entity: 'voucher', entityId: voucherId, action: 'reject', userId: by.id, userName: by.name, reason: why,
    before: finSnapshot(before, lines), after: finSnapshot(after, lines),
  });
  await finAnswerApprovalBells(qc, voucherId);
  const book = await oc('SELECT code FROM fin_books WHERE id = $1', [before.book_id]);
  await notify([before.created_by_id].filter(userId => userId !== by.id), {
    kind: 'fin_decision', title: 'Your Finance entry was rejected', body: `${finBellName(book.code, before, finToPaise(before.total))} — ${why}`,
    link: `/finance?tab=drafts&voucher=${voucherId}`, refTable: 'fin_vouchers', refId: voucherId,
  }, qc);
  return finVoucherOut(after);
}

// ── Reversal (spec §7.5) ─────────────────────────────────────────────────────────────────────

// A value left out: absent, null, or blank text.
const finBlank = value => value == null || (typeof value === 'string' && value.trim() === '');

// Why a voucher can't be reversed now, as the refusal to throw, or null: it isn't posted; it is reversed already; it is
// the reversal of an Opening voucher, which is never reversed (ruling R45); or a reversal of it is on its way, a draft or
// waiting for approval (the database allows one live reversal of a voucher at a time). Asked of the unlocked read, so a request that cannot succeed is refused before it locks anything, and again of
// the locked one, where the answer is final: every way into a reversal of this voucher, or into marking it, waits for
// that lock. A posted voucher never stops being posted, and a mark never comes off (H3).
const FIN_NOT_POSTED_AS = { draft: 'is still a draft', submitted: 'is waiting for approval', discarded: 'was discarded' };
async function finReversalProblem(oc, v) {
  if (v.status !== 'posted') {
    const state = Object.hasOwn(FIN_NOT_POSTED_AS, v.status) ? FIN_NOT_POSTED_AS[v.status] : `is ${v.status}`;
    return finError(409, 'FIN_NOT_POSTED', `Only a posted entry can be reversed, and this one ${state}.`);
  }
  if (v.reversed_by_id != null) {
    const rev = await oc('SELECT number FROM fin_vouchers WHERE id = $1', [v.reversed_by_id]);
    return finError(409, 'FIN_ALREADY_REVERSED', `${v.number} has already been reversed, by ${rev.number}.`);
  }
  // Ruling R45: the reversal of an Opening voucher is never reversed itself, which would put the opening back in the
  // books beside whatever was built in its place. The database refuses it too, at COMMIT.
  if (v.reversal_of_id != null && (await oc('SELECT voucher_type FROM fin_vouchers WHERE id = $1', [v.reversal_of_id]))?.voucher_type === 'opening') {
    return finError(409, 'FIN_BAD_REVERSAL', 'This reversed the Opening voucher, and it is never reversed itself: that would put the opening back '
      + 'in the books beside whatever replaced it. Build a new opening from the Tally import instead.');
  }
  const coming = await oc(
    `SELECT status, created_by FROM fin_vouchers WHERE reversal_of_id = $1 AND status IN ('draft', 'submitted') ORDER BY id LIMIT 1`, [v.id]);
  if (coming?.status === 'submitted') return finError(409, 'FIN_ALREADY_REVERSED', `A reversal of ${v.number} is already waiting for approval.`);
  if (coming) {
    return finError(409, 'FIN_ALREADY_REVERSED',
      `A reversal of ${v.number} is already drafted by ${coming.created_by}. It has to be submitted or discarded first.`);
  }
  return null;
}

// Reverse a posted entry. A posted entry is never changed: it is undone by a reversal, a journal that mirrors every one
// of its lines with the debit and the credit swapped (the same ledgers, line narrations and bill details), carries its
// total, and says why in its narration, "Reversal of CI-RV-2627-0012 — <reason>". It is dated by whoever asks for it,
// today when they don't say. Both entries stay in the books, so every ledger the original touched nets to zero from the
// reversal's date on.
//
// A reversal is submitted the moment it is made, the way any entry is (finSubmitVoucher), under the book's `reversal`
// rule (spec §7.3). By default that rule is always: an Approver's reversal posts at once, self-approved, and an
// accountant's waits for an Approver, who is told. Posting it marks the original reversed (finPostLocked), in the same
// transaction, and the database proves the pair at COMMIT (H11): the original posted and marked reversed by this one,
// every line mirrored.
//
// ONE transaction, the route's, in the order every transaction that may post keeps (spec §7.4; rulings R15, R27):
//   1. Unlocked reads: the entry, and whether it can be reversed at all; then where the reversal falls, its month and so
//      its number series (CI-JV-2627-). No month holds the date: 409 FIN_NO_PERIOD.
//   2. The series' lock, then the entry FOR UPDATE, read again. Two people reversing one entry meet at the series, or,
//      when they date it in two financial years, at the entry; whichever goes second finds it reversed, or a reversal of
//      it on its way, and is refused. Neither holds a row the other waits for. An approval of a waiting reversal takes the
//      same order: its series, then the reversal, then (marking it) the entry.
//   3. The reversal, a draft made by the asker, and its lines, both copied in SQL, NUMERIC to NUMERIC: no amount passes
//      through a float.
//   4. finSubmitVoucher on it. finVoucherCtx locks it (and the series again, which this transaction holds already: a
//      no-op), and it posts or it waits, as above. A month that is locked, or that comes before the books begin (unless
//      the original is the Opening voucher), refuses it there, before anything is minted.
//   5. The log: `create` on the reversal, then its `post` or `submit` (finSubmitVoucher's), then `reverse` on the
//      original, with the reason, the original as it was and as it now stands (marked reversed, when the reversal posted).
//
// Refusals, in the order they are judged. The id (404). The date: a real day, or nothing for today (400 FIN_BAD_DATE);
// the reason as text (400 FIN_BAD_INPUT). Then the entry: not posted (409 FIN_NOT_POSTED); reversed already, or a reversal
// of it on its way (409 FIN_ALREADY_REVERSED, the code the database gives a second live reversal too); the reversal of an
// Opening voucher, which is never reversed itself (409 FIN_BAD_REVERSAL, ruling R45). Then whether a
// reason was given at all (400 FIN_REASON_REQUIRED): as with a rejection, the entry's state is judged before the reason.
// Then the date against the entry: never before it (409 FIN_BAD_DATE). A reversal dated before what it reverses would
// undo something that had not happened yet, and every report dated between the two would be wrong. Last, the month, as
// for any posting.
// The Opening voucher is the exception to "today when none is given" (ruling R42): it is reversed as at its own date,
// the day before the books begin, which is the date it gets when none is given, and any other date is refused (409
// FIN_BAD_DATE). Reversed later, it would stay in the books until then, beside the opening built in its place, and every
// balance as at its date would count the opening twice. The database refuses such a reversal too, at COMMIT.
export async function finReverseVoucher(qc, oc, id, actor, { date, reason } = {}) {
  const by = finActing(actor);
  const voucherId = finIdOf(id);
  if (voucherId == null) throw finMissing();
  const asked = finBlank(date) ? null : finVoucherDate(date, 'date');
  const why = finOptionalText(reason, 'reason', FIN_REASON_MAX);

  const seen = await oc(`SELECT ${finCols()} FROM fin_vouchers WHERE id = $1`, [voucherId]);
  if (!seen) throw finMissing();
  let problem = await finReversalProblem(oc, seen);
  if (problem) throw problem;
  if (!why) throw finError(400, 'FIN_REASON_REQUIRED', "Say why the entry is reversed: the reason goes into the reversal's narration.");
  const opening = seen.voucher_type === 'opening';
  if (opening && asked !== null && asked !== seen.voucher_date) {
    throw finError(409, 'FIN_BAD_DATE', `The Opening voucher is reversed as at its own date, ${seen.voucher_date}, so the books never hold `
      + 'two openings at once. Leave the date out, or give that one.', { field: 'date' });
  }
  const day = opening ? seen.voucher_date : asked ?? plantDateStr();
  if (day < seen.voucher_date) {
    throw finError(409, 'FIN_BAD_DATE',
      `A reversal can't be dated before the entry it reverses: ${seen.number} is dated ${seen.voucher_date}.`, { field: 'date' });
  }
  const place = await finPlaceOf(oc, { book_id: seen.book_id, voucher_type: 'journal', voucher_date: day });

  await lockDocNumber(place.prefix, oc);
  const orig = await oc(`SELECT ${finCols()} FROM fin_vouchers WHERE id = $1 FOR UPDATE`, [voucherId]);
  problem = await finReversalProblem(oc, orig);
  if (problem) throw problem;

  const made = await oc(
    `INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, narration, total, reversal_of_id, created_by_id, created_by)
     SELECT o.book_id, 'journal', $2, $3, o.total, o.id, $4, $5 FROM fin_vouchers o WHERE o.id = $1
     RETURNING ${finCols()}`,
    [orig.id, day, `Reversal of ${orig.number} — ${why}`, by.id, by.name]);
  await qc(
    `INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit, narration, bill_ref, bill_date, due_date)
     SELECT $1, l.book_id, l.line_no, l.ledger_id, l.credit, l.debit, l.narration, l.bill_ref, l.bill_date, l.due_date
       FROM fin_voucher_lines l WHERE l.voucher_id = $2 ORDER BY l.line_no`, [made.id, orig.id]);
  await finAudit(qc, {
    bookId: made.book_id, entity: 'voucher', entityId: made.id, action: 'create', userId: by.id, userName: by.name,
    after: finSnapshot(made, await finLinesOf(qc, made.id)),
  });

  const reversal = await finSubmitVoucher(qc, oc, made.id, actor);

  const lines = await finLinesOf(qc, orig.id);
  const after = await oc(`SELECT ${finCols()} FROM fin_vouchers WHERE id = $1`, [orig.id]);
  await finAudit(qc, {
    bookId: orig.book_id, entity: 'voucher', entityId: orig.id, action: 'reverse', userId: by.id, userName: by.name, reason: why,
    before: finSnapshot(orig, lines), after: finSnapshot(after, lines),
  });
  return reversal;
}

// ── Who may do what ──────────────────────────────────────────────────────────────────────────

// What a login may do with a voucher right now, as the screen offers it. PURE: the voucher's status, who made it
// and how it stands, and the login's roles on the voucher's book. The server refuses what is not offered here
// whatever the screen shows (the routes and the functions check it again); this only keeps the buttons honest.
//   edit, submit   its maker, while it is a draft, holding the right to enter vouchers; never edit an Opening
//                  voucher or a reversal, which the app builds (ruling R24)
//   discard        the same, or a Finance Admin, while it is a draft
//   approve        an Approver other than its maker, while it is submitted
//   reject         an Approver, while it is submitted
//   reverse        anyone who may enter vouchers, once it is posted and not yet reversed, while no reversal of it is on
//                  its way (`pending_reversal_id`, which finVoucherView reads: a draft, or waiting for approval), unless
//                  it is the reversal of an Opening voucher (`reversal_of_type`, which finVoucherView reads too: ruling R45)
export function finVoucherCan(voucher, userId, roles) {
  const enter = finCan(roles, 'enter');
  const maker = voucher.created_by_id != null && voucher.created_by_id === userId;
  const draft = voucher.status === 'draft';
  const submitted = voucher.status === 'submitted';
  const built = voucher.voucher_type === 'opening' || voucher.reversal_of_id != null;
  return {
    edit: draft && maker && enter && !built,
    submit: draft && maker && enter,
    discard: draft && ((maker && enter) || finCan(roles, 'admin')),
    approve: submitted && finCan(roles, 'approve') && !maker,
    reject: submitted && finCan(roles, 'approve'),
    reverse: voucher.status === 'posted' && voucher.reversed_by_id == null && voucher.pending_reversal_id == null && enter
      && voucher.reversal_of_type !== 'opening',
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

// The voucher a route names, and the book it lives in, for the routes that name the voucher and not the book
// (the path has only its id). A pool read, made BEFORE the route's transaction. A voucher the caller cannot see,
// whether it does not exist or lives in a book the caller holds no view on, is FIN_NOT_FOUND, one answer for
// both, so a refusal never says whether a voucher is there (finSeenBookOf, which answers for an import the same way).
// What the caller may do with a voucher they can see is finRequire's to say next, for the book this returns.
export async function finVoucherBookOf(req) {
  const id = finIdOf(req.params?.id);
  return { id, bookId: await finSeenBookOf('voucher', id, req) };
}

// One voucher for its screen: the voucher (with the numbers of the vouchers it reverses and is reversed by, and
// pending_reversal_id, a reversal of it on its way: a draft or waiting for approval, which holds it until it is decided
// or discarded), its lines with their ledgers' names, its history from the audit log, oldest first, and what this login
// may do with it. A pool read. The history is the timeline (who, what, when, why); the log screen has the before and
// after, and sending them with every voucher would send every edit's copy of every line.
export async function finVoucherView(id, req) {
  const voucherId = finIdOf(id);
  if (voucherId == null) throw finMissing();
  const found = await one(
    `SELECT ${finCols('v')}, ro.number AS reversal_of_number, ro.voucher_type AS reversal_of_type, rb.number AS reversed_by_number
       FROM fin_vouchers v
       LEFT JOIN fin_vouchers ro ON ro.id = v.reversal_of_id
       LEFT JOIN fin_vouchers rb ON rb.id = v.reversed_by_id
      WHERE v.id = $1`, [voucherId]);
  const grant = found ? (await finAccessOf(req.user?.id)).get(found.book_id) : undefined;
  if (!grant || !finCan(grant.roles, 'view')) throw finMissing();

  const { reversal_of_number, reversal_of_type, reversed_by_number, ...row } = found;
  const pending = row.status === 'posted' && row.reversed_by_id == null
    ? await one(`SELECT id FROM fin_vouchers WHERE reversal_of_id = $1 AND status IN ('draft', 'submitted') ORDER BY id LIMIT 1`, [voucherId])
    : null;
  const pending_reversal_id = pending ? pending.id : null;
  const lines = await q(
    `SELECT l.id, l.line_no, l.ledger_id, l.debit, l.credit, l.narration, l.bill_ref, l.bill_date, l.due_date,
            fl.name AS ledger_name, fl.code AS ledger_code
       FROM fin_voucher_lines l JOIN fin_ledgers fl ON fl.id = l.ledger_id
      WHERE l.voucher_id = $1 ORDER BY l.line_no`, [voucherId]);
  const history = await q(
    `SELECT id, action, user_id, user_name, reason, at FROM fin_audit_log
      WHERE book_id = $1 AND entity = 'voucher' AND entity_id = $2 ORDER BY id`, [found.book_id, voucherId]);
  return {
    voucher: { ...finVoucherOut(row), reversal_of_number, reversed_by_number, pending_reversal_id },
    lines: lines.map(l => ({ id: l.id, ...finLineOut(l), ledger_name: l.ledger_name, ledger_code: l.ledger_code })),
    history,
    can: finVoucherCan({ ...row, pending_reversal_id, reversal_of_type }, req.user?.id, grant.roles),
  };
}

// An optional filter that must be one of a few words: absent or empty is no filter.
function finChoice(value, allowed, field) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value)) throw finBad(`${field} must be one of: ${allowed.join(', ')}.`, field);
  return value;
}

// An optional date filter: absent or empty is no filter.
function finFilterDate(value, field) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !finIsValidDate(value)) {
    throw finError(400, 'FIN_BAD_DATE', `${field} isn't a valid date. Write it as YYYY-MM-DD.`, { field });
  }
  return value;
}

const FIN_LIST_ORDER = {
  daybook: 'v.voucher_date DESC, v.id DESC',               // newest first
  approvals: 'v.submitted_at ASC NULLS LAST, v.id ASC',    // longest waiting first
  drafts: 'v.updated_at DESC, v.id DESC',                  // last touched first
};

// The vouchers list (spec §9.1). Always inside the books the login may see; with `book` it is that one book,
// and a login with no grant on it is refused (403), as every Finance route that names a book does. With no `book`
// it is every book the login may see, and a login that may see none, one with no Finance grant at all, is refused
// (403) the same way: spec §14, every route refuses a login with no grant.
//   view=daybook    every status but discarded (the default)
//   view=approvals  submitted vouchers, in the books where the caller is an Approver, that the caller did not make;
//                   a login that sees the books but approves nothing in them gets none (ruling R25), not a 403
//   view=drafts     the caller's own drafts
// and, narrowing any of them, from / to (inclusive voucher dates), type, status, and q: a search of the number,
// narration, reference and maker, whatever the capitals, in which % and _ are only themselves.
// Answers { vouchers, truncated }: a day book longer than FIN_LIST_MAX rows is cut there, newest first, and says so.
// With count=1 it answers { count } instead, how many vouchers the very same list holds, uncut, and no rows (ruling R72):
// the Day Book's figures and tab counts, asked on every realtime tick, are counts, and five thousand rows a tick to count
// them is what an overrun on the ERP's Vercel plan is made of. Every filter, the books, R25 and the refusals are the rows'.
export async function finListVouchers(req) {
  const query = req.query ?? {};
  const view = finChoice(query.view, FIN_VIEWS, 'view') ?? 'daybook';
  const from = finFilterDate(query.from, 'from');
  const to = finFilterDate(query.to, 'to');
  const type = finChoice(query.type, Object.keys(FIN_VOUCHER_TYPES), 'type');
  const status = finChoice(query.status, FIN_STATUSES, 'status');
  const search = finOptionalText(query.q, 'q', FIN_SEARCH_MAX);
  const counting = finChoice(query.count, ['1'], 'count') === '1';

  // The books: the one named, if the login may see it, otherwise every book it may see. Approvals are the
  // Approver's: in a named book the login sees but approves nothing in, nothing waits on it; with no book named
  // they are the books it approves in.
  let bookIds;
  if (query.book !== undefined) {
    const bookId = finIdOf(query.book);
    if (bookId == null) throw finBad('book must be a book id.', 'book');
    const grant = await finRequire(req, 'view', bookId);
    bookIds = view !== 'approvals' || finCan(grant.roles, 'approve') ? [bookId] : [];
  } else {
    if (!(await finBookIdsFor(req, 'view')).length) throw finError(403, 'FIN_FORBIDDEN');
    bookIds = await finBookIdsFor(req, view === 'approvals' ? 'approve' : 'view');
  }
  if (!bookIds.length) return counting ? { count: 0 } : { vouchers: [], truncated: false };

  const args = [bookIds];
  const arg = value => { args.push(value); return `$${args.length}`; };
  const where = ['v.book_id = ANY($1::int[])'];
  if (view === 'daybook') where.push("v.status <> 'discarded'");
  else if (view === 'approvals') where.push("v.status = 'submitted'", `v.created_by_id IS DISTINCT FROM ${arg(req.user.id)}::int`);
  else where.push("v.status = 'draft'", `v.created_by_id = ${arg(req.user.id)}::int`);
  if (from) where.push(`v.voucher_date >= ${arg(from)}::text`);
  if (to) where.push(`v.voucher_date <= ${arg(to)}::text`);
  if (type) where.push(`v.voucher_type = ${arg(type)}::text`);
  if (status) where.push(`v.status = ${arg(status)}::text`);
  if (search) {
    const like = arg(`%${search.replace(/[!%_]/g, '!$&')}%`);
    where.push(`(v.number ILIKE ${like} ESCAPE '!' OR v.narration ILIKE ${like} ESCAPE '!'
              OR v.reference ILIKE ${like} ESCAPE '!' OR v.created_by ILIKE ${like} ESCAPE '!')`);
  }
  if (counting) {
    const counted = await one(`SELECT COUNT(*)::int AS count FROM fin_vouchers v WHERE ${where.join(' AND ')}`, args);
    return { count: counted.count };
  }
  const rows = await q(
    `SELECT v.id, v.book_id, v.number, v.voucher_date, v.voucher_type, v.status, v.narration, v.reference, v.total,
            v.created_by, v.created_at, v.submitted_at, v.posted_at, v.reversal_of_id, v.reversed_by_id, v.self_approved,
            v.last_reject_reason
       FROM fin_vouchers v
      WHERE ${where.join(' AND ')}
      ORDER BY ${FIN_LIST_ORDER[view]}
      LIMIT ${arg(FIN_LIST_MAX + 1)}`, args);
  return {
    vouchers: rows.slice(0, FIN_LIST_MAX).map(finVoucherOut),
    truncated: rows.length > FIN_LIST_MAX,
  };
}
