import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finBootPg } from './finance-pg-harness.js';

// Opening corrections (Cash & Bank spec §9.4): a journal dated the Opening's own date, marked as an opening correction, that
// changes only the figures that were wrong. It always needs an Approver (the `opening` rule), it is allowed only while no later
// month is locked and asks for an Approver when one is closing (rulings R70, R73, as for the Opening), it may use cash and bank
// lines and system-only ledgers as the Opening may (H5 and H6 widened by migration 20261121090100), and it is reversed under the
// `reversal` rule as at the Opening's own day, marked as a correction itself, as the Opening's reversal is dated (ruling R15, after
// R42); and the Opening is not reversed while a correction of it stands or waits, so it can be rebuilt cleanly. The Opening view
// shows "Opening + corrections" for each ledger a posted correction touched.
//
// Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-opening-correction.test.js
//
// One boot for the file. CI's Opening is built through the import routes, as finance-pg-opening-locks.test.js builds one, and
// posted by the MD; DP is left with none until its own test. The tests share the database and run in order, and each puts the
// months and rules it moves back the way it found them. Every name and figure here is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee

let h, CI, DP;
const L = {};        // CI ledger name -> id
const DPL = {};      // DP ledger name -> id
const PERIOD = {};   // CI month start_date -> period id
let OPENING;         // CI's Opening voucher, posted
let K1, K2;          // the corrections of the first two tests, posted: K2 moves ₹10,000 from Office cash to Holder A
let DP_OPENING;      // DP's Opening voucher, posted in the FIN_NO_OPENING test and reversed in the last of ruling R15's
let DP_FIX;          // DP's one posted correction, made in the FIN_NO_OPENING test

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
async function refused(call, status, code, field) {
  const r = await call;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  if (field !== undefined) assert.equal(r.body?.field, field, JSON.stringify(r.body));
  return r;
}
// Everything a correction, its approval or its reversal can write, counted. A refused request leaves every figure as it was.
const written = () => h.db.one(`SELECT
  (SELECT COUNT(*)::int FROM fin_vouchers) vouchers, (SELECT COUNT(*)::int FROM fin_voucher_lines) lines,
  (SELECT COUNT(*)::int FROM fin_audit_log) audit, (SELECT COUNT(*)::int FROM notifications) bells,
  (SELECT COUNT(*)::int FROM fin_vouchers WHERE status = 'posted') posted,
  (SELECT COUNT(*)::int FROM fin_vouchers WHERE reversed_by_id IS NOT NULL) marked`);
async function refusedAndNothingWritten(call, status, code, field) {
  const was = await written();
  const r = await refused(call, status, code, field);
  assert.deepEqual(await written(), was, 'a refused request writes nothing');
  return r;
}

// A line in rupees, with its bill details if it is a party's.
const line = (ledger, dr, cr, bill = {}) => ({ ledger_id: ledger, debit_paise: dr * R, credit_paise: cr * R, ...bill });
// An opening correction entered through its route by `who`; its narration and save key are its own unless given.
const correct = (lines, { who = 'acct', book = CI, narration = 'Tally had this figure wrong', key = randomUUID() } = {}) =>
  h.call('POST', '/finance/opening-corrections', { book_id: book, narration, lines, client_key: key }, who);
const approve = (id, who = 'md') => h.call('POST', `/finance/vouchers/${id}/approve`, null, who);
const reject = (id, reason = 'not like this', who = 'md') => h.call('POST', `/finance/vouchers/${id}/reject`, { reason }, who);
const corrections = (book = CI, who = 'md') => ok(h.call('GET', `/finance/opening-corrections?book=${book}`, null, who));

// The trial balance as at a date, every ledger listed: ledger id -> closing, in paise, Dr positive.
async function tbAt(date, book = CI) {
  const tb = await ok(h.call('GET', `/finance/reports/trial-balance?book=${book}&to=${date}&all=1`, null, 'md'));
  assert.equal(tb.totals.closing_dr, tb.totals.closing_cr, 'the trial balance balances');
  return Object.fromEntries(tb.ledgers.map(l => [l.id, l.closing_paise]));
}
// What moved between two trial balances: ledger id -> the change, for the ledgers whose closing changed and no other.
const moved = (was, now) => Object.fromEntries(Object.keys(now).filter(id => now[id] !== (was[id] ?? 0)).map(id => [id, now[id] - (was[id] ?? 0)]));

// A CI month moved through the screens' own route, by the MD, one allowed step at a time; back with a reason.
const STEPS = ['open', 'closing', 'locked'];
async function setMonth(start, target, reason = 'put back after the test') {
  for (;;) {
    const { status } = await h.db.one('SELECT status FROM fin_periods WHERE id = $1', [PERIOD[start]]);
    if (status === target) return;
    const next = STEPS[STEPS.indexOf(status) + (STEPS.indexOf(target) > STEPS.indexOf(status) ? 1 : -1)];
    const body = STEPS.indexOf(next) < STEPS.indexOf(status) ? { status: next, reason } : { status: next };
    await ok(h.call('PUT', `/finance/periods/${PERIOD[start]}/status`, body, 'md'));
  }
}
const allOpen = async () => { for (const start of ['2027-01-01', '2027-02-01', '2027-03-01']) await setMonth(start, 'open'); };
// A CI approval rule set by hand, as an admin's change of it would leave it.
const setRule = (key, mode) => h.db.q('UPDATE fin_approval_rules SET mode = $3, limit_amount = NULL WHERE book_id = $1 AND rule_key = $2',
  [CI, key, mode]);

