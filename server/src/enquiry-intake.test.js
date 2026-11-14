import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyPrint, newEnquiryAlert, AVS_RUNNER, sameMail, counterPrices } from './enquiry-intake.js';

// The office AVS files the business mailbox's enquiries (owner, 13 Nov 2026: "take the costings in its run from mppchd
// mail, put them into the ERP system, and also give the notification"). Invented names and addresses.

test('a mail\'s text print ignores case and spacing, and an empty mail has no print', () => {
  assert.equal(bodyPrint('  Dear  SIR,\n\n  Kindly share   your RATE '), 'dear sir, kindly share your rate');
  assert.equal(bodyPrint(''), '');
  assert.equal(bodyPrint(null), '');
  assert.equal(bodyPrint(' \n\t '), '');
  assert.equal(bodyPrint('x'.repeat(4000)).length, 1500);
});

const mail = (over = {}) => ({
  mail_id: 7, kind: 'enquiry', customer: 'Example Pharma Ltd', mailbox_email: 'office@plant.test',
  rows: [{ id: 41, product_name: 'ALPHA 10 TAB CARTON' }, { id: 42, product_name: 'BETA SYRUP CARTON' },
    { id: 43, product_name: 'GAMMA CAPS CARTON' }, { id: 44, product_name: 'DELTA GEL CARTON' }],
  ...over,
});

test('one new enquiry mail: who, how many, three products, which mailbox — the desk opens on its first row', () => {
  const a = newEnquiryAlert([mail()]);
  assert.equal(a.title, 'New enquiry: Example Pharma Ltd — 4 items');
  assert.match(a.body, /ALPHA 10 TAB CARTON, BETA SYRUP CARTON, GAMMA CAPS CARTON \+1 more/);
  assert.match(a.body, /to office@plant\.test/);
  assert.match(a.body, /Enquiry desk/);
  assert.equal(a.link, '/costing?tab=enquiries&enquiry=41');
  assert.equal(a.refTable, 'enquiry_mails');
  assert.equal(a.refId, 7);
});

test('one item reads as one item', () => {
  const a = newEnquiryAlert([mail({ rows: [{ id: 9, product_name: 'ALPHA 10 TAB CARTON' }] })]);
  assert.equal(a.title, 'New enquiry: Example Pharma Ltd — 1 item');
  assert.doesNotMatch(a.body, /more/);
});

test('a counter-offer mail says so and points at the Counter tab', () => {
  const a = newEnquiryAlert([mail({ kind: 'counter', rows: [{ id: 50, product_name: 'ALPHA 10 TAB CARTON' }] })]);
  assert.equal(a.title, 'Counter-offer: Example Pharma Ltd — 1 item');
  assert.match(a.body, /their own prices/i);
  assert.match(a.body, /Counter tab/);
  assert.equal(a.link, '/costing?tab=enquiries&enquiry=50');
});

test('several mails: one alert naming each, new ones and counters apart', () => {
  const a = newEnquiryAlert([
    mail(),
    mail({ mail_id: 8, customer: 'Sample Labs', rows: [{ id: 60, product_name: 'OMEGA LABEL' }] }),
    mail({ mail_id: 9, kind: 'counter', customer: 'Sample Labs', rows: [{ id: 61, product_name: 'OMEGA LABEL' }] }),
  ]);
  assert.equal(a.title, '3 mails on the Enquiry desk');
  assert.match(a.body, /New: Example Pharma Ltd \(4 items\), Sample Labs \(1 item\)/);
  assert.match(a.body, /Counter-offer: Sample Labs \(1 item\)/);
  assert.equal(a.link, '/costing?tab=enquiries');
  assert.equal(a.refTable, 'enquiry_mails');
  assert.equal(a.refId, 9, 'a later batch never replaces this one on a lock screen');
});

test('no customer name: it says "a customer", never an address', () => {
  const a = newEnquiryAlert([mail({ customer: null })]);
  assert.equal(a.title, 'New enquiry: a customer — 4 items');
});

test('the robot name AVS rows carry', () => {
  assert.equal(AVS_RUNNER, 'AVS (office)');
});

// The same mail through two mailboxes: the same sender and subject, and either the very same second, or within two
// minutes with the same files or the same words. Two Claudes copy a mail's words differently (14 Nov 2026: one 824
// characters, the other 892, of the same mail), so the words alone can never decide it. A mail lost is worse than one
// shown twice, so anything less is two mails.
const copy = (over = {}) => ({
  from_email: 'Buyer@Sample-Labs.test', subject: 'RFQ  for cartons', body_text: 'PFA, kindly quote.\nRegards',
  attachments: [{ name: 'RFQ.pdf' }, { name: 'spec.xlsx' }], received_at: '2026-11-13T10:00:00Z', ...over,
});

