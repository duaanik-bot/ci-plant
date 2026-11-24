// How Finance refuses (spec §9.3): one shape for every refusal, one plain sentence for every code, and a
// translation from the database's own refusals into the same shape, so a screen reads one kind of error
// whoever made it.
//
// A refusal is  Object.assign(new Error(sentence), { status, body: { code, … } }).  The central handler
// in app.js writes  { error: sentence, ...body }  and nothing else of the error, so a structured field
// hung anywhere but `body` never reaches the screen (structured-errors.test.js guards the spelling).
//
// The database refuses some things itself: the hard-stop triggers of spec §7.2 (a pg error whose DETAIL
// is a FIN_ code) and a handful of constraints (the unique indexes, the CHECKs and the foreign keys,
// named in migrations 20261027104320 and 20261121090100). Those reach a route as pg errors. finMapDbError
// turns each into a refusal; every route ends  catch (e) { next(finMapDbError(e)); }.
//
// Every other error becomes ONE fixed 500, FIN_SERVER_ERROR, whose sentence says nothing of what went
// wrong. The central handler writes err.message to the browser, and a database's own words name its
// columns, tables, constraints and users ('null value in column "group_id" of relation "fin_ledgers"…',
// 'password authentication failed for user "postgres"'). The original rides along as `cause`, which that
// handler's console.error logs.

// The plain sentence for each code. The database can say a code only in general terms. Wherever a
// screen knows more (the figures, the line, the month) the check in finance-rules.js, or the posting
// code, says it first, in finance-rules' more specific words, and the database is only the last stop.
export const FIN_SENTENCES = Object.freeze({
  // ── The hard-stop triggers (spec §7.2)
  FIN_UNBALANCED: "Debits and credits don't match.",
  FIN_TOO_FEW_LINES: 'A voucher needs at least two lines.',
  FIN_POSTED_IMMUTABLE: "A posted voucher can't be changed or deleted. Reverse it instead.",
  FIN_PERIOD_LOCKED: 'That month is locked. Nothing more can be posted to it.',
  FIN_PERIOD_CLOSING: 'That month is closing. Only an approved entry can be posted to it.',
  FIN_BEFORE_BOOKS: 'That date comes before the books begin. Only the Opening voucher, or a reversal of it, can be dated there.',
  FIN_BAD_DATE: "That isn't a valid date. Use a real date, written YYYY-MM-DD.",
  FIN_WRONG_BOOK: 'That belongs to a different book. An entry, its ledgers and its month must all be in the same book.',
  FIN_LEDGER_INACTIVE: 'That ledger is switched off and takes no new postings.',
  FIN_SYSTEM_LEDGER: 'That ledger is kept for system entries only.',
  FIN_AUDIT_APPEND_ONLY: 'The audit log is append-only. Its rows are never edited or deleted.',
  FIN_NO_TRUNCATE: 'Vouchers, their lines and the audit log can never be emptied.',
  FIN_BAD_REVERSAL: 'A reversal must mirror every line of a posted voucher in the same book, and that voucher must be marked as reversed by it. An Opening voucher is reversed as at its own date, and that reversal is never reversed itself: a new opening is built instead.',
  // …and Cash & Bank's (migration 20261121090100): the two of its allocations (spec §6.2), and an opening correction's date (§9.4)
  FIN_BAD_ALLOCATION: "That adjustment doesn't fit those entries.",
  FIN_OVER_ALLOCATED: 'That would settle more than the entry holds.',
  FIN_BAD_CORRECTION: "An opening correction is dated the Opening's own date, the day before the books begin.",

  // ── The constraints
  FIN_OPENING_EXISTS: 'This book already has an Opening voucher. Reverse it before posting another.',
  FIN_ALREADY_REVERSED: 'That voucher has already been reversed.',
  FIN_SOURCE_POSTED: 'That document has already been posted to the books.',
  FIN_DUPLICATE_NAME: 'That name is already used in this book. Capital letters make no difference.',
  FIN_DUPLICATE_CODE: 'Another ledger in this book already has that code.',
  FIN_PARTY_LINKED: 'That customer or vendor is already linked to another ledger in this book.',
  FIN_BAD_LINE: 'A line needs a debit or a credit amount, not both and not neither.',
  FIN_BAD_AMOUNT: "That isn't a valid amount.",
  FIN_IN_USE: "That is still in use, so it can't be deleted.",

  // ── The app's own refusals, from the routes and the modules behind them
  FIN_FORBIDDEN: "This login isn't allowed to do that in these books. Ask the MD.",
  FIN_NOT_MAKER: 'Only the person who made this entry can do that.',
  FIN_NOT_FOUND: 'That could not be found.',
  FIN_BAD_INPUT: "Something in that request isn't right. Check it and try again.",
  FIN_REASON_REQUIRED: 'A reason is required.',
  FIN_NO_PERIOD: 'No financial year covers that date — add it in Finance → Setup → Months & Years.',
  FIN_SHAPE: "These lines don't suit this type of voucher.",
  FIN_NOT_DRAFT: 'This entry is no longer a draft.',
  FIN_NOT_SUBMITTED: "This entry isn't waiting for approval.",
  FIN_NOT_POSTED: "This voucher isn't posted.",
  FIN_OWN_VOUCHER: "You can't approve an entry you made yourself.",
  FIN_CHANGED: 'This entry changed while you were working on it. Reload it and try again.',
  FIN_EXISTS: 'That already exists.',
  FIN_BAD_TRANSITION: "A month can't move from its present status to that one.",
  FIN_LAST_ADMIN: 'Every book needs at least one Finance Admin. Make someone else an admin first.',
  FIN_TIE_OUT: "The Tally figures don't tie out, so the Opening voucher can't be built.",
  FIN_DUPLICATE_KEY: 'That form was already saved by someone else. Reload and try again.',
  // …and Cash & Bank's (plan 2026-11-20-finance-cash-bank, Global Constraints)
  FIN_NOT_PARTY_LINE: "Only a posted party entry that hasn't been reversed can be adjusted.",
  FIN_STAFF_IN_HR: 'Staff advances and salaries are paid in HR.',
  FIN_ROLE_MISSING: 'Set this ledger in Finance Setup → HR & payroll first.',
  FIN_HOLDER_NOT_CASH: 'Only a Cash-in-Hand ledger can have a holder.',
  FIN_DIFFERENCE_VIA_COUNT: 'Cash differences are cleared from a cash count: Count cash → Clear.',
  FIN_NO_OPENING: 'There is no Opening to correct yet.',
  FIN_UNMAPPED_CHANNEL: 'Map this HR pay channel to an account in Finance Setup first.',
  FIN_HR_OWNED: 'This entry comes from HR; correct it there.',
  // …and the HR feed's lock timeout (Cash & Bank ruling R73): Postgres' lock_not_available, 55P03, which only a transaction that set
  // lock_timeout meets
  FIN_BUSY: 'Finance was busy with another entry, so this one did not wait. Try it again in a moment.',

  // ── The fault nobody planned for: what every other error becomes (see the header)
  FIN_SERVER_ERROR: 'Something went wrong in Finance. Please try again, and tell the MD if it keeps happening.',
});