// The Tally import of a book's opening balances, as at the day before the books begin: uploaded and confirmed by the accountant,
// every row as the server proposes it, and built. The Opening voucher, waiting for the MD.
async function builtOpening(book, { accounts, tb, bills = [] }) {
  const up = await ok(h.call('POST', '/finance/imports', {
    book_id: book, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], accounts, tb, bills }, 'acct'));
  const matches = up.ledgers.map(r => (r.match_status === 'matched'
    ? { row_id: r.id, action: 'match', ledger_id: r.ledger_id }
    : { row_id: r.id, action: r.match_status, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id }));
  await ok(h.call('PUT', `/finance/imports/${up.import.id}/matches`, { matches }, 'acct'));
  const built = (await ok(h.call('POST', `/finance/imports/${up.import.id}/build-opening`, null, 'acct'))).voucher;
  assert.deepEqual([built.voucher_type, built.status], ['opening', 'submitted']);
  return built;
}
const tbRow = (tally_name, dr, cr) => ({ tally_name, debit_paise: dr * R, credit_paise: cr * R });

before(async () => {
  if (!ON) return;
  h = await finBootPg('opening-correction');
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  for (const p of await h.db.q('SELECT id, start_date FROM fin_periods WHERE book_id = $1', [CI])) PERIOD[p.start_date] = p.id;
  const groups = (await ok(h.call('GET', `/finance/books/${CI}/groups`, null, 'md'))).groups;
  const groupOf = name => groups.find(g => g.name === name).id;
  const make = async (group, name, extra = {}) => {
    L[name] = (await ok(h.call('POST', '/finance/ledgers', { book_id: CI, group_id: groupOf(group), name, ...extra }, 'acct'))).ledger.id;
  };
  await make('Cash-in-Hand', 'Holder A Cash', { holder_name: 'Holder A' });
  await make('Sundry Debtors', 'Acme Pharma');
  await make('Fixed Assets', 'Old Fixtures');

  // CI's Opening, as at 31 Dec 2026: Office cash (the book's Cash ledger) ₹1,20,000, Holder A ₹5,000, Acme Pharma's one bill of
  // ₹30,000, against Partner Capital A/c, which the build makes. Built by the accountant, posted by the MD.
  const built = await builtOpening(CI, {
    accounts: [
      { tally_name: 'Cash', tally_group: 'Cash-in-Hand' }, { tally_name: 'Holder A Cash', tally_group: 'Cash-in-Hand' },
      { tally_name: 'Acme Pharma', tally_group: 'Sundry Debtors' }, { tally_name: 'Partner Capital A/c', tally_group: 'Capital Account' },
    ],
    tb: [tbRow('Cash', 120000, 0), tbRow('Holder A Cash', 5000, 0), tbRow('Acme Pharma', 30000, 0), tbRow('Partner Capital A/c', 0, 155000)],
    bills: [{ tally_ledger_name: 'Acme Pharma', bill_ref: 'INV-1', bill_date: '2026-11-10', due_date: '2026-12-10', amount_paise: 30000 * R, side: 'dr' }],
  });
  OPENING = (await ok(approve(built.id))).voucher;
  assert.equal(OPENING.status, 'posted');
  for (const l of await h.db.q('SELECT id, name FROM fin_ledgers WHERE book_id = $1', [CI])) L[l.name] = l.id;
  for (const l of await h.db.q('SELECT id, name FROM fin_ledgers WHERE book_id = $1', [DP])) DPL[l.name] = l.id;
  assert.ok(L['Partner Capital A/c'] && L.Cash && L['Profit & Loss A/c'], 'the ledgers the tests name are there');
});

after(async () => { await h?.close(); });

// ── The brief's six ──────────────────────────────────────────────────────────────────────────

