import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, quantityBreaks } from './costing-engine.js';
import {
  parseQuantity, cleanQuantities, cleanItem, cleanMail, priceRows, ceilPaise, stageOf, customerLine, LINE_KEYS,
  quotationLines, groupByCustomer, customerKey, productKey, isRepeat, composeReply, replySubject, replyRecipient, customerSpecs, sizeText,
  BACK_TO, broughtBack, UNDO_COLS, mailReplyState, REPLY_FRESH_MS, STALE_CLAIM_MINUTES, autoCostStopped, RESUME_WHY, PRICE_CHANGED_WHY,
} from './enquiry-desk.js';
import { quotationPdf, pdfSafe } from './quotation-pdf.js';
import { loadPdfjs } from './poparse.js';
import { readFileSync } from 'node:fs';

// Invented figures, not a customer's. The internal ones are marked so a leak is easy to see.
const COSTING = {
  qty: 10000, sheet_l: 20, sheet_w: 30, ups: 6, gsm: 300, board_rate: 98.7654, wastage: 250, colours: 4,
  print_rate: 437, print_min: 1600, coat_factor: 3, dp_rate: 0.3141, emb_rate: 0, process: 4321.98, pf_pct: 5, misc_pct: 2, margin: 0.0567,
};
const ENQ = {
  id: 7, enquiry_no: 'CI-ENQ-0007', customer_name: 'Example Pharma', contact_name: 'Ravi Kumar', contact_email: 'buyer@example.com',
  product_name: 'TESTOCAL 10 TAB CARTON', size_text: '120x40x90', style: 'LOCK', board: 'FBB', gsm: 300, colours: 4,
  coating: 'Aqueous varnish', specs: 'Embossed logo', quantities: [10000, 25000], target_price: 1.11,
  notes: 'INTERNAL NOTE: margin thin, board from stock',
  final_prices: [{ qty: 10000, final: 2.5, proposed: 2.0123 }, { qty: 25000, final: 2.2, proposed: 1.8765 }],
};

test('quantities as people write them', () => {
  assert.equal(parseQuantity('10,000'), 10000);
  assert.equal(parseQuantity('1,00,000 nos'), 100000);
  assert.equal(parseQuantity('10k'), 10000);
  assert.equal(parseQuantity('25K pcs'), 25000);
  assert.equal(parseQuantity('1 lakh'), 100000);
  assert.equal(parseQuantity('1.5 lac'), 150000);
  assert.equal(parseQuantity('5000'), 5000);
  assert.equal(parseQuantity(''), null);
  assert.equal(parseQuantity('abc'), null);
  assert.deepEqual(cleanQuantities(['25,000', 10000, '10k', 0, 'x']), [10000, 25000]);
});

test('an item: size read the Costing way, pasting normalised, nothing invented', () => {
  const i = cleanItem({ product: 'Test carton', size: '120 X 40 X 90 mm', pasting: 'lock ', quantity: '10,000', colors: 4, gsm: '300' });
  assert.equal(i.size_key, '120x40x90');
  assert.equal(i.style, 'LOCK');
  assert.deepEqual(i.quantities, [10000]);
  assert.equal(i.colours, 4);
  assert.equal(i.gsm, 300);
  assert.equal(i.board, null);
  assert.equal(cleanItem({ notes: 'no product, no size' }), null);
  assert.equal(cleanItem({ product_name: 'x', style: 'ZIGZAG' }).style, null);
});

test('cleanItem reads the opening of a side-pasted carton', () => {
  const base = { product_name: 'Test carton' };
  assert.equal(cleanItem({ ...base, style: 'SIDE', opening: 'Top open' }).opening, 'top');
  assert.equal(cleanItem({ ...base, style: 'SIDE', opening: 'side' }).opening, 'side');
  assert.equal(cleanItem({ ...base, style: 'LOCK', opening: 'top' }).opening, null);
  assert.equal(cleanItem({ ...base, style: 'SIDE' }).opening, null);
  assert.equal(cleanItem({ ...base }).opening, null);
});

