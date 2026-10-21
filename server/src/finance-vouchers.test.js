import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finCleanLines, finVoucherCan, finVoucherDate, finClientKey, finIsPartyLedger } from './finance-vouchers.js';

// The pure half of the voucher drafts (finance-vouchers.js): what a typed voucher is allowed to look like
// before it reaches the database, and who may do what to it. The writes themselves, against a real database,
// are finance-pg-vouchers.test.js (FINANCE_PG=1).

// A refusal as the screen sees it: status, code, and the field it names.
const refusal = (status, code, field) => e => {
  assert.equal(e.status, status, e.message);
  assert.equal(e.body.code, code, e.message);
  if (field !== undefined) assert.equal(e.body.field, field, e.message);
  return true;
};
const line = (ledger_id, debit_paise, credit_paise, extra = {}) => ({ ledger_id, debit_paise, credit_paise, ...extra });

// ── The lines ────────────────────────────────────────────────────────────────────────────────

test('finCleanLines: whole paise in, the same lines out, with the two sides added up in paise', () => {
  const out = finCleanLines([line(7, 500000, 0), line(8, 0, 400000, { narration: '  freight  ' }), line('9', 10, 0)]);
  assert.deepEqual(out.lines, [
    { ledger_id: 7, debit_paise: 500000, credit_paise: 0, narration: null, bill_ref: null, bill_date: null, due_date: null },
    { ledger_id: 8, debit_paise: 0, credit_paise: 400000, narration: 'freight', bill_ref: null, bill_date: null, due_date: null },
    { ledger_id: 9, debit_paise: 10, credit_paise: 0, narration: null, bill_ref: null, bill_date: null, due_date: null },
  ]);
  assert.equal(out.debit_paise, 500010);
  assert.equal(out.credit_paise, 400000);
  assert.equal(finCleanLines([line(1, 10, 0), line(2, 20, 0)]).debit_paise, 30, '10 + 20 paise is 30 paise, with no float in sight');
});

test('finCleanLines: a draft may be unbalanced, short, or empty', () => {
  assert.deepEqual(finCleanLines([]), { lines: [], debit_paise: 0, credit_paise: 0 });
  assert.equal(finCleanLines([line(1, 5, 0)]).lines.length, 1);
  assert.equal(finCleanLines([line(1, 5, 0), line(2, 0, 3)]).debit_paise, 5);
});

test('finCleanLines: a missing side is nothing, so a line may carry just the side it has', () => {
  const [a, b] = finCleanLines([{ ledger_id: 1, debit_paise: 100 }, { ledger_id: 2, credit_paise: 100, debit_paise: null }]).lines;
  assert.deepEqual([a.debit_paise, a.credit_paise, b.debit_paise, b.credit_paise], [100, 0, 0, 100]);
});

test('finCleanLines: an amount is a whole, safe, non-negative number of paise, or it is a 400 FIN_BAD_AMOUNT', () => {
  const field = i => `lines[${i}].debit_paise`;
  for (const bad of [12.5, -100, -1, 0.1, NaN, Infinity, -Infinity, '100', '', ' 5', true, [1], { v: 1 }, 1e21, 2 ** 53, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => finCleanLines([line(1, 5, 0), line(2, bad, 0)]), refusal(400, 'FIN_BAD_AMOUNT', field(1)), String(bad));
  }
  assert.throws(() => finCleanLines([line(1, 0, -5)]), refusal(400, 'FIN_BAD_AMOUNT', 'lines[0].credit_paise'));
  // JSON has no NaN or Infinity, but a body that was never JSON (a test, a script) might
  assert.throws(() => finCleanLines([line(1, 5, 0), line(2, 0, NaN)]), refusal(400, 'FIN_BAD_AMOUNT', 'lines[1].credit_paise'));
});

test('finCleanLines: the largest amount is 1 lakh crore less a paisa, as everywhere else in Finance', () => {
  const top = 1e14 - 1;
  assert.equal(finCleanLines([line(1, top, 0), line(2, 0, top)]).debit_paise, top);
  assert.throws(() => finCleanLines([line(1, 1e14, 0)]), refusal(400, 'FIN_BAD_AMOUNT', 'lines[0].debit_paise'));
});