test('acct\'s correction waits; md approves; the trial balance as at 2026-12-31 moves by exactly the correction', gate, async () => {
  const was = await tbAt('2026-12-31');
  // Tally missed a December bill to Acme Pharma: its bill-wise line goes in as an item, against the partners' capital.
  const key = randomUUID();
  const lines = [
    line(L['Acme Pharma'], 7500, 0, { bill_ref: 'INV-7', bill_date: '2026-12-20', due_date: '2027-01-19' }),
    line(L['Partner Capital A/c'], 0, 7500),
  ];
  const asked = (await ok(correct(lines, { key, narration: 'INV-7 to Acme Pharma was missed' }))).voucher;
  assert.deepEqual(
    [asked.status, asked.number, asked.voucher_type, asked.voucher_date, asked.is_opening_correction, asked.total_paise, asked.book_id],
    ['submitted', null, 'journal', '2026-12-31', true, 750000, CI], 'dated the Opening\'s own date, marked, and waiting for an Approver');
  // The book's Approvers are told what it is, and the books do not move while it waits.
  const bells = await h.db.q(`SELECT user_id, body FROM notifications WHERE kind = 'fin_approval' AND ref_id = $1 ORDER BY user_id`, [asked.id]);
  assert.deepEqual(bells.map(b => b.user_id), [h.users.md.id, h.users.appr2.id].sort((a, b) => a - b));
  assert.ok(bells.every(b => b.body === 'CI Opening correction ₹7,500.00 — Test Accountant'), JSON.stringify(bells));
  assert.deepEqual(moved(was, await tbAt('2026-12-31')), {}, 'nothing moves while it waits');
  // A retry of the same save (a lost answer, a double-click past the join) answers the correction it made, and writes nothing.
  const before = await written();
  const again = (await ok(correct(lines, { key, narration: 'INV-7 to Acme Pharma was missed' }))).voucher;
  assert.deepEqual([again.id, again.status], [asked.id, 'submitted']);
  assert.deepEqual(await written(), before, 'a retry writes nothing');

  // The MD approves it: it posts in his name, numbered in the journal series, still the opening day's.
  K1 = (await ok(approve(asked.id))).voucher;
  assert.deepEqual([K1.status, K1.number, K1.approved_by_id, K1.self_approved, K1.voucher_date, K1.is_opening_correction],
    ['posted', 'CI-JV-2627-0001', h.users.md.id, false, '2026-12-31', true]);
  // The 31 Dec trial balance moves by exactly the correction, and nothing else does.
  assert.deepEqual(moved(was, await tbAt('2026-12-31')), { [L['Acme Pharma']]: 750000, [L['Partner Capital A/c']]: -750000 });
  // Its party line is a live item: the bill it adds is open, beside the Opening's.
  const items = await ok(h.call('GET', `/finance/ledgers/${L['Acme Pharma']}/open-items`, null, 'md'));
  assert.deepEqual(items.debits.map(i => [i.bill_ref, i.open_paise, i.voucher_id]), [['INV-1', 3000000, OPENING.id], ['INV-7', 750000, K1.id]]);
  assert.equal(items.balance_paise, 3750000);
});