test('a mail: Gmail id required, addresses lower-cased, a Gmail link only', () => {
  assert.equal(cleanMail({}).error, 'gmail_message_id is missing');
  const m = cleanMail({
    gmail_message_id: '19abc', from_email: 'Buyer@Example.COM', from_name: 'Ravi', view_url: 'https://evil.example/x',
    received_at: '2026-11-02T10:00:00Z', items: [{ product_name: 'A' }, { notes: 'nothing' }],
    attachments: [{ filename: 'drawing.pdf', mimeType: 'application/pdf', size: 1200 }, { size: 1 }],
  });
  assert.equal(m.from_email, 'buyer@example.com');
  assert.equal(m.contact_email, 'buyer@example.com');
  assert.equal(m.contact_name, 'Ravi');
  assert.equal(m.view_url, null);
  assert.equal(m.items.length, 1);
  assert.deepEqual(m.attachments, [{ name: 'drawing.pdf', mime: 'application/pdf', size: 1200 }]);
});

test('proposed price = the costing\'s quote price at each quantity; the suggestion is rounded UP to the paisa', () => {
  const rows = priceRows({ quantities: [10000, 25000], final_prices: [] }, COSTING);
  const breaks = quantityBreaks(COSTING, [10000, 25000]);
  assert.equal(rows.length, 2);
  rows.forEach((r, i) => {
    assert.equal(r.proposed, breaks[i].quote_per_unit);
    assert.ok(r.suggested >= r.proposed && r.suggested - r.proposed < 0.01);
    assert.equal(r.final, null);
  });
  assert.equal(ceilPaise(2.001), 2.01);
  assert.equal(ceilPaise(2.0), 2);
  // No quantity asked: the costing's own.
  assert.deepEqual(priceRows({ quantities: [], final_prices: [] }, COSTING).map(r => r.qty), [10000]);
  // Incomplete costing: no proposal, but the quantities still show.
  assert.equal(priceRows({ quantities: [5000] }, null)[0].proposed, null);
  // A final price set against an older proposal is flagged.
  const moved = priceRows({ quantities: [10000], final_prices: [{ qty: 10000, final: 2.5, proposed: 1.5 }] }, COSTING)[0];
  assert.equal(moved.final, 2.5);
  assert.equal(moved.changed, true);
});

test('"Costing completed" is read from the costing, never stored', () => {
  assert.equal(stageOf('costing', true), 'costed');
  assert.equal(stageOf('costing', false), 'costing');
  assert.equal(stageOf('price_pending', true), 'price_pending');
  // In costing with no costing behind it (none saved, or hidden): waiting to be costed, not "in progress".
  assert.equal(stageOf('costing', false, false), 'ready');
  assert.equal(stageOf('costing', true, false), 'ready');
  assert.equal(stageOf('new', false, false), 'new');
});

test('Send back is one tab to the left; Bring back returns a row to where it was dropped', () => {
  // Costing → Inbox, Final price → Costing, Quotations → Final price; the Inbox and Sent have no "back".
  assert.deepEqual(BACK_TO, { ready: 'new', costing: 'new', costed: 'ready', price_pending: 'ready', quote_ready: 'price_pending' });
  for (const s of ['new', 'sent', 'dropped']) assert.equal(BACK_TO[s], undefined);
  assert.equal(broughtBack('price_pending', 4), 'price_pending');
  assert.equal(broughtBack('ready', null), 'ready');
  // An older drop kept no record of where it was: Costing when it has a costing, else the Inbox.
  assert.equal(broughtBack(undefined, 4), 'costing');
  assert.equal(broughtBack(null, null), 'new');
  assert.equal(broughtBack('dropped', null), 'new');
  // Undo keeps every column a desk change can touch — the status, the costing link, the prices, what was asked, and what
  // CI Plant could not do by itself (a person's costing clears it; Undo brings it back).
  for (const k of ['status', 'costing_id', 'batch_id', 'final_prices', 'finalised_by', 'quotation_id', 'quantities', 'product_name', 'auto_cost_why', 'reply_claim_at']) {
    assert.ok(UNDO_COLS.includes(k), k);
  }
});

// One reply per mail (owner, 20 Nov 2026: approval fixes the price, makes the quotation and saves the Gmail draft;
// nothing is sent). Invented rows: an approved item is in To price, its costing approved, every quantity priced.
// Approve stamps each final price it keeps or fills (final review I2): priceRows reads the stamp as `approved`.
const PRICED = [{ qty: 10000, final: 2.41, approved: true }, { qty: 25000, final: 2.05, approved: true }];
const item = (id, o = {}) => ({
  id, enquiry_no: `CI-ENQ-${String(id).padStart(4, '0')}`, status: 'price_pending', stage: 'price_pending', costing_status: 'approved',
  costing_complete: true, prices: PRICED, quotation_id: null, quotation_no: null, quotation_status: null, auto_cost_why: null, auto_cost_at: null, ...o,
});