test('a copy of the same mail in the other mailbox is the same mail', () => {
  assert.equal(sameMail(copy(), copy({ from_email: 'buyer@sample-labs.test', subject: 'rfq for  cartons', body_text: 'PFA,  kindly QUOTE. Regards',
    attachments: [{ name: 'spec.xlsx' }, { name: 'RFQ.pdf' }], received_at: '2026-11-13T10:00:30Z' })), true);
});

test('the same mail copied differently by two Claudes is still one mail: the same second, or the same files', () => {
  const longer = 'PFA, kindly quote.\nRegards\nAsha K | Purchase | +91 00000 00000 | sent from the office';
  assert.equal(sameMail(copy(), copy({ body_text: longer })), true, 'the same second');
  assert.equal(sameMail(copy(), copy({ body_text: longer, attachments: [{ name: 'image001.png' }, { name: 'RFQ.pdf' }, { name: 'spec.xlsx' }] })), true,
    'one Claude also listed the logo image');
  assert.equal(sameMail(copy(), copy({ body_text: longer, received_at: '2026-11-13T10:01:30Z' })), true, '90 seconds apart, the same files');
});

test('two mails from one sender under one subject are two mails: other words and no files, or minutes apart', () => {
  const a = copy({ subject: 'RE: NEED BEST RATE', attachments: [], body_text: 'Rate not received for the carton below.', received_at: '2026-11-12T14:33:44Z' });
  const b = copy({ subject: 'RE: NEED BEST RATE', attachments: [], body_text: 'We can pay as below, final.', received_at: '2026-11-12T14:35:22Z' });
  assert.equal(sameMail(a, b), false, 'two replies 98 seconds apart');
  assert.equal(sameMail(copy(), copy({ subject: 'RFQ for labels' })), false, 'another subject');
  assert.equal(sameMail(copy(), copy({ attachments: [{ name: 'RFQ-B.pdf' }], body_text: 'Please quote the B carton.', received_at: '2026-11-13T10:01:00Z' })), false,
    'other files and other words, a minute apart');
});

test('a mail is never matched across a long gap, without a time, or from someone else', () => {
  assert.equal(sameMail(copy(), copy({ received_at: '2026-11-13T15:00:00Z' })), false, 'five hours apart');
  assert.equal(sameMail(copy(), copy({ received_at: '2026-11-13T10:03:00Z' })), false, 'three minutes apart, even with the same files');
  assert.equal(sameMail(copy(), copy({ received_at: null })), false, 'no time: cannot tell');
  assert.equal(sameMail(copy({ attachments: [], body_text: '' }), copy({ attachments: [], body_text: '', received_at: '2026-11-13T10:01:00Z' })), false,
    'no words and no files, a minute apart: cannot tell');
  assert.equal(sameMail(copy(), copy({ from_email: 'other@sample-labs.test' })), false);
});

test('a counter-offer quantity written with a comma is read as a number', () => {
  const list = [{ enquiry_no: 'CI-ENQ-0042', qty: '5,000', theirs: '3.20' }, { enquiry_no: 'CI-ENQ-0042', qty: 10000, theirs: 3 },
    { enquiry_no: 'CI-ENQ-0043', qty: '1,000', theirs: 9 }];
  assert.deepEqual(counterPrices(list, 'CI-ENQ-0042'), [{ qty: 5000, theirs: '3.20' }, { qty: 10000, theirs: 3 }]);
});

test('a mail that only asks again: who, how many, the rows already on the desk', () => {
  const a = newEnquiryAlert([{ mail_id: 12, kind: 'again', customer: 'Example Pharma Ltd', mailbox_email: 'office@plant.test',
    rows: [{ id: 7, product_name: 'ALPHA 10 TAB CARTON', enquiry_no: 'CI-ENQ-0007' }, { id: 8, product_name: 'BETA CARTON', enquiry_no: 'CI-ENQ-0008' }] }]);
  assert.equal(a.title, 'Asked again: Example Pharma Ltd — 2 items');
  assert.match(a.body, /already on the desk as CI-ENQ-0007, CI-ENQ-0008/);
  assert.equal(a.link, '/costing?tab=enquiries&enquiry=7');
});

test('several mails: asked-again ones are named apart', () => {
  const a = newEnquiryAlert([mail(), { mail_id: 13, kind: 'again', customer: 'Sample Labs', mailbox_email: 'office@plant.test',
    rows: [{ id: 9, product_name: 'OMEGA LABEL', enquiry_no: 'CI-ENQ-0009' }] }]);
  assert.match(a.body, /New: Example Pharma Ltd \(4 items\)\. Asked again: Sample Labs \(1 item\)\./);
});
