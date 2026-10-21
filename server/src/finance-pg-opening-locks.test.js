import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finBootPg } from './finance-pg-harness.js';

// Rulings R70 and R73: month locks protect balances. Every balance from a month on is carried into every month after it, so a
// posting into a month restates that month AND every later month of the book. A posting therefore takes the MOST RESTRICTIVE status
// among its own month and every later month (R73): any locked one refuses it (FIN_PERIOD_LOCKED, naming the first locked month by
// date), and any closing one asks for an Approver's approval, as a closing month does of its own entries. R70 is the case of the
// Opening voucher and its reversal: they are dated the day before the books begin, in a month that is never closed or locked, and
// every month of the books comes after it. Correcting an entry, the opening included, after an audit then needs an audited unlock
// first. The app says so before anything is written (finPostingProblem); the database says it again at COMMIT (H5), for anything
// that writes to the books.
//
// Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-opening-locks.test.js
//
// One boot for the file. The tests share the database and run in order; each puts the months and rules it moves back the way
// it found them. Every name and figure here is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

let h;
const BOOK = {};      // book code -> id
const PERIOD = {};    // book code -> month start_date -> period id
const CASH = {};      // book code -> its Cash ledger
const PL = {};        // book code -> its Profit & Loss A/c
let RENT, FREIGHT;    // two ordinary CI ledgers, for vouchers of the books' own months

before(async () => {
  if (!ON) return;
  h = await finBootPg('opening-locks');
  for (const b of await h.db.q('SELECT id, code FROM fin_books')) BOOK[b.code] = b.id;
  for (const p of await h.db.q('SELECT p.id, p.start_date, b.code FROM fin_periods p JOIN fin_books b ON b.id = p.book_id')) {
    (PERIOD[p.code] ??= {})[p.start_date] = p.id;
  }
  for (const l of await h.db.q(`SELECT l.id, l.name, b.code FROM fin_ledgers l JOIN fin_books b ON b.id = l.book_id`)) {
    if (l.name === 'Cash') CASH[l.code] = l.id;
    if (l.name === 'Profit & Loss A/c') PL[l.code] = l.id;
  }
  const expenses = await h.db.one(`SELECT id FROM fin_groups WHERE book_id = $1 AND name = 'Indirect Expenses'`, [BOOK.CI]);
  RENT = (await h.db.one(`INSERT INTO fin_ledgers (book_id, group_id, name) VALUES ($1, $2, 'Office Rent') RETURNING id`, [BOOK.CI, expenses.id])).id;
  FREIGHT = (await h.db.one(`INSERT INTO fin_ledgers (book_id, group_id, name) VALUES ($1, $2, 'Carriage Inward') RETURNING id`, [BOOK.CI, expenses.id])).id;
});

after(async () => { await h?.close(); });

const NAMES = { md: 'Test MD', acct: 'Test Accountant' };
const submit = (id, who = 'acct') => h.call('POST', `/finance/vouchers/${id}/submit`, null, who);
const approve = (id, who = 'md') => h.call('POST', `/finance/vouchers/${id}/approve`, null, who);
const reverse = (id, who = 'md', reason = 'rebuilt from Tally') => h.call('POST', `/finance/vouchers/${id}/reverse`, { reason }, who);
const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
async function refused(call, status, code) {
  const r = await call;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  return r;
}
// Everything a posting or a build can write, counted. A refused request leaves every figure as it was.
const written = async () => h.db.one(`SELECT
  (SELECT COUNT(*)::int FROM fin_vouchers) vouchers, (SELECT COUNT(*)::int FROM fin_voucher_lines) lines,
  (SELECT COUNT(*)::int FROM fin_ledgers) ledgers, (SELECT COUNT(*)::int FROM fin_audit_log) audit,
  (SELECT COUNT(*)::int FROM fin_imports WHERE status = 'used') used,
  (SELECT COUNT(*)::int FROM fin_vouchers WHERE reversed_by_id IS NOT NULL) marked`);
async function refusedAndNothingWritten(call, status, code) {
  const was = await written();
  const r = await refused(call, status, code);
  assert.deepEqual(await written(), was, 'a refused request writes nothing');
  return r;
}