// The plain sentence for a code, or `otherwise` when it has none. Own properties only: a code is data, and
// 'constructor' is not a sentence.
const finSentence = (code, otherwise) => (Object.hasOwn(FIN_SENTENCES, code) ? FIN_SENTENCES[code] : otherwise);

// A refusal. `message` is the sentence the screen shows; left out, it is the code's plain sentence.
// `extra` is structured detail for the screen (a list of problems, say) and goes into `body` only.
export function finError(status, code, message, extra = {}) {
  return Object.assign(new Error(message || finSentence(code, code)), { status, body: { code, ...extra } });
}

// ── The database's refusals ──────────────────────────────────────────────────────────────────
// Unique violations (SQLSTATE 23505), by the name of the index or constraint, which is what pg reports.
// The partial unique indexes carry the names the migration gave them. The UNIQUE on a column carries
// Postgres' default name, <table>_<column>_key, which finance-pg-schema.test.js pins.
const FIN_UNIQUE = {
  fin_vouchers_one_live_opening: 'FIN_OPENING_EXISTS',
  fin_vouchers_one_reversal: 'FIN_ALREADY_REVERSED',
  fin_vouchers_reversed_by_id_key: 'FIN_ALREADY_REVERSED',
  fin_vouchers_one_live_source: 'FIN_SOURCE_POSTED',
  fin_groups_book_name_key: 'FIN_DUPLICATE_NAME',
  fin_ledgers_book_name_key: 'FIN_DUPLICATE_NAME',
  fin_ledgers_book_code_key: 'FIN_DUPLICATE_CODE',
  fin_ledgers_party_key: 'FIN_PARTY_LINKED',
  // Cash & Bank (migration 20261121090100). The same two lines paired twice is an adjustment that does not fit them;
  // the rest are a second row where a book, a role, a key, a channel or an HR event has one, or a voucher books an HR row twice.
  fin_allocations_debit_line_id_credit_line_id_key: 'FIN_BAD_ALLOCATION',
  fin_ledger_roles_book_id_role_key: 'FIN_EXISTS',
  fin_hr_expense_map_book_id_hr_key_key: 'FIN_EXISTS',
  fin_hr_channels_pkey: 'FIN_EXISTS',
  fin_book_settings_pkey: 'FIN_EXISTS',
  fin_hr_exceptions_source_type_source_id_key: 'FIN_EXISTS',
  fin_hr_covers_voucher_id_source_type_source_id_key: 'FIN_EXISTS',
};

