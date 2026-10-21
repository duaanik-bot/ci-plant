// The Setup screens' pure half (spec §10): the tabs a login sees, the chart of accounts (what a group or a ledger row may do, the body a
// ledger form sends), the next financial year, the approval rules, the access grants, and the activity log. The components draw what
// these functions say; the source pins at the foot hold the screens to them.
//
// The browser is wherever the accountant is, and a day is a calendar day. Pinned to a zone WEST of Greenwich, so a day read through a
// Date at UTC midnight shows up as the day before and the date tests below fail on it. Must run before the first Date is built.
process.env.TZ = 'Pacific/Honolulu';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../../client/src/lib/finance/setup.js';
import { FIN_ROLES as S_FIN_ROLES, finCan } from '../../client/src/lib/finance/caps.js';
import { FIN_DEFAULT_RULES } from './finance-rules.js';
import { FIN_SENTENCES } from './finance-errors.js';

const can = roles => cap => finCan(roles, cap);

// ── The tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('six tabs, in the order of the spec, each with the capability that shows it', () => {
  assert.deepEqual(S.FIN_SETUP_TABS.map(t => [t.key, t.label, t.cap]), [
    ['chart-of-accounts', 'Chart of Accounts', 'view'],
    ['months-years', 'Months & Years', 'view'],
    ['opening-balances', 'Opening Balances', 'import'],
    ['approval-rules', 'Approval Rules', 'admin'],
    ['access', 'Access', 'admin'],
    ['activity-log', 'Activity Log', 'view'],
  ]);
  assert.ok(Object.isFrozen(S.FIN_SETUP_TABS));
});

test('a login is shown the tabs its capabilities allow and no others', () => {
  const keys = roles => S.finSetupTabs(can(roles)).map(t => t.key);
  assert.deepEqual(keys(['viewer']), ['chart-of-accounts', 'months-years', 'activity-log']);
  assert.deepEqual(keys(['approver']), ['chart-of-accounts', 'months-years', 'activity-log'], 'approving is not importing or administering');
  assert.deepEqual(keys(['accountant']), ['chart-of-accounts', 'months-years', 'opening-balances', 'activity-log']);
  assert.deepEqual(keys(['admin']), S.FIN_SETUP_TABS.map(t => t.key));
  assert.deepEqual(keys(['approver', 'admin']), S.FIN_SETUP_TABS.map(t => t.key));
  assert.deepEqual(keys([]), []);
  assert.deepEqual(S.finSetupTabs(() => false), []);
});

test('the tab a path names; a tab the login may not see is not opened, and anything else is the first', () => {
  const admin = can(['admin']);
  const viewer = can(['viewer']);
  assert.equal(S.finSetupTab('access', admin), 'access');
  assert.equal(S.finSetupTab('access/more', admin), 'access');
  assert.equal(S.finSetupTab('/activity-log', admin), 'activity-log');
  assert.equal(S.finSetupTab('access', viewer), 'chart-of-accounts', 'a viewer sent to Access lands on the first tab');
  assert.equal(S.finSetupTab('opening-balances', viewer), 'chart-of-accounts');
  for (const path of [undefined, null, '', '/', 'nonsense', 'constructor', '__proto__', 'Access']) {
    assert.equal(S.finSetupTab(path, admin), 'chart-of-accounts', String(path));
  }
  assert.equal(S.finSetupTab('access', () => false), null, 'a login that may see nothing has no tab');
});

test('a tab\'s path, and a click on the tab you are on goes nowhere', () => {
  assert.equal(S.finSetupTabPath('months-years'), '/finance/setup/months-years');
  assert.equal(S.finSetupTabMove('access', 'access'), null);
  assert.equal(S.finSetupTabMove('access', 'activity-log'), '/finance/setup/activity-log');
});

// ── The chart of accounts: groups ────────────────────────────────────────────────────────────────────────────────────

const G = (id, parent_id, name, extra = {}) => ({
  id, parent_id, name, nature: 'asset', affects_gross_profit: false, is_system: false, sort_order: id, ledger_count: 0, ...extra,
});
const groups = [
  G(1, null, 'Capital Account', { nature: 'liability', sort_order: 1, is_system: true }),
  G(2, null, 'Current Assets', { sort_order: 8, is_system: true }),
  G(3, 2, 'Bank Accounts', { sort_order: 2, is_system: true, ledger_count: 3 }),
  G(4, 2, 'Sundry Debtors', { sort_order: 3, is_system: true }),
  G(5, null, 'Indirect Expenses', { nature: 'expense', sort_order: 12, is_system: true }),
  G(6, 5, 'Admin Expenses', { nature: 'expense', sort_order: 13 }),
  G(7, 6, 'Office Costs', { nature: 'expense', sort_order: 14 }),
  G(8, null, 'Direct Expenses', { nature: 'expense', sort_order: 10, is_system: true, affects_gross_profit: true }),
  G(9, 5, 'Misc Expenses', { nature: 'expense', sort_order: 15, ledger_count: 2 }),
];

test('the groups as a picker lists them: the tree in order, each with its depth', () => {
  assert.deepEqual(S.finGroupChoices(groups).map(g => [g.id, g.name, g.depth]), [
    [1, 'Capital Account', 0], [2, 'Current Assets', 0], [3, 'Bank Accounts', 1], [4, 'Sundry Debtors', 1],
    [8, 'Direct Expenses', 0], [5, 'Indirect Expenses', 0], [6, 'Admin Expenses', 1], [7, 'Office Costs', 2], [9, 'Misc Expenses', 1]]);
  assert.deepEqual(S.finGroupChoices([]), []);
  assert.deepEqual(S.finGroupChoices(null), []);
});

test('where a group may be moved: the same nature, the same side of gross profit, never under itself or anything below it', () => {
  const targets = group => S.finGroupMoveTargets(groups, group).map(g => g.name);
  assert.deepEqual(targets(groups[6]), ['Indirect Expenses', 'Admin Expenses', 'Misc Expenses'], 'Office Costs: its own parent is among them');
  assert.deepEqual(targets(groups[5]), ['Indirect Expenses', 'Misc Expenses'], 'Admin Expenses may not go under Office Costs, which is below it, nor under itself');
  assert.deepEqual(targets(groups[8]), ['Indirect Expenses', 'Admin Expenses', 'Office Costs'], 'Misc Expenses');
  assert.ok(!targets(groups[6]).includes('Direct Expenses'), 'the other side of gross profit');
  assert.ok(!targets(groups[6]).includes('Current Assets'), 'another nature');
  assert.deepEqual(S.finGroupMoveTargets(groups, { id: 99, parent_id: 1, nature: 'liability', affects_gross_profit: false }).map(g => g.name), ['Capital Account']);
  assert.deepEqual(S.finGroupMoveTargets([], groups[6]), []);
  // a loop that is already in the data is walked once and ends
  const loop = [G(1, 2, 'A', { nature: 'asset' }), G(2, 1, 'B', { nature: 'asset' }), G(3, null, 'C', { nature: 'asset' })];
  assert.deepEqual(S.finGroupMoveTargets(loop, loop[0]).map(g => g.name), ['C']);
});

test('a group can be deleted only when it is not built in and nothing is in it', () => {
  assert.equal(S.finGroupDeletable(groups[6], groups), true, 'Office Costs: empty, nothing under it');
  assert.equal(S.finGroupDeletable(groups[5], groups), false, 'Admin Expenses has Office Costs under it');
  assert.equal(S.finGroupDeletable(groups[8], groups), false, 'Misc Expenses holds two ledgers');
  assert.equal(S.finGroupDeletable(groups[3], groups), false, 'a built-in group, empty or not');
  assert.equal(S.finGroupDeletable({ ...groups[6], is_system: true }, groups), false);
});

test('R19: what a group row offers, by capability; a built-in group is never renamed, moved or deleted', () => {
  const actions = (roles, group) => S.finGroupActions(group, groups, can(roles));
  assert.deepEqual(actions(['admin'], groups[6]), { addGroup: true, addLedger: true, edit: true, remove: true });
  assert.deepEqual(actions(['admin'], groups[2]), { addGroup: true, addLedger: true, edit: false, remove: false }, 'Bank Accounts is built in');
  assert.deepEqual(actions(['admin'], groups[5]), { addGroup: true, addLedger: true, edit: true, remove: false }, 'Admin Expenses has a group under it');
  assert.deepEqual(actions(['accountant'], groups[6]), { addGroup: false, addLedger: true, edit: false, remove: false }, 'an accountant adds ledgers and nothing else');
  assert.deepEqual(actions(['viewer'], groups[6]), { addGroup: false, addLedger: false, edit: false, remove: false });
  assert.deepEqual(actions(['approver'], groups[6]), { addGroup: false, addLedger: false, edit: false, remove: false });
  for (const g of groups.filter(x => x.is_system)) {
    const a = actions(['admin'], g);
    assert.equal(a.edit || a.remove, false, `${g.name}: built in`);
  }
});

// ── The chart of accounts: ledgers ───────────────────────────────────────────────────────────────────────────────────

