// Tally's group tree, the way every book starts (spec §6.3): the 15 primary groups, the system
// group "Profit & Loss", and Tally's 13 sub-groups. PURE data, no pg and nothing to mock; the
// setup script reads it and seeds one copy of the tree per book.
//
// Every constant is frozen. Setup runs once for each book inside one process, so a row it could
// write a book's ids onto would carry them into the next book.

// [name, nature, affects gross profit, sub-groups], in the order a book lists them. A sub-group
// takes its parent's nature and its gross-profit flag, so a nature cannot drift from its parent.
const FIN_TREE = [
  ['Capital Account', 'liability', false, ['Reserves & Surplus']],
  ['Loans (Liability)', 'liability', false, ['Bank OD A/c', 'Secured Loans', 'Unsecured Loans']],
  ['Current Liabilities', 'liability', false, ['Duties & Taxes', 'Provisions', 'Sundry Creditors']],
  ['Suspense A/c', 'liability', false, []],
  ['Branch / Divisions', 'liability', false, []],
  ['Fixed Assets', 'asset', false, []],
  ['Investments', 'asset', false, []],
  ['Current Assets', 'asset', false, [
    'Bank Accounts', 'Cash-in-Hand', 'Deposits (Asset)', 'Loans & Advances (Asset)', 'Stock-in-Hand', 'Sundry Debtors',
  ]],
  ['Misc. Expenses (ASSET)', 'asset', false, []],
  ['Sales Accounts', 'income', true, []],
  ['Direct Incomes', 'income', true, []],
  ['Indirect Incomes', 'income', false, []],
  ['Purchase Accounts', 'expense', true, []],
  ['Direct Expenses', 'expense', true, []],
  ['Indirect Expenses', 'expense', false, []],
  ['Profit & Loss', 'liability', false, []], // the system group that holds the "Profit & Loss A/c" ledger
];

const finTreeRows = FIN_TREE.flatMap(([name, nature, affects_gross_profit, subs]) => [
  { name, parent: null, nature, affects_gross_profit },
  ...subs.map(sub => ({ name: sub, parent: name, nature, affects_gross_profit })),
]);

// A primary group has parent null; any other row names its parent. sort_order counts down the
// list, so a parent is always earlier than its sub-groups: setup inserts in this order and turns
// each parent name into an id as it goes.
export const FIN_GROUP_TEMPLATE = Object.freeze(
  finTreeRows.map((row, i) => Object.freeze({ ...row, sort_order: i + 1 })),
);

// The two ledgers every book has from the start (spec §6.4). Neither can be deleted.
export const FIN_SYSTEM_LEDGERS = Object.freeze([
  Object.freeze({ name: 'Cash', group: 'Cash-in-Hand' }),
  Object.freeze({ name: 'Profit & Loss A/c', group: 'Profit & Loss' }),
]);

// A ledger is "bank or cash" when its group is, or descends from, one of these (spec §6.4).
// There is no separate flag; the ancestry decides.
export const FIN_BANK_CASH_GROUPS = Object.freeze(['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c']);

// A ledger holds a party's account when its group is, or descends from, one of these, or when it is
// linked to an ERP customer or vendor (ruling R23). finance-vouchers.js finIsPartyLedger is the one
// place that puts the two together.
export const FIN_PARTY_GROUPS = Object.freeze(['Sundry Debtors', 'Sundry Creditors']);
