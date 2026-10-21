// The Opening Balances wizard and the Tally upload (spec §11.2, §11.3, §10): the pure half. The decisions the screens take are in
// client/src/lib/finance/opening.js (which step, which import is resumed, what the Match step sends, what is still undecided, the month
// ends a trial balance may be as at, what became of the Opening voucher); reading the files is tally.js, tested in finance-import.test.js.
// The components draw what these functions say, and the source pins at the foot hold them to it.
//
// The browser is wherever the accountant is, and a day is a calendar day. Pinned to a zone WEST of Greenwich, so a day read through a
// Date at UTC midnight shows up as the day before and the date tests below fail on it. Must run before the first Date is built.
process.env.TZ = 'Pacific/Honolulu';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as O from '../../client/src/lib/finance/opening.js';

// Every name and figure here is invented.
const R = 100;   // paise per rupee

// ── The steps ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('four steps, in the order of the spec', () => {
  assert.deepEqual(O.FIN_OPENING_STEPS.map(s => [s.key, s.label]), [['upload', 'Upload'], ['match', 'Match'], ['check', 'Check'], ['build', 'Build']]);
  assert.ok(Object.isFrozen(O.FIN_OPENING_STEPS));
});

test('the opening balances are as at the day before the books begin, and that is not a choice (ruling R34)', () => {
  assert.equal(O.finOpeningAsAt('2027-01-01'), '2026-12-31');
  assert.equal(O.finOpeningAsAt('2027-03-01'), '2027-02-28');
  assert.equal(O.finOpeningAsAt('2028-03-01'), '2028-02-29');
  for (const none of [null, undefined, '', '2027-1-1', '2027-02-30', 20270101, new Date(0)]) assert.equal(O.finOpeningAsAt(none), null, String(none));
});

const imp = (id, status, extra = {}) => ({ id, status, purpose: 'opening', as_at: '2026-12-31', opening_voucher_id: null, ...extra });

test('the wizard continues the newest import when it is not used (ruling R37); behind a used one, an older draft is stale', () => {
  assert.equal(O.finResumeImport([imp(5, 'draft'), imp(4, 'used')]).id, 5);
  assert.equal(O.finResumeImport([imp(5, 'matched'), imp(4, 'draft'), imp(3, 'used')]).id, 5);
  assert.equal(O.finResumeImport([imp(5, 'used'), imp(4, 'draft')]), null, 'a draft behind a used import cannot be built while that Opening voucher stands');
  assert.equal(O.finResumeImport([imp(2, 'used')]), null);
  assert.equal(O.finResumeImport([]), null);
  for (const none of [null, undefined, 'imports', {}]) assert.equal(O.finResumeImport(none), null);
  // The server sends newest first, and the screen does not rely on it.
  assert.equal(O.finResumeImport([imp(3, 'draft'), imp(9, 'matched'), imp(4, 'used')]).id, 9);
  assert.equal(O.finResumeImport([imp(3, 'draft'), imp(9, 'used'), imp(4, 'used')]), null);
  // A status nobody knows is not something to continue.
  assert.equal(O.finResumeImport([imp(5, 'archived')]), null);
});

test('a used newest import is the one whose Opening voucher the wizard reports on', () => {
  assert.equal(O.finBuiltImport([imp(5, 'used'), imp(4, 'draft')]).id, 5);
  assert.equal(O.finBuiltImport([imp(3, 'used', { opening_voucher_id: 9 }), imp(2, 'used')]).opening_voucher_id, 9);
  assert.equal(O.finBuiltImport([imp(5, 'draft'), imp(4, 'used')]), null, 'a newer draft is what is being worked on');
  assert.equal(O.finBuiltImport([]), null);
  assert.equal(O.finBuiltImport(null), null);
});

test('an import is at the step its status says: a draft needs its matches confirmed, a matched one is checked, a used one is built', () => {
  assert.equal(O.finStepOfImport(imp(1, 'draft')), 'match');
  assert.equal(O.finStepOfImport(imp(1, 'matched')), 'check');
  assert.equal(O.finStepOfImport(imp(1, 'used')), 'build');
  assert.equal(O.finStepOfImport(null), 'upload');
  assert.equal(O.finStepOfImport(imp(1, 'weird')), 'upload');
  // Final wave item 14: a matched import with edits on the Match step that are not confirmed (restored from the tab's session after
  // a reload, say) is at Match: Check is closed to it (finStepsOpen), and a Check would be of the old matches.
  assert.equal(O.finStepOfImport(imp(1, 'matched'), { dirty: true }), 'match');
  assert.equal(O.finStepOfImport(imp(1, 'matched'), { dirty: false }), 'check');
  for (const status of ['draft', 'used']) {
    assert.equal(O.finStepOfImport(imp(1, status), { dirty: true }), O.finStepOfImport(imp(1, status)), `${status}: edits move nothing else`);
  }
  // wherever the import lands is a step the person may be on
  for (const status of ['draft', 'matched', 'used']) {
    for (const dirty of [false, true]) {
      const step = O.finStepOfImport(imp(1, status), { dirty });
      assert.equal(O.finStepsOpen({ imp: imp(1, status), dirty })[step], true, `${status}${dirty ? ', with unconfirmed edits' : ''} lands on ${step}, which is open`);
    }
  }
});

test('which steps a person may move to: Check and Build wait for the matches to be confirmed (ruling R33), and for nothing on screen to be unconfirmed', () => {
  const open = (imp_, dirty = false, extra = {}) => O.finStepsOpen({ imp: imp_, dirty, ...extra });
  assert.deepEqual(open(null), { upload: true, match: false, check: false, build: false });
  assert.deepEqual(open(imp(1, 'draft')), { upload: true, match: true, check: false, build: false });
  assert.deepEqual(open(imp(1, 'matched')), { upload: true, match: true, check: true, build: true });
  assert.deepEqual(open(imp(1, 'matched'), true), { upload: true, match: true, check: false, build: false }, 'edits not yet confirmed: the Check would be of the old matches');
  assert.deepEqual(open(imp(1, 'used')), { upload: true, match: false, check: false, build: true }, 'a used import is read, not changed');
  // The files cannot be uploaded again while the Opening voucher of a used import stands or waits (ruling R37).
  assert.deepEqual(open(imp(1, 'used'), false, { canUpload: false }), { upload: false, match: false, check: false, build: true });
  assert.deepEqual(open(imp(1, 'draft'), false, { canUpload: false }).upload, false, 'whatever the import says, the wizard\'s word on uploading is taken');
  assert.equal(O.finStepsOpen().upload, true, 'and with no word it is open');
  assert.deepEqual(O.finStepsOpen(), { upload: true, match: false, check: false, build: false });
});

// ── The groups: which are a party's ──────────────────────────────────────────────────────────────────────────────────

// The groups as GET /finance/books/:id/groups sends them. Whether a group is a party's is the server's word (is_party, finGroupKinds, ruling
// R23): these carry the flags it would send for this tree, and finance-pg-masters.test.js holds the server to them against a real database.
const group = (id, parent_id, name, is_party = false) => ({ id, parent_id, name, is_party, is_bank_cash: name === 'Bank Accounts' });
const GROUPS = [
  group(1, null, 'Current Assets'),
  group(2, 1, 'Bank Accounts'),
  group(3, 1, 'Sundry Debtors', true),
  group(4, 3, 'Debtors - Export', true),
  group(5, null, 'Current Liabilities'),
  group(6, 5, 'SUNDRY CREDITORS', true),
  group(7, 6, 'Creditors - Packaging', true),
  group(8, 7, 'Creditors - Packaging - North', true),
  group(9, 3, 'Sundry Creditors', true),
];

// Fix round, M5 (ruling R23). The screen used to work out for itself which groups are a party's, walking the names up the tree: a second
// definition to keep equal to the server's. The groups read now says it (is_party, from finGroupKinds), and the screen only takes it.
test('the party groups are the ones the server marks, taken once for as many rows as the screen holds', () => {
  const ids = O.finPartyGroupIds(GROUPS);
  assert.ok(ids instanceof Set);
  assert.deepEqual([...ids], [3, 4, 6, 7, 8, 9]);
  // only a flag that is true counts: a group with no flag, or one that is not a boolean, is not a party's
  assert.deepEqual([...O.finPartyGroupIds([{ id: 1 }, { id: 2, is_party: 'yes' }, { id: 3, is_party: 1 }, { id: 4, is_party: false }, { id: 5, is_party: true }, null, undefined])], [5]);
  for (const none of [null, undefined, 'groups', {}]) assert.equal(O.finPartyGroupIds(none).size, 0, String(none));
  // the names are not here to be compared, and neither is the walk up the tree
  for (const gone of ['FIN_PARTY_GROUP_SIDES', 'finPartySides', 'finGroupPartySide', 'finIsPartyGroup']) assert.equal(gone in O, false, `${gone}: the server says`);
});

// ── A row's decision ─────────────────────────────────────────────────────────────────────────────────────────────────

const row = (id, name, status, extra = {}) => ({
  id, tally_name: name, tally_group: null, debit_paise: 0, credit_paise: 0, match_status: status, ledger_id: null, ledger_name: null,
  group_id: null, group_name: null, party_type: null, party_id: null, party_name: null, is_party: false, ...extra,
});
const bank = row(101, 'Alpha Bank', 'create', { tally_group: 'Bank Accounts', debit_paise: 5000 * R, group_id: 2, group_name: 'Bank Accounts' });
const acme = row(102, 'Acme Pharma Ltd', 'create', { tally_group: 'Sundry Debtors', debit_paise: 1590 * R, group_id: 3, party_type: 'customer', party_id: 7, party_name: 'Acme Pharma Ltd', is_party: true });
const cash = row(103, 'Cash', 'matched', { ledger_id: 31, ledger_name: 'Cash', credit_paise: 10 * R });
const mystery = row(104, 'Mystery', 'unmatched', { tally_group: 'Nowhere' });
const beta = row(105, 'Beta Supplies', 'create', { tally_group: 'Sundry Creditors', credit_paise: 40 * R, group_id: 6, is_party: true });
const ROWS = [bank, acme, cash, mystery, beta];