test('mailReplyState: ready only when nothing of the mail waits', () => {
  assert.deepEqual(mailReplyState([item(1), item(2)]), { ready: true, approved: [1, 2], waiting: [], quoted: [], resume: null });
  const held = item(3, { status: 'costing', stage: 'costing', costing_status: 'draft', costing_complete: false,
    prices: [{ qty: 10000, final: null }], auto_cost_why: 'needs pasting: side or lock?' });
  assert.deepEqual(mailReplyState([item(1), held]),
    { ready: false, approved: [1], waiting: [{ enquiry_no: 'CI-ENQ-0003', why: 'needs pasting: side or lock?' }], quoted: [], resume: null });
  assert.deepEqual(mailReplyState([item(1), item(4, { status: 'dropped', stage: 'dropped', costing_status: 'draft' })]),
    { ready: true, approved: [1], waiting: [], quoted: [], resume: null });
  const quoted = mailReplyState([item(1), item(5, { status: 'quote_ready', stage: 'quote_ready', quotation_id: 9, quotation_no: 'CI-QTN-0003', quotation_status: 'queued' })]);
  assert.deepEqual(quoted, { ready: false, approved: [1], waiting: [], quoted: ['CI-QTN-0003'], resume: null });
});

test('mailReplyState: why an item waits, and what counts as quoted', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  const ago = min => new Date(now - min * 60_000).toISOString();
  const why = (o, at = now) => mailReplyState([item(1), item(2, o)], { now: at }).waiting.map(w => w.why);
  // A complete costing not approved yet; a row with no costing; an approved costing with a quantity still unpriced.
  assert.deepEqual(why({ costing_status: 'draft' }), ['waiting for approval']);
  assert.deepEqual(why({ status: 'ready', stage: 'ready', costing_status: null, costing_complete: false, prices: [{ qty: 10000, final: null }] }), ['not costed yet']);
  assert.deepEqual(why({ prices: [{ qty: 10000, final: 2.41 }, { qty: 25000, final: null }] }), ['waiting for approval']);
  // A hidden costing is no costing, even an approved one.
  assert.deepEqual(why({ costing_complete: false }), ['not costed yet']);
  // What CI Plant could not do by itself is the reason; a claim older than five minutes stopped part-way.
  const tried = said => ({ status: 'new', stage: 'new', costing_status: null, costing_complete: false, prices: [{ qty: 10000, final: null }], auto_cost_why: said });
  assert.deepEqual(why(tried('Could not cost it by itself: no size')), ['Could not cost it by itself: no size']);
  assert.deepEqual(why({ ...tried('being costed'), auto_cost_at: ago(1) }), ['being costed']);
  assert.deepEqual(why({ ...tried('being costed'), auto_cost_at: ago(6) }), ['costing stopped part-way — press Cost it for me']);
  assert.deepEqual(why(tried('being costed')), ['being costed'], 'no claim time: not stale, as the SQL reads it');
  // A cancelled or superseded quotation is not one; sent, ordered and a row finalised but not yet quoted are.
  for (const s of ['cancelled', 'superseded']) {
    assert.equal(mailReplyState([item(1), item(2, { quotation_id: 7, quotation_no: 'CI-QTN-0007', quotation_status: s })]).ready, true, s);
  }
  assert.deepEqual(mailReplyState([item(1), item(2, { status: 'sent', stage: 'sent', quotation_id: 7, quotation_no: 'CI-QTN-0007', quotation_status: 'sent' }),
    item(3, { status: 'ordered', stage: 'ordered', quotation_id: 7, quotation_no: 'CI-QTN-0007', quotation_status: 'sent' })]).quoted, ['CI-QTN-0007']);
  assert.deepEqual(mailReplyState([item(1), item(2, { status: 'quote_ready', stage: 'quote_ready', finalised_at: new Date(now - 5000).toISOString() })], { now }),
    { ready: false, approved: [1], waiting: [], quoted: ['CI-ENQ-0002'], resume: null }, 'finalised just now, not quoted yet: the row itself is named');
  // Nothing approved is no reply, even with nothing waiting; a deleted row is out like a dropped one.
  assert.equal(mailReplyState([item(1, { status: 'deleted', stage: 'deleted' }), item(2, { status: 'dropped', stage: 'dropped' })]).ready, false);
  assert.equal(mailReplyState([]).ready, false);
});

