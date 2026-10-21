import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIN_GROUP_TEMPLATE, FIN_SYSTEM_LEDGERS, FIN_BANK_CASH_GROUPS } from './finance-groups.js';

test('Tally template: 15 primary + Profit & Loss + 13 sub-groups (spec §6.3)', () => {
  assert.equal(FIN_GROUP_TEMPLATE.length, 29);
  assert.equal(FIN_GROUP_TEMPLATE.filter(g => !g.parent).length, 16);
  const by = new Map(FIN_GROUP_TEMPLATE.map(g => [g.name, g]));
  for (const g of FIN_GROUP_TEMPLATE) if (g.parent) {
    assert.ok(by.has(g.parent), `${g.name} → ${g.parent}`);
    assert.equal(g.nature, by.get(g.parent).nature, `${g.name} inherits nature`);
  }
  assert.deepEqual(FIN_GROUP_TEMPLATE.filter(g => g.affects_gross_profit).map(g => g.name).sort(),
    ['Direct Expenses', 'Direct Incomes', 'Purchase Accounts', 'Sales Accounts']);
  assert.equal(by.get('Sundry Debtors').parent, 'Current Assets');
  assert.equal(by.get('Bank OD A/c').parent, 'Loans (Liability)');
  assert.equal(by.get('Profit & Loss').nature, 'liability');
  for (const n of FIN_BANK_CASH_GROUPS) assert.ok(by.has(n), n);
  for (const l of FIN_SYSTEM_LEDGERS) assert.ok(by.has(l.group), l.group);
});

// ── Beyond the brief's pin: every name, spelt out once more ──────────────────────────────────

// Spec §6.3 typed out a second time as [name, parent, nature], in the order a book lists them.
// A slip in a name, a parent or a nature fails here, not in a Tally comparison three months on.
const SPEC = [
  ['Capital Account', null, 'liability'],
  ['Reserves & Surplus', 'Capital Account', 'liability'],
  ['Loans (Liability)', null, 'liability'],
  ['Bank OD A/c', 'Loans (Liability)', 'liability'],
  ['Secured Loans', 'Loans (Liability)', 'liability'],
  ['Unsecured Loans', 'Loans (Liability)', 'liability'],
  ['Current Liabilities', null, 'liability'],
  ['Duties & Taxes', 'Current Liabilities', 'liability'],
  ['Provisions', 'Current Liabilities', 'liability'],
  ['Sundry Creditors', 'Current Liabilities', 'liability'],
  ['Suspense A/c', null, 'liability'],
  ['Branch / Divisions', null, 'liability'],
  ['Fixed Assets', null, 'asset'],
  ['Investments', null, 'asset'],
  ['Current Assets', null, 'asset'],
  ['Bank Accounts', 'Current Assets', 'asset'],
  ['Cash-in-Hand', 'Current Assets', 'asset'],
  ['Deposits (Asset)', 'Current Assets', 'asset'],
  ['Loans & Advances (Asset)', 'Current Assets', 'asset'],
  ['Stock-in-Hand', 'Current Assets', 'asset'],
  ['Sundry Debtors', 'Current Assets', 'asset'],
  ['Misc. Expenses (ASSET)', null, 'asset'],
  ['Sales Accounts', null, 'income'],
  ['Direct Incomes', null, 'income'],
  ['Indirect Incomes', null, 'income'],
  ['Purchase Accounts', null, 'expense'],
  ['Direct Expenses', null, 'expense'],
  ['Indirect Expenses', null, 'expense'],
  ['Profit & Loss', null, 'liability'],
];

test('the template is the §6.3 table: names, parents and natures', () => {
  assert.deepEqual(FIN_GROUP_TEMPLATE.map(g => [g.name, g.parent, g.nature]), SPEC);
});

test('template rows are ready to insert: ordered, unique ignoring case, parents first', () => {
  // the database will hold UNIQUE (book_id, lower(name))
  assert.equal(new Set(FIN_GROUP_TEMPLATE.map(g => g.name.toLowerCase())).size, FIN_GROUP_TEMPLATE.length);
  const at = new Map(FIN_GROUP_TEMPLATE.map((g, i) => [g.name, i]));
  FIN_GROUP_TEMPLATE.forEach((g, i) => {
    assert.equal(typeof g.affects_gross_profit, 'boolean', g.name);
    assert.ok(Number.isInteger(g.sort_order), g.name);
    if (i > 0) assert.ok(g.sort_order > FIN_GROUP_TEMPLATE[i - 1].sort_order, `${g.name} sorts after the row before it`);
    // setup inserts in this order and resolves each parent to an id, so a parent must already exist
    if (g.parent) assert.ok(at.get(g.parent) < i, `${g.parent} comes before ${g.name}`);
  });
});

test('system ledgers and bank/cash families are exactly the brief, and nothing can change them', () => {
  assert.deepEqual(FIN_SYSTEM_LEDGERS, [{ name: 'Cash', group: 'Cash-in-Hand' }, { name: 'Profit & Loss A/c', group: 'Profit & Loss' }]);
  assert.deepEqual(FIN_BANK_CASH_GROUPS, ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c']);
  // Setup runs once per book in one process; a row it could write to would carry book one's ids into book two.
  for (const frozen of [FIN_GROUP_TEMPLATE, FIN_SYSTEM_LEDGERS, FIN_BANK_CASH_GROUPS]) assert.ok(Object.isFrozen(frozen));
  for (const row of [...FIN_GROUP_TEMPLATE, ...FIN_SYSTEM_LEDGERS]) assert.ok(Object.isFrozen(row), row.name);
});