const ledger = {
  id: 5, book_id: 1, group_id: 3, group_name: 'Bank Accounts', name: 'Alpha Bank', code: 'BK-1', tally_name: 'Alpha Bank (Tally)', notes: 'main account',
  party_type: null, party_id: null, party_name: null, name_differs: false, manual_entry: true, is_system: false, active: true,
};

test('a ledger form starts from the ledger as read (text as text, nothing as empty), or from nothing for a new one', () => {
  assert.deepEqual(S.finLedgerFormOf(ledger), {
    name: 'Alpha Bank', code: 'BK-1', tally_name: 'Alpha Bank (Tally)', notes: 'main account',
    group_id: 3, active: true, manual_entry: true, party_type: '', party_id: '',
  });
  assert.deepEqual(S.finLedgerFormOf({ ...ledger, code: null, tally_name: null, notes: null, party_type: 'vendor', party_id: 12, active: false, manual_entry: false }), {
    name: 'Alpha Bank', code: '', tally_name: '', notes: '', group_id: 3, active: false, manual_entry: false, party_type: 'vendor', party_id: 12,
  });
  assert.deepEqual(S.finLedgerFormOf(null), {
    name: '', code: '', tally_name: '', notes: '', group_id: null, active: true, manual_entry: true, party_type: '', party_id: '',
  });
  assert.equal(S.finLedgerFormOf(null, { group_id: 7 }).group_id, 7, 'a new ledger can start in the group it was added from');
});

test('a new ledger is sent with its book, group, text and party link; blank text is nothing and no link is two nulls', () => {
  assert.deepEqual(S.finLedgerCreateBody({
    name: '  Beta Bank ', code: ' ', tally_name: 'Beta (Tally)', notes: '', group_id: '3', active: true, manual_entry: true, party_type: '', party_id: '',
  }, 1), { book_id: 1, group_id: 3, name: 'Beta Bank', code: null, tally_name: 'Beta (Tally)', notes: null, party_type: null, party_id: null });
  assert.deepEqual(S.finLedgerCreateBody({
    name: 'Acme', code: 'D-1', tally_name: '', notes: 'x', group_id: 4, party_type: 'customer', party_id: '17',
  }, 2), { book_id: 2, group_id: 4, name: 'Acme', code: 'D-1', tally_name: null, notes: 'x', party_type: 'customer', party_id: 17 });
  // a new ledger is born active and open to typed vouchers; the body says neither
  const body = S.finLedgerCreateBody(S.finLedgerFormOf(null, { group_id: 3 }), 1);
  assert.ok(!('active' in body) && !('manual_entry' in body));
});

test('an edit: an admin sends the whole form; anyone else sends only the fields they may change, and none of the admin\'s', () => {
  const form = {
    name: 'Alpha Bank Ltd', code: '', tally_name: 'Alpha', notes: 'new note',
    group_id: '4', active: false, manual_entry: false, party_type: 'customer', party_id: '9',
  };
  assert.deepEqual(S.finLedgerEditBody(form, { isAdmin: true }), {
    name: 'Alpha Bank Ltd', code: null, tally_name: 'Alpha', notes: 'new note',
    group_id: 4, active: false, manual_entry: false, party_type: 'customer', party_id: 9,
  });
  // not an admin (final review M-7): the text, and nothing else. finUpdateLedger compares only the fields it is given, so a field
  // left out is never an admin act, and a ledger an admin changed since the form opened still takes the accountant's notes.
  assert.deepEqual(S.finLedgerEditBody(form, { isAdmin: false }), { name: 'Alpha Bank Ltd', code: null, tally_name: 'Alpha', notes: 'new note' });
  const linked = { ...ledger, party_type: 'vendor', party_id: 12, active: false, manual_entry: false };
  const tampered = { ...S.finLedgerFormOf(linked), group_id: 99, active: true, manual_entry: true, party_type: 'customer', party_id: 1 };
  for (const key of ['group_id', 'active', 'manual_entry', 'party_type', 'party_id']) {
    assert.ok(!(key in S.finLedgerEditBody(tampered, { isAdmin: false })), `${key}: whatever the form holds, a non-admin never sends it`);
  }
  // the types are the ones the server holds, or it would see a change: numbers for ids, booleans for flags
  for (const key of ['group_id', 'party_id']) assert.equal(typeof S.finLedgerEditBody(S.finLedgerFormOf(linked), { isAdmin: true })[key], 'number');
  for (const key of ['active', 'manual_entry']) assert.equal(typeof S.finLedgerEditBody(S.finLedgerFormOf(linked), { isAdmin: true })[key], 'boolean');
});

test('a form read and sent back unchanged is an edit that changes nothing, for an admin and for an accountant alike', () => {
  for (const l of [ledger, { ...ledger, party_type: 'customer', party_id: 4, party_name: 'Acme', active: false }, { ...ledger, code: null, notes: null, tally_name: null }]) {
    for (const isAdmin of [true, false]) {
      const body = S.finLedgerEditBody(S.finLedgerFormOf(l), { isAdmin });
      for (const key of ['group_id', 'active', 'manual_entry', 'party_type', 'party_id']) {
        if (isAdmin) assert.strictEqual(body[key], l[key], `${key} (admin)`);
        else assert.ok(!(key in body), `${key} (accountant): not sent`);
      }
      for (const key of ['name', 'code', 'tally_name', 'notes']) assert.strictEqual(body[key], l[key], `${key}`);
    }
  }
});

test('which fields of the ledger form can be changed: the admin\'s are the admin\'s, a built-in ledger stays put, and a new one is only given its group and link', () => {
  assert.deepEqual(S.finLedgerFields(ledger, { isAdmin: true }), { group: true, active: true, systemOnly: true, party: true });
  assert.deepEqual(S.finLedgerFields(ledger, { isAdmin: false }), { group: false, active: false, systemOnly: false, party: false });
  assert.deepEqual(S.finLedgerFields({ ...ledger, is_system: true }, { isAdmin: true }), { group: false, active: false, systemOnly: true, party: true },
    'a built-in ledger cannot be moved or switched off');
  assert.deepEqual(S.finLedgerFields(null, { isAdmin: false }), { group: true, active: false, systemOnly: false, party: true }, 'an accountant makes a ledger in a group, with its link');
  assert.deepEqual(S.finLedgerFields(null, { isAdmin: true }), { group: true, active: false, systemOnly: false, party: true });
});

test('the chips on a ledger: built in, switched off, system-only, and the amber name differs', () => {
  assert.deepEqual(S.finLedgerChips(ledger), []);
  assert.deepEqual(S.finLedgerChips({ ...ledger, name_differs: true }), [{ key: 'name-differs', label: 'Name differs', tone: 'amber' }]);
  assert.deepEqual(S.finLedgerChips({ ...ledger, is_system: true, active: false, manual_entry: false, name_differs: true }).map(c => [c.key, c.label, c.tone]), [
    ['built-in', 'Built-in', 'neutral'], ['off', 'Switched off', 'muted'], ['system-only', 'System-only', 'neutral'], ['name-differs', 'Name differs', 'amber']]);
  assert.deepEqual(S.finLedgerChips({ ...ledger, active: false }).map(c => c.label), ['Switched off']);
  assert.deepEqual(S.finLedgerChips(null), []);
});

test('the party link in words', () => {
  assert.equal(S.finPartyText(ledger), '');
  assert.equal(S.finPartyText({ ...ledger, party_type: 'customer', party_id: 1, party_name: 'Acme Pharma Ltd' }), 'Customer · Acme Pharma Ltd');
  assert.equal(S.finPartyText({ ...ledger, party_type: 'vendor', party_id: 2, party_name: 'Beta Supplies' }), 'Vendor · Beta Supplies');
  assert.equal(S.finPartyText({ ...ledger, party_type: 'vendor', party_id: 2, party_name: null }), 'Vendor · not found');
  assert.deepEqual(S.FIN_PARTY_KINDS.map(k => [k.key, k.label]), [['', 'No link'], ['customer', 'Customer'], ['vendor', 'Vendor']]);
});

test('the party picker offers the switched-on customers or vendors, and keeps the one already linked', () => {
  const parties = [
    { id: 1, name: 'Acme Pharma Ltd', city: 'Pune', gstin: '27AAAAA0000A1Z5', active: 1 },
    { id: 2, name: 'Old Co', city: null, gstin: null, active: 0 },
    { id: 3, name: 'Beta Supplies', city: 'Thane', gstin: null, active: 1 },
  ];
  const options = (kind, list, current) => S.finPartyOptions(kind, list, current).map(o => [o.value, o.label]);
  assert.deepEqual(options('customer', parties, null), [[1, 'Acme Pharma Ltd'], [3, 'Beta Supplies']]);
  assert.deepEqual(S.finPartyOptions('customer', parties, null)[0], { value: 1, label: 'Acme Pharma Ltd', hint: 'Pune', search: 'Acme Pharma Ltd Pune 27AAAAA0000A1Z5' });
  // a former customer can have a balance: the link it already has stays on offer, marked
  assert.deepEqual(options('customer', parties, { party_type: 'customer', party_id: 2, party_name: 'Old Co' }), [[1, 'Acme Pharma Ltd'], [2, 'Old Co (switched off)'], [3, 'Beta Supplies']]);
  // a link to the other kind is not this kind's business
  assert.deepEqual(options('vendor', parties, { party_type: 'customer', party_id: 2, party_name: 'Old Co' }), [[1, 'Acme Pharma Ltd'], [3, 'Beta Supplies']]);
  // the linked party is not in the list at all (it did not load, or it is gone)
  assert.deepEqual(options('customer', [], { party_type: 'customer', party_id: 9, party_name: 'Gone Ltd' }), [[9, 'Gone Ltd (not in the list)']]);
  assert.deepEqual(options('customer', [], { party_type: 'customer', party_id: 9, party_name: null }), [[9, 'Customer #9 (not in the list)']]);
  assert.deepEqual(options('', parties, null), []);
  assert.deepEqual(options('customer', null, null), []);
  assert.deepEqual(options('customer', parties, { party_type: null, party_id: null }), [[1, 'Acme Pharma Ltd'], [3, 'Beta Supplies']]);
});