// A reply cut off part-way (R23, narrowed by final review I1): rows the claim itself finalised (reply_claim_at) that are on
// no quotation yet. A finalise younger than REPLY_FRESH_MS may be another press still making it, so it reads as quoted
// (R22); older, it resumes. A row finalised any other way, or on a quotation, is quoted.
test('mailReplyState: a reply cut off part-way is resumed, one still being made is quoted', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  const at = ms => new Date(now - ms).toISOString();
  const cut = (id, o = {}) => item(id, { status: 'quote_ready', stage: 'quote_ready', finalised_at: at(10 * 60_000), reply_claim_at: at(10 * 60_000), ...o });
  const state = list => mailReplyState(list, { now });
  const resume = ids => ({ ids, why: 'Finalised, reply not finished — press Send quotation' });
  assert.equal(RESUME_WHY, 'Finalised, reply not finished — press Send quotation', "Approve is offered on To price only: the Quoted tab's Send quotation finishes it");
  assert.equal(REPLY_FRESH_MS, 35_000, 'a call has 30 s; the same margin as the client joins a write for');
  assert.deepEqual(state([cut(1), cut(2)]), { ready: false, approved: [], waiting: [], quoted: [], resume: resume([1, 2]) });
  // No finalise time at all reads as long ago.
  assert.deepEqual(state([cut(1, { finalised_at: null }), cut(2)]).resume, resume([1, 2]));
  // On a quotation (its own send step made one, 'ready' and not drafted): a quotation is there, so quoted — Send quotation
  // drafts it.
  assert.deepEqual(state([cut(1, { quotation_id: 4, quotation_no: 'CI-QTN-0004', quotation_status: 'ready' }), cut(2)]),
    { ready: false, approved: [], waiting: [], quoted: ['CI-QTN-0004', 'CI-ENQ-0002'], resume: null });
  // Finalised just now: another press may be sending it — quoted, never resumed.
  assert.deepEqual(state([cut(1, { finalised_at: at(REPLY_FRESH_MS - 1000) }), cut(2)]),
    { ready: false, approved: [], waiting: [], quoted: ['CI-ENQ-0001', 'CI-ENQ-0002'], resume: null });
  assert.deepEqual(state([cut(1, { finalised_at: at(1000), quotation_id: 4, quotation_no: 'CI-QTN-0004', quotation_status: 'ready' })]).quoted, ['CI-QTN-0004']);
  // Finalised the old way (no claim mark): quoted, however long ago.
  assert.deepEqual(state([cut(1, { reply_claim_at: null }), cut(2, { reply_claim_at: null })]),
    { ready: false, approved: [], waiting: [], quoted: ['CI-ENQ-0001', 'CI-ENQ-0002'], resume: null });
  // A reply already made (a draft queued, saved or sent) is never made again: the rest are named with it.
  assert.deepEqual(state([item(1, { status: 'quote_ready', stage: 'quote_ready', quotation_id: 4, quotation_no: 'CI-QTN-0004', quotation_status: 'drafted' }), cut(2)]),
    { ready: false, approved: [], waiting: [], quoted: ['CI-QTN-0004', 'CI-ENQ-0002'], resume: null });
  // What waits, or a row approved since, does not hold the cut-off rows back; only they are resumed.
  const held = item(3, { status: 'costing', stage: 'costing', costing_status: 'draft', costing_complete: false, prices: [{ qty: 10000, final: null }] });
  assert.deepEqual(state([cut(1), held, item(4)]),
    { ready: false, approved: [4], waiting: [{ enquiry_no: 'CI-ENQ-0003', why: 'not costed yet' }], quoted: [], resume: resume([1]) });
});