test('a row is as the server holds it until it is touched, and then as the person left it', () => {
  assert.deepEqual(O.finRowDecision(bank), { action: 'create', ledger_id: null, group_id: 2, party_type: null, party_id: null });
  assert.deepEqual(O.finRowDecision(acme), { action: 'create', ledger_id: null, group_id: 3, party_type: 'customer', party_id: 7 });
  assert.deepEqual(O.finRowDecision(cash), { action: 'match', ledger_id: 31, group_id: null, party_type: null, party_id: null });
  assert.deepEqual(O.finRowDecision(mystery), { action: 'unmatched', ledger_id: null, group_id: null, party_type: null, party_id: null });
  assert.equal(O.finRowDecision(row(1, 'X', 'surprise')).action, 'unmatched', 'a status nobody knows is undecided, not a match');
  const touched = { 104: { action: 'create', ledger_id: null, group_id: 2, party_type: null, party_id: null } };
  assert.equal(O.finDecisionOf(mystery, touched).action, 'create');
  assert.equal(O.finDecisionOf(bank, touched).action, 'create');
  assert.deepEqual(O.finDecisionOf(cash, touched), O.finRowDecision(cash));
  assert.deepEqual(O.finDecisionOf(cash), O.finRowDecision(cash), 'nothing touched at all');
  assert.equal(O.finDecisionOf(row(1, 'constructor', 'matched'), {}).action, 'match', 'an id is no key on Object.prototype');
});

test('the three actions and their words: the long form for a tooltip, the short one for the button', () => {
  assert.deepEqual(O.FIN_MATCH_ACTIONS.map(a => [a.key, a.label]), [['match', 'Match to a ledger'], ['create', 'Create a new ledger'], ['unmatched', 'Not decided yet']]);
  assert.deepEqual(O.FIN_MATCH_ACTIONS.map(a => a.short), ['Match', 'Create', 'Undecided']);
  assert.ok(Object.isFrozen(O.FIN_MATCH_ACTIONS) && O.FIN_MATCH_ACTIONS.every(a => Object.isFrozen(a)));
});

test('whether the group a new ledger goes under is a party group: the server\'s answer for the group it proposed, the groups\' for any other', () => {
  const parties = O.finPartyGroupIds(GROUPS);
  const is = (r, d) => O.finRowIsParty(r, { ...O.finRowDecision(r), ...d }, parties);
  assert.equal(is(acme, {}), true, 'proposed under Sundry Debtors: the server said so');
  assert.equal(is(bank, {}), false);
  assert.equal(is(bank, { group_id: 4 }), true, 'moved by the person to a group under Sundry Debtors: the groups say so');
  assert.equal(is(acme, { group_id: 2 }), false, 'moved to Bank Accounts');
  assert.equal(is(acme, { group_id: 3 }), true, 'and back');
  assert.equal(is(mystery, { action: 'create', group_id: 7 }), true, 'a row with no proposal, put under a creditors group');
  assert.equal(is(mystery, { action: 'create', group_id: null }), false);
  // The server's own word is kept for the group it proposed even when the groups have not come to say the same.
  assert.equal(O.finRowIsParty(acme, O.finRowDecision(acme), new Set()), true);
  assert.equal(O.finRowIsParty(acme, O.finRowDecision(acme)), true, 'and when there are no groups at all');
});

test('editing a decision: the action, the ledger, the group and the party; a party goes when the new group is not a party\'s', () => {
  const parties = O.finPartyGroupIds(GROUPS);
  const edit = (r, d, change) => O.finEditDecision(r, d, change, parties);
  const d0 = O.finRowDecision(acme);
  assert.deepEqual(edit(acme, d0, { action: 'match' }), { ...d0, action: 'match' }, 'the rest is kept, so going back loses nothing');
  assert.deepEqual(edit(acme, d0, { ledger_id: 40 }), { ...d0, ledger_id: 40 });
  assert.deepEqual(edit(acme, d0, { group_id: 4 }), { ...d0, group_id: 4 }, 'another group under Sundry Debtors keeps the customer');
  assert.deepEqual(edit(acme, d0, { group_id: 2 }), { ...d0, group_id: 2, party_type: null, party_id: null }, 'Bank Accounts has no party');
  assert.deepEqual(edit(acme, d0, { group_id: null }), { ...d0, group_id: null, party_type: null, party_id: null });
  assert.deepEqual(edit(bank, O.finRowDecision(bank), { party: { party_type: 'vendor', party_id: 3 } }), { ...O.finRowDecision(bank), party_type: 'vendor', party_id: 3 });
  assert.deepEqual(edit(acme, d0, { party: null }), { ...d0, party_type: null, party_id: null });
  // The decision it was given is not changed in place.
  assert.deepEqual(d0, O.finRowDecision(acme));
});

// ── The edits not yet confirmed, kept for a reload ───────────────────────────────────────────────────────────────────

// Fix round, M4. The Match step's edits live in the wizard's memory; a reload (the update bar, a pull to refresh, a tablet that discards a
// tab in the background) used to lose a long review of the rows. They are kept in the tab's session as well, per login, import and status.
test('the edits are kept per login, import and status: a confirmed or used import is another set', () => {
  assert.equal(O.finEditsKey(7, 12, 'draft'), 'fin:opening-edits:7:12:draft');
  const keys = new Set([O.finEditsKey(7, 12, 'draft'), O.finEditsKey(7, 12, 'matched'), O.finEditsKey(8, 12, 'draft'), O.finEditsKey(7, 13, 'draft')]);
  assert.equal(keys.size, 4, 'another status, another login, another import: each its own');
  assert.equal(O.finEditsKey(undefined, 12, 'draft'), 'fin:opening-edits:anon:12:draft');
});

test('edits are packed to text and back, and what comes back is only what the Match step could have made', () => {
  const create = (extra = {}) => ({ action: 'create', ledger_id: null, group_id: 3, party_type: 'customer', party_id: 7, ...extra });
  const touched = {
    101: create(),
    103: { action: 'match', ledger_id: 31, group_id: null, party_type: null, party_id: null },
    104: { action: 'unmatched', ledger_id: null, group_id: null, party_type: null, party_id: null },
  };
  const text = O.finEditsPack(touched);
  assert.equal(typeof text, 'string');
  assert.deepEqual(O.finEditsUnpack(text), touched, 'the same edits come back');
  assert.deepEqual(Object.keys(O.finEditsUnpack(text)), ['101', '103', '104']);
  // The same edits are the same changes: a restored set is what was left.
  assert.deepEqual(O.finChangedRows(ROWS, O.finEditsUnpack(text), GROUPS).map(r => r.id), O.finChangedRows(ROWS, touched, GROUPS).map(r => r.id));
  // Nothing to keep is no text; no text, or text that is not edits, is nothing.
  for (const none of [{}, null, undefined, 'edits', 5, []]) assert.equal(O.finEditsPack(none), '', String(none));
  for (const none of ['', null, undefined, 5, {}, [], 'not json', '{', '[]', '"x"', 'null', '5', 'true']) assert.deepEqual(O.finEditsUnpack(none), {}, String(none));
  // What a tab holds is whatever it holds: a row is kept only when its decision is whole and of the shape finRowDecision makes.
  const held = '{"101":' + JSON.stringify(create()) + ',"abc":' + JSON.stringify(create()) + ',"0":' + JSON.stringify(create()) + ',"-1":' + JSON.stringify(create())
    + ',"1.5":' + JSON.stringify(create()) + ',"__proto__":' + JSON.stringify(create()) + ',"102":{"action":"explode"},"103":null,"104":"x","105":'
    + JSON.stringify(create({ group_id: '3' })) + ',"106":' + JSON.stringify(create({ party_type: 'supplier' })) + ',"107":' + JSON.stringify(create({ ledger_id: -2 }))
    + ',"108":' + JSON.stringify(create({ extra: 'field' })) + ',"109":{"action":"match","ledger_id":31},"110":' + JSON.stringify(create({ party_id: 1.5 })) + '}';
  const back = O.finEditsUnpack(held);
  assert.deepEqual(Object.keys(back).sort(), ['101', '108', '109']);
  assert.deepEqual(back[108], create(), 'a field that is not one of the five is dropped');
  assert.deepEqual(back[109], { action: 'match', ledger_id: 31, group_id: null, party_type: null, party_id: null }, 'and one that is missing is none');
  assert.equal({}.action, undefined, 'nothing reached Object.prototype');
  // Row ids are whole numbers above zero, as the server's are.
  assert.deepEqual(O.finEditsUnpack('{"9007199254740993":' + JSON.stringify(create()) + '}'), {}, 'one that is no safe integer is not an id');
});