// A month moved through the screens' own route, by the MD, one allowed step at a time: open, closing and locked going forward,
// and back with a reason, as the Months & Years screen asks for one.
const STEPS = ['open', 'closing', 'locked'];
async function setMonth(code, start, target, reason = 'put back after the test') {
  for (;;) {
    const { status } = await h.db.one('SELECT status FROM fin_periods WHERE id = $1', [PERIOD[code][start]]);
    if (status === target) return;
    const next = STEPS[STEPS.indexOf(status) + (STEPS.indexOf(target) > STEPS.indexOf(status) ? 1 : -1)];
    const body = STEPS.indexOf(next) < STEPS.indexOf(status) ? { status: next, reason } : { status: next };
    await ok(h.call('PUT', `/finance/periods/${PERIOD[code][start]}/status`, body, 'md'));
  }
}
const allOpen = async code => { for (const start of ['2027-01-01', '2027-02-01', '2027-03-01']) await setMonth(code, start, 'open'); };

// An Opening voucher draft, dated the day before the books begin, made by `who` the way the import makes one (a draft the app
// builds; the import itself is tested below): Cash Dr, Profit & Loss A/c Cr. Its id.
async function openingDraft(code, who = 'acct', rupees = 500) {
  return h.db.tx(async (qc, oc) => {
    const v = await oc(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, total, narration, created_by_id, created_by)
                        VALUES ($1, 'opening', '2026-12-31', $2, 'Opening balances', $3, $4) RETURNING id`,
    [BOOK[code], rupees, h.users[who].id, NAMES[who]]);
    await qc(`INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit)
              VALUES ($1, $2, 1, $3, $5, 0), ($1, $2, 2, $4, 0, $5)`, [v.id, BOOK[code], CASH[code], PL[code], rupees]);
    return v.id;
  });
}
// The book's Opening voucher, posted: the accountant's draft, waiting for the MD (the opening rule is always), approved.
async function postedOpening(code) {
  const id = await openingDraft(code);
  assert.equal((await ok(submit(id))).voucher.status, 'submitted');
  const v = (await ok(approve(id))).voucher;
  assert.equal(v.status, 'posted');
  return v;
}
const live = code => h.db.one(`SELECT id, number FROM fin_vouchers
  WHERE book_id = $1 AND voucher_type = 'opening' AND status = 'posted' AND reversed_by_id IS NULL`, [BOOK[code]]);

// Posts a voucher by hand, as the database tests do and as any writer could (spec §7.4 step 5), in ONE transaction so the
// checks deferred to COMMIT run: the lines, then the status, then (for a reversal) the mark on what it reverses.
// `lines` are [ledgerId, debit, credit] in rupees. The raw error comes back, or null when the COMMIT went through.
async function postByHand(code, { type = 'journal', date = '2026-12-31', lines, approved = false, reversalOf = null }) {
  try {
    await h.db.tx(async (qc, oc) => {
      const total = lines.reduce((sum, [, debit]) => sum + debit, 0);
      const v = await oc(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, total, reversal_of_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [BOOK[code], type, date, total, reversalOf]);
      for (const [i, [ledger, debit, credit]] of lines.entries()) {
        await qc('INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)',
          [v.id, BOOK[code], i + 1, ledger, debit, credit]);
      }
      const month = await oc('SELECT id FROM fin_periods WHERE book_id = $1 AND start_date <= $2 AND end_date >= $2', [BOOK[code], date]);
      await qc(`UPDATE fin_vouchers SET status = 'posted', number = $2, period_id = $3, posted_at = now(),
                       approved_by_id = $4::int, approved_by = CASE WHEN $4::int IS NULL THEN NULL ELSE 'Test MD' END,
                       approved_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() END
                 WHERE id = $1`, [v.id, `HAND-${v.id}`, month.id, approved ? h.users.md.id : null]);
      if (reversalOf != null) await qc('UPDATE fin_vouchers SET reversed_by_id = $1 WHERE id = $2', [v.id, reversalOf]);
    });
    return null;
  } catch (e) { return e; }
}
// A hand-made reversal of a posted voucher: every line mirrored, posted on the original's own date, the original marked.
async function reverseByHand(code, originalId, opts = {}) {
  const lines = await h.db.q('SELECT ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [originalId]);
  return postByHand(code, { lines: lines.map(l => [l.ledger_id, l.credit, l.debit]), reversalOf: originalId, ...opts });
}
const refusedAtCommit = (e, code, month) => {
  assert.ok(e, 'the COMMIT went through: nothing refused it');
  assert.deepEqual([e.code, e.detail], ['P0001', code], e.message);
  if (month) assert.match(e.message, new RegExp(`^${month} `), e.message);
};

// The Tally import, small: Cash and a capital account, as at the day before the books begin. Uploaded, every row confirmed as
// the server proposes it. The import's id, ready to build.
async function confirmedImport(code) {
  const up = await ok(h.call('POST', '/finance/imports', {
    book_id: BOOK[code], purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'],
    accounts: [{ tally_name: 'Cash', tally_group: 'Cash-in-Hand' }, { tally_name: 'Partner Capital A/c', tally_group: 'Capital Account' }],
    tb: [{ tally_name: 'Cash', debit_paise: 120000, credit_paise: 0 }, { tally_name: 'Partner Capital A/c', debit_paise: 0, credit_paise: 120000 }],
  }, 'acct'));
  const matches = up.ledgers.map(r => ({ row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status,
    ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id }));
  await ok(h.call('PUT', `/finance/imports/${up.import.id}/matches`, { matches }, 'acct'));
  return up.import.id;
}
const build = id => h.call('POST', `/finance/imports/${id}/build-opening`, null, 'acct');

test('R70: a locked month refuses the opening that carries into it: no reversal and no new build, by the app or by hand', gate, async () => {
  const ob = await postedOpening('CI');
  try {
    // February locked: the opening carries into February, so it may not change.
    await setMonth('CI', '2027-02-01', 'locked');
    const feb = await refusedAndNothingWritten(reverse(ob.id), 409, 'FIN_PERIOD_LOCKED');
    assert.equal(feb.body.error, 'Feb 2027 is locked. Nothing more can be posted to it, and the opening carries into it, so the opening '
      + "can't change until it is unlocked.");
    // January locked as well: the refusal names the FIRST locked month.
    await setMonth('CI', '2027-01-01', 'locked');
    const jan = await refusedAndNothingWritten(reverse(ob.id), 409, 'FIN_PERIOD_LOCKED');
    assert.match(jan.body.error, /^Jan 2027 is locked\. .* the opening carries into it/);
    assert.equal((await live('CI')).id, ob.id, 'the opening still stands, unreversed');

    // By hand, past the app: the database refuses the reversal at COMMIT, approved or not, naming the month.
    refusedAtCommit(await reverseByHand('CI', ob.id, { approved: true }), 'FIN_PERIOD_LOCKED', 'Jan 2027');
    refusedAtCommit(await reverseByHand('CI', ob.id), 'FIN_PERIOD_LOCKED', 'Jan 2027');
    assert.equal((await live('CI')).id, ob.id, 'and the refusal took the mark with it');

    // A new opening is refused too: DP has none yet, and its January is locked. The build writes nothing (not even the ledgers
    // it would have made), and the import stays as it was; the same draft submitted is refused the same way.
    await setMonth('DP', '2027-01-01', 'locked');
    const imp = await confirmedImport('DP');
    await refusedAndNothingWritten(build(imp), 409, 'FIN_PERIOD_LOCKED');
    assert.equal((await ok(h.call('GET', `/finance/imports/${imp}`))).import.status, 'matched');
    const draft = await openingDraft('DP', 'md');
    const own = await refusedAndNothingWritten(submit(draft, 'md'), 409, 'FIN_PERIOD_LOCKED');
    assert.match(own.body.error, /^Jan 2027 is locked\./, 'an Approver\'s own opening is no exception');
    // …and by hand: a posted opening, approved, inserted with no app in front of it.
    refusedAtCommit(await postByHand('DP', { type: 'opening', lines: [[CASH.DP, 300, 0], [PL.DP, 0, 300]], approved: true }), 'FIN_PERIOD_LOCKED', 'Jan 2027');
    assert.equal(await live('DP'), null, 'DP still has no Opening voucher');

    // A voucher of the books' own months is judged by its month and the months after it: March is open, and nothing after it is
    // locked, so an entry posts there as ever.
    assert.equal(await postByHand('CI', { date: '2027-03-05', lines: [[RENT, 10, 0], [CASH.CI, 0, 10]] }), null);
  } finally {
    await allOpen('CI');
    await allOpen('DP');
  }
  // With every month open again, the same reversal goes through (R42: on the opening's own date) and a new one is built.
  const r = (await ok(reverse(ob.id))).voucher;
  assert.deepEqual([r.status, r.voucher_date, r.self_approved], ['posted', '2026-12-31', true]);
  assert.equal(await live('CI'), null);
});

test('R70: a closing month makes the opening wait for an Approver, whatever the rules say; an Approver\'s own goes through, self-approved', gate, async () => {
  const rule = `UPDATE fin_approval_rules SET mode = $3, limit_amount = NULL WHERE book_id = $1 AND rule_key = $2`;
  try {
    // The rules would post both at once: only the closing month asks for approval.
    for (const code of ['CI', 'DP']) for (const key of ['opening', 'reversal']) await h.db.q(rule, [BOOK[code], key, 'never']);
    await setMonth('CI', '2027-01-01', 'closing');

    // The accountant's new opening waits, and the approvers are told; the MD approves it.
    const draft = await openingDraft('CI');
    const asked = (await ok(submit(draft))).voucher;
    assert.deepEqual([asked.status, asked.number], ['submitted', null], 'January is closing: the opening needs an Approver');
    const bells = await h.db.q(`SELECT user_id FROM notifications WHERE kind = 'fin_approval' AND ref_id = $1 ORDER BY user_id`, [draft]);
    assert.deepEqual(bells.map(b => b.user_id), [h.users.md.id, h.users.appr2.id].sort((a, b) => a - b));
    const ob = (await ok(approve(draft))).voucher;
    assert.deepEqual([ob.status, ob.approved_by_id, ob.self_approved], ['posted', h.users.md.id, false]);

    // The accountant's reversal of it waits too.
    const rev = (await ok(reverse(ob.id, 'acct'))).voucher;
    assert.equal(rev.status, 'submitted');
    assert.equal((await live('CI')).id, ob.id, 'the opening stands until the reversal is approved');
    await ok(h.call('POST', `/finance/vouchers/${rev.id}/reject`, { reason: 'not yet' }, 'md'));
    await ok(h.call('POST', `/finance/vouchers/${rev.id}/discard`, null, 'acct'));

    // The MD's own reversal goes through at once, approved by the MD himself.
    const own = (await ok(reverse(ob.id, 'md'))).voucher;
    assert.deepEqual([own.status, own.self_approved, own.approved_by_id], ['posted', true, h.users.md.id]);
    assert.equal(await live('CI'), null);

    // By hand, past the app: with DP's January closing, an opening posted without an approval is refused at COMMIT; with one, it stands.
    await setMonth('DP', '2027-01-01', 'closing');
    refusedAtCommit(await postByHand('DP', { type: 'opening', lines: [[CASH.DP, 300, 0], [PL.DP, 0, 300]] }), 'FIN_PERIOD_CLOSING', 'Jan 2027');
    assert.equal(await postByHand('DP', { type: 'opening', lines: [[CASH.DP, 300, 0], [PL.DP, 0, 300]], approved: true }), null);
    const dp = await live('DP');
    assert.ok(dp, 'the approved opening posted');
    refusedAtCommit(await reverseByHand('DP', dp.id), 'FIN_PERIOD_CLOSING', 'Jan 2027');
    assert.equal(await reverseByHand('DP', dp.id, { approved: true }), null);
    assert.equal(await live('DP'), null);
  } finally {
    for (const code of ['CI', 'DP']) for (const key of ['opening', 'reversal']) await h.db.q(rule, [BOOK[code], key, 'always']);
    await allOpen('CI');
    await allOpen('DP');
  }
});

test('R70: correcting the opening after an audit needs an audited unlock first; then the MD corrects it', gate, async () => {
  const ob = await postedOpening('CI');
  try {
    await setMonth('CI', '2027-03-01', 'locked');
    const held = await refusedAndNothingWritten(reverse(ob.id), 409, 'FIN_PERIOD_LOCKED');
    assert.match(held.body.error, /^Mar 2027 is locked\./);

    // The unlock asks why, and the log keeps the answer.
    const mar = PERIOD.CI['2027-03-01'];
    await refused(h.call('PUT', `/finance/periods/${mar}/status`, { status: 'closing' }, 'md'), 400, 'FIN_REASON_REQUIRED');
    await ok(h.call('PUT', `/finance/periods/${mar}/status`, { status: 'closing', reason: 'CA asked for the opening to be corrected' }, 'md'));
    const unlock = await h.db.one(`SELECT user_name, reason, before, after FROM fin_audit_log
      WHERE entity = 'period' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [mar]);
    assert.deepEqual([unlock.user_name, unlock.reason, unlock.before.status, unlock.after.status],
      ['Test MD', 'CA asked for the opening to be corrected', 'locked', 'closing']);

    // March is closing now: the MD's reversal posts, approved by himself, and so does the opening built in its place.
    const r = (await ok(reverse(ob.id))).voucher;
    assert.deepEqual([r.status, r.self_approved], ['posted', true]);
    const again = await openingDraft('CI', 'md', 700);
    const rebuilt = (await ok(submit(again, 'md'))).voucher;
    assert.deepEqual([rebuilt.status, rebuilt.self_approved, rebuilt.voucher_type], ['posted', true, 'opening']);
    assert.equal((await live('CI')).id, rebuilt.id);

    // R45 still holds whatever the months: the reversal of the opening is never reversed.
    await refusedAndNothingWritten(reverse(r.id), 409, 'FIN_BAD_REVERSAL');
  } finally {
    await allOpen('CI');
  }
});