test('finCleanLines: the lines may not add up past what a double holds exactly', () => {
  // every amount is below the ceiling, but 200 of them add up past 2^53 paise, where a paisa goes missing
  const big = Array.from({ length: 200 }, (_, i) => line(i + 1, 99_999_999_999_999, 0));
  assert.throws(() => finCleanLines(big), refusal(400, 'FIN_BAD_AMOUNT', 'lines'));
  const credits = Array.from({ length: 200 }, (_, i) => line(i + 1, 0, 99_999_999_999_999));
  assert.throws(() => finCleanLines(credits), refusal(400, 'FIN_BAD_AMOUNT', 'lines'));
  // 90 of them are well inside, and add up exactly
  const ok = finCleanLines(big.slice(0, 90));
  assert.equal(ok.debit_paise, 99_999_999_999_999 * 90);
  assert.ok(Number.isSafeInteger(ok.debit_paise));
});

test('finCleanLines: exactly one side of a line is positive, or it is a 409 FIN_BAD_LINE that names the line', () => {
  for (const bad of [line(1, 100, 100), line(1, 0, 0), { ledger_id: 1 }, { ledger_id: 1, debit_paise: null, credit_paise: null }]) {
    assert.throws(() => finCleanLines([line(5, 1, 0), bad]), e => {
      refusal(409, 'FIN_BAD_LINE')(e);
      assert.match(e.message, /^Line 2 needs a debit or a credit amount, not both and not neither\.$/);
      return true;
    }, JSON.stringify(bad));
  }
});

test('finCleanLines: a line names a ledger by a whole-number id', () => {
  for (const bad of [undefined, null, 0, -3, 1.5, '', 'abc', '1e2', 2147483648, [1], { id: 1 }]) {
    assert.throws(() => finCleanLines([line(bad, 5, 0)]), refusal(400, 'FIN_BAD_INPUT', 'lines[0].ledger_id'), String(bad));
  }
});

test('finCleanLines: at most 200 lines, a list of objects', () => {
  const many = n => Array.from({ length: n }, (_, i) => line(i + 1, 1, 0));
  assert.equal(finCleanLines(many(200)).lines.length, 200);
  assert.throws(() => finCleanLines(many(201)), refusal(400, 'FIN_BAD_INPUT', 'lines'));
  assert.equal(finCleanLines(many(5000), 5000).lines.length, 5000, 'a caller with a larger cap (the Opening voucher) names it');
  for (const bad of [null, undefined, {}, 'lines', 7, { length: 2 }]) {
    assert.throws(() => finCleanLines(bad), refusal(400, 'FIN_BAD_INPUT', 'lines'), String(bad));
  }
  for (const bad of [null, 7, 'x', [1, 2], true]) {
    assert.throws(() => finCleanLines([line(1, 1, 0), bad]), refusal(400, 'FIN_BAD_INPUT', 'lines[1]'), String(bad));
  }
});

test('finCleanLines: line text goes through the shared helper, so a NUL byte, a number or an essay is a 400', () => {
  assert.throws(() => finCleanLines([line(1, 5, 0, { narration: 'a\u0000b' })]), refusal(400, 'FIN_BAD_INPUT', 'lines[0].narration'));
  assert.throws(() => finCleanLines([line(1, 5, 0, { bill_ref: 'INV\u0000' })]), refusal(400, 'FIN_BAD_INPUT', 'lines[0].bill_ref'));
  assert.throws(() => finCleanLines([line(1, 5, 0, { narration: 42 })]), refusal(400, 'FIN_BAD_INPUT', 'lines[0].narration'));
  assert.throws(() => finCleanLines([line(1, 5, 0, { bill_ref: ['a'] })]), refusal(400, 'FIN_BAD_INPUT', 'lines[0].bill_ref'));
  assert.throws(() => finCleanLines([line(1, 5, 0, { narration: 'x'.repeat(501) })]), refusal(400, 'FIN_BAD_INPUT', 'lines[0].narration'));
  assert.throws(() => finCleanLines([line(1, 5, 0, { bill_ref: 'x'.repeat(101) })]), refusal(400, 'FIN_BAD_INPUT', 'lines[0].bill_ref'));
  const [ok] = finCleanLines([line(1, 5, 0, { narration: 'x'.repeat(500), bill_ref: ' INV-12 ' })]).lines;
  assert.equal(ok.narration.length, 500);
  assert.equal(ok.bill_ref, 'INV-12');
  assert.equal(finCleanLines([line(1, 5, 0, { narration: '   ', bill_ref: '' })]).lines[0].narration, null);
});

