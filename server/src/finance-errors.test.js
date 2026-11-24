import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { finError, finMapDbError, FIN_SENTENCES } from './finance-errors.js';
import { finBalanceProblem } from './finance-rules.js';

// A pg error as node-pg raises one: an Error with the SQLSTATE in `code` and the rest of what Postgres says.
const pg = fields => Object.assign(new Error(fields.message ?? 'the database said no'), fields);
const unique = constraint => pg({ code: '23505', constraint, message: `duplicate key value violates unique constraint "${constraint}"`, detail: 'Key (x)=(1) already exists.' });
const check = constraint => pg({ code: '23514', constraint, message: `new row violates check constraint "${constraint}"` });
const fkInsert = constraint => pg({ code: '23503', constraint, message: `insert or update on table "t" violates foreign key constraint "${constraint}"`, detail: 'Key (a, b)=(1, 2) is not present in table "p".' });
const fkDelete = constraint => pg({ code: '23503', constraint, message: `update or delete on table "p" violates foreign key constraint "${constraint}" on table "t"`, detail: 'Key (id, book_id)=(1, 2) is still referenced from table "t".' });
const trigger = code => pg({ code: 'P0001', detail: code, message: 'the trigger text' });
const refusal = (e, status, code) => { assert.equal(e.status, status); assert.deepEqual(e.body, { code }); assert.equal(e.message, FIN_SENTENCES[code]); };

test('finError: status and code on a standard refusal, structured detail only inside body', () => {
  const e = finError(409, 'FIN_TIE_OUT', 'The Tally figures are ₹1 out.', { problems: [{ code: 'TB_UNBALANCED' }] });
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'The Tally figures are ₹1 out.');
  assert.equal(e.status, 409);
  assert.deepEqual(e.body, { code: 'FIN_TIE_OUT', problems: [{ code: 'TB_UNBALANCED' }] });
  // The central handler writes { error: message, ...body } and nothing else of the error.
  assert.equal(e.code, undefined);
  assert.equal(e.problems, undefined);
  // No message of its own: the code's plain sentence. No sentence either: the code itself.
  assert.equal(finError(403, 'FIN_FORBIDDEN').message, FIN_SENTENCES.FIN_FORBIDDEN);
  assert.equal(finError(500, 'FIN_NOT_A_CODE').message, 'FIN_NOT_A_CODE');
  assert.deepEqual(finError(404, 'FIN_NOT_FOUND').body, { code: 'FIN_NOT_FOUND' });
});

// The sixteen codes the hard-stop triggers raise: the core's thirteen (spec §7.2, migration 20261027104320) and Cash &
// Bank's three (migration 20261121090100): two for allocations (its spec §6.2) and one for an opening correction's date
// (§9.4). They are read off both migrations as well as listed here, so a seventeenth trigger code cannot arrive without its
// sentence.
const TRIGGER_CODES = [
  'FIN_AUDIT_APPEND_ONLY', 'FIN_BAD_ALLOCATION', 'FIN_BAD_CORRECTION', 'FIN_BAD_DATE', 'FIN_BAD_REVERSAL', 'FIN_BEFORE_BOOKS',
  'FIN_LEDGER_INACTIVE', 'FIN_NO_TRUNCATE', 'FIN_OVER_ALLOCATED', 'FIN_PERIOD_CLOSING', 'FIN_PERIOD_LOCKED', 'FIN_POSTED_IMMUTABLE',
  'FIN_SYSTEM_LEDGER', 'FIN_TOO_FEW_LINES', 'FIN_UNBALANCED', 'FIN_WRONG_BOOK',
];
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const financeSql = suffix => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(suffix));
  assert.equal(files.length, 1, suffix);
  return readFileSync(new URL(files[0], MIGRATIONS), 'utf8');
};