test('a correction may move ₹10,000 from Office cash to Holder A (cash lines allowed)', gate, async () => {
  const was = await tbAt('2026-12-31');
  // The book's Cash ledger is the office cash. Tally kept one cash figure; ₹10,000 of it was with Holder A on 31 Dec.
  const lines = [line(L['Holder A Cash'], 10000, 0), line(L.Cash, 0, 10000)];
  const asked = (await ok(correct(lines, { narration: 'Holder A held ₹10,000 of the office cash on 31 Dec' }))).voucher;
  assert.deepEqual([asked.status, asked.is_opening_correction], ['submitted', true], 'its cash lines are no refusal');
  K2 = (await ok(approve(asked.id))).voucher;
  assert.deepEqual([K2.status, K2.voucher_type, K2.voucher_date, K2.is_opening_correction], ['posted', 'journal', '2026-12-31', true]);
  assert.deepEqual(moved(was, await tbAt('2026-12-31')), { [L.Cash]: -1000000, [L['Holder A Cash']]: 1000000 });

  // A plain journal is still held to the journal rule: the same two lines, typed in January, are refused, and only a correction
  // may carry them.
  const plain = (await ok(h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type: 'journal', voucher_date: '2027-01-10', client_key: randomUUID(), narration: 'a plain journal', lines,
  }, 'acct'))).voucher;
  const shape = await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${plain.id}/submit`, null, 'acct'), 409, 'FIN_SHAPE');
  assert.equal(shape.body.error, "A journal can't use bank or cash ledgers — use a Payment, Receipt or Contra voucher.");
  await ok(h.call('POST', `/finance/vouchers/${plain.id}/discard`, null, 'acct'));
});

test('after that move, by_ledger shows Office cash\'s opening, −₹10,000 and the total, and Holder A\'s opening, +₹10,000 and the total', gate, async () => {
  const view = await corrections(CI, 'viewer');   // the right to view is enough
  assert.deepEqual(Object.keys(view).sort(), ['by_ledger', 'corrections']);
  const row = id => view.by_ledger.find(r => r.ledger_id === id);
  assert.deepEqual(row(L.Cash), { ledger_id: L.Cash, name: 'Cash', opening_paise: 12000000, corrections_paise: -1000000, total_paise: 11000000 });
  assert.deepEqual(row(L['Holder A Cash']),
    { ledger_id: L['Holder A Cash'], name: 'Holder A Cash', opening_paise: 500000, corrections_paise: 1000000, total_paise: 1500000 });
  // Every ledger a posted correction touched, and only those, by name; each total is the trial balance as at the opening day.
  assert.deepEqual(view.by_ledger.map(r => [r.name, r.opening_paise, r.corrections_paise, r.total_paise]), [
    ['Acme Pharma', 3000000, 750000, 3750000],
    ['Cash', 12000000, -1000000, 11000000],
    ['Holder A Cash', 500000, 1000000, 1500000],
    ['Partner Capital A/c', -15500000, -750000, -16250000],
  ]);
  const tb = await tbAt('2026-12-31');
  for (const r of view.by_ledger) assert.equal(r.total_paise, tb[r.ledger_id], `${r.name}: Opening + corrections is the 31 Dec balance`);
  // The corrections themselves, oldest first.
  assert.deepEqual(view.corrections.map(c => [c.id, c.number, c.status, c.narration, c.total_paise, c.reversed_by_id]), [
    [K1.id, K1.number, 'posted', 'INV-7 to Acme Pharma was missed', 750000, null],
    [K2.id, K2.number, 'posted', 'Holder A held ₹10,000 of the office cash on 31 Dec', 1000000, null],
  ]);

  // One that waits is listed, and counts in no figure until it posts.
  const waiting = (await ok(correct([line(L.Cash, 1, 0), line(L['Partner Capital A/c'], 0, 1)], { narration: 'waits' }))).voucher;
  const now = await corrections(CI, 'viewer');
  assert.deepEqual(now.by_ledger, view.by_ledger);
  assert.deepEqual(now.corrections.at(-1),
    { id: waiting.id, number: null, status: 'submitted', narration: 'waits', total_paise: 100, reversal_of_id: null, reversed_by_id: null });
  await ok(reject(waiting.id));
  await ok(h.call('POST', `/finance/vouchers/${waiting.id}/discard`, null, 'acct'));
  assert.equal((await corrections(CI, 'viewer')).corrections.some(c => c.id === waiting.id), false, 'a discarded one is gone from the list');
  // A login with no grant on the book reads nothing of it.
  await refused(h.call('GET', `/finance/opening-corrections?book=${CI}`, null, 'plant'), 403, 'FIN_FORBIDDEN');
  await refused(h.call('GET', '/finance/opening-corrections', null, 'md'), 400, 'FIN_BAD_INPUT', 'book');
});

test('with Jan 2027 locked it is refused FIN_PERIOD_LOCKED; with Jan closing it still needs md', gate, async () => {
  const lines = rupees => [line(L.Cash, rupees, 0), line(L['Partner Capital A/c'], 0, rupees)];
  const waiting = (await ok(correct(lines(300), { narration: 'made before the lock' }))).voucher;
  assert.equal(waiting.status, 'submitted');
  try {
    await setMonth('2027-01-01', 'locked');
    // The opening carries into January, so while January is locked no correction goes in: the accountant's, the MD's own, nor
    // the MD's approval of one already waiting. Nothing is written.
    const held = await refusedAndNothingWritten(correct(lines(400)), 409, 'FIN_PERIOD_LOCKED');
    assert.equal(held.body.error,
      "Jan 2027 is locked. Nothing more can be posted to it, and the opening carries into it, so the opening can't change until it is unlocked.");
    await refusedAndNothingWritten(correct(lines(400), { who: 'md' }), 409, 'FIN_PERIOD_LOCKED');
    await refusedAndNothingWritten(approve(waiting.id), 409, 'FIN_PERIOD_LOCKED');
    assert.equal((await h.db.one('SELECT status FROM fin_vouchers WHERE id = $1', [waiting.id])).status, 'submitted');

    // January closing: no refusal, and the accountant's still waits for the MD, who approves it; the one made before posts too.
    await setMonth('2027-01-01', 'closing', 'the CA has finished with January');
    const asked = (await ok(correct(lines(400)))).voucher;
    assert.deepEqual([asked.status, asked.number], ['submitted', null], 'January is closing: it waits for an Approver');
    const posted = (await ok(approve(asked.id))).voucher;
    assert.deepEqual([posted.status, posted.approved_by_id, posted.self_approved], ['posted', h.users.md.id, false]);
    assert.equal((await ok(approve(waiting.id))).voucher.status, 'posted');
    // The MD's own posts at once, approved by himself.
    const own = (await ok(correct(lines(50), { who: 'md' }))).voucher;
    assert.deepEqual([own.status, own.self_approved, own.approved_by_id], ['posted', true, h.users.md.id]);
    // A later month locked holds it back as well (R73): March locked, January and February open.
    await setMonth('2027-01-01', 'open', 'reopened for the next case');
    await setMonth('2027-03-01', 'locked');
    const mar = await refusedAndNothingWritten(correct(lines(60), { who: 'md' }), 409, 'FIN_PERIOD_LOCKED');
    assert.match(mar.body.error, /^Mar 2027 is locked\. .* the opening carries into it/);
  } finally {
    await allOpen();
  }
});

test('with no Opening, FIN_NO_OPENING', gate, async () => {
  // DP has no Opening at all: neither the accountant nor the MD can correct one, and nothing is written.
  const dp = rupees => [line(DPL.Cash, rupees, 0), line(DPL['Profit & Loss A/c'], 0, rupees)];
  const none = await refusedAndNothingWritten(correct(dp(100), { book: DP }), 409, 'FIN_NO_OPENING');
  assert.equal(none.body.error, 'There is no Opening to correct yet.');
  await refusedAndNothingWritten(correct(dp(100), { book: DP, who: 'md' }), 409, 'FIN_NO_OPENING');
  // Said first: with nothing to correct, what the lines name is no matter (here a ledger of another book).
  await refusedAndNothingWritten(correct([line(L.Cash, 1, 0), line(DPL.Cash, 0, 1)], { book: DP }), 409, 'FIN_NO_OPENING');
  assert.deepEqual(await corrections(DP), { corrections: [], by_ledger: [] }, 'and the view of a book with none is empty');

  // An Opening still waiting for the MD is not the books' opening yet.
  const built = await builtOpening(DP, {
    accounts: [{ tally_name: 'Cash', tally_group: 'Cash-in-Hand' }, { tally_name: 'Partner Capital A/c', tally_group: 'Capital Account' }],
    tb: [tbRow('Cash', 900, 0), tbRow('Partner Capital A/c', 0, 900)],
  });
  await refusedAndNothingWritten(correct(dp(100), { book: DP, who: 'md' }), 409, 'FIN_NO_OPENING');
  // Posted, it is corrected. (Reversing it afterwards waits for its corrections, ruling R15: the last of R15's tests below, which
  // also shows nothing more is corrected once it is gone.)
  DP_OPENING = (await ok(approve(built.id))).voucher;
  for (const l of await h.db.q('SELECT id, name FROM fin_ledgers WHERE book_id = $1', [DP])) DPL[l.name] = l.id;
  DP_FIX = (await ok(correct([line(DPL.Cash, 100, 0), line(DPL['Partner Capital A/c'], 0, 100)], { book: DP, who: 'md' }))).voucher;
  assert.deepEqual([DP_FIX.status, DP_FIX.self_approved, DP_FIX.is_opening_correction], ['posted', true, true]);
  const view = await corrections(DP);
  assert.deepEqual(view.by_ledger.map(r => [r.name, r.opening_paise, r.corrections_paise, r.total_paise]),
    [['Cash', 90000, 10000, 100000], ['Partner Capital A/c', -90000, -10000, -100000]]);
});

test('a posted correction reverses like any voucher (the reversal rule), as at the Opening\'s own day (ruling R15)', gate, async () => {
  const dec31 = await tbAt('2026-12-31');
  const was = await corrections();
  // The accountant asks for it. The date the form sends is not the requester's to choose (as for the Opening's reversal): it is
  // the Opening's own day, and the reversal is marked as a correction. Under the reversal rule (always) it waits for the MD.
  const asked = (await ok(h.call('POST', `/finance/vouchers/${K2.id}/reverse`, { date: '2027-01-15', reason: 'Holder A had it back on the 2nd' }, 'acct'))).voucher;
  assert.deepEqual([asked.status, asked.number, asked.voucher_type, asked.voucher_date, asked.reversal_of_id, asked.is_opening_correction],
    ['submitted', null, 'journal', '2026-12-31', K2.id, true]);
  const bells = await h.db.q(`SELECT user_id, body FROM notifications WHERE kind = 'fin_approval' AND ref_id = $1 ORDER BY user_id`, [asked.id]);
  assert.deepEqual(bells.map(b => b.user_id), [h.users.md.id, h.users.appr2.id].sort((a, b) => a - b));
  assert.deepEqual(moved(dec31, await tbAt('2026-12-31')), {}, 'nothing moves while it waits');
  const rev = (await ok(approve(asked.id))).voucher;
  assert.deepEqual([rev.status, rev.approved_by_id, rev.self_approved, rev.voucher_date], ['posted', h.users.md.id, false, '2026-12-31']);
  assert.match(rev.number, /^CI-JV-2627-\d{4}$/);
  assert.equal((await h.db.one('SELECT reversed_by_id FROM fin_vouchers WHERE id = $1', [K2.id])).reversed_by_id, rev.id);
  const mirrored = await h.db.q(`SELECT l.ledger_id, l.debit::text AS debit, l.credit::text AS credit FROM fin_voucher_lines l
    WHERE l.voucher_id = $1 ORDER BY l.line_no`, [rev.id]);
  assert.deepEqual(mirrored, [{ ledger_id: L['Holder A Cash'], debit: '0.00', credit: '10000.00' }, { ledger_id: L.Cash, debit: '10000.00', credit: '0.00' }]);

  // As at the opening day the move is undone, and the pair nets to nothing in "Opening + corrections".
  assert.deepEqual(moved(dec31, await tbAt('2026-12-31')), { [L.Cash]: 1000000, [L['Holder A Cash']]: -1000000 });
  const view = await corrections();
  const change = id => view.by_ledger.find(r => r.ledger_id === id).corrections_paise - was.by_ledger.find(r => r.ledger_id === id).corrections_paise;
  assert.deepEqual([change(L.Cash), change(L['Holder A Cash'])], [1000000, -1000000]);
  const tb = await tbAt('2026-12-31');
  for (const r of view.by_ledger) assert.equal(r.total_paise, tb[r.ledger_id], `${r.name}: Opening + corrections is the 31 Dec balance`);
  assert.equal(view.corrections.find(c => c.id === K2.id).reversed_by_id, rev.id);

  // A reversal rule loosened since is no way round the Approver: a reversal dated before the books begin goes in only approved.
  try {
    await setRule('reversal', 'never');
    const fix = (await ok(correct([line(L.Cash, 15, 0), line(L['Partner Capital A/c'], 0, 15)], { who: 'md' }))).voucher;
    const back = (await ok(h.call('POST', `/finance/vouchers/${fix.id}/reverse`, { reason: 'entered twice' }, 'acct'))).voucher;
    assert.deepEqual([back.status, back.number, back.voucher_date], ['submitted', null, '2026-12-31']);
    assert.equal((await ok(approve(back.id))).voucher.status, 'posted');
  } finally {
    await setRule('reversal', 'always');
  }
});

// ── Ruling R15: a correction is reversed as at the opening day, and the Opening waits for its corrections ──────────────

test('R15: md reverses a posted correction: dated 2026-12-31, marked, posted self-approved; the 31 Dec trial balance is back to its figures before it, and by_ledger nets the pair to zero', gate, async () => {
  const dec31 = await tbAt('2026-12-31');
  const was = await corrections();
  const rev = (await ok(h.call('POST', `/finance/vouchers/${K1.id}/reverse`, { reason: 'INV-7 was never sent' }, 'md'))).voucher;
  assert.deepEqual(
    [rev.status, rev.voucher_type, rev.voucher_date, rev.is_opening_correction, rev.reversal_of_id, rev.self_approved, rev.approved_by_id],
    ['posted', 'journal', '2026-12-31', true, K1.id, true, h.users.md.id]);
  // K1 moved Acme Pharma +₹7,500 and Partner Capital −₹7,500 as at 31 Dec: exactly that is taken back, and nothing else moves.
  assert.deepEqual(moved(dec31, await tbAt('2026-12-31')), { [L['Acme Pharma']]: -750000, [L['Partner Capital A/c']]: 750000 });
  const view = await corrections();
  const change = id => view.by_ledger.find(r => r.ledger_id === id).corrections_paise - was.by_ledger.find(r => r.ledger_id === id).corrections_paise;
  assert.deepEqual([change(L['Acme Pharma']), change(L['Partner Capital A/c'])], [-750000, 750000]);
  const tb = await tbAt('2026-12-31');
  for (const r of view.by_ledger) assert.equal(r.total_paise, tb[r.ledger_id], r.name);
  // The list shows K1 reversed by it, and the reversal itself, saying what it reverses.
  assert.equal(view.corrections.find(c => c.id === K1.id).reversed_by_id, rev.id);
  assert.deepEqual(view.corrections.find(c => c.id === rev.id), {
    id: rev.id, number: rev.number, status: 'posted', narration: `Reversal of ${K1.number} — INV-7 was never sent`, total_paise: 750000,
    reversal_of_id: K1.id, reversed_by_id: null,
  });
  // INV-7 is no longer open, and the database holds the reversal as a marked journal whose lines mirror K1's (both CHECKs, H11).
  const items = await ok(h.call('GET', `/finance/ledgers/${L['Acme Pharma']}/open-items`, null, 'md'));
  assert.equal(items.debits.some(i => i.bill_ref === 'INV-7'), false);
  assert.deepEqual(await h.db.one('SELECT voucher_type, is_opening_correction, reversal_of_id FROM fin_vouchers WHERE id = $1', [rev.id]),
    { voucher_type: 'journal', is_opening_correction: true, reversal_of_id: K1.id });
  const mirror = await h.db.one(`SELECT COUNT(*)::int AS n FROM fin_voucher_lines r JOIN fin_voucher_lines k ON k.voucher_id = $2 AND k.line_no = r.line_no
    AND k.ledger_id = r.ledger_id AND k.debit = r.credit AND k.credit = r.debit AND k.bill_ref IS NOT DISTINCT FROM r.bill_ref WHERE r.voucher_id = $1`, [rev.id, K1.id]);
  assert.equal(mirror.n, 2);
  // The reversal of a correction is never reversed itself, and is not offered for it: that would put the correction back as at the
  // opening day, beside whatever Opening stands then. The correction is entered again instead.
  const again = await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${rev.id}/reverse`, { reason: 'put it back' }, 'md'), 409, 'FIN_BAD_REVERSAL');
  assert.equal(again.body.error, 'This reversed an opening correction, and it is never reversed itself: that would put the correction back in the books '
    + 'as at the opening day. Enter the correction again instead.');
  assert.equal((await ok(h.call('GET', `/finance/vouchers/${rev.id}`, null, 'md'))).can.reverse, false);
});