// Final review I1 (the reviewer's case): A was finalised by hand days ago and its quotation then cancelled — cancel empties
// quotation_id and the row waits in Quoted. B was just approved. A went the old way, so the mail's automatic reply is not
// made (B is sent by hand, "part of this mail went on …"), and A is never quoted again by a claim.
test("mailReplyState: a row whose quotation was cancelled or superseded counts as quoted, never as a reply to resume", () => {
  const now = Date.parse('2026-11-25T10:00:00Z');
  const daysAgo = new Date(now - 4 * 86_400_000).toISOString();
  const A = item(1, { status: 'quote_ready', stage: 'quote_ready', costing_status: 'draft', finalised_at: daysAgo });
  const B = item(2);
  const st = mailReplyState([A, B], { now });
  assert.deepEqual(st, { ready: false, approved: [2], waiting: [], quoted: ['CI-ENQ-0001'], resume: null });
  assert.deepEqual(st.ready ? st.approved : st.resume?.ids || [], [], "what claimReply would finalise and send: nothing — A is not re-quoted");
  // A superseded quotation's row: quoted too (it used to read as resumable for ever, with nothing the send step could do).
  const sup = item(3, { status: 'quote_ready', stage: 'quote_ready', finalised_at: daysAgo, reply_claim_at: daysAgo,
    quotation_id: 9, quotation_no: 'CI-QTN-0009', quotation_status: 'superseded' });
  assert.deepEqual(mailReplyState([sup, B], { now }), { ready: false, approved: [2], waiting: [], quoted: ['CI-ENQ-0003'], resume: null });
  // A row the claim finalised whose quotation a person then cancelled: the claim's mark went when its quotation was made,
  // so it reads as any finalised row — and even a mark left behind is no resume while the row points at a quotation.
  const cancelledClaim = item(5, { status: 'quote_ready', stage: 'quote_ready', finalised_at: daysAgo, reply_claim_at: daysAgo,
    quotation_id: 11, quotation_no: 'CI-QTN-0011', quotation_status: 'cancelled' });
  assert.deepEqual(mailReplyState([cancelledClaim, B], { now }).resume, null);
  // The claim's own cut-off row, on no quotation and older than REPLY_FRESH_MS: still resumed.
  const cut = item(4, { status: 'quote_ready', stage: 'quote_ready', finalised_at: daysAgo, reply_claim_at: daysAgo });
  assert.deepEqual(mailReplyState([cut, B], { now }).resume, { ids: [4], why: RESUME_WHY });
});

// Final review I2: a row is approved for the automatic reply only when every final price carries Approve's stamp. A price
// set after the approval (PUT prices, by any login) is not stamped: the mail's reply waits until a manager approves again.
test('mailReplyState: a price changed after approval waits for Approve again', () => {
  assert.equal(PRICE_CHANGED_WHY, 'price changed after approval — Approve again');
  const changed = item(2, { prices: [{ qty: 10000, final: 2.55, approved: false }, { qty: 25000, final: 2.05, approved: true }] });
  assert.deepEqual(mailReplyState([item(1), changed]),
    { ready: false, approved: [1], waiting: [{ enquiry_no: 'CI-ENQ-0002', why: 'price changed after approval — Approve again' }], quoted: [], resume: null });
  // never stamped at all (priced by hand, the costing approved on its own screen): the same — Approve stamps it
  const unstamped = item(3, { prices: PRICED.map(({ approved, ...p }) => p) });
  assert.deepEqual(mailReplyState([unstamped]).waiting, [{ enquiry_no: 'CI-ENQ-0003', why: 'price changed after approval — Approve again' }]);
  assert.equal(mailReplyState([item(1)]).ready, true);
});

test("priceRows: each quantity says whether its final price is the one Approve stamped", () => {
  const e = { quantities: [10000, 25000, 50000], final_prices: [
    { qty: 10000, final: 2.41, proposed: 2.4, ok: true }, { qty: 25000, final: 2.1, proposed: 2.0 }, { qty: 50000, final: 1.9, proposed: 1.9, ok: 'yes' }] };
  assert.deepEqual(priceRows(e, null).map(r => [r.qty, r.final, r.approved]), [[10000, 2.41, true], [25000, 2.1, false], [50000, 1.9, false]]);
  assert.equal(priceRows({ quantities: [10000], final_prices: [] }, null)[0].approved, false);
});

test('one stale-claim threshold: the desk reads it, and the auto-costing\'s SQL uses the same minutes', async () => {
  assert.equal(STALE_CLAIM_MINUTES, 5);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./auto-costing.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bSTALE_CLAIM_MINUTES\b[^}]*\} from '\.\/enquiry-desk\.js'/);
  assert.match(src, /auto_cost_at < now\(\) - make_interval\(mins => \$\{STALE_CLAIM_MINUTES\}\)/);
  assert.doesNotMatch(src, /interval '5 minutes'/, 'no second copy of the threshold');
});