// ── Months and years ─────────────────────────────────────────────────────────────────────────────────────────────────

test('the next financial year is the one after the latest, whatever order they come in', () => {
  assert.equal(S.finNextYearLabel([{ label: '2026-27' }], '2027-01-01'), '2027-28');
  assert.equal(S.finNextYearLabel([{ label: '2027-28' }, { label: '2026-27' }], '2027-01-01'), '2028-29');
  assert.equal(S.finNextYearLabel([{ label: '2025-26' }, { label: '2026-27' }, { label: '2029-30' }], null), '2030-31');
  assert.equal(S.finNextYearLabel([{ label: '2098-99' }], null), '2099-00', 'the century turns: 2099-00');
  assert.equal(S.finNextYearLabel([{ label: '2099-00' }], null), null, 'the server stops at 2099-00');
  // a book with no year yet starts with the year its books begin in
  assert.equal(S.finNextYearLabel([], '2027-01-01'), '2026-27');
  assert.equal(S.finNextYearLabel([], '2027-04-01'), '2027-28');
  assert.equal(S.finNextYearLabel(null, '2027-01-01'), '2026-27');
  assert.equal(S.finNextYearLabel([], null), null);
  assert.equal(S.finNextYearLabel([], 'not a day'), null);
  // labels that are no years are ignored, not guessed at
  assert.equal(S.finNextYearLabel([{ label: 'FY27' }, { label: '2026-27' }, {}, null], '2027-01-01'), '2027-28');
  assert.equal(S.finNextYearLabel([{ label: '2026-29' }], '2027-01-01'), '2026-27', 'a label whose second half is not the next year is no year');
});

// ── Approval rules ───────────────────────────────────────────────────────────────────────────────────────────────────

test('a rule is named for the entry it governs', () => {
  assert.equal(S.finRuleLabel('journal'), 'Journal');
  assert.equal(S.finRuleLabel('reversal'), 'Reversal');
  assert.equal(S.finRuleLabel('credit_note'), 'Credit Note');
  assert.equal(S.finRuleLabel('opening'), 'Opening');
  assert.equal(S.finRuleLabel('something_new'), 'something_new', 'a key nobody has named is shown as it came');
  assert.equal(S.finRuleLabel('constructor'), 'constructor');
});

test('a rule in words, and the form it starts from', () => {
  assert.equal(S.finRuleText({ mode: 'always', limit_paise: null }), 'Always');
  assert.equal(S.finRuleText({ mode: 'never', limit_paise: null }), 'Never');
  assert.equal(S.finRuleText({ mode: 'above_limit', limit_paise: 10000000 }), 'Above ₹1,00,000.00');
  assert.equal(S.finRuleText({ mode: 'above_limit', limit_paise: 0 }), 'Above ₹0.00');
  assert.equal(S.finRuleText({ mode: 'sometimes' }), 'sometimes');
  assert.deepEqual(S.finRuleFormOf({ mode: 'above_limit', limit_paise: 10000000 }), { mode: 'above_limit', limitText: '1,00,000.00' });
  assert.deepEqual(S.finRuleFormOf({ mode: 'above_limit', limit_paise: 0 }), { mode: 'above_limit', limitText: '0.00' });
  assert.deepEqual(S.finRuleFormOf({ mode: 'always', limit_paise: null }), { mode: 'always', limitText: '' });
  assert.deepEqual(S.FIN_RULE_MODES.map(m => m.key), ['always', 'above_limit', 'never']);
});

test('the body a rule form sends: the limit is typed in rupees and goes in paise, and only above_limit has one', () => {
  assert.deepEqual(S.finRuleBody({ mode: 'above_limit', limitText: '1,00,000' }), { ok: true, body: { mode: 'above_limit', limit_paise: 10000000 } });
  assert.deepEqual(S.finRuleBody({ mode: 'above_limit', limitText: ' 250000.50 ' }), { ok: true, body: { mode: 'above_limit', limit_paise: 25000050 } });
  assert.deepEqual(S.finRuleBody({ mode: 'above_limit', limitText: '0' }), { ok: true, body: { mode: 'above_limit', limit_paise: 0 } });
  // a limit typed beside always or never is not sent: the server refuses one
  assert.deepEqual(S.finRuleBody({ mode: 'always', limitText: '5,000' }), { ok: true, body: { mode: 'always' } });
  assert.deepEqual(S.finRuleBody({ mode: 'never', limitText: 'junk' }), { ok: true, body: { mode: 'never' } });
  // refusals say why, in the sentence money.js and the form already use
  assert.deepEqual(S.finRuleBody({ mode: 'above_limit', limitText: '' }), { ok: false, error: 'Enter the limit in rupees.' });
  assert.deepEqual(S.finRuleBody({ mode: 'above_limit', limitText: '   ' }), { ok: false, error: 'Enter the limit in rupees.' });
  for (const bad of ['12.345', '1250,50', '-5', 'ten', '1 000', '1e5', '99999999999999.00']) {
    const out = S.finRuleBody({ mode: 'above_limit', limitText: bad });
    assert.equal(out.ok, false, bad);
    assert.equal(out.error, 'Enter an amount in rupees with at most two decimals', bad);
  }
  assert.deepEqual(S.finRuleBody({ mode: 'bogus', limitText: '' }), { ok: false, error: 'Choose when an Approver is needed.' });
  assert.deepEqual(S.finRuleBody({ mode: undefined, limitText: '' }), { ok: false, error: 'Choose when an Approver is needed.' });
  assert.deepEqual(S.finRuleBody({ mode: 'constructor', limitText: '' }), { ok: false, error: 'Choose when an Approver is needed.' });
});

test('a rule form that says what the rule already says is not a change', () => {
  const rule = { mode: 'above_limit', limit_paise: 10000000 };
  assert.equal(S.finRuleChanged(rule, { mode: 'above_limit', limit_paise: 10000000 }), false);
  assert.equal(S.finRuleChanged(rule, { mode: 'above_limit', limit_paise: 10000001 }), true);
  assert.equal(S.finRuleChanged(rule, { mode: 'always' }), true);
  assert.equal(S.finRuleChanged({ mode: 'always', limit_paise: null }, { mode: 'always' }), false);
  assert.equal(S.finRuleChanged({ mode: 'never', limit_paise: null }, { mode: 'always' }), true);
});

// ── Access ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const books = [
  { id: 1, code: 'CI', name: 'Colour Impressions', roles: ['approver', 'admin'] },
  { id: 2, code: 'DP', name: 'Darbi Print Pack', roles: ['accountant'] },
  { id: 3, code: 'XX', name: 'Third Book', roles: ['admin'] },
];
const grants = [
  { id: 10, user_id: 7, user_name: 'Test Accountant', email: 'a@x.test', book_id: 1, roles: ['accountant'], can_export: true },
  { id: 11, user_id: 8, user_name: 'Test Viewer', email: 'v@x.test', book_id: 1, roles: ['viewer'], can_export: false },
];

test('the books a login may grant on are the ones it administers', () => {
  assert.deepEqual(S.finAdminBooks(books).map(b => b.code), ['CI', 'XX']);
  assert.deepEqual(S.finAdminBooks([]), []);
  assert.deepEqual(S.finAdminBooks(null), []);
  assert.deepEqual(S.finAdminBooks([{ id: 1, roles: 'admin' }]), [], 'roles that are not a list grant nothing');
});

test('the grant a login already has on a book, and the form it starts from (R31: what the grant says, or a new grant\'s defaults)', () => {
  assert.equal(S.finGrantFor(grants, 7, 1), grants[0]);
  assert.equal(S.finGrantFor(grants, '7', '1'), grants[0], 'ids as text are the same ids');
  assert.equal(S.finGrantFor(grants, 7, 2), null);
  assert.equal(S.finGrantFor(grants, 99, 1), null);
  assert.equal(S.finGrantFor(null, 7, 1), null);
  assert.deepEqual(S.finGrantFormOf(grants, 7, 1), { roles: ['accountant'], canExport: true, existing: grants[0] });
  assert.deepEqual(S.finGrantFormOf(grants, 8, 1), { roles: ['viewer'], canExport: false, existing: grants[1] }, 'an export that was switched off is shown switched off');
  assert.deepEqual(S.finGrantFormOf(grants, 7, 2), { roles: [], canExport: true, existing: null }, 'a NEW grant exports by default');
  assert.deepEqual(S.finGrantFormOf(grants, null, null), { roles: [], canExport: true, existing: null });
  const copy = S.finGrantFormOf(grants, 7, 1);
  copy.roles.push('admin');
  assert.deepEqual(grants[0].roles, ['accountant'], 'the form\'s list is its own');
});

