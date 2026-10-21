// The browser is wherever the accountant is, and the ledger's days are calendar days. Pinned to a zone WEST of Greenwich so a
// day read through a Date (UTC midnight) shows up as the day before: the date tests below only pass if none is. Must run
// before the first Date is built.
process.env.TZ = 'Pacific/Honolulu';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finDifference, finBalancingLine, finFormLinesToApi, finVoucherKey } from '../../client/src/lib/finance/voucher.js';
import * as V from '../../client/src/lib/finance/voucher.js';
import { createBusyGuard } from '../../client/src/lib/busyClick.js';
import { FIN_VOUCHER_TYPES } from './finance-rules.js';
import { finClientKey, finVoucherCan } from './finance-vouchers.js';
const l = (d, c, ledger_id = 1) => ({ ledger_id, debit_paise: d, credit_paise: c });

test('difference and the balancing next line', () => {
  assert.equal(finDifference([l(500, 0), l(0, 300)]), 200);
  assert.deepEqual(finBalancingLine([l(500, 0), l(0, 300)]), { debit_paise: 0, credit_paise: 200 });
  assert.deepEqual(finBalancingLine([l(0, 500)]), { debit_paise: 500, credit_paise: 0 });
  assert.equal(finBalancingLine([l(500, 0), l(0, 500)]), null);
});

test('empty lines never reach the API', () => {
  assert.equal(finFormLinesToApi([l(5, 0), { ledger_id: null, debit_paise: 0, credit_paise: 0 }, l(0, 5, 2)]).length, 2);
});

test('keyboard: Ctrl/Cmd+Enter saves, Enter moves, Enter at an unbalanced line end adds a line', () => {
  assert.equal(finVoucherKey({ key: 'Enter', ctrlKey: true }, { atLastField: false, difference: 0 }), 'save');
  assert.equal(finVoucherKey({ key: 'Enter', metaKey: true }, { atLastField: true, difference: 9 }), 'save');
  assert.equal(finVoucherKey({ key: 'Enter' }, { atLastField: true, difference: 9 }), 'add-line');
  assert.equal(finVoucherKey({ key: 'Enter' }, { atLastField: true, difference: 0 }), 'next');
  assert.equal(finVoucherKey({ key: 'Enter', shiftKey: true }, { atLastField: false, difference: 0 }), 'prev');
  assert.equal(finVoucherKey({ key: 'a' }, { atLastField: false, difference: 0 }), null);
});

// ── Beyond the brief ──────────────────────────────────────────────────────────────────────────────────────────────
// The helpers the entry screen, the lists and the print lean on. Read off the namespace (V.) so each one that is missing
// fails on its own, by name, while red.

test('the arithmetic copes with a line that carries one side only, and with no lines at all', () => {
  assert.equal(finDifference([{ debit_paise: 5 }, { credit_paise: 3 }]), 2);
  assert.equal(finDifference([]), 0);
  assert.equal(finBalancingLine([]), null);
  assert.equal(finDifference([{ debit_paise: NaN, credit_paise: undefined }, l(7, 0)]), 7, 'a figure that is not a number is nothing');
});

test('keys: Shift+Enter goes back even at the end of an unbalanced line, and Ctrl+Shift+Enter still saves', () => {
  assert.equal(finVoucherKey({ key: 'Enter', shiftKey: true }, { atLastField: true, difference: 9 }), 'prev');
  assert.equal(finVoucherKey({ key: 'Enter', ctrlKey: true, shiftKey: true }, { atLastField: false, difference: 0 }), 'save');
  assert.equal(finVoucherKey({ key: 'Enter' }, { atLastField: true }), 'next', 'no difference given is not an unbalanced voucher');
  assert.equal(finVoucherKey({ key: 'Enter' }, { atLastField: true, difference: NaN }), 'next');
  assert.equal(finVoucherKey({ key: 'Tab' }, { atLastField: true, difference: 9 }), null);
  assert.equal(finVoucherKey(undefined, undefined), null);
});

test('what reaches the API: only the API\'s own fields, blank text as nothing, half-filled lines kept for the server to name', () => {
  const typed = {
    key: 7, ledger_id: 3, debit_text: '5', credit_text: '', debit_paise: 500, credit_paise: 0, debit_error: null, credit_error: null,
    narration: '  freight  ', bill_ref: ' ', bill_date: '', due_date: '2026-11-01',
  };
  assert.deepEqual(finFormLinesToApi([typed]), [
    { ledger_id: 3, debit_paise: 500, credit_paise: 0, narration: 'freight', bill_ref: null, bill_date: null, due_date: '2026-11-01' }]);
  const kept = finFormLinesToApi([l(0, 0, 3), { ledger_id: '', debit_paise: 0, credit_paise: 9 }]);
  assert.deepEqual(kept.map(x => [x.ledger_id, x.debit_paise, x.credit_paise]), [[3, 0, 0], [null, 0, 9]]);
  assert.deepEqual(finFormLinesToApi([{ ledger_id: null, debit_paise: 0, credit_paise: 0, narration: 'a note and nothing else' }]), []);
});

test('the type labels are the server\'s own table, and the four typed types are the ones it marks manual', () => {
  assert.deepEqual({ ...V.FIN_TYPE_LABELS }, Object.fromEntries(Object.entries(FIN_VOUCHER_TYPES).map(([type, t]) => [type, t.label])));
  assert.deepEqual([...V.FIN_ENTRY_TYPES], Object.entries(FIN_VOUCHER_TYPES).filter(([, t]) => t.manual).map(([type]) => type));
  assert.ok(Object.isFrozen(V.FIN_TYPE_LABELS) && Object.isFrozen(V.FIN_ENTRY_TYPES));
  assert.equal(V.finTypeLabel('credit_note'), 'Credit Note');
  assert.equal(V.finTypeLabel('constructor'), 'constructor', 'a word on every object is not a type');
  assert.equal(V.finTypeLabel(undefined), '—');
});

test('a voucher\'s status and number, the way a person reads them', () => {
  assert.deepEqual(V.finStatusOf({ status: 'draft' }), { key: 'draft', label: 'Draft' });
  assert.deepEqual(V.finStatusOf({ status: 'submitted' }), { key: 'waiting', label: 'Waiting approval' });
  assert.deepEqual(V.finStatusOf({ status: 'posted', reversed_by_id: null }), { key: 'posted', label: 'Posted' });
  assert.deepEqual(V.finStatusOf({ status: 'posted', reversed_by_id: 9 }), { key: 'reversed', label: 'Reversed' });
  assert.deepEqual(V.finStatusOf({ status: 'discarded' }), { key: 'discarded', label: 'Discarded' });
  assert.deepEqual(V.finStatusOf({ status: 'something-new' }), { key: 'something-new', label: 'something-new' });
  assert.equal(V.finNumberText({ number: 'CI-JV-2627-0001', status: 'posted' }), 'CI-JV-2627-0001');
  assert.equal(V.finNumberText({ number: null, status: 'draft' }), 'Draft');
  assert.equal(V.finNumberText({ number: null, status: 'submitted' }), 'Awaiting approval');
  assert.equal(V.finNumberText({ number: null, status: 'discarded' }), 'Discarded draft');
});

test('a day is written as the calendar day it is, in whatever zone the browser keeps (this file runs in Honolulu)', () => {
  assert.equal(V.finDateText('2026-10-17'), '17 Oct 2026');
  assert.equal(V.finDateText('2027-01-01'), '01 Jan 2027', 'the first of January, not the 31st of December');
  for (const none of [null, undefined, '', 'garbage', '2026-02-30', 20261017]) assert.equal(V.finDateText(none), '—', String(none));
});

