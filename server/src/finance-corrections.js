// Finance — opening corrections (Cash & Bank spec §9.4). A wrong figure in the Opening is put right without rebuilding the Opening:
// an opening correction is a journal dated the Opening's own date, the day before the books begin, marked as one
// (is_opening_correction), that changes only the figures that were wrong. Its lines balance, and may include bill-wise party lines
// (each a live item, ruling R9: depth 0), cash and bank lines (office cash moved to a holder, say), and the system-only ledgers the
// Opening itself may use (the staff ledgers, Salary Payable, Profit & Loss A/c: §9.5's cut-over check is fixed this way).
//   • finCreateOpeningCorrection  enters one and submits it at once, in the route's transaction;
//   • finOpeningCorrections       the Opening view's list of them, and "Opening + corrections" for each ledger they touched.
//
// Everything else about a correction is SP1's, in finance-vouchers.js: the approval rule (`opening`, and an Approver always, whatever
// the rule has been set to: finSubmitVoucher), the months (it is carried into every month of the books, so a locked one refuses it
// and a closing one asks for the approval it has anyway: rulings R70, R73), the posting check (finPostingProblem: its date, an
// Opening to correct, its approval, then H5, H6 and the balance), an Approver's rejection and the maker's edit of it (its lines
// change, never its date or its mark: finUpdateDraft), and its reversal (ruling R15, finReverseVoucher): dated the opening day
// whatever date is asked for, marked as a correction itself, under the `reversal` rule and always approved, and never reversed
// itself. The Opening is not reversed while a correction of it stands or waits, so each is reversed (or sent back) first, and the
// Opening is then rebuilt from Tally with every pair netting to nothing as at the opening day. The database holds the same rules
// at COMMIT (migration 20261121090100: H5 and H6 widened, FIN_BAD_CORRECTION for any other date).
//
// The write takes the qc / oc of its route's transaction and nothing else (the pool is one client on Vercel). It takes the
// correction's number series first, the journal series of the opening day (CI-JV-2627-), before it reads or writes anything else:
// the series a posting of it and a reversal of the Opening both lock first, so a correction is never made against an Opening that
// is being reversed at that moment. The submit then takes every lock a posting takes, in their order (series → voucher → party →
// months → ledgers, ruling R7); this module takes none of its own besides. The read goes through the pool, in ONE statement, so the
// list and the figures come from one snapshot, and names no word the response cache takes for a write (data-tables.js).
//
// Amounts are whole paise in JS and in the API; dates are 'YYYY-MM-DD'.

import { one } from './db.js';
import { lockDocNumber } from './helpers.js';
import { finError } from './finance-errors.js';
import { finIdOf, finOptionalText } from './finance-masters.js';
import { finPrefix } from './finance-rules.js';
import {
  FIN_NARRATION_MAX, FIN_OPENING_HOLDS_SQL, finCheckLedgers, finCleanLines, finClientKey, finCreateBuiltDraft, finLiveOpening, finReplay,
  finSubmitVoucher,
} from './finance-vouchers.js';
import { finDayBefore, finFyOf } from '../../client/src/lib/finance/fy.js';
import { finToPaise } from '../../client/src/lib/finance/money.js';

const finBad = (message, field) => finError(400, 'FIN_BAD_INPUT', message, field ? { field } : {});

// Enter an opening correction: { book_id, lines, narration, client_key } (anything else the body carries is not a correction's: its
// type, date and mark are fixed). Answers { voucher }, as the submit left it. In this order, and nothing written before the draft:
//   1. The request, checked: the book (400), the narration as text, the save key a UUID, the lines as finCleanLines takes them (a
//      list, at most 200, each a ledger with one positive side in whole paise, real bill dates).
//   2. A save key this login has used in this book already is a retry: the answer is the voucher that first save made, as it now
//      stands (finReplay; anyone else's key is 409 FIN_DUPLICATE_KEY). It writes nothing.
//   3. The book's opening day, finDayBefore(books_begin), and its journal series, locked.
//   4. A live Opening to correct: posted, and not reversed as at its own date (finLiveOpening); none, 409 FIN_NO_OPENING. An
//      Opening still waiting for the MD is not the books' yet.
//   5. The ledgers: every one this book's (409 FIN_WRONG_BOOK) and switched on (409 FIN_LEDGER_INACTIVE), a system-only one allowed
//      as the Opening's own (H6), and bill details on a party's ledger only (400).
//   6. The draft: a journal dated the opening day, marked as a correction (finCreateBuiltDraft), then submitted (finSubmitVoucher).
//      An accountant's waits for an Approver, who is told; an Approver's posts at once, self-approved. A locked month anywhere in
//      the books refuses it (409 FIN_PERIOD_LOCKED), and lines that don't balance are refused there too (409 FIN_UNBALANCED /
//      FIN_TOO_FEW_LINES): either rolls the whole of it back, the draft included.
// `actor` is { id, name, roles }: the login's roles on the book, which decide whether it waits or posts.
export async function finCreateOpeningCorrection(qc, oc, input, actor) {
  if (!Number.isSafeInteger(actor?.id)) throw new Error('An opening correction needs to know who is acting: pass { id, name, roles }');
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const bookId = finIdOf(raw.book_id);
  if (bookId == null) throw finBad('Say which book this correction is for.', 'book_id');
  const narration = finOptionalText(raw.narration, 'narration', FIN_NARRATION_MAX);
  const key = finClientKey(raw.client_key);
  const clean = finCleanLines(raw.lines);

  const again = key ? await finReplay(oc, key, actor, bookId) : null;
  if (again) return { voucher: again };

  const book = await oc('SELECT id, code, books_begin FROM fin_books WHERE id = $1', [bookId]);
  if (!book) throw finError(404, 'FIN_NOT_FOUND');
  const day = finDayBefore(book.books_begin);
  await lockDocNumber(finPrefix(book.code, 'journal', finFyOf(day).short), oc);
  if (!(await finLiveOpening(oc, bookId))) throw finError(409, 'FIN_NO_OPENING');
  await finCheckLedgers(qc, bookId, clean.lines, { allowSystemOnly: true });

  const draft = await finCreateBuiltDraft(qc, oc, {
    book_id: bookId, voucher_type: 'journal', voucher_date: day, narration, is_opening_correction: true, client_key: key,
  }, clean, actor);
  if (!draft) {
    // The key was taken between the look above and the insert, by a save that has now settled: this is a retry of it.
    const first = await finReplay(oc, key, actor, bookId);
    if (!first) throw finError(409, 'FIN_DUPLICATE_KEY');
    return { voucher: first };
  }
  return { voucher: await finSubmitVoucher(qc, oc, draft.id, actor) };
}