test('R31: a grant always says whether the login may export, and the roles go in the order the server keeps them', () => {
  const body = S.finGrantBody({ userId: '7', bookId: '1', roles: ['admin', 'viewer', 'bogus', 'viewer'], canExport: false });
  assert.deepEqual(body, { user_id: 7, book_id: 1, roles: ['viewer', 'admin'], can_export: false });
  assert.deepEqual(S.finGrantBody({ userId: 7, bookId: 1, roles: ['accountant'], canExport: true }), { user_id: 7, book_id: 1, roles: ['accountant'], can_export: true });
  // whatever the form holds, the flag is there and is a boolean: an omitted flag would keep the stored value and the screen would lie
  for (const canExport of [true, false, undefined, null, 0, 1, 'yes', '']) {
    const sent = S.finGrantBody({ userId: 7, bookId: 1, roles: ['viewer'], canExport });
    assert.ok('can_export' in sent, String(canExport));
    assert.equal(typeof sent.can_export, 'boolean', String(canExport));
    assert.equal(sent.can_export, canExport === true);
  }
});

test('what a grant form still lacks', () => {
  assert.equal(S.finGrantProblem({ userId: null, bookId: 1, roles: ['viewer'] }), 'Choose a login.');
  assert.equal(S.finGrantProblem({ userId: 7, bookId: null, roles: ['viewer'] }), 'Choose a book.');
  assert.equal(S.finGrantProblem({ userId: 7, bookId: 1, roles: [] }), 'Pick at least one role.');
  assert.equal(S.finGrantProblem({ userId: 7, bookId: 1, roles: ['bogus'] }), 'Pick at least one role.');
  assert.equal(S.finGrantProblem({ userId: 7, bookId: 1, roles: ['viewer'] }), '');
});

test('R60: a grant is the login\'s own when it names the logged-in user', () => {
  const me = { user: { id: 7, name: 'Test Accountant' }, books };
  assert.equal(S.finIsOwnGrant(grants[0], me), true);
  assert.equal(S.finIsOwnGrant(grants[1], me), false);
  assert.equal(S.finIsOwnGrant({ user_id: '7' }, me), true, 'an id as text is the same id');
  assert.equal(S.finIsOwnGrant(grants[0], null), false);
  assert.equal(S.finIsOwnGrant(null, me), false);
  assert.equal(S.finIsOwnGrant({ user_id: null }, { user: { id: null } }), false, 'nobody is nobody\'s own');
});

test('M2: whether a login still administers the book it is on, from the books the shell holds', () => {
  const held = [{ id: 1, roles: ['approver', 'admin'] }, { id: 2, roles: ['accountant'] }];
  assert.equal(S.finAdministers(held, 1), true);
  assert.equal(S.finAdministers(held, '1'), true, 'an id as text is the same id');
  assert.equal(S.finAdministers(held, 2), false, 'a book it holds without admin');
  assert.equal(S.finAdministers(held, 3), false, 'a book it no longer holds');
  assert.equal(S.finAdministers([], 1), false);
  assert.equal(S.finAdministers(null, 1), false);
  assert.equal(S.finAdministers(held, null), false);
  assert.equal(S.finAdministers([{ id: 1, roles: 'admin' }], 1), false, 'roles that are not a list grant nothing');
});

test('the roles, in words, with what each one does', () => {
  assert.deepEqual(S.FIN_ROLE_CHOICES.map(r => r.key), ['viewer', 'accountant', 'approver', 'admin']);
  assert.deepEqual(S.FIN_ROLE_CHOICES.map(r => r.label), ['Viewer', 'Accountant', 'Approver', 'Admin']);
  for (const role of S.FIN_ROLE_CHOICES) assert.match(role.hint, /\S/);
  assert.equal(S.finRoleLabel('approver'), 'Approver');
  assert.equal(S.finRoleLabel('constructor'), 'constructor');
});

// ── The activity log ─────────────────────────────────────────────────────────────────────────────────────────────────

// Round 2, item 3: since ruling R71 the list has no record before and after, so the search reaches who, what, which entity and why,
// and the box says so. The rows carry the server's keys ('post', 'period'); the words they are shown in are searched too.
test('the activity search: who, what, which entity and why, in the words on the screen', () => {
  assert.equal(S.finActivitySearchText({ entity: 'period', action: 'status' }), 'Status changed Month');
  assert.equal(S.finActivitySearchText({ entity: 'voucher', action: 'reject' }), 'Sent back Voucher');
  assert.equal(S.finActivitySearchText({ entity: 'rule', action: 'edit' }), 'Changed Approval rule');
  assert.equal(S.finActivitySearchText({ entity: 'mystery', action: 'poke' }), 'poke mystery', 'a word nobody named is searched as it came');
  const log = SOURCES.activity;
  assert.match(log, /searchPlaceholder="Search by person, change, entity or reason…"/);
  assert.match(log, /rows\.filter\(r => rowMatches\(r, query, finActivitySearchText\(r\)\)\)/);
});

test('the activity read: the book and the period always, the person and the kind only when chosen', () => {
  const path = S.finActivityUrl({ bookId: 1, from: '2026-04-01', to: '2026-10-18', user: '', entity: '' });
  assert.equal(path, '/finance/activity?book=1&from=2026-04-01&to=2026-10-18');
  const url = new URL(S.finActivityUrl({ bookId: 2, from: '2026-04-01', to: '2026-10-18', user: ' Test MD ', entity: 'ledger' }), 'http://x');
  assert.equal(url.pathname, '/finance/activity');
  assert.deepEqual([...url.searchParams], [['book', '2'], ['from', '2026-04-01'], ['to', '2026-10-18'], ['user', 'Test MD'], ['entity', 'ledger']]);
  assert.ok(!S.finActivityUrl({ bookId: 1, from: 'a', to: 'b', user: '   ' }).includes('user='), 'a name of spaces is no name');
});

test('the log is cut at the newest 500, and says so when it may have been', () => {
  assert.equal(S.FIN_ACTIVITY_CAP, 500);
  assert.equal(S.finActivityCut(Array(499).fill({})), false);
  assert.equal(S.finActivityCut(Array(500).fill({})), true);
  assert.equal(S.finActivityCut([]), false);
  assert.equal(S.finActivityCut(null), false);
  assert.match(S.FIN_ACTIVITY_CUT_NOTE, /newest 500/);
});

test('the kinds of thing the log records, and what was done to them, in words', () => {
  assert.deepEqual(S.FIN_ENTITY_CHOICES.map(c => c.key), ['voucher', 'ledger', 'group', 'period', 'rule', 'access', 'import', 'year', 'book']);
  assert.equal(S.finEntityLabel('period'), 'Month');
  assert.equal(S.finEntityLabel('rule'), 'Approval rule');
  assert.equal(S.finEntityLabel('constructor'), 'constructor');
  assert.equal(S.finActionLabel('voucher', 'create'), 'Draft made');
  assert.equal(S.finActionLabel('voucher', 'submit'), 'Sent for approval');
  assert.equal(S.finActionLabel('voucher', 'reject'), 'Sent back');
  assert.equal(S.finActionLabel('voucher', 'reverse'), 'Reversal entered');
  assert.equal(S.finActionLabel('ledger', 'create'), 'Added');
  assert.equal(S.finActionLabel('group', 'delete'), 'Deleted');
  assert.equal(S.finActionLabel('period', 'status'), 'Status changed');
  assert.equal(S.finActionLabel('access', 'grant'), 'Access given or changed');
  assert.equal(S.finActionLabel('access', 'revoke'), 'Access taken away');
  assert.equal(S.finActionLabel('import', 'build'), 'Opening voucher built');
  assert.equal(S.finActionLabel('anything', 'frobnicate'), 'frobnicate', 'an action nobody has named is shown as it came');
  assert.equal(S.finActionLabel('voucher', 'constructor'), 'constructor');
});

test('when it happened: the browser\'s own day and the time, to the minute', () => {
  // 09:45 UTC is 23:45 the day before in Honolulu, which is where this file runs
  assert.equal(S.finWhenText('2026-10-18T09:45:12.000Z'), '17 Oct 2026, 23:45');
  assert.equal(S.finWhenText('2026-10-18T20:05:00.000Z'), '18 Oct 2026, 10:05');
  assert.equal(S.finWhenText(null), '—');
  assert.equal(S.finWhenText(''), '—');
  assert.equal(S.finWhenText('not a time'), '—');
});