test('finCleanLines: bill dates are real dates, or a 400 FIN_BAD_DATE; blank is none', () => {
  const [ok] = finCleanLines([line(1, 5, 0, { bill_ref: 'INV-12', bill_date: '2027-01-05', due_date: '2027-02-04' })]).lines;
  assert.deepEqual([ok.bill_ref, ok.bill_date, ok.due_date], ['INV-12', '2027-01-05', '2027-02-04']);
  const blank = finCleanLines([line(1, 5, 0, { bill_date: '', due_date: null })]).lines[0];
  assert.deepEqual([blank.bill_date, blank.due_date], [null, null]);
  for (const bad of ['2027-02-29', '2027-1-5', '05/01/2027', 20270105, '2027-13-01', '1999-12-31', '2100-01-01', 'yesterday', true, {}]) {
    assert.throws(() => finCleanLines([line(1, 5, 0, { bill_date: bad })]), refusal(400, 'FIN_BAD_DATE', 'lines[0].bill_date'), String(bad));
    assert.throws(() => finCleanLines([line(1, 5, 0, { due_date: bad })]), refusal(400, 'FIN_BAD_DATE', 'lines[0].due_date'), String(bad));
  }
});

// ── The header ───────────────────────────────────────────────────────────────────────────────

test('finVoucherDate: a real calendar day, written YYYY-MM-DD, in 2000 to 2099', () => {
  assert.equal(finVoucherDate('2027-01-10'), '2027-01-10');
  assert.equal(finVoucherDate('2028-02-29'), '2028-02-29');
  assert.equal(finVoucherDate('2000-01-01'), '2000-01-01');
  assert.equal(finVoucherDate('2099-12-31'), '2099-12-31');
  for (const bad of ['2027-02-29', '2027-1-5', '27-01-10', '', ' 2027-01-10', '2027-01-10 ', null, undefined, 20270110, new Date(), '1999-12-31', '2100-01-01', '0000-01-01', '9999-12-31']) {
    assert.throws(() => finVoucherDate(bad), refusal(400, 'FIN_BAD_DATE', 'voucher_date'), String(bad));
  }
});