// ── What is sent ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('the entry for a row names what its action needs and nothing else (the server refuses a stray field)', () => {
  const parties = O.finPartyGroupIds(GROUPS);
  const entry = (r, d = {}) => O.finEntryOf(r, { ...O.finRowDecision(r), ...d }, parties);
  assert.deepEqual(entry(cash), { row_id: 103, action: 'match', ledger_id: 31 });
  assert.deepEqual(entry(bank), { row_id: 101, action: 'create', group_id: 2 });
  assert.deepEqual(entry(acme), { row_id: 102, action: 'create', group_id: 3, party_type: 'customer', party_id: 7 });
  assert.deepEqual(entry(mystery), { row_id: 104, action: 'unmatched' });
  // Fields left over from another action are not sent.
  assert.deepEqual(entry(cash, { group_id: 2, party_type: 'customer', party_id: 7 }), { row_id: 103, action: 'match', ledger_id: 31 });
  assert.deepEqual(entry(acme, { action: 'unmatched' }), { row_id: 102, action: 'unmatched' });
  assert.deepEqual(entry(acme, { action: 'match', ledger_id: 31 }), { row_id: 102, action: 'match', ledger_id: 31 });
  // A party goes only with a party group, and only whole.
  assert.deepEqual(entry(acme, { group_id: 2 }), { row_id: 102, action: 'create', group_id: 2 });
  assert.deepEqual(entry(acme, { party_id: null }), { row_id: 102, action: 'create', group_id: 3 });
  // Not yet decided enough to send: a match with no ledger, a new ledger with no group.
  assert.equal(entry(cash, { ledger_id: null }), null);
  assert.equal(entry(bank, { group_id: null }), null);
  assert.equal(entry(mystery, { action: 'create' }), null);
  assert.equal(entry(mystery, { action: 'match' }), null);
});

const matchView = (touched = {}, extra = {}) => O.finMatchView(ROWS, touched, GROUPS, extra);

test('the confirmation lists EVERY row, once, in the order they came (ruling R33)', () => {
  const view = matchView();
  assert.deepEqual(view.matches, [
    { row_id: 101, action: 'create', group_id: 2 },
    { row_id: 102, action: 'create', group_id: 3, party_type: 'customer', party_id: 7 },
    { row_id: 103, action: 'match', ledger_id: 31 },
    { row_id: 104, action: 'unmatched' },
    { row_id: 105, action: 'create', group_id: 6 },
  ]);
  assert.equal(view.ready, true, 'a row left undecided is still confirmed as undecided; the Check step says it blocks the build');
  assert.equal(view.blocked, 0);
  assert.equal(O.finMatchView([], {}, GROUPS).matches.length, 0);
  assert.deepEqual(O.finMatchView(null, null, null).matches, []);
});

test('a row that is not decided enough to send stops the confirmation, and says what is missing', () => {
  const view = matchView({
    103: { action: 'match', ledger_id: null, group_id: null, party_type: null, party_id: null },
    104: { action: 'create', ledger_id: null, group_id: null, party_type: null, party_id: null },
  });
  assert.equal(view.ready, false);
  assert.equal(view.matches, null);
  assert.equal(view.blocked, 2);
  assert.deepEqual(view.states.get(103), { kind: 'attention', note: 'Choose a ledger', tone: 'amber' });
  assert.deepEqual(view.states.get(104), { kind: 'attention', note: 'Choose a group', tone: 'amber' });
});

test('two rows on one Finance ledger, or one party on two rows, are said before the server has to (it refuses both)', () => {
  const twin = row(106, 'Cash in hand', 'matched', { ledger_id: 31 });
  const rows = [...ROWS, twin];
  const view = O.finMatchView(rows, {}, GROUPS);
  assert.equal(view.ready, false);
  assert.equal(view.blocked, 2);
  assert.deepEqual(view.states.get(103), { kind: 'attention', note: 'Cash in hand is matched to the same ledger', tone: 'red' });
  assert.deepEqual(view.states.get(106), { kind: 'attention', note: 'Cash is matched to the same ledger', tone: 'red' });
  assert.equal(view.states.get(101).kind, 'create', 'the others are untouched');
  // One customer linked to two new ledgers.
  const acme2 = row(107, 'Acme Pharma (Export)', 'create', { group_id: 4, party_type: 'customer', party_id: 7, is_party: true });
  const dup = O.finMatchView([acme, acme2], {}, GROUPS);
  assert.equal(dup.ready, false);
  assert.match(dup.states.get(102).note, /^Acme Pharma \(Export\) is linked to the same customer$/);
  assert.match(dup.states.get(107).note, /^Acme Pharma Ltd is linked to the same customer$/);
  // A vendor and a customer with the same number are two parties.
  const vendor7 = row(108, 'Seven Traders', 'create', { group_id: 6, party_type: 'vendor', party_id: 7, is_party: true });
  assert.equal(O.finMatchView([acme, vendor7], {}, GROUPS).ready, true);
  // Three rows on one ledger name the others, a few at a time.
  const many = [1, 2, 3, 4, 5].map(i => row(200 + i, `Row ${i}`, 'matched', { ledger_id: 9 }));
  assert.equal(O.finMatchView(many, {}, GROUPS).states.get(201).note, 'Row 2, Row 3 and 2 more are matched to the same ledger');
  assert.equal(O.finMatchView(many.slice(0, 3), {}, GROUPS).states.get(201).note, 'Row 2 and Row 3 are matched to the same ledger');
});

test('a party under a group that is not a party\'s is not sent, and not counted as linked', () => {
  const moved = matchView({ 102: { ...O.finRowDecision(acme), group_id: 2 } });
  assert.deepEqual(moved.matches[1], { row_id: 102, action: 'create', group_id: 2 });
  const clash = O.finMatchView([bank, { ...acme, id: 108, party_id: 7 }, acme], { 108: { ...O.finRowDecision(acme), group_id: 2, party_type: 'customer', party_id: 7 } }, GROUPS);
  assert.equal(clash.ready, true, 'the customer is linked once: the row moved out of the debtors lost its link');
});

test('a row matched to a ledger that is switched off is flagged, and still sent: the server decides', () => {
  const ledgerById = new Map([[31, { id: 31, name: 'Cash', active: false }]]);
  const view = matchView({}, { ledgerById });
  assert.deepEqual(view.states.get(103), { kind: 'match', note: 'Cash is switched off', tone: 'amber' });
  assert.equal(view.ready, true);
  // No balance, nothing posts to it, and the server lets it be.
  const quiet = O.finMatchView([{ ...cash, credit_paise: 0 }], {}, GROUPS, { ledgerById });
  assert.equal(quiet.states.get(103).note, null);
  assert.equal(O.finMatchView([cash], {}, GROUPS, { ledgerById: new Map([[31, { id: 31, name: 'Cash', active: true }]]) }).states.get(103).note, null);
});

test('how the rows divide, for the filters above the table', () => {
  const view = matchView();
  assert.deepEqual(view.counts, { all: 5, match: 1, create: 3, attention: 1 });
  assert.deepEqual(view.states.get(101), { kind: 'create', note: null, tone: null });
  assert.deepEqual(view.states.get(103), { kind: 'match', note: null, tone: null });
  assert.deepEqual(view.states.get(104), { kind: 'attention', note: 'Not decided yet', tone: 'amber' });
  const names = filter => O.finFilterRows(ROWS, view, filter).map(r => r.tally_name);
  assert.deepEqual(names('all'), ['Alpha Bank', 'Acme Pharma Ltd', 'Cash', 'Mystery', 'Beta Supplies']);
  assert.deepEqual(names('attention'), ['Mystery']);
  assert.deepEqual(names('match'), ['Cash']);
  assert.deepEqual(names('create'), ['Alpha Bank', 'Acme Pharma Ltd', 'Beta Supplies']);
  assert.deepEqual(names('anything else'), names('all'));
  assert.deepEqual(O.FIN_MATCH_FILTERS.map(f => f.key), ['all', 'attention', 'match', 'create']);
  // Deciding the undecided row moves it between the counts.
  const decided = matchView({ 104: { ...O.finRowDecision(mystery), action: 'match', ledger_id: 40 } });
  assert.deepEqual(decided.counts, { all: 5, match: 2, create: 3, attention: 0 });
});

test('what has changed since the server last held the matches: only a row whose decision is not the one it holds', () => {
  const changed = touched => O.finChangedRows(ROWS, touched, GROUPS).map(r => r.id);
  assert.deepEqual(changed({}), []);
  assert.deepEqual(changed(null), []);
  assert.deepEqual(changed({ 103: O.finRowDecision(cash) }), [], 'touched and put back');
  assert.deepEqual(changed({ 103: { ...O.finRowDecision(cash), ledger_id: 32 } }), [103]);
  assert.deepEqual(changed({ 104: { ...O.finRowDecision(mystery), action: 'create', group_id: 2 } }), [104]);
  assert.deepEqual(changed({ 103: { ...O.finRowDecision(cash), group_id: 2, party_type: 'vendor', party_id: 4 } }), [], 'fields the action does not send are no change');
  assert.deepEqual(changed({ 103: { ...O.finRowDecision(cash), ledger_id: null } }), [103], 'a half-made decision is a change');
  assert.deepEqual(changed({ 102: { ...O.finRowDecision(acme), group_id: 2 } }), [102]);
  assert.deepEqual(changed({ 999: { action: 'match', ledger_id: 1 } }), [], 'a row that is not on the screen');
});

test('a refusal that names a row of the confirmation says which row, so the screen can mark it', () => {
  const matches = [{ row_id: 101 }, { row_id: 102 }, { row_id: 103 }];
  const refused = field => ({ status: 409, data: { field } });
  assert.equal(O.finRefusedRowId(refused('matches[2].ledger_id'), matches), 103);
  assert.equal(O.finRefusedRowId(refused('matches[0].action'), matches), 101);
  assert.equal(O.finRefusedRowId(refused('matches[7].group_id'), matches), null, 'a place beyond the list');
  for (const field of ['matches', 'tb[2].tally_name', '', null, undefined, 7]) assert.equal(O.finRefusedRowId(refused(field), matches), null, String(field));
  assert.equal(O.finRefusedRowId(null, matches), null);
  assert.equal(O.finRefusedRowId(refused('matches[1].party_id'), null), null);
});