test('the thing a log row is about, from what was recorded about it', () => {
  const row = (entity, entity_id, before, after) => ({ entity, entity_id, before, after });
  assert.equal(S.finActivityTarget(row('ledger', 5, null, { name: 'Alpha Bank' })), 'Alpha Bank');
  assert.equal(S.finActivityTarget(row('ledger', 5, { name: 'Old' }, { name: 'New' })), 'New', 'after, else before');
  assert.equal(S.finActivityTarget(row('group', 3, { name: 'Gone Group' }, null)), 'Gone Group');
  assert.equal(S.finActivityTarget(row('period', 9, { label: 'Feb 2027', status: 'open' }, { label: 'Feb 2027', status: 'closing' })), 'Feb 2027');
  assert.equal(S.finActivityTarget(row('year', 2, null, { label: '2027-28' })), '2027-28');
  assert.equal(S.finActivityTarget(row('voucher', 12, null, { number: 'CI-JV-2627-0003' })), 'CI-JV-2627-0003');
  assert.equal(S.finActivityTarget(row('voucher', 12, null, { number: null, status: 'draft' })), 'Draft #12');
  assert.equal(S.finActivityTarget(row('rule', 4, { rule_key: 'payment' }, { rule_key: 'payment' })), 'Payment');
  assert.equal(S.finActivityTarget(row('access', 4, null, { user_name: 'Test MD' })), 'Test MD');
  assert.equal(S.finActivityTarget(row('book', 1, null, { name: 'Colour Impressions' })), 'Colour Impressions');
  assert.equal(S.finActivityTarget(row('import', 6, null, { purpose: 'opening' })), '#6');
  assert.equal(S.finActivityTarget(row('ledger', 5, null, null)), '#5');
  assert.equal(S.finActivityTarget({ entity: 'ledger', entity_id: null, before: null, after: null }), '');
  assert.equal(S.finActivityTarget(null), '');
});

test('what was recorded before and after, pretty-printed for the side-by-side view', () => {
  assert.equal(S.finJsonText({ name: 'A', n: [1, 2] }), '{\n  "name": "A",\n  "n": [\n    1,\n    2\n  ]\n}');
  assert.equal(S.finJsonText(null), '');
  assert.equal(S.finJsonText(undefined), '');
  assert.equal(S.finJsonText(0), '0');
  assert.equal(S.finJsonText('text'), '"text"');
  const loop = {}; loop.self = loop;
  assert.equal(S.finJsonText(loop), '[could not be shown]', 'a value JSON cannot hold is said, not thrown');
});

// ── A list that has not come ─────────────────────────────────────────────────────────────────────────────────────────

test('what an empty Setup table says: loading, could not load, or what there really is none of', () => {
  assert.equal(S.finSetupEmpty({ known: true, failed: false, none: 'No rules.' }), 'No rules.');
  assert.equal(S.finSetupEmpty({ known: true, failed: true, none: 'No rules.' }), 'No rules.', 'older rows are on screen and the notice above says they are old');
  assert.equal(S.finSetupEmpty({ known: false, failed: true, none: 'No rules.' }), 'The list couldn’t load');
  assert.equal(S.finSetupEmpty({ known: false, failed: false, none: 'No rules.' }), 'Loading…');
  assert.equal(S.finSetupEmpty({ known: false, failed: false, none: 'No rules.', blocked: 'Choose a period that ends after it starts.' }),
    'Choose a period that ends after it starts.', 'a read that is not being asked for is neither loading nor failed');
  assert.equal(S.finSetupEmpty({ known: false, failed: true, none: 'x', blocked: 'Choose a period.' }), 'Choose a period.');
  assert.equal(S.finSetupEmpty({ known: true, none: 'x', blocked: 'Choose a period.' }), 'x');
});

// ── Where a refusal is said ──────────────────────────────────────────────────────────────────────────────────────────

test('a refusal belongs under the field it names, or under the field its code is about where the database said it', () => {
  const refusal = (data, status = 409) => Object.assign(new Error('x'), { status, data });
  assert.equal(S.finProblemField(refusal({ code: 'FIN_BAD_INPUT', field: 'name' }, 400)), 'name', 'the app names its field');
  assert.equal(S.finProblemField(refusal({ code: 'FIN_DUPLICATE_NAME' })), 'name', 'a name that is taken (a ledger or a group)');
  assert.equal(S.finProblemField(refusal({ code: 'FIN_DUPLICATE_CODE' })), 'code');
  assert.equal(S.finProblemField(refusal({ code: 'FIN_PARTY_LINKED' })), 'party_id', 'a customer or vendor already linked to another ledger');
  assert.equal(S.finProblemField(refusal({ code: 'FIN_DUPLICATE_NAME', field: 'tally_name' })), 'tally_name', 'the field the server names wins');
  // nothing to hang it on: the form says it at the foot
  for (const data of [{ code: 'FIN_LAST_ADMIN' }, { code: 'FIN_IN_USE' }, { code: 'constructor' }, { code: 'toString' }, {}, undefined, null]) {
    assert.equal(S.finProblemField(refusal(data)), null, JSON.stringify(data));
  }
  assert.equal(S.finProblemField(null), null);
  assert.equal(S.finProblemField(new Error('no answer at all')), null);
  // and every code it maps is one the server has a sentence for
  for (const code of Object.keys(S.FIN_CODE_FIELDS)) assert.ok(Object.prototype.hasOwnProperty.call(FIN_SENTENCES, code), code);
});

// ── The screens are held to these ────────────────────────────────────────────────────────────────────────────────────

// Source pins read the files with comments stripped, so a sentence in a comment never satisfies one.
const code = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const FILES = {
  setupLib: '../../client/src/lib/finance/setup.js',
  page: '../../client/src/pages/finance/Setup.jsx',
  chart: '../../client/src/components/finance/ChartOfAccounts.jsx',
  ledgerForm: '../../client/src/components/finance/LedgerForm.jsx',
  groupForm: '../../client/src/components/finance/GroupForm.jsx',
  formWrite: '../../client/src/components/finance/useFormWrite.js',
  months: '../../client/src/components/finance/MonthsYears.jsx',
  rules: '../../client/src/components/finance/ApprovalRules.jsx',
  access: '../../client/src/components/finance/FinanceAccess.jsx',
  activity: '../../client/src/components/finance/ActivityLog.jsx',
};

test('the pins read real files: every Setup source exists and says something', () => {
  for (const [name, file] of Object.entries(FILES)) assert.ok(code(file).trim().length > 200, `${name}: ${file}`);
});

const SOURCES = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, code(file)]));
const components = ['chart', 'ledgerForm', 'groupForm', 'months', 'rules', 'access', 'activity'];
const serverCode = f => code(`./${f}`);