test('finClientKey: absent is none; a UUID is kept in lower case; anything else is a 400', () => {
  assert.equal(finClientKey(undefined), null);
  assert.equal(finClientKey(null), null);
  assert.equal(finClientKey('0F8FAD5B-D9CB-469F-A165-70867728950E'), '0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.equal(finClientKey('0f8fad5b-d9cb-469f-a165-70867728950e'), '0f8fad5b-d9cb-469f-a165-70867728950e');
  for (const bad of ['', 'abc', '0f8fad5b-d9cb-469f-a165-70867728950', '0f8fad5bd9cb469fa16570867728950e', '{0f8fad5b-d9cb-469f-a165-70867728950e}',
    '0f8fad5b-d9cb-469f-a165-70867728950e\u0000', 7, true, ['0f8fad5b-d9cb-469f-a165-70867728950e'], {}]) {
    assert.throws(() => finClientKey(bad), refusal(400, 'FIN_BAD_INPUT', 'client_key'), String(bad));
  }
});

// ── Who may do what to a voucher ─────────────────────────────────────────────────────────────

test('finVoucherCan: from the status, who made it, and the roles on its book', () => {
  const v = (status, extra = {}) => ({ status, created_by_id: 5, reversed_by_id: null, ...extra });
  const none = { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false };
  const can = (voucher, userId, roles) => finVoucherCan(voucher, userId, roles);

  // A draft: its maker, holding enter, edits, submits and discards it
  assert.deepEqual(can(v('draft'), 5, ['accountant']), { ...none, edit: true, submit: true, discard: true });
  assert.deepEqual(can(v('draft'), 5, ['approver']), { ...none, edit: true, submit: true, discard: true });
  // …someone else's draft is theirs: an admin may only discard it
  assert.deepEqual(can(v('draft'), 6, ['accountant']), none);
  assert.deepEqual(can(v('draft'), 6, ['approver', 'admin']), { ...none, discard: true });
  assert.deepEqual(can(v('draft'), 6, ['admin']), { ...none, discard: true });
  // …a viewer, or a maker whose grant has since shrunk to viewer, can do nothing to it
  assert.deepEqual(can(v('draft'), 5, ['viewer']), none);
  assert.deepEqual(can(v('draft'), 5, []), none);
  // A maker who is an admin may discard through either door
  assert.deepEqual(can(v('draft'), 5, ['admin']), { ...none, discard: true });

  // A submitted voucher is frozen. An approver other than its maker approves or rejects it
  assert.deepEqual(can(v('submitted'), 6, ['approver']), { ...none, approve: true, reject: true });
  assert.deepEqual(can(v('submitted'), 5, ['approver']), { ...none, reject: true }, 'nobody approves their own entry');
  assert.deepEqual(can(v('submitted'), 5, ['accountant']), none);
  assert.deepEqual(can(v('submitted'), 6, ['accountant', 'admin']), none);

  // A posted voucher is reversed, once, by anyone who may enter vouchers
  assert.deepEqual(can(v('posted'), 6, ['accountant']), { ...none, reverse: true });
  assert.deepEqual(can(v('posted'), 5, ['approver']), { ...none, reverse: true });
  assert.deepEqual(can(v('posted', { reversed_by_id: 9 }), 6, ['approver']), none, 'already reversed');
  assert.deepEqual(can(v('posted'), 6, ['viewer']), none);
  assert.deepEqual(can(v('posted'), 6, ['admin']), none);

  // A discarded voucher is the trail and nothing more
  assert.deepEqual(can(v('discarded'), 5, ['accountant', 'approver', 'admin']), none);

  // Nobody made a voucher the system made, and a missing maker is nobody's
  assert.deepEqual(can(v('draft', { created_by_id: null }), 5, ['accountant']), none);
  assert.deepEqual(can(v('draft', { created_by_id: null }), null, ['accountant']), none);
  // …and a role list that is not a list grants nothing
  assert.deepEqual(can(v('draft'), 5, undefined), none);
  assert.deepEqual(can(v('draft'), 5, 'approver'), none);
});

test('finVoucherCan: an Opening voucher or a reversal is never offered for editing, though its maker still submits or discards it (ruling R24)', () => {
  const none = { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false };
  for (const built of [{ voucher_type: 'opening' }, { voucher_type: 'journal', reversal_of_id: 9 }]) {
    const draft = { status: 'draft', created_by_id: 5, reversed_by_id: null, ...built };
    assert.deepEqual(finVoucherCan(draft, 5, ['accountant']), { ...none, submit: true, discard: true }, JSON.stringify(built));
  }
  assert.equal(finVoucherCan({ status: 'draft', created_by_id: 5, voucher_type: 'journal', reversal_of_id: null }, 5, ['accountant']).edit, true);
});

// Ruling R45: the reversal of an Opening voucher is never reversed itself (that would put the opening back in the books
// beside whatever replaced it), so nobody is offered it. A reversal of anything else is a journal like any other.
test('finVoucherCan: the reversal of an Opening voucher is never offered for reversing (ruling R45)', () => {
  const none = { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false };
  const reversal = { status: 'posted', created_by_id: 5, reversed_by_id: null, pending_reversal_id: null, reversal_of_id: 9 };
  assert.deepEqual(finVoucherCan({ ...reversal, reversal_of_type: 'opening' }, 6, ['approver']), none);
  assert.deepEqual(finVoucherCan({ ...reversal, reversal_of_type: 'journal' }, 6, ['approver']), { ...none, reverse: true });
});

test('finVoucherCan: a posted voucher with a reversal on its way (a draft, or waiting for approval) is not offered for reversing again', () => {
  const none = { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false };
  const v = { status: 'posted', created_by_id: 5, reversed_by_id: null };
  assert.deepEqual(finVoucherCan({ ...v, pending_reversal_id: 12 }, 6, ['approver']), none);
  assert.deepEqual(finVoucherCan({ ...v, pending_reversal_id: 12 }, 6, ['accountant']), none);
  assert.deepEqual(finVoucherCan({ ...v, pending_reversal_id: null }, 6, ['approver']), { ...none, reverse: true });
});

// ── Source pins: the two rules a test of behaviour can only catch when two requests happen to collide ──

// finance-vouchers.js without its comments, split into its top-level functions.
const source = readFileSync(new URL('./finance-vouchers.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
function bodyOf(name) {
  const head = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
  assert.ok(head >= 0, `${name} is not in finance-vouchers.js`);
  return source.slice(head, source.indexOf('\n}\n', head));
}

// Ruling R15. The line trigger fin_line_guard takes FOR SHARE on a line's voucher, so a write of lines that
// has not locked the voucher FOR UPDATE first can wait on another edit while holding the share lock that edit
// is waiting for: a deadlock. The concurrent-edit test in finance-pg-vouchers.test.js is the proof; this is
// the pin that holds when no two requests collide.
test('finUpdateDraft and finDiscardDraft lock the voucher FOR UPDATE before they read or write a line (ruling R15)', () => {
  for (const name of ['finUpdateDraft', 'finDiscardDraft']) {
    const body = bodyOf(name);
    const lock = body.search(/FROM fin_vouchers WHERE id = \$1 FOR UPDATE/);
    assert.ok(lock >= 0, `${name} never locks the voucher`);
    for (const touch of [/finLinesOf\(/, /DELETE FROM fin_voucher_lines/, /finInsertLines\(/, /UPDATE fin_vouchers/]) {
      const at = body.search(touch);
      assert.ok(at < 0 || lock < at, `${name} reaches ${touch} before it has locked the voucher`);
    }
  }
  // …and the first thing either does with the voucher id is take that lock
  assert.match(bodyOf('finUpdateDraft'), /const before = await oc\(`SELECT \$\{finCols\(\)\} FROM fin_vouchers WHERE id = \$1 FOR UPDATE`/);
  assert.match(bodyOf('finDiscardDraft'), /const before = await oc\(`SELECT \$\{finCols\(\)\} FROM fin_vouchers WHERE id = \$1 FOR UPDATE`/);
});

// A write runs inside the route's transaction, and the pool is one client on Vercel: a pool call made there
// waits for the client the transaction holds. So the pool's q / one are used by the functions that read and by
// nothing else in the file. The third reader, finVoucherBookOf, reads the pool through finSeenBookOf
// (finance-access.js), which answers for a Tally import in the same way.
test('only the reading functions use the pool; every write uses the transaction\'s qc and oc', () => {
  const functions = source.split(/^(?=(?:export )?(?:async )?function )/m).filter(chunk => /^(?:export )?(?:async )?function /.test(chunk));
  const usingPool = functions.filter(chunk => /\b(?:q|one)\(/.test(chunk)).map(chunk => /function (\w+)/.exec(chunk)[1]).sort();
  assert.deepEqual(usingPool, ['finListVouchers', 'finVoucherView']);
  assert.match(bodyOf('finVoucherBookOf'), /finSeenBookOf\('voucher', id, req\)/);
  const seen = functions.filter(chunk => /\bfinSeenBookOf\(/.test(chunk)).map(chunk => /function (\w+)/.exec(chunk)[1]);
  assert.deepEqual(seen, ['finVoucherBookOf'], 'and no write asks it');
  assert.ok(functions.length >= 12, `non-vacuous: only ${functions.length} functions found`);
});

// ── Party ledgers (ruling R23) ───────────────────────────────────────────────────────────────

test('finIsPartyLedger: linked to a customer or vendor, or filed under a party group; nothing else', () => {
  const kinds = new Map([[10, { is_bank_cash: false, is_party: true }], [11, { is_bank_cash: true, is_party: false }]]);
  assert.equal(finIsPartyLedger({ party_type: 'vendor', group_id: 99 }, kinds), true, 'a linked ledger, wherever it is filed');
  assert.equal(finIsPartyLedger({ party_type: 'customer', group_id: 11 }, new Map()), true);
  assert.equal(finIsPartyLedger({ party_type: null, group_id: 10 }, kinds), true, 'an unlinked ledger under Sundry Creditors, say');
  assert.equal(finIsPartyLedger({ party_type: null, group_id: 11 }, kinds), false, 'a bank is no party');
  assert.equal(finIsPartyLedger({ party_type: null, group_id: 12 }, kinds), false, 'a group the map does not know is no party group');
  assert.equal(finIsPartyLedger({ party_type: undefined, group_id: 10 }, undefined), false, 'no map, no party group');
});

// ── Source pins: the posting transaction's lock order (spec §7.4) ─────────────────────────────

// Every transaction that may post takes the number series' advisory lock BEFORE it locks a row, so two of them
// meet first at the series and never each hold a row the other waits for. The race tests prove it when two
// postings collide (Task 10); these hold when none do.
test('finVoucherCtx takes the number series\' lock before it locks the voucher, and reads the voucher again under that lock', () => {
  const body = bodyOf('finVoucherCtx');
  const lock = body.search(/await lockDocNumber\(\w+\.prefix, oc\)/);
  const row = body.search(/FROM fin_vouchers WHERE id = \$1 FOR UPDATE/);
  assert.ok(lock >= 0, 'finVoucherCtx never takes the number lock');
  assert.ok(row >= 0, 'finVoucherCtx never locks the voucher');
  assert.ok(lock < row, 'the voucher is locked before its number series');
  assert.ok(body.search(/FIN_CHANGED/) > row, 'a voucher that moved series while unlocked is refused after the lock, not before');
});

test('finPostLocked mints only after its checks, posts before it marks a reversal, and reads its month FOR SHARE', () => {
  const post = bodyOf('finPostLocked');
  const facts = bodyOf('finPostingFacts');
  assert.match(facts, /FROM fin_periods WHERE id = \$1 FOR SHARE/, 'the month is read FOR SHARE, so a month being locked waits for this posting or this for it');
  const checked = post.search(/finPostingProblem\(/);
  const mint = post.search(/nextNumber\(ctx\.prefix, 'fin_vouchers', 'number', oc\)/);
  const posted = post.search(/SET status = 'posted'/);
  const marked = post.search(/SET reversed_by_id = \$1 WHERE id = \$2 AND reversed_by_id IS NULL/);
  assert.ok(checked >= 0 && mint >= 0 && posted >= 0 && marked >= 0, 'the four steps are all there');
  assert.ok(checked < mint && mint < posted && posted < marked, 'check, mint, post, then mark the reversed entry');
  // marking sets reversed_by_id and nothing else: the database's H3 refuses any other change to a posted voucher
  assert.match(post, /UPDATE fin_vouchers SET reversed_by_id = \$1 WHERE id = \$2 AND reversed_by_id IS NULL RETURNING id/);
});

// Ruling R27. The database re-reads a posted voucher's ledgers at COMMIT (H6), so the posting holds them from its own
// check to its COMMIT. The two-client race tests in finance-pg-vouchers.test.js are the proof; this holds when none race.
test('finPostingFacts takes the lines\' ledgers FOR SHARE, in id order, and reads their flags from that locked read (ruling R27)', () => {
  const facts = bodyOf('finPostingFacts');
  const lock = facts.search(/FROM fin_ledgers WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR SHARE/);
  assert.ok(lock >= 0, 'the ledgers are not locked');
  assert.doesNotMatch(facts, /JOIN fin_ledgers/, 'no unlocked read of the ledgers beside it');
  assert.ok(facts.search(/FROM fin_periods WHERE id = \$1 FOR SHARE/) < lock, 'the month first, then the ledgers');
});

test('a rejection locks the voucher and nothing else: it takes no number lock and mints nothing', () => {
  const body = bodyOf('finRejectVoucher');
  assert.match(body, /FROM fin_vouchers WHERE id = \$1 FOR UPDATE/);
  for (const never of [/lockDocNumber\(/, /nextNumber\(/, /finVoucherCtx\(/, /finPostLocked\(/]) assert.doesNotMatch(body, never);
});

// Spec §7.4, §7.5. A reversal may post, so it takes its number series' lock before it locks the entry it reverses, and
// locks that entry before it writes anything. Two people reversing one entry then meet at the series (or, dated in two
// financial years, at the entry), and the second finds it reversed. The race tests in finance-pg-race.test.js are the
// proof; this holds when none race. The decision to post or to wait is finSubmitVoucher's, in one place.
test('finReverseVoucher locks the number series, then the entry, then writes the reversal and its lines, then submits it', () => {
  const body = bodyOf('finReverseVoucher');
  const at = {
    lock: body.search(/await lockDocNumber\(\w+\.prefix, oc\)/),
    entry: body.search(/FROM fin_vouchers WHERE id = \$1 FOR UPDATE/),
    reversal: body.search(/INSERT INTO fin_vouchers/),
    lines: body.search(/INSERT INTO fin_voucher_lines/),
    submit: body.search(/finSubmitVoucher\(qc, oc, /),
  };
  for (const [step, i] of Object.entries(at)) assert.ok(i >= 0, `finReverseVoucher has no ${step} step`);
  assert.ok(at.lock < at.entry && at.entry < at.reversal && at.reversal < at.lines && at.lines < at.submit,
    'the series, the entry FOR UPDATE, the reversal, its lines, then finSubmitVoucher');
  assert.equal(body.match(/FOR UPDATE/g).length, 1, 'one row locked here, the entry; finVoucherCtx locks the reversal');
  assert.doesNotMatch(body, /nextNumber\(|finPostLocked\(|SET status = /, 'posting is finSubmitVoucher\'s, not a copy of it');
});