// ── The party picker ─────────────────────────────────────────────────────────────────────────────────────────────────

const CUSTOMERS = [{ id: 7, name: 'Acme Pharma Ltd', city: 'Pune', gstin: '27AAAAA0000A1Z5', active: 1 }, { id: 8, name: 'Old Customer', city: 'Delhi', active: 0 }];
const VENDORS = [{ id: 3, name: 'Beta Supplies', city: 'Surat', active: 1 }, { id: 7, name: 'Seven Traders', active: true }];

// Fix round, M5. The group says only that it is a party's, not on which side (the server's word is is_party), so the list is the same under
// every party group: the customers, then the vendors. A name that is only a vendor is proposed under Sundry Debtors too (ruling R32), so
// both are on offer whichever group it is.
test('the parties on offer under a party group: the customers, then the vendors, the switched-off ones only if one is linked', () => {
  const choices = current => O.finPartyChoices(CUSTOMERS, VENDORS, current).map(c => [c.value, c.label, c.hint]);
  assert.deepEqual(choices(), [['customer:7', 'Acme Pharma Ltd', 'Customer · Pune'], ['vendor:3', 'Beta Supplies', 'Vendor · Surat'], ['vendor:7', 'Seven Traders', 'Vendor']]);
  assert.equal(O.finPartyChoices.length, 3, 'customers, vendors and the one already linked: no side');
  // A party that was switched off since it was linked is still shown, as the current value.
  assert.deepEqual(choices({ party_type: 'customer', party_id: 8, party_name: 'Old Customer' }).map(c => c[1]),
    ['Acme Pharma Ltd', 'Old Customer (switched off)', 'Beta Supplies', 'Seven Traders']);
  // And one the lists do not have at all.
  const gone = choices({ party_type: 'customer', party_id: 99, party_name: 'Gone Ltd' });
  assert.deepEqual(gone[gone.length - 1], ['customer:99', 'Gone Ltd (not in the list)', 'Customer']);
  assert.equal(O.finPartyChoices(CUSTOMERS, VENDORS, { party_type: 'customer', party_id: 7 }).filter(c => c.value === 'customer:7').length, 1, 'never twice');
  assert.deepEqual(O.finPartyChoices(null, null), []);
  assert.deepEqual(O.finPartyChoices(CUSTOMERS, undefined, null).map(c => c.value), ['customer:7']);
  assert.match(O.finPartyChoices(CUSTOMERS, VENDORS)[0].search, /Acme Pharma Ltd.*Pune.*27AAAAA0000A1Z5/);
});

test('a party picked from the list is its kind and its number, and a cleared one is none', () => {
  assert.deepEqual(O.finPartyOfChoice('customer:7'), { party_type: 'customer', party_id: 7 });
  assert.deepEqual(O.finPartyOfChoice('vendor:312'), { party_type: 'vendor', party_id: 312 });
  for (const none of ['', null, undefined, 'customer', 'customer:', 'customer:0', 'customer:-1', 'customer:1.5', 'supplier:3', 'vendor:3x', 3, {}]) {
    assert.equal(O.finPartyOfChoice(none), null, String(none));
  }
  assert.equal(O.finPartyChoiceOf({ party_type: 'vendor', party_id: 3 }), 'vendor:3');
  for (const none of [null, undefined, {}, { party_type: 'vendor' }, { party_id: 3 }, { party_type: 'vendor', party_id: null }]) assert.equal(O.finPartyChoiceOf(none), '');
});

// ── The month ends of a trial balance ────────────────────────────────────────────────────────────────────────────────

const period = (end, label) => ({ label, end_date: end, start_date: `${end.slice(0, 8)}01` });
const YEARS = [
  { id: 2, label: '2027-28', start_date: '2027-04-01', end_date: '2028-03-31', periods: [period('2027-04-30', 'Apr 2027'), period('2027-05-31', 'May 2027')] },
  { id: 1, label: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31',
    periods: [period('2026-11-30', 'Nov 2026'), period('2026-12-31', 'Dec 2026'), period('2027-01-31', 'Jan 2027'), period('2027-02-28', 'Feb 2027'), period('2027-03-31', 'Mar 2027')] },
];

test('a month-end trial balance may be as at the end of any month of the book\'s years that ends on or after the day the books begin', () => {
  const ends = O.finMonthEnds(YEARS, '2027-01-01');
  assert.deepEqual(ends.map(e => [e.value, e.label, e.hint]), [
    ['2027-01-31', '31 Jan 2027', 'Jan 2027'], ['2027-02-28', '28 Feb 2027', 'Feb 2027'], ['2027-03-31', '31 Mar 2027', 'Mar 2027'],
    ['2027-04-30', '30 Apr 2027', 'Apr 2027'], ['2027-05-31', '31 May 2027', 'May 2027']]);
  assert.deepEqual(O.finMonthEnds(YEARS, '2026-12-31').map(e => e.value).slice(0, 2), ['2026-12-31', '2027-01-31'], 'a month ending on the very day the books begin is the first day they keep');
  assert.deepEqual(O.finMonthEnds(YEARS, '2027-03-01').map(e => e.value).slice(0, 2), ['2027-03-31', '2027-04-30']);
  for (const none of [null, undefined, [], 'years', {}]) assert.deepEqual(O.finMonthEnds(none, '2027-01-01'), []);
  assert.deepEqual(O.finMonthEnds([{ id: 1, start_date: '2026-04-01' }], '2027-01-01'), [], 'a year with no months');
  assert.deepEqual(O.finMonthEnds([{ id: 1, start_date: '2026-04-01', periods: [{ label: 'x', end_date: 'soon' }] }], '2027-01-01'), []);
  assert.deepEqual(O.finMonthEnds(YEARS, 'tomorrow'), [], 'books that begin on no day');
});

test('the month end offered first is the latest that has come, else the first the books keep', () => {
  const ends = O.finMonthEnds(YEARS, '2027-01-01');
  assert.equal(O.finDefaultMonthEnd(ends, '2027-03-02'), '2027-02-28');
  assert.equal(O.finDefaultMonthEnd(ends, '2027-03-31'), '2027-03-31', 'the month end itself');
  assert.equal(O.finDefaultMonthEnd(ends, '2027-01-30'), '2027-01-31', 'before the first month end: the first, so there is always something to choose');
  assert.equal(O.finDefaultMonthEnd(ends, '2026-10-18'), '2027-01-31', 'before the books begin');
  assert.equal(O.finDefaultMonthEnd(ends, '2030-01-01'), '2027-05-31');
  assert.equal(O.finDefaultMonthEnd([], '2027-03-02'), '');
  assert.equal(O.finDefaultMonthEnd(null, '2027-03-02'), '');
});

// ── What is sent to start an import ──────────────────────────────────────────────────────────────────────────────────

test('the opening upload: the three files, the bills of every bills file together, and the names of the files', () => {
  const body = O.finUploadBody({
    bookId: 4, asAt: '2026-12-31',
    accounts: { rows: [{ tally_name: 'Alpha Bank', tally_group: 'Bank Accounts' }], fileName: 'List of Accounts.xlsx' },
    tb: { rows: [{ tally_name: 'Alpha Bank', debit_paise: 100, credit_paise: 0 }], fileName: 'Trial Balance.xlsx' },
    bills: [{ rows: [{ tally_ledger_name: 'Acme Pharma Ltd', amount_paise: 50, side: 'dr' }], fileName: 'Receivable.xlsx' },
      { rows: [{ tally_ledger_name: 'Beta Supplies', amount_paise: -70, side: 'cr' }], fileName: 'Payable.xlsx' }],
  });
  assert.deepEqual(body, {
    book_id: 4, purpose: 'opening', as_at: '2026-12-31', file_names: ['List of Accounts.xlsx', 'Trial Balance.xlsx', 'Receivable.xlsx', 'Payable.xlsx'],
    accounts: [{ tally_name: 'Alpha Bank', tally_group: 'Bank Accounts' }], tb: [{ tally_name: 'Alpha Bank', debit_paise: 100, credit_paise: 0 }],
    bills: [{ tally_ledger_name: 'Acme Pharma Ltd', amount_paise: 50, side: 'dr' }, { tally_ledger_name: 'Beta Supplies', amount_paise: -70, side: 'cr' }],
  });
  const none = O.finUploadBody({ bookId: 4, asAt: '2026-12-31', accounts: { rows: [], fileName: 'a.xlsx' }, tb: { rows: [], fileName: 'b.xlsx' }, bills: [] });
  assert.deepEqual(none.bills, [], 'bills are optional');
  assert.deepEqual(none.file_names, ['a.xlsx', 'b.xlsx']);
  // The server takes twenty names and 255 characters to a name.
  const many = O.finUploadBody({
    bookId: 4, asAt: '2026-12-31', accounts: { rows: [], fileName: 'a'.repeat(300) }, tb: { rows: [], fileName: 'b.xlsx' },
    bills: Array.from({ length: 25 }, (_, i) => ({ rows: [], fileName: `bills ${i}.xlsx` })),
  });
  assert.equal(many.file_names.length, 20);
  assert.equal(many.file_names[0].length, 255);
});