test('the month a day falls in, for the "this month" figure', () => {
  assert.deepEqual(V.finMonthOf('2026-10-17'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(V.finMonthOf('2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(V.finMonthOf('2027-03-31'), { from: '2027-03-01', to: '2027-03-31' }, 'the last day of a financial year');
  assert.deepEqual(V.finMonthOf('2027-04-01'), { from: '2027-04-01', to: '2027-04-30' }, 'the first day of the next');
});

test('the date a new voucher opens on: the last one used while it is a real day, otherwise today', () => {
  assert.equal(V.finPickDate('2026-10-12', '2026-10-17'), '2026-10-12');
  assert.equal(V.finPickDate(null, '2026-10-17'), '2026-10-17');
  assert.equal(V.finPickDate('', '2026-10-17'), '2026-10-17');
  assert.equal(V.finPickDate('2026-02-30', '2026-10-17'), '2026-10-17', 'not a day');
  assert.equal(V.finPickDate('12/10/2026', '2026-10-17'), '2026-10-17', 'not the shape a date takes');
});

test('a typed amount: blank is nothing, a good one is whole paise, a bad one says why', () => {
  assert.deepEqual(V.finParseAmountText(''), { paise: 0, error: null });
  assert.deepEqual(V.finParseAmountText('   '), { paise: 0, error: null });
  assert.deepEqual(V.finParseAmountText(null), { paise: 0, error: null });
  assert.deepEqual(V.finParseAmountText('1,250.5'), { paise: 125050, error: null });
  assert.deepEqual(V.finParseAmountText('12,50,000'), { paise: 125000000, error: null }, 'Indian grouping');
  assert.deepEqual(V.finParseAmountText(' 7 '), { paise: 700, error: null });
  for (const bad of ['12.345', '1250,50', '-5', 'abc', '1e5', '5 0']) {
    const out = V.finParseAmountText(bad);
    assert.equal(out.paise, 0, bad);
    assert.match(out.error, /Enter an amount in rupees with at most two decimals/, bad);
  }
});

test('paise back to the text a cell shows, and that text reads back as the same paise', () => {
  assert.equal(V.finAmountText(0), '', 'no amount is an empty cell');
  assert.equal(V.finAmountText(100), '1.00');
  assert.equal(V.finAmountText(125050), '1,250.50');
  assert.equal(V.finAmountText(12345678900), '12,34,56,789.00');
  for (const paise of [1, 5, 99, 100, 123456, 987654321, 99999999999999]) {
    assert.equal(V.finParseAmountText(V.finAmountText(paise)).paise, paise, String(paise));
  }
  assert.equal(V.finAmountText(NaN), '');
  assert.equal(V.finAmountText(-5), '', 'a cell never shows a negative');
});

test('a line from the API becomes a form line and goes back, losing nothing', () => {
  const api = { line_no: 1, ledger_id: 7, debit_paise: 125050, credit_paise: 0, narration: 'freight', bill_ref: 'INV-9', bill_date: '2026-10-01', due_date: null, ledger_name: 'Rent' };
  const form = V.finLineFromApi(api);
  assert.deepEqual(form, {
    ledger_id: 7, debit_text: '1,250.50', credit_text: '', debit_paise: 125050, credit_paise: 0, debit_error: null, credit_error: null,
    narration: 'freight', bill_ref: 'INV-9', bill_date: '2026-10-01', due_date: '',
  });
  assert.deepEqual(finFormLinesToApi([form]), [
    { ledger_id: 7, debit_paise: 125050, credit_paise: 0, narration: 'freight', bill_ref: 'INV-9', bill_date: '2026-10-01', due_date: null }]);
  const blank = V.finBlankLine();
  assert.deepEqual([blank.ledger_id, blank.debit_text, blank.credit_text, blank.debit_paise, blank.credit_paise, blank.narration], [null, '', '', 0, 0, '']);
  assert.ok(finFormLinesToApi([blank]).length === 0, 'a blank line is empty');
});

test('typing in one side clears the other; an entry that does not parse is nothing for now and says nothing until the cell is left', () => {
  const credited = { ...V.finBlankLine(), credit_text: '5', credit_paise: 500 };
  const typed = V.finSetAmount(credited, 'debit', '7.5');
  assert.deepEqual([typed.debit_text, typed.debit_paise, typed.credit_text, typed.credit_paise], ['7.5', 750, '', 0]);
  const cleared = V.finSetAmount(credited, 'debit', '');
  assert.deepEqual([cleared.credit_text, cleared.credit_paise, cleared.debit_paise], ['5', 500, 0], 'emptying one side does not touch the other');
  const half = V.finSetAmount(V.finBlankLine(), 'credit', '12.');
  assert.deepEqual([half.credit_text, half.credit_paise, half.credit_error], ['12.', 0, null]);
  assert.equal(V.finSetAmount({ ...V.finBlankLine(), debit_error: 'old' }, 'debit', '3').debit_error, null, 'a fresh keystroke clears the old complaint');
});

test('leaving a cell settles it: good text is tidied, bad text keeps its error, zero is no amount', () => {
  const tidy = V.finSettleAmounts({ ...V.finBlankLine(), debit_text: '1250.5', debit_paise: 125050 });
  assert.deepEqual([tidy.debit_text, tidy.debit_paise, tidy.debit_error], ['1,250.50', 125050, null]);
  const bad = V.finSettleAmounts({ ...V.finBlankLine(), credit_text: 'abc' });
  assert.deepEqual([bad.credit_text, bad.credit_paise], ['abc', 0], 'what was typed stays, so the person can fix it');
  assert.match(bad.credit_error, /Enter an amount in rupees/);
  const zero = V.finSettleAmounts({ ...V.finBlankLine(), debit_text: '0.00' });
  assert.deepEqual([zero.debit_text, zero.debit_paise, zero.debit_error], ['', 0, null]);
  const stale = V.finSettleAmounts({ ...V.finBlankLine(), debit_text: '4', debit_paise: 999 });
  assert.equal(stale.debit_paise, 400, 'the text is the truth, whatever the paise said');
});

test('the lines that were sent, by their place on the form', () => {
  const rows = [l(5, 0), V.finBlankLine(), l(0, 5, 2), { ...V.finBlankLine(), narration: 'only a note' }];
  assert.deepEqual(V.finSentRows(rows), [0, 2]);
  assert.deepEqual(V.finSentRows([]), []);
});

test('a refusal that names a field points at the cell, counting the lines that were SENT', () => {
  const sent = [0, 2];                       // row 1 was blank and never went
  assert.deepEqual(V.finFieldTarget('lines[1].debit_paise', sent), { row: 2, column: 'debit_paise' });
  assert.deepEqual(V.finFieldTarget('lines[0].ledger_id', sent), { row: 0, column: 'ledger_id' });
  assert.deepEqual(V.finFieldTarget('lines[1].bill_ref', sent), { row: 2, column: 'bill_ref' });
  assert.deepEqual(V.finFieldTarget('lines[1]', sent), { row: 2, column: null });
  assert.deepEqual(V.finFieldTarget('narration', sent), { name: 'narration' });
  assert.deepEqual(V.finFieldTarget('voucher_date', sent), { name: 'voucher_date' });
  assert.deepEqual(V.finFieldTarget('lines', sent), { name: 'lines' });
  assert.equal(V.finFieldTarget('lines[7].debit_paise', sent), null, 'there was no seventh line');
  for (const none of [undefined, null, '', 42]) assert.equal(V.finFieldTarget(none, sent), null, String(none));
});

test('the draft body: a new draft names its book, type and save key; an edit sends only what can change', () => {
  const lines = [V.finLineFromApi({ ledger_id: 3, debit_paise: 500, credit_paise: 0 }), V.finBlankLine(), V.finLineFromApi({ ledger_id: 4, debit_paise: 0, credit_paise: 500 })];
  const form = { date: '2026-10-17', narration: '  Rent for October ', reference: '   ', lines };
  const made = V.finDraftBody(form, { bookId: 2, type: 'journal', clientKey: '6f1c0a2e-0000-4000-8000-000000000000' });
  assert.deepEqual(Object.keys(made).sort(), ['book_id', 'client_key', 'lines', 'narration', 'reference', 'voucher_date', 'voucher_type']);
  assert.deepEqual([made.book_id, made.voucher_type, made.voucher_date, made.narration, made.reference], [2, 'journal', '2026-10-17', 'Rent for October', null]);
  assert.equal(made.lines.length, 2, 'the blank line is not sent');
  const edited = V.finDraftBody(form);
  assert.deepEqual(Object.keys(edited).sort(), ['lines', 'narration', 'reference', 'voucher_date']);
  assert.deepEqual(edited.lines, made.lines);
});

test('the amount in words keeps the paise instead of rounding them away', () => {
  assert.equal(V.finAmountWords(12345600), 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only');
  assert.equal(V.finAmountWords(12345650), 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only');
  assert.equal(V.finAmountWords(0), 'Rupees Zero Only');
  assert.equal(V.finAmountWords(5), 'Rupees Zero and Five Paise Only');
  assert.equal(V.finAmountWords(100000050), 'Rupees Ten Lakh and Fifty Paise Only');
  assert.equal(V.finAmountWords(null), 'Rupees Zero Only');
});

test('the Drafts tab offers Edit by the rule the server keeps (ruling R24), and that rule is pinned to finVoucherCan', () => {
  const rows = [
    { voucher_type: 'journal', reversal_of_id: null }, { voucher_type: 'payment', reversal_of_id: null },
    { voucher_type: 'opening', reversal_of_id: null }, { voucher_type: 'journal', reversal_of_id: 12 },
  ];
  for (const row of rows) {
    const draft = { status: 'draft', created_by_id: 5, ...row };
    assert.equal(V.finDraftEditable(row), finVoucherCan(draft, 5, ['accountant']).edit, JSON.stringify(row));
  }
  assert.deepEqual(rows.map(V.finDraftEditable), [true, true, false, false]);
});

test('the sentences the Vouchers page owes the brief, and the list cap it names is the server\'s own', () => {
  assert.equal(V.FIN_PHONE_ENTRY_NOTE, 'Use a computer or tablet to enter vouchers.');
  const cap = Number(/const FIN_LIST_MAX = (\d+);/.exec(readFileSync(new URL('./finance-vouchers.js', import.meta.url), 'utf8'))?.[1]);
  assert.ok(cap > 0, 'non-vacuous: the server\'s cap was found');
  assert.equal(V.FIN_LIST_CAP, cap);
  assert.equal(V.FIN_TRUNCATED_NOTE, 'The list stops at 5,000 vouchers. Narrow the dates to see the rest.');
});

test('a save key is a UUID the server accepts, with or without randomUUID (a plain-http tablet has none)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;     // the server's own pattern (finClientKey)
  assert.match(V.finNewSaveKey(), UUID);
  assert.match(V.finNewSaveKey({}), UUID, 'no crypto at all');
  const noUuid = { getRandomValues: bytes => bytes.fill(255) };
  const key = V.finNewSaveKey(noUuid);
  assert.match(key, UUID);
  assert.equal(key[14], '4', 'a version 4 UUID');
  assert.match(key[19], /[89ab]/, 'with the variant bits set');
  assert.notEqual(V.finNewSaveKey({}), V.finNewSaveKey({}));
  assert.equal(finClientKey(V.finNewSaveKey({})).length, 36, 'and finClientKey takes it');
  assert.equal(V.finNewSaveKey({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }), '11111111-2222-4333-8444-555555555555');
});

test('voucher numbers sort by year and then serial, never as the dates the table\'s sort would take them for', () => {
  assert.ok(V.finNumberKey('CI-JV-2627-0012') > V.finNumberKey('CI-JV-2627-0001'));
  assert.ok(V.finNumberKey('CI-JV-2728-0001') > V.finNumberKey('CI-RV-2627-9999'));
  assert.equal(V.finNumberKey('CI-OB-2627-0001'), V.finNumberKey('CI-JV-2627-0001'), 'the type does not matter');
  for (const none of [null, undefined, '', 'Draft']) assert.equal(V.finNumberKey(none), 0, String(none));
  assert.equal(typeof V.finNumberKey('DP-PV-2627-0003'), 'number');
});

// ── Fix round 1: the writes of a save (ruling R55) ────────────────────────────────────────────────────────────────
// A POST whose answer is lost may still have made the draft. The server answers the repeat of its save key with THAT draft,
// edits unapplied, so a save that follows must PUT what is on screen to the draft before it submits (or reports "kept as
// draft"). The sequence lives in voucher.js as a plan, and a runner that takes the sending as a parameter, so it is tested here
// with a fake server instead of being left to a screen nobody can run in a test.
const noAnswer = () => new TypeError('Failed to fetch');                          // the connection dropped: no HTTP status at all
const refused = status => Object.assign(new Error(`refused ${status}`), { status });
// A fake server. Each write is recorded as 'step' or 'step:draft'; script[i] says what the i-th write answers: an Error is thrown,
// anything else is the voucher (the default names draft 41, or the draft the write was for).
const fakeServer = (...script) => {
  const calls = [];
  const send = async (step, now) => {
    calls.push(now.savedId == null ? step : `${step}:${now.savedId}`);
    const answer = script[calls.length - 1];
    if (answer instanceof Error) throw answer;
    return answer ?? { id: now.savedId ?? 41 };
  };
  return { calls, send };
};

test('R55: the writes of a save, from where the form stands', () => {
  const plan = V.finSavePlan;
  assert.deepEqual(plan({ savedId: null, keySent: false }, true), ['post', 'submit'], 'a fresh Save');
  assert.deepEqual(plan({ savedId: null, keySent: false }, false), ['post'], 'a fresh Keep as draft');
  assert.deepEqual(plan({ savedId: null, keySent: true }, true), ['post', 'put', 'submit'], 'a POST went out and its answer never came');
  assert.deepEqual(plan({ savedId: null, keySent: true }, false), ['post', 'put'], 'Keep as draft keeps the edits too');
  assert.deepEqual(plan({ savedId: 7, keySent: false }, true), ['put', 'submit'], 'a draft being edited');
  assert.deepEqual(plan({ savedId: 7, keySent: true }, false), ['put']);
  assert.deepEqual(plan(undefined, true), ['post', 'submit'], 'nothing known is a fresh form');
});

test('R55: what the form knows after a write: a POST answered, refused cleanly, or never answered', () => {
  const after = V.finSaveAfter;
  const fresh = { savedId: null, keySent: false };
  assert.deepEqual(after(fresh, 'post', { ok: true, id: 41 }), { savedId: 41, keySent: true });
  assert.deepEqual(after(fresh, 'post', { ok: false, status: 400 }), fresh, 'a clean refusal made nothing');
  assert.deepEqual(after(fresh, 'post', { ok: false, status: 409 }), fresh);
  assert.deepEqual(after(fresh, 'post', { ok: false }), { savedId: null, keySent: true }, 'no answer at all: a draft may exist');
  assert.deepEqual(after(fresh, 'post', { ok: false, status: 502 }), { savedId: null, keySent: true }, 'a gateway that gave up says nothing of the commit');
  assert.deepEqual(after(fresh, 'post', { ok: false, status: 500 }), { savedId: null, keySent: true });
  assert.deepEqual(after({ savedId: null, keySent: true }, 'post', { ok: false, status: 400 }), { savedId: null, keySent: true },
    'a refusal of a RETRY says nothing of the first POST');
  for (const step of ['put', 'submit']) {
    for (const outcome of [{ ok: true, id: 41 }, { ok: false, status: 409 }, { ok: false }]) {
      assert.deepEqual(after({ savedId: 41, keySent: true }, step, outcome), { savedId: 41, keySent: true }, `${step} never changes which draft the server holds`);
    }
  }
  assert.deepEqual(after(fresh, 'post', { ok: true }), { savedId: null, keySent: true }, 'an answer that names no draft is not one');
});

test('R55: a fresh Save is a POST then a submit; Keep as draft is the POST alone', async () => {
  const save = fakeServer();
  const out = await V.finRunSave({ state: {}, thenSubmit: true, send: save.send });
  assert.deepEqual(save.calls, ['post', 'submit:41']);
  assert.equal(out.ok, true);
  assert.deepEqual(out.state, { savedId: 41, keySent: true });
  assert.deepEqual(out.voucher, { id: 41 }, 'what the last write answered');
  const keep = fakeServer();
  await V.finRunSave({ state: {}, thenSubmit: false, send: keep.send });
  assert.deepEqual(keep.calls, ['post']);
});

test('R55: a POST whose answer was lost, an edit, then Save again: the replay is followed by a PUT of what is on screen BEFORE the submit', async () => {
  const lost = fakeServer(noAnswer());
  const first = await V.finRunSave({ state: {}, thenSubmit: true, send: lost.send });
  assert.deepEqual([first.ok, first.step, first.state], [false, 'post', { savedId: null, keySent: true }]);
  assert.deepEqual(lost.calls, ['post'], 'and nothing after the failed write');
  // the person edits the lines and presses Save: the same save key goes out again, and the server replays the FIRST draft
  const again = fakeServer();
  const second = await V.finRunSave({ state: first.state, thenSubmit: true, send: again.send });
  assert.deepEqual(again.calls, ['post', 'put:41', 'submit:41']);
  assert.equal(second.ok, true);
  // Keep as draft does not drop the edits either
  const keep = fakeServer();
  await V.finRunSave({ state: first.state, thenSubmit: false, send: keep.send });
  assert.deepEqual(keep.calls, ['post', 'put:41']);
});

test('R55: an edit of a draft the server already holds is a PUT then a submit, never a POST', async () => {
  const edit = fakeServer();
  await V.finRunSave({ state: { savedId: 7 }, thenSubmit: true, send: edit.send });
  assert.deepEqual(edit.calls, ['put:7', 'submit:7']);
});

test('R55: a failure between steps leaves what the next press needs', async () => {
  // Save: the draft is made and the submit is refused. The next press edits THAT draft and tries again: no second POST
  const refusedSubmit = fakeServer({ id: 41 }, refused(409));
  const r1 = await V.finRunSave({ state: {}, thenSubmit: true, send: refusedSubmit.send });
  assert.deepEqual([r1.ok, r1.step, r1.error.status, r1.state], [false, 'submit', 409, { savedId: 41, keySent: true }]);
  assert.deepEqual(refusedSubmit.calls, ['post', 'submit:41']);
  const next = fakeServer();
  await V.finRunSave({ state: r1.state, thenSubmit: true, send: next.send });
  assert.deepEqual(next.calls, ['put:41', 'submit:41']);
  // a retry whose replay is answered but whose PUT is refused: the draft is named now, so the press after that does not POST again
  const refusedPut = fakeServer({ id: 41 }, refused(400));
  const r2 = await V.finRunSave({ state: { keySent: true }, thenSubmit: true, send: refusedPut.send });
  assert.deepEqual([refusedPut.calls, r2.step, r2.state], [['post', 'put:41'], 'put', { savedId: 41, keySent: true }]);
  assert.deepEqual(V.finSavePlan(r2.state, true), ['put', 'submit']);
  // a POST refused cleanly made nothing: the next press is a fresh create
  const refusedPost = fakeServer(refused(400));
  const r3 = await V.finRunSave({ state: {}, thenSubmit: true, send: refusedPost.send });
  assert.deepEqual([refusedPost.calls, r3.state], [['post'], { savedId: null, keySent: false }]);
  assert.deepEqual(V.finSavePlan(r3.state, true), ['post', 'submit']);
  // a POST the server could not finish (a 502) may have committed: the next press replays it and then edits it
  const gateway = fakeServer(refused(502));
  const r4 = await V.finRunSave({ state: {}, thenSubmit: true, send: gateway.send });
  assert.deepEqual(V.finSavePlan(r4.state, true), ['post', 'put', 'submit']);
  // a PUT whose answer was lost leaves the next press to PUT again, whatever the draft came to hold
  const lostPut = fakeServer({ id: 41 }, noAnswer());
  const r5 = await V.finRunSave({ state: { keySent: true }, thenSubmit: true, send: lostPut.send });
  assert.deepEqual([r5.step, V.finSavePlan(r5.state, true)], ['put', ['put', 'submit']]);
});

test('R55: no later write is sent to a draft the server never named', async () => {
  const nameless = fakeServer({});
  const out = await V.finRunSave({ state: {}, thenSubmit: true, send: nameless.send });
  assert.equal(out.ok, false);
  assert.deepEqual(nameless.calls, ['post'], 'the submit is not sent to "null"');
  assert.deepEqual(out.state, { savedId: null, keySent: true });
  assert.match(out.error.message, /did not say which draft/);
});

// The same sequences against a server that keeps the real one's replay rule (finance-vouchers.js, finReplay): a repeat of a save key
// is answered with the draft the first POST made, with the first POST's lines. What a submit posts is whatever the draft HOLDS.
const replayingServer = ({ dropAnswerTo = [] } = {}) => {
  const byKey = new Map();
  const byId = new Map();
  const posted = [];
  const dropped = new Set(dropAnswerTo);     // 'post' or 'submit': the write commits, its answer never arrives
  let nextId = 41;
  const handle = async (step, known, screen) => {
    let draft;
    if (step === 'post') {
      draft = byKey.get(screen.key);
      if (!draft) { draft = { id: nextId++, lines: screen.lines, status: 'draft' }; byKey.set(screen.key, draft); byId.set(draft.id, draft); }
    } else {
      draft = byId.get(known.savedId);
      if (step === 'put') {
        if (draft.status !== 'draft') throw Object.assign(new Error('This entry is no longer a draft.'), { status: 409, data: { code: 'FIN_NOT_DRAFT' } });
        draft.lines = screen.lines;
      }
      if (step === 'submit') { draft.status = 'posted'; posted.push({ id: draft.id, lines: draft.lines }); }
    }
    if (dropped.delete(step)) throw noAnswer();
    return { id: draft.id };
  };
  return { handle, posted, draftLines: id => byId.get(id)?.lines, statusOf: id => byId.get(id)?.status };
};
const press = (server, screen, state, thenSubmit) => V.finRunSave({ state, thenSubmit, send: (step, known) => server.handle(step, known, screen) });

test('R55, end to end against the real replay rule: the voucher that is posted is the one that is on screen', async () => {
  const first = ['rent 500'];
  const edited = ['rent 750'];
  const server = replayingServer({ dropAnswerTo: ['post'] });
  // the first Save: the POST commits draft 41 with the first lines, and its answer is lost
  const lost = await press(server, { key: 'K', lines: first }, {}, true);
  assert.equal(lost.ok, false);
  assert.deepEqual(server.draftLines(41), first, 'the draft exists on the server, and the form does not know it');
  // the person edits and presses Save again
  const again = await press(server, { key: 'K', lines: edited }, lost.state, true);
  assert.equal(again.ok, true);
  assert.deepEqual(server.posted, [{ id: 41, lines: edited }], 'what was posted is what the screen showed, not the first lines');

  // Keep as draft does not drop the edits either
  const keepServer = replayingServer({ dropAnswerTo: ['post'] });
  const keepLost = await press(keepServer, { key: 'K', lines: first }, {}, false);
  await press(keepServer, { key: 'K', lines: edited }, keepLost.state, false);
  assert.deepEqual(keepServer.draftLines(41), edited);

  // The old sequence, a POST and a submit, is what the bug was: the replay hands back the first draft and the submit posts ITS lines
  const old = replayingServer({ dropAnswerTo: ['post'] });
  await old.handle('post', {}, { key: 'K', lines: first }).catch(() => {});
  const replayed = await old.handle('post', {}, { key: 'K', lines: edited });
  await old.handle('submit', { savedId: replayed.id }, { key: 'K', lines: edited });
  assert.deepEqual(old.posted, [{ id: 41, lines: first }], 'without the PUT, the posted voucher is not the one on screen');
});

test('R55: a submit whose answer was lost, then Save again: a draft that is no longer a draft says so, and the form does not claim "not submitted"', async () => {
  const server = replayingServer({ dropAnswerTo: ['submit'] });
  const lost = await press(server, { key: 'K', lines: ['rent 500'] }, {}, true);
  assert.deepEqual([lost.ok, lost.step, server.statusOf(41)], [false, 'submit', 'posted'], 'the submit committed and the form was not told');
  assert.deepEqual(lost.state, { savedId: 41, keySent: true });
  const again = await press(server, { key: 'K', lines: ['rent 500'] }, lost.state, true);
  assert.deepEqual([again.ok, again.step, again.error.data.code], [false, 'put', 'FIN_NOT_DRAFT']);
  assert.deepEqual(server.posted, [{ id: 41, lines: ['rent 500'] }], 'and it was posted once, not twice');
  const text = V.finSaveNotice({ step: again.step, error: again.error, state: again.state });
  assert.match(text, /no longer a draft/);
  assert.match(text, /Day Book/);
  assert.doesNotMatch(text, /not in it|not submitted/);
});

test('M3: one press at a time: a handler that returns the save\'s promise leaves the second and third press with nothing to do', async () => {
  const guard = createBusyGuard({ setTimer: () => 0, clearTimer: () => {} });
  const server = fakeServer();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = async (step, now) => { await gate; return server.send(step, now); };
  const press = () => guard.press(() => V.finRunSave({ state: {}, thenSubmit: true, send: slow }));
  const first = press();
  assert.equal(press(), undefined, 'swallowed while the first is on the wire');
  assert.equal(press(), undefined);
  release();
  await first;
  assert.deepEqual(server.calls, ['post', 'submit:41'], 'one POST and one submit, not three of each');
  assert.equal(guard.busy, false, 'and the button is free again');
  // a handler that forgets to return the promise is NOT guarded: the wiring pins below keep the screens from being written so
  const unguarded = createBusyGuard({ setTimer: () => 0, clearTimer: () => {} });
  const loose = fakeServer();
  const forgetful = () => { V.finRunSave({ state: {}, thenSubmit: false, send: loose.send }); };
  unguarded.press(forgetful);
  unguarded.press(forgetful);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(loose.calls, ['post', 'post'], 'which is exactly the double send the guard exists to stop');
});

test('M1: what the form says after a save that failed never claims "not submitted" when only the answer was lost', () => {
  const notice = (step, error, state) => V.finSaveNotice({ step, error, state });
  // answered refusals: the server said no, so what it did not do is certain
  assert.match(notice('submit', refused(409), { savedId: 41, keySent: true }), /saved, but it was not submitted/);
  assert.match(notice('put', refused(400), { savedId: 41, keySent: true }), /saved, but your latest changes are not in it/);
  assert.equal(notice('post', refused(400), { savedId: null, keySent: false }), '', 'a refused first POST made nothing, so there is nothing to say');
  // no answer: it may or may not have gone through, and the Day Book is where to look
  for (const [step, state] of [['post', { savedId: null, keySent: true }], ['put', { savedId: 41, keySent: true }], ['submit', { savedId: 41, keySent: true }]]) {
    for (const error of [noAnswer(), refused(502)]) {
      const text = notice(step, error, state);
      assert.match(text, /Day Book/, step);
      assert.match(text, /couldn't confirm/i, step);
      assert.doesNotMatch(text, /not submitted|not in it/, `${step}: it must not claim what it does not know`);
    }
  }
  // a refused retry after an earlier POST whose answer never came: that earlier one is still unknown
  assert.match(notice('post', refused(400), { savedId: null, keySent: true }), /Day Book/);
});

test('M1: an error with no HTTP status is a write that got no answer, and the sentence for it is the one the coordinator gave', () => {
  assert.equal(V.FIN_NO_ANSWER_NOTE, "Couldn't reach the server — check the connection and try again.");
  assert.equal(V.finIsNoAnswer(noAnswer()), true);
  assert.equal(V.finIsNoAnswer(refused(409)), false, 'the server answered, and api.js has said what it said');
  assert.equal(V.finIsNoAnswer(refused(502)), false);
  assert.equal(V.finIsNoAnswer(null), false);
  assert.equal(V.finIsNoAnswer(undefined), false);
});

// ── Wiring pins ────────────────────────────────────────────────────────────────────────────────────────────────────
// A .jsx cannot be node --test'd, so what the screens promise is pinned from their source, the way startup-entry-lean.test.js
// pins the shell. Each pin names the ruling or the line of the brief it holds, and the file is read WITHOUT its comments, so a
// sentence in a comment never satisfies it.
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, keep) => keep + ' '.repeat(m.length - keep.length));
const client = file => stripComments(readFileSync(new URL(`../../client/src/${file}`, import.meta.url), 'utf8'));
const page = client('pages/finance/Vouchers.jsx');
const detail = client('components/finance/VoucherDetail.jsx');
const form = client('components/finance/VoucherForm.jsx');
const lineRow = client('components/finance/LineRow.jsx');
const noAnswerHook = client('components/finance/useNoAnswer.js');
const picker = client('components/finance/LedgerPicker.jsx');
const print = client('pages/finance/VoucherPrint.jsx');
const inOrder = (text, needles) => {
  const at = needles.map(needle => text.indexOf(needle));
  assert.ok(at.every(i => i >= 0), `all present: ${needles.filter((_, i) => at[i] < 0).join(' | ')}`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), `in this order: ${needles.join(' | ')}`);
};

test('the Vouchers page and the open voucher refresh when another login changes a Finance table', () => {
  for (const [name, src] of [['Vouchers.jsx', page], ['VoucherDetail.jsx', detail]]) {
    assert.match(src, /useRealtimeRefresh\(load, FINANCE_TABLES\)/, name);
    assert.match(src, /import \{ FINANCE_TABLES \} from '\.\.\/\.\.\/lib\/finance\/tables\.js'/, name);
  }
});

test('the tabs are Day Book, Approvals and Drafts, kept in ?tab=; ?voucher= opens that voucher; the lists are the list endpoint\'s', () => {
  inOrder(page, ["label: 'Day Book'", "label: 'Approvals'", "label: 'Drafts'"]);
  assert.match(page, /params\.get\('tab'\)/);
  assert.match(page, /\/\^\\d\+\$\/\.test\(params\.get\('voucher'\) \?\? ''\)/);
  assert.match(page, /voucherId != null && \(\s*<VoucherDetail id=\{voucherId\}/);
  for (const view of ['daybook', 'approvals', 'drafts']) assert.match(page, new RegExp(`'${view}'`), view);
  // the figures are counted from GET /finance/vouchers: the page asks for nothing else but the voucher it is about to edit
  const asks = [...page.matchAll(/api\.get\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(asks.length >= 3, 'non-vacuous: the page asks for things');
  for (const ask of asks) assert.match(ask, /^listUrl\(|^`\/finance\/vouchers\/\$\{row\.id\}`$/, ask);
});

test('the Day Book has the brief\'s columns in the brief\'s order, and the Approvals and Drafts rows carry their buttons', () => {
  const cols = page.slice(page.indexOf('const columns = {'));
  assert.ok(cols.length > 0 && cols.length < page.length, 'non-vacuous: the columns are where this pin looks for them');
  const day = cols.slice(cols.indexOf('daybook: ['), cols.indexOf('approvals: ['));
  inOrder(day, ['dateColumn', "label: 'Number'", 'typeColumn', 'narrationColumn', 'amountColumn', "label: 'Status'", 'madeByColumn']);
  for (const label of ["label: 'Date'", "label: 'Type'", "label: 'Narration'", "label: 'Amount'", "label: 'Made by'"]) assert.ok(page.includes(label), label);
  const approvals = cols.slice(cols.indexOf('approvals: ['), cols.indexOf('drafts: ['));
  assert.ok(approvals.includes('>Approve</Button>') && approvals.includes('>Reject</Button>'), 'Approve and Reject');
  const drafts = cols.slice(cols.indexOf('drafts: ['), cols.indexOf('const sorts'));
  inOrder(drafts, ['>Edit</Button>', '>Submit</Button>', '>Discard</Button>']);
});

test('R24 and R45: the detail offers an action only when the view\'s `can` does, and keeps no capability rules of its own', () => {
  for (const action of ['discard', 'edit', 'reverse', 'reject', 'approve', 'submit']) assert.match(detail, new RegExp(`can\\.${action} &&`), action);
  assert.doesNotMatch(detail, /finCan|lib\/finance\/caps/, 'the server\'s can is the authority');
  assert.match(page, /finDraftEditable\(r\) && mayKey && <Button/, 'the Drafts tab hides Edit for an Opening voucher or a reversal');
  assert.match(page, /const mayKey = tier !== 'phone'/, 'a phone has no entry grid, so no Edit either');
  assert.match(page, /onEdit=\{mayKey \? openEdit : undefined\}/);
  assert.match(detail, /can\.edit && onEdit && <Button/, 'and the detail shows Edit only when its page can open the form');
  assert.match(page, /if \(!view\.can\.edit\)/, 'and the view\'s can has the last word on a draft that is opened for editing');
});

test('R28 and R42: the Reverse dialog dates no earlier than the voucher, and an Opening voucher\'s date is fixed, not offered', () => {
  const dialog = detail.slice(detail.indexOf('function ReverseDialog'), detail.indexOf('const ACTION_LABEL'));
  assert.ok(dialog.length > 400, 'non-vacuous: the dialog was found');
  assert.match(dialog, /min=\{voucher\.voucher_date\}/);
  assert.match(dialog, /const opening = voucher\.voucher_type === 'opening'/);
  inOrder(dialog, ['{opening ? (', 'An Opening voucher is reversed as at its own date', ') : (', '<Input type="date"']);
  assert.match(dialog, /useState\(opening \|\| today < voucher\.voucher_date \? voucher\.voucher_date : today\)/, 'it opens on its own date, or today when that is not before it');
});

test('R29: a reversal on its way is said, with a way to open it', () => {
  assert.match(detail, /v\.pending_reversal_id != null/);
  assert.match(detail, /Reversal waiting for approval/);
  assert.match(detail, /onOpen\?\.\(v\.pending_reversal_id\)/);
});

// Final review M-9: a long voucher (the Opening voucher can have thousands of lines) prints across as many A4 pages as it takes. A
// sheet kept whole (.print-fit, break-inside: avoid) cannot hold it, and a scroll box (overflow-x-auto) prints as one clipped page.
test('M-9: a short voucher prints on one fitted sheet; a long one flows across pages, its table header repeated on each', () => {
  assert.equal(V.FIN_PRINT_FIT_LINES, 15);
  for (const n of [0, 2, 15]) assert.equal(V.finPrintFits(Array(n).fill({})), true, `${n} lines`);
  for (const n of [16, 200, 1501]) assert.equal(V.finPrintFits(Array(n).fill({})), false, `${n} lines`);
  assert.equal(V.finPrintFits(undefined), true, 'no lines is a short voucher');
  assert.match(print, /const fits = finPrintFits\(lines\);/);
  assert.equal((print.match(/print-fit/g) || []).length, 1, 'print-fit only where `fits` says');
  assert.match(print, /<div className="mt-5 overflow-x-auto print:overflow-visible">/, 'the table is not a scroll box on paper');
  assert.match(print, /<thead className="table-header-group">/, 'the header row repeats on every page');
  assert.match(print, /print:mt-8 print:break-inside-avoid">/, 'the signatures stay together');
});

test('R47: the detail and the print show the voucher\'s OWN book, and the shell is asked to switch once, only when the books differ', () => {
  assert.match(detail, /finBookOf\(me\?\.books, v\.book_id\)/);
  assert.match(print, /finBookOf\(me\?\.books, voucher\.book_id\)/);
  assert.doesNotMatch(print, /\bbook\.name\b/, 'the print never names the shell\'s current book');
  assert.match(detail, /ownBookId === book\.id \|\| switched\.current === ownBookId/);
  assert.match(detail, /setBook\?\.\(ownBookId\)/);
  assert.equal((detail.match(/setBook\?\.\(/g) || []).length, 1, 'one call');
});

test('the entry form: the last date through storage, one save key per opened form, then edits of the draft it made, and the brief\'s keys', () => {
  assert.match(form, /const LAST_DATE = 'fin_last_date'/);
  assert.match(form, /storage\.getItem\(LAST_DATE\)/);
  assert.match(form, /storage\.setItem\(LAST_DATE, date\)/);
  assert.match(form, /if \(saveKey\.current === null\) saveKey\.current = finNewSaveKey\(\)/);
  assert.equal((form.match(/finNewSaveKey\(\)/g) || []).length, 1, 'made in one place, once');
  // R55: the writes of a save are voucher.js' plan, run with this form's sending; the key rides on the POST and on nothing else
  assert.match(form, /finRunSave\(\{\s*state: writes\.current,\s*thenSubmit,/);
  assert.match(form, /const writes = useRef\(\{ savedId: voucher\?\.id \?\? null, keySent: false \}\)/, 'a draft being edited is a draft the server holds');
  assert.match(form, /writes\.current = run\.state/, 'what the form learned stays for the next press');
  assert.equal((form.match(/clientKey: saveKey\.current/g) || []).length, 1, 'the save key is on one body, the POST\'s');
  assert.equal((form.match(/api\.post\('\/finance\/vouchers'/g) || []).length, 1, 'and there is one POST');
  assert.match(form, /api\.put\(`\/finance\/vouchers\/\$\{known\.savedId\}`, finDraftBody\(screen\)\)/, 'a PUT is the screen\'s body without the key');
  assert.match(form, /api\.post\(`\/finance\/vouchers\/\$\{known\.savedId\}\/submit`\)/);
  assert.match(form, /if \(step === 'put' \|\| !known\.keySent\) \{/, 'the form counts the screen as saved after a PUT, or after the POST that made the draft: not after a replay');
  assert.match(form, /finVoucherKey\(e, \{/);
  assert.match(form, /action === 'add-line'\) addLine\(true\)/, 'add-line pre-fills the balancing line');
  assert.match(form, /data-ci-form/, 'a build update never reloads a half-keyed voucher');
  assert.match(form, />Keep as draft</);
  assert.match(form, /Difference \{finFormatINR\(difference, \{ drcr: true \}\)\}/);
  assert.doesNotMatch(form, /localStorage|sessionStorage/);
});

test('the phone sentence and the truncation line are drawn, and an entry button needs the right to enter', () => {
  assert.match(page, /items=\{!mayKey\s*\? \[\{ key: 'phone', label: FIN_PHONE_ENTRY_NOTE \}\]/);
  assert.match(page, /const newVoucher = mayEnter && \(/);
  assert.match(page, /tab === 'daybook' && truncated && \(\s*<p [^>]*>\{FIN_TRUNCATED_NOTE\}<\/p>/);
  assert.match(page, /const mayEnter = can\('enter'\)/);
  assert.match(page, /const mayApprove = can\('approve'\)/);
});

test('LedgerPicker: the shared Select over the book\'s ledgers, active ones, found by name, code or group, each showing its group', () => {
  assert.match(picker, /import \{ Select \} from '\.\.\/ui\.jsx'/);
  assert.match(picker, /`\/finance\/books\/\$\{bookId\}\/ledgers\?include_inactive=1`/);
  assert.match(picker, /search: \[l\.name, l\.code, l\.group_name\]\.filter\(Boolean\)\.join\(' '\)/);
  assert.match(picker, /l\.active && \(!manualOnly \|\| l\.manual_entry\)/);
  assert.match(picker, /renderOption=\{item => \(/);
  assert.match(picker, /\{item\.group\}/);
});

test('the print is POPrint\'s pattern: a no-print toolbar and a print-fit sheet with the words, the signatures and the voucher\'s own book', () => {
  assert.match(print, /className="no-print mb-4 flex justify-between"/);
  assert.match(print, /className=\{`\$\{fits \? 'print-fit ' : ''\}rounded-2xl /, 'a short voucher is the fitted sheet');
  assert.match(print, /window\.print\(\)/);
  assert.match(print, /finAmountWords\(voucher\.total_paise\)/);
  assert.ok(print.includes('Prepared by') && print.includes('Approved by'));
  assert.match(print, /<Link to=\{`\/finance\?voucher=\$\{voucher\.id\}`\}>/, 'Back to the voucher, whichever book the shell is on');
});

// ── Fix round 1: pins for the rest of the review ───────────────────────────────────────────────────────────────────

// An onClick={...} expression, braces balanced, one string per attribute.
const onClicks = src => {
  const out = [];
  for (const m of src.matchAll(/onClick=\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) { if (src[i] === '{') depth += 1; else if (src[i] === '}') depth -= 1; i += 1; }
    out.push(src.slice(m.index + m[0].length, i - 1).trim());
  }
  return out;
};

// The shared Button is one press at a time (lib/busyClick.js) only while its onClick RETURNS the write's promise: a block body with no
// return, or a handler that is not async, hands the button nothing to wait for and the double click goes twice. The behavioural half of
// this is the finRunSave test above; this holds the screens to it, by shape, for every button that sends a write.
test('M3: every button that sends a write hands the shared Button the promise to wait on, and the write behind it is async', () => {
  const WRITES = ['save', 'submit', 'approve', 'go', 'submitDraft', 'startEdit', 'load', 'reject', 'discard'];
  const names = { 'Vouchers.jsx': page, 'VoucherDetail.jsx': detail, 'VoucherForm.jsx': form };
  let writers = 0;
  for (const [name, src] of Object.entries(names)) {
    for (const expression of onClicks(src)) {
      if (!WRITES.some(w => new RegExp(`(^|[^.\\w])${w}(\\(|$)`).test(expression))) continue;
      writers += 1;
      assert.doesNotMatch(expression, /=>\s*\{(?![^}]*\breturn\b)/, `${name}: onClick={${expression}} must return the write's promise`);
    }
  }
  assert.ok(writers >= 9, `non-vacuous: ${writers} write buttons found`);
  for (const [src, shape] of [
    [form, /async function save\(thenSubmit\)/],
    [detail, /const act = \(name, run\) => async \(\) => \{/],
    [detail, /const submit = act\('submit', async \(\) => \{/],
    [detail, /const approve = act\('approve', async \(\) => \{/],
    [detail, /const discard = act\('discard', async \(\) => \{/],
    [detail, /const reject = async reason => \{/],
    [page, /const withRow = async \(id, run\) => \{/],
    [page, /const approve = row => withRow\(row\.id, async \(\) => \{/],
    [page, /const submitDraft = row => withRow\(row\.id, async \(\) => \{/],
    [page, /const startEdit = row => withRow\(row\.id, async \(\) => openEdit\(await api\.get\(/],
    [page, /const reject = async reason => \{/],
    [page, /const discard = async \(\) => \{/],
  ]) assert.match(src, shape);
  assert.equal((detail.match(/const go = async \(\) => \{/g) || []).length, 2, 'the Reject reason dialog\'s go and the Reverse dialog\'s');
  // the dialogs' own buttons take the owner's async function by name
  assert.match(page, /onSubmit=\{reject\}/);
  assert.match(page, /onConfirm=\{discard\}/);
  assert.match(detail, /onSubmit=\{reject\}/);
  assert.match(detail, /onConfirm=\{discard\}/);
});

test('M1: a write that got no answer is said, on every write path, and a refusal is not said twice', () => {
  // the one hook: quiet for a refusal (an error with a status: api.js toasted it) and for a login just signed out
  assert.match(noAnswerHook, /finIsNoAnswer\(error\) && auth\.token/);
  assert.match(noAnswerHook, /toast\.error\(FIN_NO_ANSWER_NOTE\)/);
  // the form's save, and what its notice may claim
  assert.match(form, /const noAnswer = useNoAnswer\(\)/);
  assert.match(form, /noAnswer\(run\.error\);\s*setNotice\(finSaveNotice\(\{ step: run\.step, error: run\.error, state: run\.state \}\)\)/);
  assert.doesNotMatch(form, /not submitted/, 'what a failed save may claim is voucher.js\' to word');
  // the detail's actions and its Reject, and the Reverse dialog's own write
  assert.match(detail, /const failedWrite = async e => \{ noAnswer\(e\); await load\(\); throw e; \}/);
  assert.equal((detail.match(/await failedWrite\(e\)/g) || []).length, 2, 'the actions (act) and Reject');
  const reverse = detail.slice(detail.indexOf('function ReverseDialog'), detail.indexOf('const ACTION_LABEL'));
  assert.match(reverse, /noAnswer\(e\);/);
  assert.match(reverse, /onFailed\?\.\(\)/);
  assert.match(detail, /onFailed=\{load\}/, 'and a refused reversal reloads the voucher');
  // the list's row buttons and its dialogs' writes; a failed one reloads the list
  assert.match(page, /const failedWrite = async e => \{ noAnswer\(e\); await load\(\); throw e; \}/);
  assert.equal((page.match(/await failedWrite\(e\)/g) || []).length, 3, 'a row button, Reject and Discard');
});

test('M2: a list that did not load is not an empty list: a figure never heard is a dash, a failed load says so with a Retry', () => {
  assert.match(page, /const \[known, setKnown\] = useState\(\{ daybook: false, approvals: false, drafts: false \}\)/);
  assert.match(page, /const \[counts, setCounts\] = useState\(\{ drafts: null, approvals: null, waiting: null, today: null, month: null \}\)/,
    'a count that has never come is null, not zero');
  for (const figure of ["counts.drafts != null ? fmt.num(counts.drafts) : '—'", "counts.waiting != null ? fmt.num(counts.waiting) : '—'",
    "counts.today != null ? fmt.num(counts.today) : '—'", "counts.month != null ? fmt.num(counts.month) : '—'"]) {
    assert.ok(page.includes(figure), figure);
  }
  assert.match(page, /count: counts\.approvals \?\? undefined/, 'and no count on a tab whose count never came');
  assert.match(page, /count: counts\.drafts \?\? undefined/);
  // "Nothing is waiting…" and "You have no drafts" only once the list has been heard
  const empty = page.slice(page.indexOf('const empty = !known[tab]'), page.indexOf('const newVoucher'));
  inOrder(empty, ['const empty = !known[tab]', "'The list couldn’t load'", "'Loading…'", "'Nothing is waiting for your approval'", "'You have no drafts'"]);
  assert.match(page, /Couldn't load the vouchers\{known\[tab\] \? ' just now — showing the last ones loaded' : ''\}\./);
  assert.match(page, /onClick=\{\(\) => load\(\)\}>Retry<\/Button>/);
  // a list is marked heard only when its answer came, and only the newest request's failure is news
  assert.match(page, /setKnown\(k => \(\{ \.\.\.k, \[view\]: true \}\)\);/);
  assert.match(page, /if \(!answer\) \{ if \(seq === latest\.current\[view\]\) setFailing\(f => \(\{ \.\.\.f, \[view\]: true \}\)\); return; \}/);
  assert.match(page, /if \(seq === countLatest\.current\) setFailing\(f => \(\{ \.\.\.f, counts: missed \}\)\);/);
  assert.match(page, /asks\.forEach\(\(ask, i\) => \{ if \(answers\[i\]\) next\[ask\.key\] = answers\[i\]\.count; \}\);/,
    'a count that did not come keeps its last figure');
  // the open voucher and the print: only a 404 says "not available to you"
  for (const [name, src] of [['VoucherDetail', detail], ['VoucherPrint', print]]) {
    assert.match(src, /e\?\.status === 404 \? 'gone' : 'trouble'/, name);
    assert.ok(src.includes("Couldn't load this voucher."), name);
    assert.ok(src.includes('Retry'), name);
  }
});

// Ruling R72 (the ERP is on Vercel's Hobby plan, where an overrun pauses every project): the Day Book opens on this month, the figures
// and the tab counts are counts the server makes (GET /finance/vouchers?count=1, the list's own query), and a realtime tick asks again
// for the list on show and the counts, nothing more. It used to ask four lists of up to 5,000 rows each, to count them.
test('R72: the Day Book opens on this month; its figures and tab counts are the server\'s counts; a tick asks only for the list on show', () => {
  assert.deepEqual(V.finDayBookWindow('2026-10-18'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(V.finDayBookWindow('2028-02-29'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(V.finVoucherCountAsks({ today: '2026-10-18', mayApprove: true, mayEnter: true }), [
    { key: 'drafts', view: 'drafts', filters: { count: '1' } },
    { key: 'approvals', view: 'approvals', filters: { count: '1' } },
    { key: 'waiting', view: 'daybook', filters: { status: 'submitted', count: '1' } },
    { key: 'today', view: 'daybook', filters: { status: 'posted', from: '2026-10-18', to: '2026-10-18', count: '1' } },
    { key: 'month', view: 'daybook', filters: { status: 'posted', from: '2026-10-01', to: '2026-10-31', count: '1' } },
  ]);
  assert.deepEqual(V.finVoucherCountAsks({ today: '2027-03-31', mayApprove: false, mayEnter: false }).map(a => a.key), ['waiting', 'today', 'month'],
    'a viewer has no drafts and approves nothing: those two are not asked');
  assert.deepEqual(V.finVoucherCountAsks({ today: '2027-03-31', mayApprove: false, mayEnter: true }).map(a => a.key), ['drafts', 'waiting', 'today', 'month']);
  // the page names its own month, so a page left open past a month's end counts, labels and opens the same month
  assert.deepEqual(V.finVoucherCountAsks({ today: '2026-11-01', month: V.finDayBookWindow('2026-10-31') }).find(a => a.key === 'month').filters,
    { status: 'posted', from: '2026-10-01', to: '2026-10-31', count: '1' });
  // the page: the window it opens on, and the one Reset filters comes back to
  assert.match(page, /const \[monthNow\] = useState\(\(\) => finDayBookWindow\(dayOf\(new Date\(\)\)\)\);/);
  assert.match(page, /const \[from, setFrom\] = useState\(monthNow\.from\);/);
  assert.match(page, /const \[to, setTo\] = useState\(monthNow\.to\);/);
  assert.match(page, /\[from, setFrom, monthNow\.from, 'from date'\], \[to, setTo, monthNow\.to, 'to date'\]/);
  assert.match(page, /filters\.dirty \? 'No vouchers match these filters' : `No vouchers are dated in \$\{monthLabel\}\. Widen the dates to see others\.`/,
    'an empty month is not an empty book');
  // the counts: the server's, through the list route, never a list counted here
  assert.match(page, /const asks = finVoucherCountAsks\(\{ today: dayOf\(new Date\(\)\), month: monthNow, mayApprove, mayEnter \}\);/);
  assert.match(page, /sub=\{`dated in \$\{monthLabel\}`\}\s*onClick=\{\(\) => showInDayBook\(\{ status: 'posted', \.\.\.finMonthOf\(monthNow\.from\) \}\)\}/,
    'the figure, its label and the Day Book it opens are the one month');
  assert.match(page, /asks\.map\(ask => api\.get\(listUrl\(book\.id, ask\.view, ask\.filters\)\)\.catch\(\(\) => null\)\)/);
  assert.doesNotMatch(page, /vouchers\.length|\.truncated\)\s*\?\s*'\+'|more: Boolean/, 'no figure is a list counted in the browser');
  // only the list on show is asked for, and a tick asks for it and the counts
  assert.equal((page.match(/api\.get\(listUrl\(/g) || []).length, 2, 'the list on show, and the counts');
  assert.match(page, /api\.get\(listUrl\(book\.id, view, view === 'daybook' \? \{ from, to, type, status, q \} : \{\}\)\)/);
  assert.match(page, /const load = useCallback\(\(\) => Promise\.all\(\[loadList\(\), loadCounts\(\)\]\), \[loadList, loadCounts\]\);/);
  assert.match(page, /useRealtimeRefresh\(load, FINANCE_TABLES\)/);
});

test('M4: a line is its own component, and the keyboard flow\'s cells are on it: the ledger, Dr, Cr and the bill fields walk; the line narration does not', () => {
  assert.match(form, /import LineRow, \{ LINE_GRID, cellProblem, redRing \} from '\.\/LineRow\.jsx'/);
  assert.match(form, /<LineRow key=\{line\.key\}/);
  for (const cell of ['ledger', 'bill_ref', 'bill_date', 'due_date']) assert.ok(lineRow.includes(`data-fin-field="${cell}" data-fin-cell="${cell}"`), cell);
  assert.match(lineRow, /data-fin-field=\{side\} data-fin-cell=\{side\}/);
  const narration = lineRow.slice(lineRow.indexOf('placeholder="Line narration (optional)"'), lineRow.indexOf("onChange={e => onEdit('narration'"));
  assert.ok(narration.includes('data-fin-cell="narration"') && !narration.includes('data-fin-field'), 'reachable by Tab and by the form, but not on the Enter walk');
  assert.equal((lineRow.match(/\{\.\.\.common\}/g) || []).length, 6, 'every cell carries data-fin-line');
  assert.doesNotMatch(form, /'data-fin-line':/, 'and the form sets none of the row\'s markup (it only reads it, to find a cell)');
});

// ── Fix round 1 of Task 16: the helpers the Reports page shares with this page ──────────────────────────────────────

test('M9: the page changes its query string through the one shared helper, which the Reports page uses too', () => {
  assert.match(page, /import \{ finQueryWith, finSearchEmpty \} from '\.\.\/\.\.\/lib\/finance\/page\.js';/);
  assert.match(page, /const change = updates => setParams\(previous => finQueryWith\(previous, updates\), \{ replace: true \}\);/);
  assert.doesNotMatch(page, /new URLSearchParams\(previous\)/, 'and the page makes no query string of its own');
});

test('M4: Approvals and Drafts hold their search, so "Nothing is waiting" and "You have no drafts" are only said when they are true', () => {
  assert.match(page, /import \{[^}]*\browMatches\b[^}]*\} from '\.\.\/\.\.\/components\/ui\.jsx';/);
  assert.match(page, /const \[listSearch, setListSearch\] = useState\(''\);/);
  assert.match(page, /useEffect\(\(\) => \{ setListSearch\(''\); \}, \[tab\]\);/, 'a search typed on one tab is not carried to the next');
  assert.match(page, /const listQuery = tab === 'daybook' \? '' : listSearch\.trim\(\);/);
  assert.doesNotMatch(page, /\bsearchable\b/, 'the table\'s own search would hide rows without saying so');
  assert.match(page, /searchValue: listSearch, onSearchChange: setListSearch/);
  assert.match(page, /finSearchEmpty\(\{ searching: Boolean\(listQuery\), total: approvals\.length, none: 'Nothing is waiting for your approval', noun: 'waiting vouchers' \}\)/);
  assert.match(page, /finSearchEmpty\(\{ searching: Boolean\(listQuery\), total: drafts\.length, none: 'You have no drafts', noun: 'drafts' \}\)/);
  assert.match(page, /rows\.filter\(r => rowMatches\(r, listQuery\)\)/);
});
