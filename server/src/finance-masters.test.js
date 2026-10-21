import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finCleanName, finIdOf, finOptionalText, finRequiredName } from './finance-masters.js';

// The pure half of the chart-of-accounts writes (finance-masters.js), and a source pin on the routes that
// call them. The writes themselves, against a real database, are finance-pg-masters.test.js (FINANCE_PG=1).

test('finCleanName: trimmed, every run of whitespace one space, capitals left alone', () => {
  assert.equal(finCleanName('  Beta   Bank '), 'Beta Bank');
  assert.equal(finCleanName('Office \t Tea\n\r\nExpenses'), 'Office Tea Expenses');
  assert.equal(finCleanName('Acme Pharma　Ltd'), 'Acme Pharma Ltd', 'a non-breaking or ideographic space is a space');
  assert.equal(finCleanName('beta BANK'), 'beta BANK');
  assert.equal(finCleanName('Loans & Advances (Asset)'), 'Loans & Advances (Asset)');
  // Not text, so not a name: the caller reads '' as "blank" and refuses it
  for (const v of [undefined, null, 42, true, ['a'], { a: 1 }, '', '   ', '\t\n']) assert.equal(finCleanName(v), '', String(v));
});

test('finIdOf: a whole number from 1 to the INTEGER ceiling, as a number or as the digits of one', () => {
  assert.equal(finIdOf(1), 1);
  assert.equal(finIdOf(2147483647), 2147483647);
  assert.equal(finIdOf('42'), 42);
  assert.equal(finIdOf('2147483647'), 2147483647);
  // Anything else is no id. The ceiling matters: a bigger number reaches Postgres as "out of range" and comes back a 500.
  for (const v of [0, -1, 1.5, NaN, Infinity, 2147483648, 99999999999, '0', '-3', '1.5', '1e2', '0x1', ' 5', '5 ', '+5', '', 'abc',
    '99999999999', '2147483648', null, undefined, true, false, [1], ['1'], { id: 1 }, 1n]) {
    assert.equal(finIdOf(v), null, String(typeof v === 'bigint' ? v : JSON.stringify(v)));
  }
});

// Ruling R22: the two text helpers are shared with the voucher fields (narration, reference, line narration,
// bill_ref). Postgres refuses a NUL byte (\u0000) in TEXT, and left alone that comes back as a 500, so both
// helpers turn it away first, as a 400 FIN_BAD_INPUT that names the field.
test('finOptionalText and finRequiredName refuse a NUL byte as a 400, and only the NUL byte', () => {
  const refused = (fn, field) => assert.throws(fn, e => e.status === 400 && e.body.code === 'FIN_BAD_INPUT' && e.body.field === field);
  refused(() => finOptionalText('rent\u0000', 'narration', 100), 'narration');
  refused(() => finOptionalText('a\u0000b', 'notes', 100), 'notes');
  refused(() => finOptionalText('\u0000', 'reference', 100), 'reference');     // a NUL is not whitespace, so this is not "blank"
  refused(() => finOptionalText('  \u0000  ', 'bill_ref', 100), 'bill_ref');
  refused(() => finRequiredName('Rent\u0000', 'A ledger'), 'name');
  refused(() => finRequiredName('\u0000', 'A group'), 'name');
  // everything else about them is as it was
  assert.equal(finOptionalText('  June rent  ', 'narration', 100), 'June rent');
  assert.equal(finOptionalText('line one\nline two\tend', 'narration', 100), 'line one\nline two\tend', 'free text may run to several lines');
  assert.equal(finOptionalText('', 'notes', 100), null);
  assert.equal(finOptionalText('   ', 'notes', 100), null);
  assert.equal(finOptionalText(null, 'notes', 100), null);
  assert.equal(finOptionalText(undefined, 'notes', 100), null);
  assert.equal(finOptionalText('undefined', 'notes', 100), null, "the words a client sends when it means nothing");
  assert.throws(() => finOptionalText(42, 'notes', 100), e => e.status === 400 && e.body.field === 'notes');
  assert.throws(() => finOptionalText('x'.repeat(101), 'notes', 100), e => e.status === 400 && e.body.field === 'notes');
  assert.equal(finOptionalText('x'.repeat(100), 'notes', 100).length, 100);
  assert.equal(finRequiredName('  Beta   Bank ', 'A ledger'), 'Beta Bank');
  assert.throws(() => finRequiredName('   ', 'A ledger'), e => e.status === 400 && e.body.field === 'name');
  assert.throws(() => finRequiredName('Bell\u0007', 'A ledger'), e => e.status === 400, 'other control characters stay refused in a name');
});

// The rule every Finance route follows (spec §8.2): it says who may, for the book it acts on, before it
// touches anything. finRequire reads through the pool, so it cannot run inside a transaction either (the pool
// is one client on Vercel, and the transaction holds it): a write route authorises FIRST, then opens its tx.
test('every finance write route authorises before it opens its transaction', () => {
  const src = readFileSync(new URL('./routes/finance.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const writes = src.split(/^(?=r\.(?:get|post|put|patch|delete)\()/m).filter(b => /^r\.(?:post|put|patch|delete)\(/.test(b));
  assert.ok(writes.length >= 7, `non-vacuous: only ${writes.length} write routes found`);
  for (const block of writes) {
    const route = block.split('\n')[0];
    const authorised = block.search(/\bfinRequire(?:Row)?\(/);
    const opened = block.search(/\btx\(/);
    assert.ok(authorised >= 0, `${route}: never asks finRequire who may do this`);
    assert.ok(opened < 0 || authorised < opened, `${route}: opens its transaction before it has asked who may`);
    assert.doesNotMatch(block, /\b(?:q|one)\(/, `${route}: reads through the pool; do it before the transaction, in a helper`);
  }
});