test('the opening upload is ready when the List of Accounts and the Trial Balance have been read; the bills are optional', () => {
  const ok = { rows: [{ tally_name: 'A' }], fileName: 'a.xlsx' };
  assert.equal(O.finUploadReady({ accounts: ok, tb: ok }), true);
  assert.equal(O.finUploadReady({ accounts: ok, tb: null }), false);
  assert.equal(O.finUploadReady({ accounts: null, tb: ok }), false);
  assert.equal(O.finUploadReady({ accounts: { rows: [], fileName: 'a.xlsx' }, tb: ok }), false, 'a file with no rows in it is no file');
  assert.equal(O.finUploadReady({ accounts: ok, tb: ok, bills: [null, { rows: [], fileName: 'b.xlsx' }] }), true);
  assert.equal(O.finUploadReady({}), false);
  assert.equal(O.finUploadReady(), false);
});

test('the bills files that have been read: only those with rows, in the order they were chosen', () => {
  const slots = { 1: { rows: [{ a: 1 }], fileName: 'one.xlsx' }, 2: null, 3: { rows: [], fileName: 'empty.xlsx' }, 4: { rows: [{ a: 2 }], fileName: 'four.xlsx' } };
  assert.deepEqual(O.finBillsRead(slots, [1, 2, 3, 4]).map(f => f.fileName), ['one.xlsx', 'four.xlsx']);
  assert.deepEqual(O.finBillsRead(slots, [4, 1]).map(f => f.fileName), ['four.xlsx', 'one.xlsx']);
  assert.deepEqual(O.finBillsRead({}, [1, 2]), []);
  assert.deepEqual(O.finBillsRead(undefined, undefined), []);
});

// Fix round, M7. A bills file could be replaced and never taken back: a person who chose the wrong one, or added a slot they do not need,
// had no way to drop it. A slot goes; the only slot is emptied instead, as a NEW slot, so there is always a place to choose a file and a
// screen that keeps what a slot has read (a slot's key) draws the emptied one from nothing.
test('a bills file is taken off the screen: its slot goes, and the only slot is emptied as a new one', () => {
  const file = (name, n = 1) => ({ rows: Array.from({ length: n }, (_, i) => ({ a: i })), fileName: name });
  const slots = { 1: file('one.xlsx'), 2: null, 3: file('three.xlsx') };
  // one of several: gone, and the others keep their files and their order
  assert.deepEqual(O.finRemoveBillsSlot(slots, [1, 2, 3], 2, 9), { slots: { 1: file('one.xlsx'), 3: file('three.xlsx') }, order: [1, 3] });
  const first = O.finRemoveBillsSlot(slots, [1, 2, 3], 1, 9);
  assert.deepEqual(first.order, [2, 3]);
  assert.deepEqual(O.finBillsRead(first.slots, first.order).map(f => f.fileName), ['three.xlsx'], 'what is sent no longer holds the file taken off');
  assert.equal(1 in first.slots, false, 'and the slot holds nothing of it');
  // the order of the files is the order they were chosen in, whichever is removed
  assert.deepEqual(O.finRemoveBillsSlot(slots, [3, 1, 2], 1, 9).order, [3, 2]);
  // the only slot is not removed: it is emptied, as a slot that has never been used (a key the screen has not drawn)
  assert.deepEqual(O.finRemoveBillsSlot({ 1: file('one.xlsx') }, [1], 1, 9), { slots: { 9: null }, order: [9] });
  assert.deepEqual(O.finBillsRead(...Object.values(O.finRemoveBillsSlot({ 1: file('one.xlsx') }, [1], 1, 9))), []);
  // a slot that is not on the screen changes nothing
  assert.deepEqual(O.finRemoveBillsSlot(slots, [1, 2, 3], 7, 9), { slots, order: [1, 2, 3] });
  // the lists it was given are not touched
  const order = [1, 2, 3];
  O.finRemoveBillsSlot(slots, order, 3, 9);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(Object.keys(slots), ['1', '2', '3']);
  // a slot with a file turned back (nothing read into it) goes like any other
  assert.deepEqual(O.finRemoveBillsSlot({ 1: file('one.xlsx'), 2: null }, [1, 2], 2, 9), { slots: { 1: file('one.xlsx') }, order: [1] });
  for (const none of [undefined, null, 'slots']) assert.deepEqual(O.finRemoveBillsSlot(none, none, 1, 9), { slots: {}, order: [] }, String(none));
});

test('a month-end trial balance upload: the one file, no accounts and no bills', () => {
  assert.deepEqual(O.finParallelBody({ bookId: 4, asAt: '2027-01-31', tb: { rows: [{ tally_name: 'Alpha Bank', debit_paise: 1, credit_paise: 0 }], fileName: 'TB Jan.xlsx' } }), {
    book_id: 4, purpose: 'parallel_tb', as_at: '2027-01-31', file_names: ['TB Jan.xlsx'], tb: [{ tally_name: 'Alpha Bank', debit_paise: 1, credit_paise: 0 }],
  });
  const body = O.finParallelBody({ bookId: 4, asAt: '2027-01-31', tb: { rows: [], fileName: 'x'.repeat(400) } });
  assert.equal(body.file_names[0].length, 255);
  assert.equal('accounts' in body || 'bills' in body, false);
});

// ── What became of the Opening voucher ───────────────────────────────────────────────────────────────────────────────

test('the Opening voucher, in the words of the screen: waiting, posted, sent back, reversed or discarded', () => {
  const outcome = v => O.finOpeningOutcome(v);
  assert.deepEqual(outcome({ status: 'submitted', number: null }), { state: 'waiting', text: 'Waiting for MD approval' });
  assert.deepEqual(outcome({ status: 'posted', number: 'CI-OB-2627-0001', reversed_by_id: null }), { state: 'posted', text: 'Posted as CI-OB-2627-0001' });
  assert.deepEqual(outcome({ status: 'posted', number: 'CI-OB-2627-0001', reversed_by_id: 12 }), { state: 'reversed', text: 'CI-OB-2627-0001 was posted and has since been reversed' });
  assert.deepEqual(outcome({ status: 'draft', last_reject_reason: 'Alpha Bank is ₹1,000 out' }), { state: 'returned', text: 'The MD sent it back: Alpha Bank is ₹1,000 out' });
  assert.deepEqual(outcome({ status: 'draft', last_reject_reason: null }), { state: 'returned', text: 'It was sent back to draft' });
  assert.deepEqual(outcome({ status: 'discarded' }), { state: 'discarded', text: 'The Opening voucher was discarded' });
  assert.equal(outcome({ status: 'surprise' }).state, 'unknown');
  assert.equal(outcome(null), null);
  assert.equal(outcome(undefined), null);
});

test('files can be uploaded again only when the Opening voucher is gone: sent back, discarded or reversed (ruling R37)', () => {
  const frees = status => O.finOutcomeFreesUpload(O.finOpeningOutcome({ status, number: 'CI-OB-2627-0001', reversed_by_id: status === 'reversed' ? 3 : null }));
  assert.equal(frees('draft'), true);
  assert.equal(frees('discarded'), true);
  assert.equal(O.finOutcomeFreesUpload({ state: 'reversed' }), true);
  assert.equal(frees('submitted'), false, 'it is waiting for the MD: another cannot be built beside it');
  assert.equal(frees('posted'), false, 'it holds the books\' opening');
  assert.equal(O.finOutcomeFreesUpload(null), false);
  assert.equal(O.finOutcomeFreesUpload({ state: 'unknown' }), false);
});

test('what building does, said before the button is pressed, by the part the login plays', () => {
  const approver = O.finBuildNote(['approver', 'admin']);
  const accountant = O.finBuildNote(['accountant']);
  assert.match(approver, /post it at once|posts at once/);
  assert.match(accountant, /waits for the MD|goes to the MD/);
  assert.notEqual(approver, accountant);
  assert.equal(O.finBuildNote(null), accountant);
  assert.equal(O.finBuildNote(['viewer']), accountant);
});

// ── The check ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a row\'s figures in a sentence: its balance, Dr or Cr, or both sides when it carries both', () => {
  assert.equal(O.finFiguresText({ debit_paise: 659000 * R, credit_paise: 0 }), '₹6,59,000.00 Dr');
  assert.equal(O.finFiguresText({ debit_paise: 0, credit_paise: 300000 * R }), '₹3,00,000.00 Cr');
  assert.equal(O.finFiguresText({ debit_paise: 659001 * R, credit_paise: 659000 * R }), 'Dr ₹6,59,001.00, Cr ₹6,59,000.00');
  assert.equal(O.finFiguresText({ debit_paise: 0, credit_paise: 0 }), '₹0.00');
  assert.equal(O.finFiguresText({}), '₹0.00');
});

test('the difference between the sides of a trial balance', () => {
  assert.equal(O.finTotalsGap({ dr: 659001 * R, cr: 659000 * R }), 1 * R);
  assert.equal(O.finTotalsGap({ dr: 100, cr: 250 }), 150);
  assert.equal(O.finTotalsGap({ dr: 7, cr: 7 }), 0);
  assert.equal(O.finTotalsGap(null), 0);
  assert.equal(O.finTotalsGap({}), 0);
});

// ── Source pins: the screens are held to the rules above ─────────────────────────────────────────────────────────────