test('one quotation per customer: master first, else the address, else the name', () => {
  const rows = [
    { id: 1, customer_id: 5 }, { id: 2, customer_id: 5, contact_email: 'a@x.com' },
    { id: 3, contact_email: 'A@x.com' }, { id: 4, contact_email: 'a@x.com' }, { id: 5, customer_name: 'Other' },
  ];
  assert.equal(customerKey(rows[2]), 'e:a@x.com');
  assert.deepEqual(groupByCustomer(rows).map(g => g.map(e => e.id)), [[1, 2], [3, 4], [5]]);
});

test('one customer who wrote to both mailboxes gets one quotation per mailbox, each a reply in its own thread', () => {
  const rows = [
    { id: 1, customer_id: 5, mailbox: 'trial' }, { id: 2, customer_id: 5, mailbox: 'business' },
    { id: 3, customer_id: 5, mailbox: 'trial' }, { id: 4, customer_id: 6, mailbox: 'business' },
  ];
  assert.deepEqual(groupByCustomer(rows).map(g => g.map(e => e.id)), [[1, 3], [2], [4]]);
});

test('a row typed in by hand (no mailbox) joins its customer\'s mailed rows, as before', () => {
  const rows = [
    { id: 1, customer_id: 5, mailbox: 'trial' }, { id: 2, customer_id: 5, mailbox: null },
    { id: 3, customer_id: 7, mailbox: null }, { id: 4, customer_id: 5, mailbox: 'trial' },
  ];
  assert.deepEqual(groupByCustomer(rows).map(g => g.map(e => e.id)), [[1, 2, 4], [3]]);
  // A hand row first, the mailed rows after: still one quotation.
  assert.deepEqual(groupByCustomer([{ id: 9, customer_id: 5 }, { id: 10, customer_id: 5, mailbox: 'business' }]).map(g => g.map(e => e.id)), [[9, 10]]);
});

test('the trial mailbox replies only to itself; the business one to the customer', () => {
  assert.deepEqual(replyRecipient({ email: 'trial@example.com', send_to: 'own' }, 'buyer@example.com'),
    { to: 'trial@example.com', trial: true, would_go_to: 'buyer@example.com' });
  assert.deepEqual(replyRecipient({ email: 'biz@example.com', send_to: 'customers' }, 'Buyer@Example.com'), { to: 'buyer@example.com', trial: false });
  assert.match(replyRecipient({ email: 'biz@example.com', send_to: 'customers' }, '').error, /no e-mail address/);
  assert.equal(replySubject('Rate enquiry', 'CI-QTN-0001'), 'Re: Rate enquiry');
  assert.equal(replySubject('RE: Rate enquiry', 'CI-QTN-0001', true), 'RE: Rate enquiry', 'no [TRIAL] tag a customer could see (11 Nov 2026)');
  assert.equal(replySubject(null, 'CI-QTN-0001'), 'Quotation CI-QTN-0001 — Colour Impressions');
});

// ── Strict separation: nothing internal reaches the customer ────────────────────────────────────
const result = computeCosting(COSTING);
const INTERNAL = [
  '98.7654', '98.77', '4321.98', '4,321.98', '0.0567', '0.3141', '437', '2.0123', '1.8765', '1.11',
  'INTERNAL NOTE', 'margin', 'board from stock', 'wastage', 'cost per carton',
  String(Math.round(result.cost_per_unit * 10000) / 10000), String(Math.round(result.parts.board)),
];
const leaks = textOut => INTERNAL.filter(s => textOut.toLowerCase().includes(s.toLowerCase()));

test('a quotation line holds the whitelisted fields only, whatever the enquiry row carries', () => {
  const row = { ...ENQ, costing_inputs: COSTING, result, cost_per_unit: result.cost_per_unit, board_rate: 98.7654 };
  const line = customerLine(row, { qty: 10000, rate: 2.5 });
  assert.deepEqual(Object.keys(line).sort(), [...LINE_KEYS].sort());
  assert.deepEqual(leaks(JSON.stringify(line)), []);
  assert.equal(customerSpecs(ENQ), 'Lock bottom, FBB, 300 GSM, 4 colours, Aqueous varnish, Embossed logo');
  assert.equal(line.size, '120 × 40 × 90');
  assert.equal(sizeText('148x210'), '148 × 210');
});

const QT = () => {
  const { lines, total } = quotationLines([{ ...ENQ, costing_inputs: COSTING, result }]);
  return {
    quotation_no: 'CI-QTN-0003', customer_name: ENQ.customer_name, contact_name: ENQ.contact_name, contact_email: ENQ.contact_email,
    lines, total, terms: 'GST extra.', email_subject: 'Re: Carton rates', email_opening: 'Thank you for your enquiry.',
    email_closing: 'We look forward to your order.', created_at: '2026-11-03T06:00:00Z',
  };
};