// ── Ruling R73: every month, not only the opening's ──────────────────────────────────────────

// A typed entry in CI, made through the API by `who`: a journal (Office Rent Dr, Carriage Inward Cr) or a receipt (Cash Dr, Office
// Rent Cr), `rupees` on `date`. Its id.
async function typed(who, voucher_type, date, rupees = 40) {
  const lines = voucher_type === 'receipt'
    ? [{ ledger_id: CASH.CI, debit_paise: rupees * 100, credit_paise: 0 }, { ledger_id: RENT, debit_paise: 0, credit_paise: rupees * 100 }]
    : [{ ledger_id: RENT, debit_paise: rupees * 100, credit_paise: 0 }, { ledger_id: FREIGHT, debit_paise: 0, credit_paise: rupees * 100 }];
  return (await ok(h.call('POST', '/finance/vouchers', {
    book_id: BOOK.CI, voucher_type, voucher_date: date, client_key: randomUUID(), narration: `R73 ${voucher_type} ${date}`, lines,
  }, who))).voucher.id;
}

test('R73: a locked month refuses an entry in any month before it, by the app and by hand; and the books still come first', gate, async () => {
  const posted = (await ok(submit(await typed('md', 'journal', '2027-01-08'), 'md'))).voucher;   // a January entry, to reverse
  assert.equal(posted.status, 'posted');
  try {
    await setMonth('CI', '2027-02-01', 'locked');
    // the accountant's January journal, and the MD's own: February would carry it, so January takes nothing more
    const held = await refusedAndNothingWritten(submit(await typed('acct', 'journal', '2027-01-20')), 409, 'FIN_PERIOD_LOCKED');
    assert.equal(held.body.error, 'Feb 2027 is locked. Nothing more can be posted to it, and an entry in Jan 2027 carries into it, so Jan 2027 '
      + "can't take new entries until Feb 2027 is unlocked.");
    await refusedAndNothingWritten(submit(await typed('md', 'receipt', '2027-01-21'), 'md'), 409, 'FIN_PERIOD_LOCKED');
    // a reversal is an entry like any other: dated in January it is refused; dated after February, it posts
    const back = await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${posted.id}/reverse`, { date: '2027-01-25', reason: 'twice' }, 'md'),
      409, 'FIN_PERIOD_LOCKED');
    assert.match(back.body.error, /^Feb 2027 is locked\./);
    assert.equal((await ok(h.call('POST', `/finance/vouchers/${posted.id}/reverse`, { date: '2027-03-02', reason: 'twice' }, 'md'))).voucher.status, 'posted');
    // by hand, past the app: refused at COMMIT, approved or not, naming February
    refusedAtCommit(await postByHand('CI', { date: '2027-01-22', lines: [[RENT, 10, 0], [FREIGHT, 0, 10]], approved: true }), 'FIN_PERIOD_LOCKED', 'Feb 2027');
    refusedAtCommit(await postByHand('CI', { date: '2027-01-22', lines: [[RENT, 10, 0], [FREIGHT, 0, 10]] }), 'FIN_PERIOD_LOCKED', 'Feb 2027');
    // a typed entry dated before the books begin is still told so first, not that February is locked
    await refusedAndNothingWritten(submit(await typed('md', 'journal', '2026-12-15'), 'md'), 409, 'FIN_BEFORE_BOOKS');
    refusedAtCommit(await postByHand('CI', { date: '2026-12-15', lines: [[RENT, 10, 0], [FREIGHT, 0, 10]], approved: true }), 'FIN_BEFORE_BOOKS');
    // with March locked as well, the first locked month by date is the one named
    await setMonth('CI', '2027-03-01', 'locked');
    const first = await refusedAndNothingWritten(submit(await typed('md', 'journal', '2027-01-26'), 'md'), 409, 'FIN_PERIOD_LOCKED');
    assert.match(first.body.error, /^Feb 2027 is locked\./);
  } finally {
    await allOpen('CI');
  }
});

test('R73: a closing month makes an entry in any month before it wait for an Approver; an Approver\'s own posts, self-approved', gate, async () => {
  try {
    await setMonth('CI', '2027-02-01', 'closing');
    // a receipt needs nobody in an open month (the rule is never); February closing makes January's wait
    const asked = (await ok(submit(await typed('acct', 'receipt', '2027-01-12')))).voucher;
    assert.deepEqual([asked.status, asked.number], ['submitted', null], 'February is closing: the January receipt needs an Approver');
    const bells = await h.db.q(`SELECT user_id FROM notifications WHERE kind = 'fin_approval' AND ref_id = $1 ORDER BY user_id`, [asked.id]);
    assert.deepEqual(bells.map(b => b.user_id), [h.users.md.id, h.users.appr2.id].sort((a, b) => a - b));
    const approved = (await ok(approve(asked.id))).voucher;
    assert.deepEqual([approved.status, approved.approved_by_id, approved.self_approved], ['posted', h.users.md.id, false]);
    // the MD's own posts at once, approved by himself
    const own = (await ok(submit(await typed('md', 'receipt', '2027-01-13'), 'md'))).voucher;
    assert.deepEqual([own.status, own.self_approved, own.approved_by_id], ['posted', true, h.users.md.id]);
    // March, after February, is open: a receipt there posts at once
    assert.equal((await ok(submit(await typed('acct', 'receipt', '2027-03-04')))).voucher.status, 'posted');
    // by hand: unapproved, refused at COMMIT naming February; approved, it stands
    refusedAtCommit(await postByHand('CI', { date: '2027-01-14', lines: [[RENT, 10, 0], [FREIGHT, 0, 10]] }), 'FIN_PERIOD_CLOSING', 'Feb 2027');
    assert.equal(await postByHand('CI', { date: '2027-01-14', lines: [[RENT, 10, 0], [FREIGHT, 0, 10]], approved: true }), null);
  } finally {
    await allOpen('CI');
  }
});

test('R73: a locked month holds back only the months before it: with January locked, February and March post as ever', gate, async () => {
  try {
    await setMonth('CI', '2027-01-01', 'locked');
    assert.equal((await ok(submit(await typed('acct', 'receipt', '2027-02-03')))).voucher.status, 'posted', 'a February receipt posts at once');
    const mar = (await ok(submit(await typed('md', 'journal', '2027-03-03'), 'md'))).voucher;
    assert.deepEqual([mar.status, mar.self_approved], ['posted', true]);
    assert.equal(await postByHand('CI', { date: '2027-02-04', lines: [[RENT, 10, 0], [FREIGHT, 0, 10]] }), null, 'and by hand');
    // …while January itself is locked, as ever
    const jan = await refusedAndNothingWritten(submit(await typed('md', 'journal', '2027-01-27'), 'md'), 409, 'FIN_PERIOD_LOCKED');
    assert.equal(jan.body.error, 'Jan 2027 is locked. Nothing more can be posted to it.');
  } finally {
    await allOpen('CI');
  }
});