test('every code a trigger raises has a plain sentence, and a trigger refusal is a 409 with that code and sentence', () => {
  const sql = financeSql('_finance_ledger_core.sql') + financeSql('_finance_cash_bank.sql');
  const raised = [...new Set([...sql.matchAll(/detail = '(FIN_[A-Z0-9_]+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(raised, TRIGGER_CODES, 'the migrations raise a different set of codes: give the new one a sentence');
  for (const code of TRIGGER_CODES) {
    assert.ok(Object.hasOwn(FIN_SENTENCES, code), `${code} has no sentence`);
    refusal(finMapDbError(trigger(code)), 409, code);
  }
});

test('a trigger code with no sentence yet still goes out under its own code, in the trigger\'s words', () => {
  const e = finMapDbError(pg({ code: 'P0001', detail: 'FIN_SOMETHING_NEW', message: 'Something new was refused.' }));
  assert.equal(e.status, 409);
  assert.deepEqual(e.body, { code: 'FIN_SOMETHING_NEW' });
  assert.equal(e.message, 'Something new was refused.');
});

test('unique violations map by the name of the index or constraint', () => {
  for (const [constraint, code] of [
    ['fin_vouchers_one_live_opening', 'FIN_OPENING_EXISTS'],
    ['fin_vouchers_one_reversal', 'FIN_ALREADY_REVERSED'],
    ['fin_vouchers_reversed_by_id_key', 'FIN_ALREADY_REVERSED'],
    ['fin_vouchers_one_live_source', 'FIN_SOURCE_POSTED'],
    ['fin_groups_book_name_key', 'FIN_DUPLICATE_NAME'],
    ['fin_ledgers_book_name_key', 'FIN_DUPLICATE_NAME'],
    ['fin_ledgers_book_code_key', 'FIN_DUPLICATE_CODE'],
    ['fin_ledgers_party_key', 'FIN_PARTY_LINKED'],
  ]) refusal(finMapDbError(unique(constraint)), 409, code);
});

test('check violations: a line that is not one side is FIN_BAD_LINE (409), a NaN total or limit is FIN_BAD_AMOUNT (400)', () => {
  refusal(finMapDbError(check('fin_voucher_lines_one_side')), 409, 'FIN_BAD_LINE');
  refusal(finMapDbError(check('fin_vouchers_total_check')), 400, 'FIN_BAD_AMOUNT');
  refusal(finMapDbError(check('fin_approval_rules_limit_not_nan')), 400, 'FIN_BAD_AMOUNT');
});

// Cash & Bank (migration 20261121090100): every constraint it names, and every default-named CHECK and UNIQUE it adds, has a
// Finance code (the controller's rule for that migration). finance-pg-cash-schema.test.js holds these names to the database's.
test('Cash & Bank\'s constraints: each one a Finance refusal, never the fixed 500', () => {
  for (const [constraint, code] of [
    ['fin_allocations_debit_line_id_credit_line_id_key', 'FIN_BAD_ALLOCATION'],
    ['fin_ledger_roles_book_id_role_key', 'FIN_EXISTS'],
    ['fin_hr_expense_map_book_id_hr_key_key', 'FIN_EXISTS'],
    ['fin_hr_channels_pkey', 'FIN_EXISTS'],
    ['fin_book_settings_pkey', 'FIN_EXISTS'],
    ['fin_hr_exceptions_source_type_source_id_key', 'FIN_EXISTS'],
    ['fin_hr_covers_voucher_id_source_type_source_id_key', 'FIN_EXISTS'],
  ]) refusal(finMapDbError(unique(constraint)), 409, code);
  for (const [constraint, code] of [
    ['fin_ledgers_float_needs_holder', 'FIN_BAD_INPUT'],
    ['fin_vouchers_correction_is_journal', 'FIN_BAD_INPUT'],
    ['fin_allocations_amount_check', 'FIN_BAD_AMOUNT'],
    ['fin_allocations_mode_check', 'FIN_BAD_INPUT'],
    ['fin_cash_counts_count_date_check', 'FIN_BAD_DATE'],
    ['fin_cash_counts_counted_check', 'FIN_BAD_AMOUNT'],
    ['fin_ledger_roles_role_check', 'FIN_BAD_INPUT'],
    ['fin_hr_expense_map_hr_key_check', 'FIN_BAD_INPUT'],
    ['fin_book_settings_payroll_booking_check', 'FIN_BAD_INPUT'],
  ]) refusal(finMapDbError(check(constraint)), 400, code);
  for (const fk of ['fin_allocations_ledger_book_fk', 'fin_cash_counts_ledger_book_fk', 'fin_ledger_roles_ledger_book_fk',
    'fin_hr_channels_ledger_book_fk', 'fin_hr_expense_map_ledger_book_fk']) {
    refusal(finMapDbError(fkInsert(fk)), 409, 'FIN_WRONG_BOOK');
    refusal(finMapDbError(fkDelete(fk)), 409, 'FIN_IN_USE');
  }
  // Every constraint the migration names with CONSTRAINT is among them, but the core's rule-key CHECK, which it widens under
  // its old name: that one keeps the core's answer (the app never writes a rule key, so a bad one is the fixed 500).
  const named = [...financeSql('_finance_cash_bank.sql').matchAll(/\bconstraint (fin_\w+)\s+(check|foreign key|unique)\b/gi)]
    .filter(([, name]) => name !== 'fin_approval_rules_rule_key_check');
  assert.ok(named.length >= 7, `non-vacuous: ${named.length} named constraints`);
  for (const [, name, kind] of named) {
    const raw = /^check$/i.test(kind) ? check(name) : /^unique$/i.test(kind) ? unique(name) : fkInsert(name);
    assert.notEqual(finMapDbError(raw).status, 500, `${name} has no Finance code`);
  }
});

test('foreign keys: a row pointing across books is FIN_WRONG_BOOK, a delete that would orphan a row is FIN_IN_USE', () => {
  for (const fk of ['fin_voucher_lines_ledger_book_fk', 'fin_ledgers_group_book_fk']) {
    refusal(finMapDbError(fkInsert(fk)), 409, 'FIN_WRONG_BOOK');
  }
  // fin_ledgers_group_book_fk breaks both ways: only the direction tells them apart.
  refusal(finMapDbError(fkDelete('fin_ledgers_group_book_fk')), 409, 'FIN_IN_USE');
  refusal(finMapDbError(fkDelete('fin_voucher_lines_ledger_book_fk')), 409, 'FIN_IN_USE');
  refusal(finMapDbError(fkDelete('fin_groups_parent_id_fkey')), 409, 'FIN_IN_USE');
  // The direction is also read from the detail alone, should the message be worded differently.
  refusal(finMapDbError(pg({ code: '23503', constraint: 'whatever_fkey', message: 'x', detail: 'Key (id)=(1) is still referenced from table "t".' })), 409, 'FIN_IN_USE');
});

// The central handler in app.js writes err.message to the browser. What the database says in its own words names
// columns, tables, constraints and users, so nothing it says may travel: whatever Finance has no word for leaves
// as one fixed 500, and the original goes along as `cause`, where the handler's console.error logs it.
const FIXED = { status: 500, body: { code: 'FIN_SERVER_ERROR' }, message: FIN_SENTENCES.FIN_SERVER_ERROR };
const LEAKS = /group_id|fin_[a-z]|violates|constraint|password|authentication|postgres|boom|ECONNREFUSED|timeout|Cannot read|null value|duplicate key/;
const unplanned = [
  ['a plain error', new Error('boom')],
  ['a not-null violation', pg({ code: '23502', table: 'fin_ledgers', column: 'group_id', message: 'null value in column "group_id" of relation "fin_ledgers" violates not-null constraint' })],
  ['a unique violation nobody maps', unique('fin_vouchers_number_key')],
  ['another one', unique('fin_vouchers_client_key_key')],
  ['a check nobody maps', check('fin_vouchers_posted_shape')],
  ['a draft marked reversed, which the app never writes', check('fin_vouchers_reversed_only_posted')],
  ['a reversal that is not a journal, which the app never makes', check('fin_vouchers_reversal_is_journal')],
  ['a foreign key written wrong, not across books', fkInsert('fin_vouchers_period_id_fkey')],
  ['a statement timeout', pg({ code: '57014', message: 'canceling statement due to statement timeout' })],
  ['a connection fault', pg({ code: '28P01', message: 'password authentication failed for user "postgres"' })],
  ['a system error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })],
  ['FIN_ only counts at the start of DETAIL', pg({ code: 'P0001', detail: 'Key (x)=(FIN_FOO) is not a code', message: 'not ours' })],
  ['no DETAIL at all', pg({ code: 'P0001', detail: undefined, message: 'not ours either' })],
  ['a bug in the route', new TypeError("Cannot read properties of undefined (reading 'id')")],
  ['a thrown string', 'a string'], ['a thrown number', 42], ['null', null], ['undefined', undefined],
];

test('what Finance has no word for leaves as one fixed 500, and none of the database\'s words go with it', () => {
  for (const [what, raw] of unplanned) {
    const e = finMapDbError(raw);
    assert.ok(e instanceof Error, what);
    assert.equal(e.status, FIXED.status, what);
    assert.deepEqual(e.body, FIXED.body, `${what}: the body is the code and nothing else`);
    assert.equal(e.message, FIXED.message, what);
    // what the central handler writes: { error: message, ...body }, and a copy of the error's own fields
    assert.doesNotMatch(JSON.stringify({ error: e.message, ...e.body, ...e }), LEAKS, what);
    if (raw?.message) assert.ok(!e.message.includes(raw.message), what);
    assert.equal(e.cause, raw, `${what}: the original is reachable as cause`);
  }
});

// Cash & Bank ruling R73: the HR feed's transactions wait five seconds at most for a lock (lock_timeout, transaction-local). One that
// waited longer is 55P03, and Finance's word for it is FIN_BUSY, 409, in its own sentence: the HR exception it becomes says it, and
// says to try again. A statement timeout, which nothing in Finance sets, stays the fixed 500 (above).
test('a lock timeout is FIN_BUSY, 409, in Finance\'s own words, never the database\'s', () => {
  const raw = pg({ code: '55P03', message: 'canceling statement due to lock timeout' });
  const e = finMapDbError(raw);
  assert.deepEqual([e.status, e.body, e.message], [409, { code: 'FIN_BUSY' }, FIN_SENTENCES.FIN_BUSY]);
  assert.equal(FIN_SENTENCES.FIN_BUSY, 'Finance was busy with another entry, so this one did not wait. Try it again in a moment.');
  assert.doesNotMatch(JSON.stringify({ error: e.message, ...e.body, ...e }), LEAKS);
  assert.equal(e.cause, raw);
  assert.deepEqual(finMapDbError(e), e, 'mapping twice maps once');
});

test('the three leaks reproduced in review: a not-null, an unmapped unique, a connection fault', () => {
  const notNull = finMapDbError(pg({ code: '23502', message: 'null value in column "group_id" of relation "fin_ledgers" violates not-null constraint' }));
  const unmappedUnique = finMapDbError(unique('fin_vouchers_number_key'));
  const connection = finMapDbError(pg({ code: '28P01', message: 'password authentication failed for user "postgres"' }));
  for (const e of [notNull, unmappedUnique, connection]) {
    assert.deepEqual([e.status, e.message, e.body], [500, FIN_SENTENCES.FIN_SERVER_ERROR, { code: 'FIN_SERVER_ERROR' }]);
  }
  assert.match(notNull.cause.message, /group_id/);
  assert.equal(unmappedUnique.cause.constraint, 'fin_vouchers_number_key');
  assert.match(connection.cause.message, /password authentication failed/);
});

test('only an error with an HTTP error status is a business error; any other status is just a field', () => {
  for (const status of [400, 403, 404, 409, 413, 418, 500, 503, 599]) {
    const raw = Object.assign(new Error('said on purpose'), { status });
    assert.equal(finMapDbError(raw), raw, `status ${status}`);
  }
  for (const status of ['409', NaN, Infinity, 0, 99, 200, 399, 600, 409.5, null, undefined, {}, true]) {
    const raw = Object.assign(new Error('internal detail'), { status });
    const e = finMapDbError(raw);
    assert.notEqual(e, raw, `status ${String(status)}`);
    assert.deepEqual([e.status, e.body, e.message], [FIXED.status, FIXED.body, FIXED.message], `status ${String(status)}`);
  }
});

test('a refusal that is already one passes through untouched, and mapping twice maps once', () => {
  const mine = finError(403, 'FIN_FORBIDDEN');
  assert.equal(finMapDbError(mine), mine);
  const once = finMapDbError(trigger('FIN_UNBALANCED'));
  assert.equal(finMapDbError(once), once);
  const fixed = finMapDbError(new Error('boom'));                 // the fixed 500 has a status too: it is not wrapped again
  assert.equal(finMapDbError(fixed), fixed);
  assert.equal(fixed.cause.message, 'boom');
});

test('the original error rides along as cause, and only as cause', () => {
  for (const [what, raw] of [
    ['a mapped database refusal', unique('fin_ledgers_book_code_key')],
    ['the fixed 500', unique('fin_vouchers_number_key')],
  ]) {
    const mapped = finMapDbError(raw);
    assert.equal(mapped.cause, raw, what);
    // not an enumerable field, as with the Error constructor's own `cause` option: nothing that copies or
    // serialises the error (a spread, JSON.stringify) can carry the database's words to a browser
    const descriptor = Object.getOwnPropertyDescriptor(mapped, 'cause');
    assert.ok(descriptor && descriptor.enumerable === false, what);
    assert.ok(!Object.keys(mapped).includes('cause'), what);
    assert.ok(!JSON.stringify({ ...mapped }).includes(raw.message), what);
  }
  // what console.error prints is the fixed sentence and, below it, the original in full
  const logged = inspect(finMapDbError(pg({ code: '23502', message: 'null value in column "group_id" of relation "fin_ledgers" violates not-null constraint' })));
  assert.ok(logged.includes(FIN_SENTENCES.FIN_SERVER_ERROR), 'the log carries the fixed sentence');
  assert.match(logged, /\[cause\]: Error: null value in column "group_id"/);
});

// Read by someone whose work may just have been lost, and by a login that only wanted to look something up.
// It says that something went wrong and what to do, and claims nothing about saving or about nothing being
// changed: a read has nothing to save, and a route can fail after its transaction has committed.
test('the fixed 500 says only that something went wrong and what to do', () => {
  assert.equal(FIN_SENTENCES.FIN_SERVER_ERROR, 'Something went wrong in Finance. Please try again, and tell the MD if it keeps happening.');
  assert.doesNotMatch(FIN_SENTENCES.FIN_SERVER_ERROR, /sav(e|ing)|chang|nothing/i);
});

test('FIN_SENTENCES: every code the briefs name has one plain sentence, and the table is frozen', () => {
  const named = [
    // the database's
    ...TRIGGER_CODES,
    'FIN_OPENING_EXISTS', 'FIN_ALREADY_REVERSED', 'FIN_SOURCE_POSTED', 'FIN_DUPLICATE_NAME', 'FIN_DUPLICATE_CODE', 'FIN_PARTY_LINKED',
    'FIN_BAD_LINE', 'FIN_BAD_AMOUNT', 'FIN_IN_USE',
    // the app's, 403 / 404 / 400 / 409
    'FIN_FORBIDDEN', 'FIN_NOT_MAKER', 'FIN_NOT_FOUND', 'FIN_BAD_INPUT', 'FIN_REASON_REQUIRED',
    'FIN_NO_PERIOD', 'FIN_SHAPE', 'FIN_NOT_DRAFT', 'FIN_NOT_SUBMITTED', 'FIN_NOT_POSTED', 'FIN_OWN_VOUCHER', 'FIN_CHANGED', 'FIN_EXISTS',
    'FIN_BAD_TRANSITION', 'FIN_LAST_ADMIN', 'FIN_TIE_OUT', 'FIN_DUPLICATE_KEY',
    // Cash & Bank's (its plan's Global Constraints; FIN_BAD_ALLOCATION and FIN_OVER_ALLOCATED are among the trigger codes)
    'FIN_NOT_PARTY_LINE', 'FIN_STAFF_IN_HR', 'FIN_ROLE_MISSING', 'FIN_HOLDER_NOT_CASH', 'FIN_NO_OPENING', 'FIN_UNMAPPED_CHANNEL',
    'FIN_HR_OWNED', 'FIN_DIFFERENCE_VIA_COUNT',
    // the HR feed's lock timeout (Cash & Bank ruling R73)
    'FIN_BUSY',
    // the one nobody planned for (ruling R20)
    'FIN_SERVER_ERROR',
  ];
  assert.deepEqual(Object.keys(FIN_SENTENCES).sort(), [...new Set(named)].sort());
  for (const [code, sentence] of Object.entries(FIN_SENTENCES)) {
    assert.equal(typeof sentence, 'string', code);
    assert.equal(sentence, sentence.trim(), code);
    assert.match(sentence, /^[A-Z].*[.]$/, `${code}: a sentence starts with a capital and ends with a full stop`);
  }
  assert.ok(Object.isFrozen(FIN_SENTENCES));
});

// Cash & Bank's sentences, exactly as its plan's Global Constraints give them.
test('Cash & Bank\'s nine sentences are the plan\'s, word for word', () => {
  assert.deepEqual(Object.fromEntries(['FIN_BAD_ALLOCATION', 'FIN_OVER_ALLOCATED', 'FIN_NOT_PARTY_LINE', 'FIN_STAFF_IN_HR', 'FIN_ROLE_MISSING',
    'FIN_HOLDER_NOT_CASH', 'FIN_NO_OPENING', 'FIN_UNMAPPED_CHANNEL', 'FIN_HR_OWNED'].map(code => [code, FIN_SENTENCES[code]])), {
    FIN_BAD_ALLOCATION: "That adjustment doesn't fit those entries.",
    FIN_OVER_ALLOCATED: 'That would settle more than the entry holds.',
    FIN_NOT_PARTY_LINE: "Only a posted party entry that hasn't been reversed can be adjusted.",
    FIN_STAFF_IN_HR: 'Staff advances and salaries are paid in HR.',
    FIN_ROLE_MISSING: 'Set this ledger in Finance Setup → HR & payroll first.',
    FIN_HOLDER_NOT_CASH: 'Only a Cash-in-Hand ledger can have a holder.',
    FIN_NO_OPENING: 'There is no Opening to correct yet.',
    FIN_UNMAPPED_CHANNEL: 'Map this HR pay channel to an account in Finance Setup first.',
    FIN_HR_OWNED: 'This entry comes from HR; correct it there.',
  });
  assert.equal(FIN_SENTENCES.FIN_DIFFERENCE_VIA_COUNT, 'Cash differences are cleared from a cash count: Count cash → Clear.');
  // The HR feed's wait for the inter-company pair is gone: the pair posts (Cash & Bank rulings R18, R24).
  assert.equal(Object.hasOwn(FIN_SENTENCES, 'FIN_INTERCOMPANY_PENDING'), false);
  // …and the one the database's opening-correction date rule says (the pre-review fix to migration 20261121090100).
  assert.equal(FIN_SENTENCES.FIN_BAD_CORRECTION, "An opening correction is dated the Opening's own date, the day before the books begin.");
});

// One code reads one way (the Task 2 carry-forward). Where the database says a code in general terms and
// finance-rules says it in particular (the figures, the line number), the two are the same sentence.
test('a code the rules also say reads the same way in its plain form', () => {
  const line = (debit_paise, credit_paise) => ({ debit_paise, credit_paise });
  assert.equal(FIN_SENTENCES.FIN_TOO_FEW_LINES, finBalanceProblem([]).message);
  const badLine = finBalanceProblem([line(0, 0), line(0, 0)]);
  assert.equal(badLine.code, 'FIN_BAD_LINE');
  assert.ok(badLine.message.endsWith('needs a debit or a credit amount, not both and not neither.'));
  assert.ok(FIN_SENTENCES.FIN_BAD_LINE.endsWith('needs a debit or a credit amount, not both and not neither.'));
  const unbalanced = finBalanceProblem([line(100, 0), line(0, 90)]);
  assert.equal(unbalanced.code, 'FIN_UNBALANCED');
  assert.ok(unbalanced.message.includes("don't match") && FIN_SENTENCES.FIN_UNBALANCED.includes("don't match"));
});