test('inside, the quotation row keeps a value: the first quantity of each item, the others as options', () => {
  const qt = QT();
  assert.deepEqual(qt.lines.map(l => [l.qty, l.rate, l.amount, l.option]), [[10000, 2.5, 25000, false], [25000, 2.2, 55000, true]]);
  assert.equal(qt.total, 25000);
});

test('the reply carries the final prices and nothing internal', () => {
  const reply = composeReply(QT(), { sender: 'Sales desk' });
  // Owner, 3 Nov 2026: "Dear Sir/Madam" (never a name), no amount column, no total, no validity days.
  assert.match(reply.text, /^Dear Sir\/Madam,$/m);
  assert.doesNotMatch(reply.text, /Ravi/);
  assert.match(reply.text, /10,000 cartons at Rs\. 2\.50 a carton$/m);
  assert.match(reply.text, /25,000 cartons at Rs\. 2\.20 a carton$/m);
  for (const out of [reply.text, reply.html]) assert.doesNotMatch(out, /Amount|Total|25,000\.00|option/);
  assert.match(reply.text, /Regards,\nSales desk\nColour Impressions/);
  assert.match(composeReply(QT()).text, /Regards,\nColour Impressions$/, 'ends at the signature — no "attached" line (11 Nov 2026)');
  assert.match(reply.html, /<table/);
  assert.deepEqual(leaks(reply.text), []);
  assert.deepEqual(leaks(reply.html), []);
  const trial = composeReply(QT(), { trialFor: 'buyer@example.com' });
  assert.doesNotMatch(trial.text + trial.html, /TRIAL|would go to/, 'no trial words in what a customer may read');
  // A revised quotation: our first quote and their counter beside the revised rate, on the row.
  const rev = composeReply({ ...QT(), lines: QT().lines.map(l => ({ ...l, first: 2.8, counter: 2.1 })) });
  assert.match(rev.text, /10,000 cartons — our first quote Rs\. 2\.80 · your counter Rs\. 2\.10 · our revised rate Rs\. 2\.50 a carton/);
  assert.match(rev.html, /Our first quote<\/th><th [^>]+>Your counter<\/th><th [^>]+>Our revised rate a carton/);
  assert.deepEqual(leaks(rev.text), []);
});

test('a revised quotation PDF lists our first quote and their counter beside the revised rate', async () => {
  const bytes = await quotationPdf({ ...QT(), revision: 1, lines: QT().lines.map(l => ({ ...l, first: 2.8, counter: 2.1 })) }, { name: 'Colour Impressions' }, { trialFor: 'buyer@example.com' });
  const { getDocument } = await loadPdfjs();
  const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const text = (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
  assert.match(text, /REVISED QUOTATION/);
  assert.match(text, /First quote/);
  assert.match(text, /Your counter/);
  assert.match(text, /2\.80/);
  assert.match(text, /2\.10/);
  assert.doesNotMatch(text, /TRIAL/);
});

test('the PDF says the final prices, in words the standard font can draw, and nothing internal', async () => {
  const bytes = await quotationPdf(QT(), { name: 'Colour Impressions', address: 'Plot 1, Example Area', city: 'Chandigarh', gstin: '00AAAAA0000A0Z0' });
  assert.ok(bytes.length > 1500);
  const { getDocument } = await loadPdfjs();
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true }).promise;
  let all = '';
  for (let p = 1; p <= doc.numPages; p++) all += (await (await doc.getPage(p)).getTextContent()).items.map(i => i.str).join(' ') + ' ';
  assert.match(all, /CI-QTN-0003/);
  assert.match(all, /TESTOCAL 10 TAB CARTON/);
  assert.match(all, /2\.50/);
  assert.doesNotMatch(all, /Amount|Total|25,000\.00/);
  assert.deepEqual(leaks(all), []);
  assert.equal(pdfSafe('₹ 2.50 — ok ✓'), 'Rs. 2.50 — ok ?');
});