test('R15: with January locked, a correction\'s reversal is refused FIN_PERIOD_LOCKED; with January closing it needs md, as ever', gate, async () => {
  const fix = (await ok(correct([line(L.Cash, 40, 0), line(L['Partner Capital A/c'], 0, 40)], { who: 'md' }))).voucher;
  assert.equal(fix.status, 'posted');
  const reverse = who => h.call('POST', `/finance/vouchers/${fix.id}/reverse`, { reason: 'entered twice' }, who);
  try {
    await setMonth('2027-01-01', 'locked');
    const held = await refusedAndNothingWritten(reverse('md'), 409, 'FIN_PERIOD_LOCKED');
    assert.equal(held.body.error,
      "Jan 2027 is locked. Nothing more can be posted to it, and the opening carries into it, so the opening can't change until it is unlocked.");
    await refusedAndNothingWritten(reverse('acct'), 409, 'FIN_PERIOD_LOCKED');
    await setMonth('2027-01-01', 'closing', 'the CA has finished with January');
    const asked = (await ok(reverse('acct'))).voucher;
    assert.deepEqual([asked.status, asked.voucher_date, asked.is_opening_correction], ['submitted', '2026-12-31', true]);
    const posted = (await ok(approve(asked.id))).voucher;
    assert.deepEqual([posted.status, posted.approved_by_id, posted.self_approved], ['posted', h.users.md.id, false]);
  } finally {
    await allOpen();
  }
});