// $1 the book. The book's corrections (every status but discarded: a draft is one an Approver sent back), the reversals of
// corrections among them (marked as corrections too, ruling R15), and for every ledger a POSTED one touched, its line in the live
// Opening (FIN_OPENING_HOLDS_SQL: posted, not reversed as at its own date), the net of the posted ones' lines, and the two
// together. A correction and its reversal are both dated the opening day, so a reversed pair nets to nothing there, and the total
// is the ledger's balance as at the opening day.
const FIN_CORRECTIONS_SQL = `
WITH live AS (
  SELECT o.id FROM fin_vouchers o
   WHERE o.book_id = $1 AND o.voucher_type = 'opening' AND ${FIN_OPENING_HOLDS_SQL}
   ORDER BY o.id LIMIT 1
),
fixes AS (
  SELECT v.id, v.number, v.status, v.narration, v.total, v.reversal_of_id, v.reversed_by_id
    FROM fin_vouchers v
   WHERE v.book_id = $1 AND v.is_opening_correction AND v.status <> 'discarded'
),
corrected AS (
  SELECT l.ledger_id, SUM(l.debit - l.credit) AS net
    FROM fin_voucher_lines l JOIN fixes f ON f.id = l.voucher_id
   WHERE f.status = 'posted'
   GROUP BY l.ledger_id
),
opened AS (
  SELECT l.ledger_id, SUM(l.debit - l.credit) AS net
    FROM fin_voucher_lines l JOIN live ON live.id = l.voucher_id
   GROUP BY l.ledger_id
)
SELECT
  (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.id), '[]'::jsonb) FROM fixes f) AS corrections,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'ledger_id', c.ledger_id, 'name', fl.name, 'opening', COALESCE(o.net, 0), 'corrections', c.net,
            'total', COALESCE(o.net, 0) + c.net) ORDER BY lower(fl.name), fl.id), '[]'::jsonb)
     FROM corrected c
     JOIN fin_ledgers fl ON fl.id = c.ledger_id
     LEFT JOIN opened o ON o.ledger_id = c.ledger_id) AS by_ledger`;

// The Opening view's corrections (spec §9.4, "Opening + corrections"): { corrections, by_ledger }.
//   corrections  each { id, number, status, narration, total_paise, reversal_of_id, reversed_by_id }, oldest first: drafts sent
//                back, those waiting for an Approver (no number yet) and those posted; a correction's reversal is listed too, naming
//                the correction it reverses (reversal_of_id), and a correction reversed names its reversal (reversed_by_id);
//   by_ledger    each ledger a posted correction touched, by name: { ledger_id, name, opening_paise, corrections_paise, total_paise },
//                its line in the Opening (0 when it has none, or the book has no Opening now), the corrections' net and the two
//                together, Dr positive. A ledger no posted correction touched is not listed. A book with no corrections lists none.
// A pool read; the route has asked who may (the right to view the book).
export async function finOpeningCorrections(bookId) {
  const row = await one(FIN_CORRECTIONS_SQL, [bookId]);
  return {
    corrections: row.corrections.map(c => ({
      id: c.id, number: c.number, status: c.status, narration: c.narration, total_paise: finToPaise(c.total),
      reversal_of_id: c.reversal_of_id, reversed_by_id: c.reversed_by_id,
    })),
    by_ledger: row.by_ledger.map(r => ({
      ledger_id: r.ledger_id, name: r.name,
      opening_paise: finToPaise(r.opening), corrections_paise: finToPaise(r.corrections), total_paise: finToPaise(r.total),
    })),
  };
}