// CHECK violations (23514): [status, code]. A line that is not exactly one side is the same refusal the
// app makes in finBalanceProblem (409). A NaN total, or a NaN approval limit, is a bad amount, which the app
// answers 400. The CHECKs the app never meets (a voucher's posted shape, a draft marked reversed, a reversal
// that is not a journal) are bugs in whatever wrote them, and leave as the one fixed 500.
const FIN_CHECKS = {
  fin_voucher_lines_one_side: [409, 'FIN_BAD_LINE'],
  fin_vouchers_total_check: [400, 'FIN_BAD_AMOUNT'],
  fin_approval_rules_limit_not_nan: [400, 'FIN_BAD_AMOUNT'],
  // Cash & Bank (migration 20261121090100): every CHECK it adds is a bad amount, a bad date or a bad request (400).
  // A float with no holder, and a correction that is not a journal, are requests the app refuses first in its own words.
  fin_ledgers_float_needs_holder: [400, 'FIN_BAD_INPUT'],
  fin_vouchers_correction_is_journal: [400, 'FIN_BAD_INPUT'],
  fin_allocations_amount_check: [400, 'FIN_BAD_AMOUNT'],
  fin_allocations_mode_check: [400, 'FIN_BAD_INPUT'],
  fin_cash_counts_count_date_check: [400, 'FIN_BAD_DATE'],
  fin_cash_counts_counted_check: [400, 'FIN_BAD_AMOUNT'],
  fin_ledger_roles_role_check: [400, 'FIN_BAD_INPUT'],
  fin_hr_expense_map_hr_key_check: [400, 'FIN_BAD_INPUT'],
  fin_book_settings_payroll_booking_check: [400, 'FIN_BAD_INPUT'],
};

// Foreign keys (23503) that mean "another book's" when a row is written pointing across books: a ledger with
// another book's group, and anything else naming a ledger with another book's id beside it.
const FIN_BOOK_FKS = new Set([
  'fin_voucher_lines_ledger_book_fk', 'fin_ledgers_group_book_fk',
  'fin_allocations_ledger_book_fk', 'fin_cash_counts_ledger_book_fk', 'fin_ledger_roles_ledger_book_fk',
  'fin_hr_channels_ledger_book_fk', 'fin_hr_expense_map_ledger_book_fk',
]);

// A foreign key breaks in two directions, and one constraint can break both ways. A ledger written with
// another book's group is refused as it is written; a group that still has ledgers under it is refused
// as it is deleted, by the very same fin_ledgers_group_book_fk. Only the wording tells them apart.
const finStillReferenced = e => /^update or delete on table /.test(e.message) || /is still referenced from table/.test(e.detail);

// What a database error means to Finance: [status, code], or null when Finance has no word for it.
function finDbMeaning(e) {
  if (e === null || typeof e !== 'object') return null;
  const fromTrigger = typeof e.detail === 'string' ? /^(FIN_[A-Z0-9_]+)/.exec(e.detail) : null;
  if (fromTrigger) return [409, fromTrigger[1]];
  switch (e.code) {
    case '23505': return Object.hasOwn(FIN_UNIQUE, e.constraint) ? [409, FIN_UNIQUE[e.constraint]] : null;
    case '23514': return Object.hasOwn(FIN_CHECKS, e.constraint) ? FIN_CHECKS[e.constraint] : null;
    case '23503':
      if (finStillReferenced(e)) return [409, 'FIN_IN_USE'];
      return FIN_BOOK_FKS.has(e.constraint) ? [409, 'FIN_WRONG_BOOK'] : null;
    // A lock waited for longer than the transaction's lock_timeout allows (Cash & Bank ruling R73: the HR feed's transactions set one, 5 s).
    case '55P03': return [409, 'FIN_BUSY'];
    default: return null;
  }
}

// A business error already says what it has to say: it carries an HTTP error status (finError, finRequire's
// 403, a helper's own). A status that is no HTTP error status, a string or NaN or 200, is just a field.
const finIsBusinessError = e => e !== null && typeof e === 'object' && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599;

// The original error rides along as `cause`, and not as an enumerable field (the Error constructor's own
// `cause` option makes it the same): nothing that copies or serialises the refusal, a spread or
// JSON.stringify, can then carry the database's words to a browser. util.inspect prints it as [cause].
const finCaused = (refusal, original) => Object.defineProperty(refusal, 'cause', { value: original, writable: true, configurable: true });

// Whatever a route's catch has caught, as the refusal the central handler will send.
//   - A business error (an HTTP error status) comes back as it is, so mapping twice maps once.
//   - A hard-stop trigger names its code in DETAIL (FIN_UNBALANCED, FIN_PERIOD_LOCKED, …): 409. A code
//     with no sentence yet still goes out as that code, saying what the trigger said; the triggers are ours.
//   - A unique, check or foreign-key violation Finance knows by name is mapped as listed above, and a lock timeout (55P03) is
//     FIN_BUSY, 409 (Cash & Bank ruling R73).
//   - Anything else, the database's other errors, a connection fault, a bug, something thrown that is not
//     even an Error, is the one fixed 500, FIN_SERVER_ERROR.
export function finMapDbError(e) {
  if (finIsBusinessError(e)) return e;
  const meaning = finDbMeaning(e);
  if (!meaning) return finCaused(finError(500, 'FIN_SERVER_ERROR'), e);
  const [status, code] = meaning;
  return finCaused(finError(status, code, finSentence(code, e.message)), e);
}