// Found in the live trial (4 Nov 2026): the AVS cloud routine must never be started for an enquiry job — the
// owner's AVS mailbox rule keeps it off dua.anik@gmail.com, and it reads mppchd@gmail.com only in Chrome.
// Since 12 Nov the desk has a cloud routine of its own (enquiry-cloud.js): it is started through its OWN link, kept
// under its own keys — never the AVS link's keys (routine_fire_url / routine_token). enquiry-pg.test.js proves it in
// use: with only the AVS link saved, Fetch starts nothing.
test('the desk never starts the AVS cloud routine, and the routine prompt has no enquiry branch', async () => {
  const { readFileSync } = await import('node:fs');
  const desk = readFileSync(new URL('./routes/enquiries.js', import.meta.url), 'utf8');
  assert.doesNotMatch(desk, /fireRoutine|routine_fire_url|avs-intake\.js/);
  const cloud = readFileSync(new URL('./enquiry-cloud.js', import.meta.url), 'utf8');
  assert.doesNotMatch(cloud, /'routine_fire_url'|'routine_token'|avsSettings/);
  const { CLOUD_KEYS } = await import('./enquiry-cloud.js');
  assert.deepEqual({ ...CLOUD_KEYS }, { url: 'enquiry_routine_fire_url', token: 'enquiry_routine_token' });
  const prompt = readFileSync(new URL('../../client/src/lib/avs-robot/routine-prompt.md', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /enquiry/i);
});

// A customer asking again for the same item (owner, 14 Nov 2026: "If an inquiry has already been downloaded into the
// system, it should not be coming up again … If work has already been done, then those inquiries should not be coming
// up again"): same product (case, spacing and punctuation aside) and either no quantity or only quantities already asked.
test('a product is the same product whatever its case, spacing or punctuation', () => {
  assert.equal(productKey('  Alphacal-500  Tab. CARTON '), productKey('alphacal 500 tab carton'));
  assert.notEqual(productKey('ALPHA 10 TAB CARTON'), productKey('ALPHA 20 TAB CARTON'));
  assert.equal(productKey(null), '');
});

test('asked again: the same item with no quantity or only quantities already asked', () => {
  const open = { product_name: 'Alpha 10 Tab Carton', quantities: [5000, 10000] };
  assert.equal(isRepeat(open, { product_name: 'ALPHA 10 TAB CARTON', quantities: [5000] }), true);
  assert.equal(isRepeat(open, { product_name: 'alpha 10 tab carton', quantities: [10000, 5000] }), true);
  assert.equal(isRepeat(open, { product_name: 'ALPHA 10 TAB CARTON', quantities: [] }), true, 'no quantity: a reminder');
});

test('a new quantity, another product or a nameless item is a new request', () => {
  const open = { product_name: 'ALPHA 10 TAB CARTON', quantities: [5000] };
  assert.equal(isRepeat(open, { product_name: 'ALPHA 10 TAB CARTON', quantities: [5000, 25000] }), false);
  assert.equal(isRepeat(open, { product_name: 'ALPHA 20 TAB CARTON', quantities: [5000] }), false);
  assert.equal(isRepeat(open, { product_name: '', quantities: [5000] }), false);
  assert.equal(isRepeat({ product_name: 'ALPHA 10 TAB CARTON', quantities: [] }, { product_name: 'ALPHA 10 TAB CARTON', quantities: [3000] }), false,
    'the first asked no quantity; a quantity now is new');
});

test('autoCostStopped: only a claim older than the shared threshold, never one with no time', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  const at = mins => new Date(now - mins * 60_000).toISOString();
  assert.equal(autoCostStopped({ auto_cost_why: 'being costed', auto_cost_at: at(STALE_CLAIM_MINUTES + 1) }, now), true);
  assert.equal(autoCostStopped({ auto_cost_why: 'being costed', auto_cost_at: at(STALE_CLAIM_MINUTES - 1) }, now), false);
  assert.equal(autoCostStopped({ auto_cost_why: 'being costed', auto_cost_at: null }, now), false);
  assert.equal(autoCostStopped({ auto_cost_why: 'needs pasting: side or lock?', auto_cost_at: at(60) }, now), false);
  assert.equal(autoCostStopped({ auto_cost_why: null, auto_cost_at: null }, now), false);
});

test('both robot skills read every artwork and ask for the opening', () => {
  for (const f of ['avs-enquiries', 'enquiry-desk']) {
    const text = readFileSync(new URL(`../../skills/${f}/SKILL.md`, import.meta.url), 'utf8');
    for (const must of ['opening', 'every enquiry item', 'Pantone', 'artwork only as CDR']) {
      assert.ok(text.includes(must), `${f} lacks "${must}"`);
    }
    assert.match(text, /Never send/, `${f} lost its never-send rule`);
  }
});