test('R15: the Opening is not reversed while a correction of it is posted or waiting ("Reverse or settle this Opening\'s corrections first."); once each is reversed or sent back, it is, and nothing more is corrected', gate, async () => {
  const reverseOpening = () => h.call('POST', `/finance/vouchers/${DP_OPENING.id}/reverse`, { reason: 'rebuilt from Tally' }, 'md');
  const offered = async id => (await ok(h.call('GET', `/finance/vouchers/${id}`, null, 'md'))).can.reverse;
  const SENTENCE = "Reverse or settle this Opening's corrections first.";
  const waiting = (await ok(correct([line(DPL.Cash, 7, 0), line(DPL['Partner Capital A/c'], 0, 7)], { book: DP }))).voucher;
  assert.equal(waiting.status, 'submitted');
  // DP_FIX posted and one waiting: the Opening stays, and the screen does not offer to reverse it.
  assert.equal((await refusedAndNothingWritten(reverseOpening(), 409, 'FIN_BAD_REVERSAL')).body.error, SENTENCE);
  assert.equal(await offered(DP_OPENING.id), false);
  // The waiting one sent back is a draft; DP_FIX still holds the Opening, and still does while its own reversal waits.
  await ok(reject(waiting.id, 'the opening is being rebuilt'));
  assert.equal((await refusedAndNothingWritten(reverseOpening(), 409, 'FIN_BAD_REVERSAL')).body.error, SENTENCE);
  const asked = (await ok(h.call('POST', `/finance/vouchers/${DP_FIX.id}/reverse`, { reason: 'the opening is being rebuilt' }, 'acct'))).voucher;
  assert.deepEqual([asked.status, asked.voucher_date, asked.is_opening_correction], ['submitted', '2026-12-31', true]);
  await refusedAndNothingWritten(reverseOpening(), 409, 'FIN_BAD_REVERSAL');
  assert.equal((await ok(approve(asked.id))).voucher.status, 'posted');
  // A correction that waits holds it on its own: the one sent back, sent again.
  assert.equal((await ok(h.call('POST', `/finance/vouchers/${waiting.id}/submit`, null, 'acct'))).voucher.status, 'submitted');
  assert.equal(await offered(DP_OPENING.id), false);
  assert.equal((await refusedAndNothingWritten(reverseOpening(), 409, 'FIN_BAD_REVERSAL')).body.error, SENTENCE);
  // Sent back again it is a draft, which holds nothing: the Opening is offered, and reversed as at its own date.
  await ok(reject(waiting.id, 'the opening is being rebuilt'));
  assert.equal(await offered(DP_OPENING.id), true);
  const back = (await ok(reverseOpening())).voucher;
  assert.deepEqual([back.status, back.voucher_date], ['posted', '2026-12-31']);
  // Nothing more is corrected until another Opening is built: not a new correction, nor the draft, which checks again when sent.
  await refusedAndNothingWritten(correct([line(DPL.Cash, 1, 0), line(DPL['Partner Capital A/c'], 0, 1)], { book: DP, who: 'md' }), 409, 'FIN_NO_OPENING');
  await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${waiting.id}/submit`, null, 'acct'), 409, 'FIN_NO_OPENING');
  await ok(h.call('POST', `/finance/vouchers/${waiting.id}/discard`, null, 'acct'));
  // As at the opening day each pair nets to nothing, beside no Opening: the book is clear for a new build.
  const view = await corrections(DP);
  assert.deepEqual(view.by_ledger.map(r => [r.name, r.opening_paise, r.corrections_paise, r.total_paise]),
    [['Cash', 0, 0, 0], ['Partner Capital A/c', 0, 0, 0]]);
  const tb = await tbAt('2026-12-31', DP);
  for (const r of view.by_ledger) assert.equal(tb[r.ledger_id], 0, r.name);
});

// ── The controller's rulings for this task ─────────────────────────────────────────────────────

test('whatever the opening rule says, acct\'s correction waits for an Approver: it never goes to the database unapproved', gate, async () => {
  try {
    await setRule('opening', 'never');
    const asked = (await ok(correct([line(L.Cash, 20, 0), line(L['Partner Capital A/c'], 0, 20)]))).voucher;
    assert.deepEqual([asked.status, asked.number], ['submitted', null]);
    // Posted by any other way in with no Approver named, the app refuses it, in its own words, before the database is asked (whose
    // FIN_BEFORE_BOOKS would say only the Opening and its reversal are dated there).
    const { finVoucherCtx, finPostLocked } = await import('./finance-vouchers.js');
    const was = await written();
    const unapproved = await h.db.tx(async (qc, oc) => finPostLocked(qc, oc, await finVoucherCtx(qc, oc, asked.id),
      { id: h.users.acct.id, name: 'Test Accountant', roles: ['accountant'] })).then(() => null, e => e);
    assert.deepEqual([unapproved?.status, unapproved?.body?.code, unapproved?.message], [409, 'FIN_BEFORE_BOOKS',
      "An opening correction changes the books as they stood before they began, so it goes in only with an Approver's approval."]);
    assert.deepEqual(await written(), was, 'nothing was written');
    const posted = (await ok(approve(asked.id))).voucher;
    assert.deepEqual([posted.status, posted.approved_by_id], ['posted', h.users.md.id]);
    // …and the MD's own posts approved by himself, as ever.
    const own = (await ok(correct([line(L.Cash, 30, 0), line(L['Partner Capital A/c'], 0, 30)], { who: 'md' }))).voucher;
    assert.deepEqual([own.status, own.self_approved, own.approved_by_id], ['posted', true, h.users.md.id]);
  } finally {
    await setRule('opening', 'always');
  }
});

test('a rejected correction is edited by its maker: its lines change, its date and its mark do not', gate, async () => {
  const asked = (await ok(correct([line(L['Acme Pharma'], 200, 0, { bill_ref: 'INV-8' }), line(L['Partner Capital A/c'], 0, 200)]))).voucher;
  await ok(reject(asked.id, 'INV-8 was ₹250'));
  const edit = body => h.call('PUT', `/finance/vouchers/${asked.id}`, body, 'acct');
  // The date is the Opening's own and stays so; the form may send it back as it is.
  const moving = await refusedAndNothingWritten(edit({ voucher_date: '2027-01-05' }), 409, 'FIN_BAD_CORRECTION', 'voucher_date');
  assert.match(moving.body.error, /^An opening correction is dated 2026-12-31/);
  // The lines change, onto a system-only ledger too (the Opening's own allowance, H6); the voucher stays a correction.
  const edited = (await ok(edit({
    voucher_date: '2026-12-31', narration: 'INV-8 was ₹250',
    lines: [line(L['Acme Pharma'], 250, 0, { bill_ref: 'INV-8' }), line(L['Profit & Loss A/c'], 0, 250)],
  }))).voucher;
  assert.deepEqual([edited.status, edited.voucher_date, edited.is_opening_correction, edited.total_paise], ['draft', '2026-12-31', true, 25000]);

  // Past the app, a draft's date moved by hand: the app says so in its own words before the database does.
  await h.db.q(`UPDATE fin_vouchers SET voucher_date = '2027-01-05' WHERE id = $1 AND status = 'draft'`, [asked.id]);
  const off = await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${asked.id}/submit`, null, 'acct'), 409, 'FIN_BAD_CORRECTION');
  assert.equal(off.body.error,
    "An opening correction is dated 2026-12-31, the Opening's own date, the day before the books begin. This one is dated 2027-01-05.");
  await h.db.q(`UPDATE fin_vouchers SET voucher_date = '2026-12-31' WHERE id = $1 AND status = 'draft'`, [asked.id]);

  // Sent again, it waits for the MD, who posts it as edited.
  assert.equal((await ok(h.call('POST', `/finance/vouchers/${asked.id}/submit`, null, 'acct'))).voucher.status, 'submitted');
  const posted = (await ok(approve(asked.id))).voucher;
  assert.deepEqual([posted.status, posted.is_opening_correction, posted.voucher_date, posted.total_paise], ['posted', true, '2026-12-31', 25000]);
  const lines = await h.db.q('SELECT ledger_id, bill_ref FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [asked.id]);
  assert.deepEqual(lines, [{ ledger_id: L['Acme Pharma'], bill_ref: 'INV-8' }, { ledger_id: L['Profit & Loss A/c'], bill_ref: null }]);
});