const read = path => readFileSync(new URL(`../../client/src/${path}`, import.meta.url), 'utf8');
const code = path => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('opening.js is pure: no React, no DOM, and nothing but this folder\'s own files', () => {
  const text = code('lib/finance/opening.js');
  const imports = [...text.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map(m => m[1]);
  assert.ok(imports.length > 0, 'non-vacuous');
  for (const spec of imports) assert.match(spec, /^\.\/[\w]+\.js$/, spec);
  assert.doesNotMatch(text, /\bwindow\b|\bdocument\b|\bReact\b|Object\.hasOwn\s*\(/);
  assert.doesNotMatch(text, /sundry|parent_id/i, 'and no walk up the group tree, no group name: whether a group is a party\'s is the server\'s word (is_party)');
});

const SOURCES = {
  upload: code('components/finance/TallyUpload.jsx'),
  openingUpload: code('components/finance/OpeningUpload.jsx'),
  match: code('components/finance/OpeningMatch.jsx'),
  check: code('components/finance/OpeningCheck.jsx'),
  build: code('components/finance/OpeningBuild.jsx'),
  page: code('pages/finance/OpeningBalances.jsx'),
  parallelUpload: code('components/finance/ParallelUpload.jsx'),
};
const count = (text, pattern) => (text.match(pattern) || []).length;

test('no screen of this task loads ExcelJS or the exporter up front, keeps anything in localStorage, or draws a layer of its own', () => {
  for (const [name, text] of Object.entries(SOURCES)) {
    assert.doesNotMatch(text, /from\s+['"][^'"]*(exceljs|exporter)[^'"]*['"]/i, `${name} imports ExcelJS or the exporter statically`);
    assert.doesNotMatch(text, /\blocalStorage\b|\bsessionStorage\b/, `${name} reaches into the browser's storage`);
    assert.doesNotMatch(text, /createPortal|className=[{"'`][^>]*\bfixed\b/, `${name} draws a layer: it would need data-ci-overlay or data-ci-chrome`);
    assert.doesNotMatch(text, /Object\.hasOwn\s*\(/, name);
  }
});

test('the upload reads the file on the pick: ExcelJS by a dynamic import, the first sheet, the header found, the first 10 rows shown, the page told', () => {
  const t = SOURCES.upload;
  assert.match(t, /const ExcelJS = \(await import\('exceljs'\)\)\.default;/, 'the lib/exporter.js pattern');
  assert.equal(count(t, /import\('exceljs'\)/g), 1);
  assert.match(t, /await book\.xlsx\.load\(await picked\.arrayBuffer\(\)\);/);
  assert.match(t, /const first = book\.worksheets\[0\];/, 'the first worksheet');
  assert.match(t, /finSheetRows\(first\)/);
  assert.match(t, /book\.worksheets\.length > 1/, 'and it says so when the workbook has more than one');
  assert.match(t, /finFindHeaderRow\(rows, kind\)/);
  assert.match(t, /finGuessLayout\(rows, kind\)/, 'no header found: the selects, filled in with the best guess');
  assert.match(t, /setChanging\(!found\)/, 'and open at once');
  assert.match(t, /finReadSheet\(rows, kind, next\)/, 'the rows come from the one reader');
  assert.match(t, /const PREVIEW_ROWS = 10;/);
  assert.match(t, /rows\.slice\(0, PREVIEW_ROWS\)/);
  assert.match(t, /finTallyFileProblem\(picked\.name\)/, 'an .xls is turned back with the sentence tally.js owns');
  assert.match(t, /accept="\.xlsx,\.xls"/, 'an .xls can be picked, so that it can be told what to do');
  assert.match(t, /import \{ finFormatINR \} from/);
});

test('a bills file can be removed, not only replaced: a Remove on the slot, the slot dropped by the one rule, and a read still in flight dropped with it', () => {
  const t = SOURCES.openingUpload;
  assert.match(t, /import \{ finBillsRead, finRemoveBillsSlot, finUploadBody, finUploadReady \} from/);
  assert.match(t, /const removeSlot = key => \{\s*const after = finRemoveBillsSlot\(slots, order, key, next\.current\+\+\);\s*setSlots\(after\.slots\);\s*setOrder\(after\.order\);\s*\};/,
    'the one rule says what is left; a new slot has a key nobody has used');
  assert.match(t, /onRemove=\{\(\) => removeSlot\(key\)\} removable=\{order\.length > 1\}/, 'every bills slot can be taken off, and an empty one too when there are several');
  assert.equal(count(t, /onRemove=/g), 1, 'the bills slots only: the List of Accounts and the Trial Balance are required, and are replaced');
  const u = SOURCES.upload;
  assert.match(u, /export default function TallyUpload\(\{ kind, label, hint, optional = false, removable = false, disabled = false, onRows, onRemove \}\)/);
  assert.match(u, /const canRemove = Boolean\(onRemove\) && \(removable \|\| phase !== 'empty' \|\| Boolean\(problem\)\);/,
    'offered when there is a file in hand (or one that was turned back), or the slot may go');
  assert.match(u, /<button type="button" disabled=\{disabled\} onClick=\{onRemove\} aria-label=\{`Remove \$\{label\}`\}/);
  assert.match(u, /useEffect\(\(\) => \(\) => \{ picks\.current \+= 1; \}, \[\]\);/, 'a slot taken off while its file is being read is not told about it afterwards');
});

test('the upload tells the page about every change: the rows with the file\'s name, and nothing when the file in hand cannot be read', () => {
  const t = SOURCES.upload;
  assert.match(t, /onRows\(out\.rows \?\? null, \{ fileName: name \}\);/, 'one place hands rows over, and a refusal or a pending choice hands nothing');
  assert.match(t, /const mine = \+\+picks\.current;\s*onRows\(null\);/, 'a new pick takes the old rows back at once');
  assert.match(t, /No rows were found under the header/, 'a header with nothing under it is said, not sent');
  assert.equal(count(t, /onRows\(/g), 2, 'the only two calls');
  assert.match(t, /if \(mine !== picks\.current\) return;/, 'a read that comes back for an older pick is dropped');
  assert.match(t, /onLayout=\{next => apply\(sheet, next, fileName\)\}/, 'changing a column reads the sheet again and tells the page');
  assert.doesNotMatch(t, /api\./, 'nothing here talks to the server');
});

test('the Opening upload: three files, bills in as many files as there are, As at fixed (ruling R34) and POST /finance/imports, written the way a Finance form is', () => {
  const t = SOURCES.openingUpload;
  assert.equal(count(t, /<TallyUpload /g), 3, 'accounts, trial balance, and the bills slot that is repeated');
  for (const kind of ['accounts', 'tb', 'bills']) assert.match(t, new RegExp(`kind="${kind}"`), kind);
  assert.match(t, /<TallyUpload key=\{key\} kind="bills" optional /, 'bills are optional, one slot for each file');
  assert.match(t, /finBillsRead\(slots, order\)/, 'every file\'s rows go together, in the order the files were chosen');
  assert.match(t, /api\.post\('\/finance\/imports', finUploadBody\(\{ bookId: book\.id, asAt, accounts, tb, bills \}\)\)/);
  assert.doesNotMatch(t, /type="date"|<Input/, 'As at is shown and has no picker');
  assert.match(t, /<strong>\{finDateText\(asAt\)\}<\/strong>/, 'the day is shown');
  assert.match(t, /<Button onClick=\{upload\} disabled=\{!ready\}>/, 'the button hands back the promise of the write (async upload)');
  assert.match(t, /const upload = async \(\) => \{/);
  assert.match(t, /const \{ problems, attempt \} = useFormWrite\(\);/, 'the one way a Finance form saves: a refusal stays on the screen, a dropped connection is said, and the files stay');
  assert.match(t, /const done = await attempt\(async \(\) => \{\s*id = \(await api\.post\(/);
  assert.match(t, /setUploading\(false\);\s*if \(!done\) \{ setRefusedFor\(files\); return; \}\s*await onUploaded\(id\);/);
  assert.match(t, /const refusal = refusedFor === files \? Object\.values\(problems\)\[0\] : undefined;/, 'a refusal is about the files that were sent: a change of file answers it');
  assert.doesNotMatch(t, /noAnswer|useNoAnswer/, 'useFormWrite says a write with no answer');
  assert.match(t, /disabled=\{uploading\}/, 'the files are not changed while they are being sent');
  assert.equal(count(t, /onRows=\{(?:into\(set\w+\)|readInto\(key\))\}/g), 3, 'every slot goes through one reader');
});

test('the Match step: every row is sent once, the group party-ness is the server\'s for the proposed group and the groups\' for a chosen one, the table never sorts', () => {
  const t = SOURCES.match;
  assert.match(t, /api\.put\(`\/finance\/imports\/\$\{view\.import\.id\}\/matches`, \{ matches: sent \}\)/);
  assert.match(t, /const sent = match\.matches;/, 'what finMatchView says the confirmation is');
  assert.match(t, /<Button onClick=\{confirm\} disabled=\{!match\.ready\}>/, 'Confirm waits for every row to be decidable');
  assert.match(t, /const confirm = async \(\) => \{/, 'and hands back the promise of the write');
  assert.match(t, /finMatchView\(rows, touched, groups, \{ ledgerById \}\)/);
  assert.match(t, /finRowIsParty\(r, d, match\.partyGroups\)/, 'the party picker is drawn where the group is a party group, by the one rule');
  assert.doesNotMatch(t, /Sundry|is_party|FIN_PARTY_GROUP|\bsides?\b/, 'the screen holds no definition of a party group: the server marks them (the groups read\'s is_party) and opening.js takes the mark');
  assert.match(t, /const columns = finUnsorted\(\[/);
  assert.doesNotMatch(t, /sortable:\s*true/);
  assert.match(t, /<LedgerPicker bookId=\{book\.id\} ledgers=\{ledgers\} value=\{d\.ledger_id\}/, 'the book\'s ledgers are read once and handed to every picker');
  assert.match(t, /finGroupChoices\(groups\)/);
  assert.match(t, /finPartyChoices\(parties\.customers, parties\.vendors, current\)/);
  assert.match(t, /const parties = useParties\('both'\);/, 'the ERP\'s own customers and vendors, both, by the one hook');
});

// Fix round, M8. The ledger form and the Match step each carried a copy of the reader of the ERP's customers and vendors, and two copies
// drift (a failed read, a kind that changes under a form). One hook reads them, and nothing else in Finance asks the server for them.
test('the ERP\'s customers and vendors are read in ONE place, by the hook the ledger form and the Match step both use', () => {
  const files = readdirSync(new URL('../../client/src/components/finance/', import.meta.url)).filter(f => /\.jsx?$/.test(f));
  const text = f => code(`components/finance/${f}`);
  assert.ok(files.length > 20, 'non-vacuous');
  assert.deepEqual(files.filter(f => /function useParties\b/.test(text(f))), ['useParties.js'], 'one definition');
  assert.deepEqual(files.filter(f => /\/customers['"`]|\/vendors['"`]/.test(text(f))), ['useParties.js'], 'and the only place that asks for them');
  assert.deepEqual(files.filter(f => /import useParties from '\.\/useParties\.js';/.test(text(f))).sort(), ['LedgerForm.jsx', 'OpeningMatch.jsx']);
  assert.match(text('LedgerForm.jsx'), /const parties = useParties\(fields\.party \? form\.party_type : ''\);/, 'asked for only when a party kind is being chosen');
  assert.doesNotMatch(read('pages/finance/OpeningBalances.jsx'), /useParties/);
  const hook = text('useParties.js');
  assert.match(hook, /export default function useParties\(kind\) \{/);
  assert.match(hook, /const asked = kind => \(kind === 'both' \? \['customer', 'vendor'\] : kind === 'customer' \|\| kind === 'vendor' \? \[kind\] : \[\]\);/,
    'a kind, both, or nothing: anything else reads nothing');
  assert.match(hook, /if \(asks\.length === 0\) return undefined;/);
  assert.match(hook, /Promise\.all\(asks\.map\(k => api\.get\(PATH\[k\]\)\)\)/);
  assert.match(hook, /const mine = state\.kind === kind;/, 'the lists of the kind before are not shown under another');
  assert.match(hook, /\.catch\(\(\) => \{ if \(live\) setState\(\{ kind, \.\.\.none, failed: true \}\); \}\);/, 'a read that fails is failed, with empty lists, never an empty list that looks like none');
  assert.match(hook, /return \(\) => \{ live = false; \};/, 'and an answer that comes back for a kind no longer asked for is dropped');
  assert.match(hook, /list: kind === 'customer' \? customers : kind === 'vendor' \? vendors : null,/);
  assert.match(hook, /retry: \(\) => setAttempt\(n => n \+ 1\)/);
});

test('the Match step marks the row the server refused, and answers the refusal when anything is changed', () => {
  const t = SOURCES.match;
  assert.match(t, /const \{ problems, attempt \} = useFormWrite\(\);/);
  assert.match(t, /const done = await attempt\(\(\) => api\.put\(`\/finance\/imports\/\$\{view\.import\.id\}\/matches`, \{ matches: sent \}\), \{ onFail: reload \}\);/,
    'the view is read again after a refusal, since another login may have changed the import');
  assert.match(t, /const sent = match\.matches;\s*if \(!sent\) return;/, 'nothing is sent while a row stops the confirmation, whatever pressed the button');
  assert.match(t, /if \(!done\) \{ setRefusedFor\(touched\); return; \}/);
  assert.match(t, /const \[refusedField, refusal\] = refusedFor === touched \? Object\.entries\(problems\)\[0\] \?\? \[\] : \[\];/, 'touched is a new value at every edit, so a change answers the refusal');
  assert.match(t, /finRefusedRowId\(\{ data: \{ field: refusedField \} \}, sentRef\.current\)/, 'the field the server names is the entry sent, which is a row');
  assert.match(t, /rowClass=\{r => \(match\.states\.get\(r\.id\)\?\.tone === 'red' \|\| refusedRow === r\.id \? 'ci-row-alarm-soft' : ''\)\}/);
  assert.match(t, /role="alert"/);
  assert.match(t, /Show that row/);
  assert.doesNotMatch(t, /noAnswer|useNoAnswer/, 'useFormWrite says a write with no answer');
  assert.match(t, /<LoadNotice failed=\{parties\.failed\} shown=\{false\} what="the customers and vendors, so none can be linked" onRetry=\{parties\.retry\} \/>/);
});

test('the Match step\'s filters keep the rows as they stood when chosen, and its search is the screen\'s own, so an empty result never says there is nothing', () => {
  const t = SOURCES.match;
  assert.match(t, /useEffect\(\(\) => \{ edits\.current = touched; \}, \[touched\]\);/, 'the edits are read from a ref, written by an effect and not during a render');
  assert.match(t, /\[rows, groups, ledgerById, filter, refresh\]/, 'the rows a filter shows are looked at when it is chosen, never on an edit');
  assert.match(t, /const choose = key => \{ if \(key === filter\) setRefresh\(n => n \+ 1\); else setFilter\(key\); \};/);
  assert.match(t, /const query = useDeferredValue\(search\);/);
  assert.match(t, /searchValue=\{search\} onSearchChange=\{setSearch\}/);
  assert.doesNotMatch(t, /\bsearchable\b/);
  assert.match(t, /finSearchEmpty\(\{ searching: query\.trim\(\) !== '', total: base\.length, none: FILTER_NONE\[filter\], noun: 'rows' \}\)/);
  assert.match(read('components/finance/OpeningMatch.jsx'), /import \{ finSearchEmpty \} from '\.\.\/\.\.\/lib\/finance\/page\.js';/, 'Task 16\'s one helper, not a sentence of its own');
});

test('the Check step: problems red, warnings amber, both sides, and what was left out; Build waits for a tie-out with no problem', () => {
  const t = SOURCES.check;
  assert.match(t, /<Notes tone="red" title="Problems: /);
  assert.match(t, /<Notes tone="amber" title="Warnings: /);
  assert.match(t, /finFormatINR\(totals\.dr\)/);
  assert.match(t, /finFormatINR\(totals\.cr\)/);
  assert.match(t, /summary\.ignored_with_amounts/, 'a TB_UNBALANCED can be traced to what was left out (ruling R43)');
  assert.match(t, /summary\.unknown/, 'a trial balance row in no List of Accounts (ruling R36)');
  assert.match(t, /summary\.zero_bills/);
  assert.match(t, /<Button onClick=\{onNext\} disabled=\{!ties\}>Continue to build<\/Button>/);
  assert.match(t, /<Button variant="secondary" onClick=\{reload\}>Check again<\/Button>/, 'and the promise of the new read keeps the button busy');
  assert.match(t, /role=\{tone === 'red' \? 'alert' : undefined\}/);
  assert.doesNotMatch(t, /api\./, 'the check only draws what the import view says');
});

// Fix round, M6. tie_out is null for an import that is no opening one, and a screen that read through it would be a TypeError and a blank
// page. Every read of it is `?.`, and an import with none says so and offers the two ways back.
test('a tie-out that is not there is read as nothing and said so: no bare read of tie_out in the Check or the Build step', () => {
  for (const [name, text] of [['check', SOURCES.check], ['build', SOURCES.build], ['page', SOURCES.page]]) {
    assert.doesNotMatch(text, /\btie(?:_out)?\.[a-z]/, `${name} reads tie_out without ?.`);
    assert.doesNotMatch(text, /\.tie_out\.[a-z]/, `${name} reads tie_out without ?.`);
  }
  const check = SOURCES.check;
  assert.match(check, /const tie = view\.tie_out;/);
  assert.match(check, /const totals = tie\?\.totals;/);
  assert.match(check, /const ties = tie\?\.ok === true;/);
  assert.match(check, /\(tie\?\.problems \?\? \[\]\)\.map\(/);
  assert.match(check, /\(tie\?\.warnings \?\? \[\]\)\.map\(/);
  assert.match(check, /if \(!tie\) \{[^}]*could not be read[\s\S]*?onClick=\{onBack\}[\s\S]*?onClick=\{reload\}/, 'and offers the way back and a second read');
  assert.match(SOURCES.build, /const found = tie\?\.problems\?\.length;/);
  assert.match(SOURCES.build, /typeof found === 'number'/, 'a Check that was not read is not "0 problems"');
});

test('the Build step: enabled only for a matched import that ties out, a minting POST, the voucher number or "Waiting for MD approval" with a link, and no upload until it is gone', () => {
  const t = SOURCES.build;
  assert.match(t, /const canBuild = imp\.status === 'matched' && tie\?\.ok === true;/, 'ruling R33: matched AND tie_out.ok');
  assert.match(t, /<Button onClick=\{build\} disabled=\{!canBuild\}>Build the Opening voucher<\/Button>/);
  assert.match(t, /api\.post\(`\/finance\/imports\/\$\{imp\.id\}\/build-opening`\)/);
  assert.match(t, /const build = async \(\) => \{/);
  assert.match(t, /const \{ problems, attempt \} = useFormWrite\(\);/);
  assert.match(t, /const done = await attempt\(async \(\) => \{ voucher = \(await api\.post\(`\/finance\/imports\/\$\{imp\.id\}\/build-opening`\)\)\.voucher; \}, \{ onFail: onRefused \}\);/,
    'the import is read again whatever the refusal');
  assert.match(t, /if \(done\) await onBuilt\(voucher\);/);
  assert.doesNotMatch(t, /noAnswer|useNoAnswer/, 'useFormWrite says a write with no answer');
  assert.match(t, /<Link to=\{`\/finance\?voucher=\$\{id\}`\}/, 'the Vouchers page opens a voucher from ?voucher=');
  assert.match(code('pages/finance/OpeningBalances.jsx'), /const outcome = finOpeningOutcome\(voucher\);/, 'the words ("Waiting for MD approval", "Posted as …") are opening.js\'s');
  assert.match(t, /export function OpeningBuilt\(\{ imp, outcome, failed, onRetry, onUploadAgain \}\)/, 'what became of the voucher is the wizard\'s to read, so it can close the Upload step too');
  assert.match(t, /\{finOutcomeFreesUpload\(outcome\) && \(/, 'upload again only once the Opening voucher is gone (ruling R37)');
  assert.match(t, /finBuildNote\(book\.roles\)/);
});

test('the wizard: every read through useReport, resumed by the one rule, steps opened by the one rule, edits held above the steps, Check and Build never on unconfirmed edits', () => {
  const t = SOURCES.page;
  assert.match(t, /export default function OpeningBalances\(\{ me, book, can \}\)/);
  assert.match(t, /if \(!can\('import'\)\) return/);
  assert.equal(count(t, /useReport\(/g), 5, 'the uploads, the import, the groups and ledgers of the book, and the Opening voucher of a used import');
  assert.doesNotMatch(t, /api\./, 'the steps make the writes; the wizard only reads');
  assert.match(t, /useReport\(`\/finance\/imports\?\$\{new URLSearchParams\(\{ book: String\(book\.id\), purpose: 'opening' \}\)\}`\)/);
  assert.match(t, /const resume = imports \? finResumeImport\(imports\) : null;/);
  assert.match(t, /const importId = chosen \?\? resume\?\.id \?\? null;/);
  assert.match(t, /finBuiltImport\(imports\)/);
  assert.match(t, /finStepsOpen\(\{ imp, dirty, canUpload \}\)/);
  // final wave item 14: the step a matched import lands on knows about unconfirmed edits, and edits restored from the session count as
  // unconfirmed until the rows and groups have come to say otherwise, so the wizard never lands on a Check of the old matches first
  assert.match(t, /const where = importId == null \? \(usedImport \? 'build' : 'upload'\) : \(imp \? finStepOfImport\(imp, \{ dirty \}\) : null\);/);
  assert.match(t, /const dirty = Object\.keys\(touched\)\.length > 0 && \(!\(full && groups\) \|\| finChangedRows\(full\.ledgers, touched, groups\)\.length > 0\);/);
  assert.match(t, /const canUpload = !builtImp \|\| finOutcomeFreesUpload\(outcome\);/, 'the files are uploaded again only once the Opening voucher is gone (ruling R37)');
  assert.match(t, /voucherRead\.data\?\.voucher \?\? \(built && built\.id === voucherId \? built : null\)/, 'what the build answered stands in until the voucher itself has been read');
  assert.match(t, /finChangedRows\(full\.ledgers, touched, groups\)/);
  assert.match(t, /useEffect\(\(\) => \{ setStep\(null\); setBuilt\(null\); \}, \[importId\]\);/, 'another import is another step; its edits are its own (the edit scope)');
  assert.match(t, /finOpeningAsAt\(book\.books_begin\)/);
  assert.match(t, /<LoadNotice failed=\{list\.failed\} shown=\{Boolean\(imports\)\} what="the earlier uploads" onRetry=\{list\.reload\} \/>/);
  assert.match(t, /<LoadNotice failed=\{view\.failed\} shown=\{Boolean\(full\)\} what="the import" onRetry=\{view\.reload\} \/>/);
  assert.match(t, /const refused = async \(\) => \{ await reloadAll\(\); setRecheck\(true\); \};/);
  assert.match(t, /if \(full\?\.tie_out\?\.ok === false\) setStep\('check'\);/, 'a build the tie-out refuses (the server works it out again, and refuses a stale one) sends the person to where the problems are');
  assert.match(t, /await list\.reload\(\);/);
});

// Fix round, M4. The edits are the wizard's, held above the step so that leaving it loses nothing, and now kept in the tab's session so that a
// reload loses nothing either. They belong to one import at one status: confirmed, built, or another upload is a new, empty set.
test('the wizard keeps the Match step\'s edits in the tab\'s session, per login, import and status, and forgets them when confirmed or discarded', () => {
  const t = SOURCES.page;
  assert.match(t, /import \{ sessionStore \} from '\.\.\/\.\.\/lib\/safeStorage\.js';/, 'the one storage door, never the browser\'s own');
  assert.match(t, /export default function OpeningBalances\(\{ me, book, can \}\)/);
  assert.match(t, /const editScope = imp && imp\.status !== 'used' \? finEditsKey\(me\?\.user\?\.id, imp\.id, imp\.status\) : null;/);
  assert.match(t, /const \[held, setHeld\] = useState\(\{ scope: null, touched: NO_EDITS \}\);/);
  assert.match(t, /if \(held\.scope !== editScope\) setHeld\(\{ scope: editScope, touched: editScope \? finEditsUnpack\(sessionStore\.getItem\(editScope\)\) : NO_EDITS \}\);/,
    'a scope that changes is read from the session, so the edits of one import are never laid over another');
  assert.match(t, /const touched = held\.scope === editScope \? held\.touched : NO_EDITS;/);
  assert.match(t, /const setTouched = useCallback\(update => setHeld\(h => \(\{ scope: h\.scope, touched: typeof update === 'function' \? update\(h\.touched\) : update \}\)\), \[\]\);/,
    'the step keeps its setState-shaped door, and an edit lands on the scope it was made in');
  assert.match(t, /const text = finEditsPack\(held\.touched\);\s*if \(text\) sessionStore\.setItem\(held\.scope, text\); else sessionStore\.removeItem\(held\.scope\);/, 'no edits is no copy');
  assert.match(t, /if \(held\.scope == null\) return;/, 'between imports the copy stays');
  assert.match(t, /if \(wrote\.current && wrote\.current !== held\.scope\) sessionStore\.removeItem\(wrote\.current\);/, 'another status or another import: the earlier copy goes');
  assert.match(t, /onConfirmed=\{\(\) => \{ setTouched\(\{\}\); setStep\('check'\); \}\}/, 'a confirmed set of matches is not an unconfirmed edit');
  assert.equal(count(t, /useState\(\{\}\)/g), 0, 'no copy of the edits outside the scope');
  assert.doesNotMatch(t, /setTouched\(\{\}\);\s*setStep\(null\)/, 'a new upload is a new scope, not a reset');
  assert.match(t, /const uploaded = async id => \{\s*setChosen\(id\); setUploading\(false\); setStep\(null\); setBuilt\(null\);/, 'and a new upload is a new import: its own scope, with nothing to reset');
  assert.match(code('pages/finance/Setup.jsx'), /<OpeningBalances me=\{me\} /, 'the login is the shell\'s');
});

test('the Match step is a form to the update bar while it holds unconfirmed edits, and the Upload step says its files are not kept', () => {
  const m = SOURCES.match;
  assert.match(m, /return \(\s*<div data-ci-form>/, 'a form scope (lib/reloadSafety.js): an unsent edit holds off an automatic reload');
  assert.match(m, /<input type="hidden" value=\{String\(changed\)\} readOnly \/>/, 'the one field the scope is read by: how many rows are unconfirmed, whatever the edits were');
  assert.match(m, /<div data-reload-safe>\s*<DataTable /, 'the table\'s own pickers come and go as it scrolls, so they are not the signal');
  assert.match(SOURCES.openingUpload, /The files you choose are read in this tab only/, 'the files themselves are not kept: a reload is a choosing again');
});

test('the wizard is mounted by Setup, and the month-end upload by the Parallel Run tab', () => {
  assert.match(code('pages/finance/Setup.jsx'), /\{tab === 'opening-balances' && <OpeningBalances me=\{me\} book=\{book\} can=\{can\} \/>\}/);
  assert.match(code('components/finance/ParallelRun.jsx'), /<ParallelUpload book=\{book\} onUploaded=/);
});

test('the Parallel Run upload: a month-end picker limited to the book\'s years, the trial balance alone, then the new report is opened', () => {
  const t = SOURCES.parallelUpload;
  assert.match(t, /useReport\(`\/finance\/books\/\$\{book\.id\}\/years`\)/);
  assert.match(t, /finMonthEnds\(years\.data\?\.years, book\.books_begin\)/);
  assert.match(t, /finDefaultMonthEnd\(ends, dayOf\(new Date\(\)\)\)/);
  assert.match(t, /<TallyUpload kind="tb" /);
  assert.equal(count(t, /<TallyUpload /g), 1);
  assert.match(t, /api\.post\('\/finance\/imports', finParallelBody\(\{ bookId: book\.id, asAt, tb \}\)\)/);
  assert.match(t, /<Modal open onClose=\{onClose\} title="Upload a Tally trial balance"/, 'a dialog of the shared Modal, which carries data-ci-overlay');
  assert.match(t, /onClose\(\);\s*await onUploaded\(id\);/, 'the dialog closes, then the tab opens the new upload');
  assert.match(t, /<Button onClick=\{upload\} disabled=\{!asAt \|\| !tb\}>Upload<\/Button>/);
  assert.match(t, /const \{ problems, attempt \} = useFormWrite\(\);/);
  assert.match(t, /const done = await attempt\(async \(\) => \{\s*id = \(await api\.post\('\/finance\/imports', finParallelBody/);
  assert.match(t, /<FieldError>\{said\.as_at\}<\/FieldError>/, 'a date the server refuses is said under the date');
  assert.match(t, /const said = refusedFor === sent \? problems : \{\};/, 'a refusal is about what was sent: changing the day or the file answers it');
  assert.doesNotMatch(t, /noAnswer|useNoAnswer/, 'useFormWrite says a write with no answer');
  assert.match(t, /<Button onClick=\{\(\) => setOpen\(true\)\}><Upload size=\{14\} \/> Upload Tally TB<\/Button>/);
});
