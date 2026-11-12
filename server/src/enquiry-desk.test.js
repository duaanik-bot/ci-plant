import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, quantityBreaks } from './costing-engine.js';
import {
  parseQuantity, cleanQuantities, cleanItem, cleanMail, priceRows, ceilPaise, stageOf, customerLine, LINE_KEYS,
  quotationLines, groupByCustomer, customerKey, composeReply, replySubject, replyRecipient, customerSpecs, sizeText,
  BACK_TO, broughtBack, UNDO_COLS,
} from './enquiry-desk.js';
import { quotationPdf, pdfSafe } from './quotation-pdf.js';
import { loadPdfjs } from './poparse.js';

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
  // Undo keeps every column a desk change can touch — the status, the costing link, the prices, what was asked.
  for (const k of ['status', 'costing_id', 'batch_id', 'final_prices', 'finalised_by', 'quotation_id', 'quantities', 'product_name']) {
    assert.ok(UNDO_COLS.includes(k), k);
  }
});

test('one quotation per customer: master first, else the address, else the name', () => {
  const rows = [
    { id: 1, customer_id: 5 }, { id: 2, customer_id: 5, contact_email: 'a@x.com' },
    { id: 3, contact_email: 'A@x.com' }, { id: 4, contact_email: 'a@x.com' }, { id: 5, customer_name: 'Other' },
  ];
  assert.equal(customerKey(rows[2]), 'e:a@x.com');
  assert.deepEqual(groupByCustomer(rows).map(g => g.map(e => e.id)), [[1, 2], [3, 4], [5]]);
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