test('a correction may use a system-only ledger, as the Opening may; a switched-off ledger, another book\'s, a misplaced bill or unbalanced lines are refused, writing nothing', gate, async () => {
  const pl = [line(L['Acme Pharma'], 1000, 0, { bill_ref: 'INV-9' }), line(L['Profit & Loss A/c'], 0, 1000)];
  const own = (await ok(correct(pl, { who: 'md' }))).voucher;
  assert.deepEqual([own.status, own.is_opening_correction], ['posted', true], 'Profit & Loss A/c is system-only: a correction may use it');
  // A plain journal may not.
  await refusedAndNothingWritten(h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type: 'journal', voucher_date: '2027-01-10', client_key: randomUUID(), lines: pl,
  }, 'md'), 409, 'FIN_SYSTEM_LEDGER');

  await ok(h.call('PUT', `/finance/ledgers/${L['Old Fixtures']}`, { active: false }, 'md'));
  await refusedAndNothingWritten(correct([line(L['Old Fixtures'], 10, 0), line(L['Partner Capital A/c'], 0, 10)]), 409, 'FIN_LEDGER_INACTIVE');
  await refusedAndNothingWritten(correct([line(DPL.Cash, 10, 0), line(L['Partner Capital A/c'], 0, 10)]), 409, 'FIN_WRONG_BOOK');
  await refusedAndNothingWritten(correct([line(L.Cash, 10, 0, { bill_ref: 'X-1' }), line(L['Partner Capital A/c'], 0, 10)]), 400, 'FIN_BAD_INPUT', 'lines[0].bill_ref');
  const off = await refusedAndNothingWritten(correct([line(L.Cash, 10, 0), line(L['Partner Capital A/c'], 0, 9)]), 409, 'FIN_UNBALANCED');
  assert.equal(off.body.error, "Debits ₹10.00 and credits ₹9.00 don't match — difference ₹1.00.");
  await refusedAndNothingWritten(correct([line(L.Cash, 10, 0)]), 409, 'FIN_TOO_FEW_LINES');
  await refusedAndNothingWritten(h.call('POST', '/finance/opening-corrections', { book_id: CI, lines: 'none' }, 'acct'), 400, 'FIN_BAD_INPUT', 'lines');
  await refusedAndNothingWritten(h.call('POST', '/finance/opening-corrections', { lines: [] }, 'acct'), 400, 'FIN_BAD_INPUT', 'book_id');
  // Only those who may enter vouchers make one.
  await refusedAndNothingWritten(correct([line(L.Cash, 10, 0), line(L['Partner Capital A/c'], 0, 10)], { who: 'viewer' }), 403, 'FIN_FORBIDDEN');
});