test('Setup never touches the browser\'s storage, the exporter, the chat, or Object.hasOwn, and draws its overlays only through the shared ones', () => {
  for (const name of ['setupLib', 'page', ...components]) {
    const src = SOURCES[name];
    assert.doesNotMatch(src, /\b(?:localStorage|sessionStorage)\b/, `${name}: storage goes through safeStorage, and Setup needs none`);
    assert.doesNotMatch(src, /import[^;]*(?:lib\/exporter|exceljs|Chat\.jsx)/, `${name}: the exporter and the chat are never loaded up front`);
    assert.doesNotMatch(src, /Object\.hasOwn\s*\(/, `${name}: the browser baseline predates it`);
    assert.doesNotMatch(src, /createPortal|position:\s*['"]?fixed|\bfixed\s+inset/, `${name}: every overlay is a Modal, a ConfirmDialog or an ActionMenu, which carry the marker`);
  }
});

test('the pure file imports only the Finance modules next to it and dayOf, and the screens take their rules from it', () => {
  const imports = [...SOURCES.setupLib.matchAll(/^import [^;]* from '([^']+)';/gm)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['../dayOf.js', './book.js', './caps.js', './fy.js', './money.js', './tb.js', './voucher.js']);
  for (const name of components) assert.match(SOURCES[name], /from '\.\.\/\.\.\/lib\/finance\/setup\.js'/, `${name} reads its rules from setup.js`);
});

test('no write button forgets to hand back its promise: no braced onClick calls a write, and every write sits in a handler that says so when nothing answered', () => {
  for (const name of components) {
    const src = SOURCES[name];
    for (const m of src.matchAll(/onClick=\{\(\) => \{[^}]*\}\}/g)) {
      assert.doesNotMatch(m[0], /\b(?:api\.|attempt\(|save\(|revoke\(|moveMonth\(|addYear\(|removeGroup\()/, `${name}: ${m[0]}`);
    }
    if (/api\.(?:post|put|del)\(/.test(src)) {
      assert.match(src, /useFormWrite|useNoAnswer/, `${name}: a write that gets no answer is said`);
    }
  }
  // the writes that are made in a try/catch of the screen's own say so, reload, and let the failure through
  for (const name of ['chart', 'months', 'access']) {
    assert.match(SOURCES[name], /noAnswer\(e\)/, name);
    assert.match(SOURCES[name], /await reload\(\)/, `${name}: and show the truth`);
  }
  // the forms save through the one hook: the write's promise comes back to the Button
  for (const name of ['ledgerForm', 'groupForm', 'rules']) {
    assert.match(SOURCES[name], /await attempt\(/, name);
    assert.match(SOURCES[name], /<Button onClick=\{save\} disabled=\{!ready\}>/, `${name}: Save is the shared Button, held while the write runs`);
  }
  assert.match(SOURCES.access, /<Button onClick=\{save\} disabled=\{problem !== ''\}>/);
});

test('useFormWrite: a refusal is said under its field or at the form\'s foot, a write with no answer is said, the list is reloaded, and the answer is whether it went through', () => {
  const hook = SOURCES.formWrite;
  assert.match(hook, /const attempt = useCallback\(async \(write, \{ onFail \} = \{\}\) => \{/);
  assert.match(hook, /await write\(\);\s*return true;/);
  assert.match(hook, /\} catch \(e\) \{\s*noAnswer\(e\);/, 'a dropped connection is said, as everywhere in Finance');
  assert.match(hook, /const field = finProblemField\(e\);\s*if \(field\) setProblems\(\{ \[field\]: e\.message \}\);/);
  assert.match(hook, /else if \(Number\.isInteger\(e\?\.status\)\) setProblems\(\{ form: e\.message \}\);/);
  assert.match(hook, /try \{ await onFail\?\.\(\); \} catch/, 'the list behind the form shows the truth');
  assert.match(hook, /return false;\s*\}\s*\}, \[noAnswer\]\);/);
  assert.doesNotMatch(hook, /\.(?:post|put|del)\(/, 'it sends nothing itself and never retries');
  assert.match(hook, /return \{ problems, attempt \};/, 'and offers exactly what the forms use');
  // and every form shows what it is told, at the foot
  for (const name of ['ledgerForm', 'groupForm', 'rules', 'access']) assert.match(SOURCES[name], /<FieldError>\{problems\.form\}<\/FieldError>/, name);
});

test('every read goes through useReport: the newest answer for the very request, refreshed when a Finance table changes, a failure said with a Retry', () => {
  for (const name of ['chart', 'months', 'rules', 'access', 'activity']) {
    assert.match(SOURCES[name], /useReport\(/, name);
    assert.match(SOURCES[name], /<LoadNotice failed=\{/, `${name}: a read that failed is not drawn as an empty list`);
    // The one read that is not a report's: an activity row's record, opened, read once (ruling R71). An audit row never changes, so a
    // realtime tick has nothing to ask it again for, and the record of a large opening is not one to fetch on every tick.
    const reads = [...SOURCES[name].matchAll(/api\.get\(([^)]*)\)/g)].map(m => m[1]);
    assert.deepEqual(reads, name === 'activity' ? ['`/finance/activity/${row.id}`'] : [], `${name}: it reads through useReport and nowhere else`);
  }
  assert.equal((SOURCES.chart.match(/useReport\(/g) || []).length, 3, 'the closings, the groups and the ledgers');
  assert.match(SOURCES.chart, /LoadNotice failed=\{failed\} shown=\{known\}/);
});

test('every Setup table says "couldn\'t load" in the Setup words, never a report\'s', () => {
  for (const name of ['chart', 'rules', 'access', 'activity']) {
    assert.match(SOURCES[name], /empty=\{finSetupEmpty\(/, name);
    assert.doesNotMatch(SOURCES[name], /finReportEmpty/, `${name}: a report's wording is for the reports`);
  }
});

test('M1: a search that empties a table says nothing matched, never that nothing was recorded: the screen holds the search, and the empty line knows when the search emptied the table', () => {
  for (const [name, noun] of [['chart', 'groups or ledgers'], ['access', 'grants'], ['activity', 'changes']]) {
    const src = SOURCES[name];
    assert.doesNotMatch(src, /\bsearchable\b/, `${name}: the table's own search box prints the screen's "none" for a search that found nothing`);
    assert.match(src, /const \[search, setSearch\] = useState\(''\);\s*const query = useDeferredValue\(search\);/, `${name}: the box shows what is typed at once, the filter reads the deferred copy`);
    // the activity log also searches the words its rows are shown in (finActivitySearchText): its rows carry the server's keys
    const matched = name === 'activity' ? 'rowMatches\\(r, query, finActivitySearchText\\(r\\)\\)' : 'rowMatches\\(r, query\\)';
    assert.match(src, new RegExp(`const shown = useMemo\\(\\(\\) => \\(query\\.trim\\(\\) \\? rows\\.filter\\(r => ${matched}\\) : rows\\), \\[rows, query\\]\\);`), name);
    assert.match(src, /<DataTable rows=\{shown\}/, `${name}: the table is given the rows that matched`);
    assert.match(src, /searchValue=\{search\} onSearchChange=\{setSearch\}/, `${name}: controlled`);
    assert.match(src, new RegExp(`finSearchEmpty\\(\\{\\s*searching: query\\.trim\\(\\) !== '',\\s*total: rows\\.length,\\s*none: [^]*?noun: '${noun}',?\\s*\\}\\)`), `${name}: says "No ${noun} match this search."`);
    assert.match(src, /import \{[^}]*\browMatches\b[^}]*\} from '\.\.\/ui\.jsx';/, name);
    assert.match(src, /import \{ finSearchEmpty \} from '\.\.\/\.\.\/lib\/finance\/page\.js';/, `${name}: Task 16's one helper, not a sentence of its own`);
  }
  // the three nones are what is true when nothing was searched for
  assert.match(SOURCES.chart, /none: 'This book has no groups yet\.'/);
  assert.match(SOURCES.access, /none: 'No one has access to these books yet\.'/);
  assert.match(SOURCES.activity, /none: filtered \? 'No changes match these filters\.' : 'No changes were recorded in this period\.'/);
});

test('Setup page: the tabs come from the capabilities, a click on the tab you are on goes nowhere, and the log\'s period is the Reports page\'s, held in the URL', () => {
  const page = SOURCES.page;
  assert.match(page, /const tabs = finSetupTabs\(can\);/);
  assert.match(page, /const tab = finSetupTab\(useParams\(\)\['\*'\], can\);/);
  assert.match(page, /<Tabs tabs=\{tabs\} active=\{tab\} onChange=\{goTab\} \/>/);
  assert.match(page, /const path = finSetupTabMove\(tab, key\);\s*if \(path\) navigate\(path\);/);
  assert.match(page, /finReportRange\(query, dayOf\(new Date\(\)\), book\.books_begin\)/, 'the same default period as the reports (R58), read in the browser\'s own day');
  assert.match(page, /setQuery\(previous => finQueryWith\(previous, updates\), \{ replace: true \}\)/);
  assert.doesNotMatch(page, /new URLSearchParams|toISOString/, 'no query string or date of its own');
  for (const tab of ['chart-of-accounts', 'months-years', 'opening-balances', 'approval-rules', 'access', 'activity-log']) {
    assert.match(page, new RegExp(`tab === '${tab}'`), tab);
  }
  assert.match(page, /<FinanceAccess me=\{me\} book=\{book\} reloadMe=\{reloadMe\} \/>/, 'Access is given the means to refresh the shell (R60)');
  assert.match(page, /export default function Setup\(\{ me, book, can, reloadMe \}\)/);
  // Task 18: the Opening Balances tab is the wizard, no longer a sentence that says it is coming
  assert.match(page, /import OpeningBalances from '\.\/OpeningBalances\.jsx';/);
  assert.match(page, /\{tab === 'opening-balances' && <OpeningBalances me=\{me\} book=\{book\} can=\{can\} \/>\}/);
  assert.doesNotMatch(page, /That import is added in the next step/);
});

test('Chart of Accounts: the trial balance as at today with every group open, the closings from it, and only what the login may do', () => {
  const chart = SOURCES.chart;
  assert.match(chart, /trial-balance\?\$\{new URLSearchParams\(\{ book: String\(book\.id\), to: today, all: '1' \}\)\}/, 'as at today, with the ledgers that have no figures');
  assert.match(chart, /const today = dayOf\(new Date\(\)\);/);
  assert.match(chart, /finTbRows\(tb, finTbExpandable\(tb\), \{ hideEmpty: false \}\)/, 'both groups and ledgers, everything open, nothing hidden');
  assert.match(chart, /ledgers\?include_inactive=1/, 'a switched-off ledger is on the chart');
  assert.match(chart, /finTbCells\(r, r\.kind === 'group' && holding\.has\(r\.id\)\)/, 'the closing is the Trial Balance\'s own cell');
  assert.match(chart, /const columns = finUnsorted\(\[/, 'the tree keeps its own order');
  // capabilities
  assert.match(chart, /can\('admin'\) && <Button variant="secondary" disabled=\{!known\} onClick=\{\(\) => setGroupForm\(\{\}\)\}>/, 'Add group is the admin\'s, and waits for the groups it picks from');
  assert.match(chart, /can\('ledger'\) && <Button disabled=\{!known\} onClick=\{\(\) => setLedgerForm\(\{\}\)\}>/, 'Add ledger is the ledger capability\'s, and waits for the groups');
  assert.match(chart, /if \(!tb \|\| !groups \|\| !ledgers\) return \[\];/, 'a chart is drawn only once all three reads have answered: half of one looks whole and has no buttons');
  assert.match(chart, /if \(!r\.ledger \|\| !can\('ledger'\)\) return null;/, 'Edit ledger is the ledger capability\'s');
  assert.match(chart, /finGroupActions\(r\.group, groups, can\)/, 'a group row offers what finGroupActions says');
  assert.match(chart, /allowed\.edit && \{ key: 'edit-group'/);
  assert.match(chart, /allowed\.remove && \{ key: 'delete-group'/);
  assert.doesNotMatch(chart, /is_system/, 'R19: whether a group may be renamed or moved is finGroupActions\'s answer, never a check of the screen\'s own');
  // the chips, and the dimmed switched-off row
  assert.match(chart, /finLedgerChips\(r\.ledger\)/);
  assert.match(chart, /r\.ledger\?\.active === false \? 'opacity-60'/);
  assert.match(chart, /finPartyText\(r\.ledger\)/);
  // a delete
  assert.match(chart, /api\.del\(`\/finance\/groups\/\$\{group\.id\}`\)/);
  assert.match(chart, /toast\.success\('Group deleted'\);\s*await reload\(\);/, 'and the chart shows the group gone');
  assert.match(chart, /if \(e\?\.status === 403 \|\| e\?\.status === 404\) return;/, 'a group already deleted by someone else: the reload shows it gone and the dialog closes');
  assert.match(chart, /<ConfirmDialog open=\{deleting != null\}[\s\S]*?\bdanger\b/);
});

test('Group form: a move offers only the places the server allows, and an edit never reaches a built-in group', () => {
  const form = SOURCES.groupForm;
  assert.match(form, /group \? finGroupMoveTargets\(groups, group\) : finGroupChoices\(groups\)/);
  assert.match(form, /api\.put\(`\/finance\/groups\/\$\{group\.id\}`, body\)/);
  assert.match(form, /api\.post\('\/finance\/groups', \{ book_id: book\.id, \.\.\.body \}\)/);
  assert.match(form, /parent_id: Number\(parent\)/, 'the id goes as a number');
  assert.match(form, /const changed = !group \|\| name\.trim\(\) !== group\.name \|\| Number\(parent\) !== group\.parent_id;/);
  assert.match(form, /const ready = name\.trim\(\) !== '' && parent != null && parent !== '' && changed;/, 'Save waits for a name, a place and a change');
  assert.doesNotMatch(form, /is_system/, 'the chart never opens this form on a built-in group (finGroupActions)');
  assert.match(form, /maxLength=\{255\}/);
});

test('Ledger form: what a login cannot change is shown as text, and an edit goes through finLedgerEditBody with the login\'s own right to change it', () => {
  const form = SOURCES.ledgerForm;
  assert.match(form, /const fields = finLedgerFields\(ledger, \{ isAdmin \}\);/);
  // M-7: the edit is the form as finLedgerEditBody makes it for this login (a non-admin's has none of the admin-only fields), sent as
  // it is: no second read of the book's ledgers at save time, and no race between that read and the save
  assert.match(form, /return api\.put\(`\/finance\/ledgers\/\$\{ledger\.id\}`, finLedgerEditBody\(form, \{ isAdmin \}\)\);/);
  assert.doesNotMatch(form, /api\.get\(/, 'the form reads nothing of its own to save');
  assert.doesNotMatch(form, /currentLedger|finFreshLedger/);
  assert.match(form, /api\.post\('\/finance\/ledgers', finLedgerCreateBody\(form, book\.id\)\)/);
  for (const field of ['group', 'party', 'active', 'systemOnly']) assert.match(form, new RegExp(`fields\\.${field}\\b`), `${field} is drawn as a control only when the login may change it`);
  assert.match(form, /Only an Admin can change these/);
  assert.match(form, /checked=\{!form\.manual_entry\}/, 'system-only is manual_entry off');
  assert.match(form, /const linkMissing = fields\.party && form\.party_type !== '' && form\.party_id === '';/);
  assert.match(form, /const ready = form\.name\.trim\(\) !== '' && form\.group_id != null && form\.group_id !== '' && !linkMissing;/, 'Save waits for a name, a group, and a party where a link was chosen');
  assert.match(form, /useParties\(fields\.party \? form\.party_type : ''\)/, 'the customers and vendors are read only when the party link is being edited and a kind is chosen');
  assert.match(form, /import useParties from '\.\/useParties\.js';/, 'by the one hook the Opening Match step also uses (finance-opening-ui.test.js holds its source)');
  assert.doesNotMatch(form, /function useParties|api\.get\(kind ===/, 'no copy of it here');
  assert.match(form, /<LoadNotice failed=\{parties\.failed\}/, 'a party list that did not load is not a list of none');
  assert.match(form, /ledger\?\.name_differs|ledger\.name_differs/, 'the amber note');
  // the lengths the server takes
  const master = serverCode('finance-masters.js');
  const max = name => Number(new RegExp(`const FIN_${name}_MAX = ([\\d_]+);`).exec(master)?.[1].replace(/_/g, ''));
  assert.deepEqual([max('NAME'), max('CODE'), max('NOTES')], [255, 50, 2000], 'non-vacuous: the server\'s own limits');
  assert.match(form, new RegExp(`label="Code">\\s*<Input value=\\{form\\.code\\} maxLength=\\{${max('CODE')}\\}`));
  assert.match(form, new RegExp(`<Textarea value=\\{form\\.notes\\} maxLength=\\{${max('NOTES')}\\}`));
  assert.match(form, new RegExp(`<Input autoFocus value=\\{form\\.name\\} maxLength=\\{${max('NAME')}\\}`));
});

test('Months & Years: the buttons are the table\'s moves for an Approver, a reason is asked where the table says, and adding a year is the admin\'s', () => {
  const months = SOURCES.months;
  assert.match(months, /const mayMove = can\('approve'\);/);
  assert.match(months, /const moves = mayMove \? finPeriodMoves\(month\.status\) : \[\];/);
  assert.match(months, /finPeriodMoveLabel\(month\.status, m\.to\)/);
  assert.match(months, /\{move\?\.reason && \(\s*<ReasonDialog/, 'a move that needs a reason asks for one');
  assert.match(months, /<ConfirmDialog open=\{Boolean\(move\) && !move\.reason\}/, 'and the others ask to be sure');
  assert.match(months, /api\.put\(`\/finance\/periods\/\$\{month\.id\}\/status`, \{ status: to, \.\.\.\(reason \? \{ reason \} : \{\}\) \}\)/);
  assert.match(months, /can\('admin'\) && nextLabel &&/);
  assert.match(months, /const nextLabel = years \? finNextYearLabel\(years, book\.books_begin\) : null;/);
  assert.match(months, /api\.post\('\/finance\/years', \{ book_id: book\.id, label: nextLabel \}\)/);
  // M4: a year another admin has just added (FIN_EXISTS) closes the dialog BEFORE the grid reloads: the reload moves nextLabel on, and the
  // dialog left open would be asking about the year after
  assert.match(months, /const exists = e\?\.data\?\.code === 'FIN_EXISTS';\s*if \(exists\) setAdding\(false\);\s*await reload\(\);\s*if \(exists\) return;\s*throw e;/);
  assert.match(months, /toast\.success\(`Financial year \$\{nextLabel\} added`\);\s*setAdding\(false\);\s*await reload\(\);/, 'and so does a year added by this press');
  assert.doesNotMatch(months, /failedWrite/, 'the helper that rethrew every failure had one user left, and it was this one');
  assert.match(months, /b\.start_date\.localeCompare\(a\.start_date\)/, 'the newest year first');
  assert.match(months, /if \(e\?\.data\?\.code === 'FIN_BAD_TRANSITION'\) \{ setMove\(null\); return; \}/, 'a month another Approver has already moved: the grid shows where it is and the dialog closes');
  assert.doesNotMatch(months, /to:\s*'(?:open|closing|locked)'|reason:\s*(?:true|false)\b|FIN_PERIOD_TRANSITIONS/, 'the moves are periods.js\'s alone: this screen keeps no table of them');
});

test('Approval rules: the limit is typed in rupees and read by finRuleBody, and only an admin gets an Edit button', () => {
  const rules = SOURCES.rules;
  assert.match(rules, /const result = finRuleBody\(form\);/);
  assert.match(rules, /api\.put\(`\/finance\/approval-rules\/\$\{rule\.id\}`, result\.body\)/);
  assert.match(rules, /const ready = result\.ok && finRuleChanged\(rule, result\.body\);/);
  assert.match(rules, /const mayEdit = can\('admin'\);/);
  assert.match(rules, /mayEdit\s*\? <div className="flex justify-end"><Button size="sm" variant="secondary" onClick=\{\(\) => setEditing\(r\)\}>Edit<\/Button><\/div> : null/);
  assert.doesNotMatch(rules, /\*\s*100\b|parseFloat|Math\.round|Number\(form\.limitText/, 'no money arithmetic of its own: the paise come from money.js');
  assert.match(rules, /approval-rules\?\$\{new URLSearchParams\(\{ book: String\(book\.id\) \}\)\}/);
  assert.match(rules, /const columns = finUnsorted\(\[/, 'the rules keep the order they were made in');
  // the modes the form offers are the modes the server takes
  const admin = serverCode('finance-admin.js');
  assert.match(admin, /const FIN_RULE_MODES = Object\.freeze\(\['always', 'above_limit', 'never'\]\);/);
  assert.deepEqual(S.FIN_RULE_MODES.map(m => m.key), ['always', 'above_limit', 'never']);
});

test('Access: every grant says whether the login may export (R31), the books are the ones the login administers, and a grant for its own id refreshes the shell (R60)', () => {
  const access = SOURCES.access;
  assert.match(access, /const body = finGrantBody\(\{ userId, bookId, roles: state\.roles, canExport: state\.canExport \}\);/);
  assert.match(access, /api\.post\('\/finance\/access', body\)/);
  assert.doesNotMatch(access, /\bcan_export\s*:/, 'the screen builds no body of its own: the flag is put in by finGrantBody alone, so it can never be left out');
  assert.match(access, /const adminBooks = useMemo\(\(\) => finAdminBooks\(me\.books\), \[me\.books\]\);/);
  assert.match(access, /finGrantFormOf\(grants, start\.userId, start\.bookId\)/, 'a change starts from the grant that is stored');
  assert.match(access, /setState\(finGrantFormOf\(grants, nextUser, nextBook\)\)/, 'and so does a new one, once the login and the book are chosen');
  assert.match(access, /const problem = finGrantProblem\(\{ userId, bookId, roles: state\.roles \}\);/);
  assert.match(access, /FIN_ROLE_CHOICES\.map\(role =>/);
  assert.match(access, /api\.get\('\/finance\/access'\)|useReport\('\/finance\/access'\)/);
  // R60: after a grant and after a revoke
  assert.match(access, /const followShell = async grant => \{\s*if \(!finIsOwnGrant\(grant, me\)\) return null;\s*try \{ return await reloadMe\(\); \} catch/, 'the shell\'s new answer comes back, or null when it was not asked or could not answer');
  // M2: after a write the shell is asked FIRST, and the list only if this login still administers the book: a login that has just stopped
  // administering anything would be refused the list (a 403 that api.js toasts), and the screen is going
  assert.match(access, /const afterWrite = async grant => \{\s*const answer = await followShell\(grant\);\s*if \(answer && !finAdministers\(answer\.books, book\.id\)\) return;\s*await reload\(\);\s*\};/);
  assert.match(access, /setForm\(null\);\s*await afterWrite\(\{ user_id: body\.user_id \}\);/);
  assert.match(access, /toast\.success\('Access taken away'\);\s*await afterWrite\(grant\);/);
  assert.equal((access.match(/await afterWrite\(/g) || []).length, 2, 'defined once, used after a grant and after a revoke');
  assert.equal((access.match(/await followShell\(/g) || []).length, 1, 'and followShell is asked in one place, first');
  // a revoke
  assert.match(access, /api\.del\(`\/finance\/access\/\$\{grant\.id\}`\)/);
  assert.equal((access.match(/api\.del\(/g) || []).length, 1, 'the one revoke, inside the dialog\'s handler');
  assert.match(access, /<Button size="sm" variant="ghost" onClick=\{\(\) => setRevoking\(r\)\}>Revoke<\/Button>/, 'the row\'s button only asks');
  assert.match(access, /catch \{\s*toast\.error\('Your own access changed, but it could not be refreshed here\. Reload the page to see what you may do now\.'\);\s*return null;\s*\}/);
  assert.match(access, /<ConfirmDialog open=\{revoking != null\}[\s\S]*?\bdanger\b/);
  assert.match(access, /if \(e\?\.status === 403 \|\| e\?\.status === 404\) return;/, 'already revoked: the reload shows it gone');
  // M5: a refusal that names the login or the book is drawn when a grant is being CHANGED too (a switched-off login), not only for a new one
  const change = access.slice(access.indexOf('{grant ? ('), access.indexOf(') : ('));
  assert.ok(change.length > 100, 'non-vacuous: the change branch was found');
  assert.match(change, /<FieldError>\{problems\.user_id\}<\/FieldError>/);
  assert.match(change, /<FieldError>\{problems\.book_id\}<\/FieldError>/);
  // the book switch in the form lists only the administered books
  assert.match(access, /const bookOptions = adminBooks\.map\(/);
});

test('Activity log: the period is the page\'s, the person is heard once typing stops, the order is the server\'s, and a row shows before and after side by side', () => {
  const log = SOURCES.activity;
  assert.match(log, /finActivityUrl\(\{ bookId: book\.id, from, to, user, entity \}\)/);
  assert.match(log, /<PeriodFields from=\{from\} to=\{to\} onChange=\{onPeriod\} \/>/);
  assert.match(log, /const problem = finRangeProblem\(from, to\);\s*const url = problem \? null :/, 'a period that ends before it starts is not asked for');
  assert.match(log, /const columns = finUnsorted\(\[/, 'a time order sorted is no order');
  assert.match(log, /setTimeout\(\(\) => hear\.current\(\{ user: userText\.trim\(\) \}\), 350\)/);
  assert.match(log, /maxLength=\{100\}/);
  assert.match(log, /onRowClick=\{setOpen\}/);
  assert.match(log, /grid gap-3 md:grid-cols-2">\s*<JsonPane label="Before" value=\{detail\.before\}[^>]*\/>\s*<JsonPane label="After" value=\{detail\.after\}/);
  assert.match(log, /<pre [^>]*>\{shown\}<\/pre>/, 'pretty-printed text, not a rendered object');
  // Ruling R71: the list is summaries; a row's record before and after is asked for when it is opened, once (an audit row never
  // changes, so it is not a useReport read that a realtime tick asks again), and a failure is said with a Retry, never as "nothing".
  assert.match(log, /const answer = await api\.get\(`\/finance\/activity\/\$\{row\.id\}`\);\s*if \(live\.current\) setDetail\(answer\.row\);/);
  assert.match(log, /<LoadNotice failed=\{failed\} shown=\{false\} what="what was recorded for this change" onRetry=\{load\} \/>/);
  assert.match(log, /\{detail == null \? \(\s*!failed && /, 'nothing is drawn as recorded until the record has come');
  assert.equal((log.match(/useReport\(/g) || []).length, 1, 'the list is the one useReport read');
  assert.doesNotMatch(log, /\b(r|row)\.(before|after)\b/, 'a list row carries no record');
  assert.match(log, /title=\{r\.label \|\| ''\}>\{r\.label\}</, 'what a row is about is the server\'s label');
  assert.match(log, /<ReadOnlyFact label="About">\{row\.label\}<\/ReadOnlyFact>/);
  assert.match(log, /<ActivityDetail key=\{open\.id\} row=\{open\}/);
  assert.match(log, /finActivityCut\(data\?\.rows\)/);
  assert.doesNotMatch(log, /_order/, 'nothing sorts, so no row carries an order index');
  assert.match(log, /FIN_ENTITY_CHOICES\.map\(c =>/);
});

// ── The words and limits are the server's ───────────────────────────────────────────────────────────────────────────

test('the log has a word for everything the server records: every entity is in the filter and every action has a label', () => {
  const files = ['finance-admin.js', 'finance-import.js', 'finance-masters.js', 'finance-setup.js', 'finance-vouchers.js'];
  const pairs = files.flatMap(f => [...serverCode(f).matchAll(/entity: '([a-z_]+)', entityId[^\n]*?action: '([a-z_]+)'/g)].map(m => [m[1], m[2]]));
  assert.ok(pairs.length >= 20, `non-vacuous: only ${pairs.length} audit calls found`);
  const entities = [...new Set(pairs.map(p => p[0]))].sort();
  assert.deepEqual(S.FIN_ENTITY_CHOICES.map(c => c.key).sort(), entities, 'the filter offers exactly the kinds of thing the log records');
  for (const [entity, action] of pairs) {
    assert.notEqual(S.finActionLabel(entity, action), action, `${entity} ${action} has no label`);
    assert.notEqual(S.finEntityLabel(entity), entity, `${entity} has no name`);
  }
});

test('the constants the screens mirror are the server\'s: the years it takes, the rows the log is cut at, the roles, the rules\' keys', () => {
  const masters = serverCode('finance-masters.js');
  assert.equal(Number(/const FIN_FIRST_YEAR = (\d+);/.exec(masters)?.[1]), S.FIN_FIRST_YEAR);
  assert.equal(Number(/const FIN_LAST_YEAR = (\d+);/.exec(masters)?.[1]), S.FIN_LAST_YEAR);
  assert.equal(Number(/const FIN_ACTIVITY_MAX = (\d+);/.exec(serverCode('finance-reports.js'))?.[1]), S.FIN_ACTIVITY_CAP);
  assert.equal(Number(/const FIN_USER_MAX = (\d+);/.exec(serverCode('finance-reports.js'))?.[1]), 100, 'the person box takes what the server takes');
  assert.deepEqual(S.FIN_ROLE_CHOICES.map(r => r.key), [...serverRoles()]);
  const ruleKeys = FIN_DEFAULT_RULES.map(rule => rule.rule_key);
  assert.equal(ruleKeys.length, 10, 'non-vacuous: the ten rules a book is given');
  for (const key of ruleKeys) assert.notEqual(S.finRuleLabel(key), key, `rule ${key} has no name`);
});
function serverRoles() { return S_FIN_ROLES; }
