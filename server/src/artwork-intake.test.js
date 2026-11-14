import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newArtworkAlert, itemIdentity, AVS_RUNNER } from './artwork-intake.js';

// The office AVS files the business mailbox's artwork mails (Artwork Manager P1). Invented names and codes.

const mail = (over = {}) => ({
  mail_id: 7, customer: 'Example Pharma Ltd',
  rows: [{ job_no: 'CI-AW-0041', label: 'R0.1', product_name: 'ALPHA 10 TAB CARTON', fresh: true },
    { job_no: 'CI-AW-0042', label: 'R0.1', product_name: 'BETA SYRUP CARTON', fresh: true }],
  ...over,
});

test('one mail of new artwork: who, how many, which jobs — and the register opens', () => {
  const a = newArtworkAlert([mail()]);
  assert.equal(a.title, 'New artwork: Example Pharma Ltd — 2 items');
  assert.match(a.body, /CI-AW-0041 ALPHA 10 TAB CARTON \(R0\.1\), CI-AW-0042 BETA SYRUP CARTON \(R0\.1\)/);
  assert.equal(a.link, '/artwork?tab=register');
  assert.equal(a.refTable, 'artwork_mails');
  assert.equal(a.refId, 7);
});

test('a mail that only revises jobs already in the register says revised; one item reads as one item', () => {
  const a = newArtworkAlert([mail({ rows: [{ job_no: 'CI-AW-0041', label: 'R0.2', product_name: 'ALPHA 10 TAB CARTON', fresh: false }] })]);
  assert.equal(a.title, 'Revised artwork: Example Pharma Ltd — 1 item');
  assert.match(a.body, /R0\.2/);
  // one new job among revised ones is still news of new artwork
  assert.match(newArtworkAlert([mail({ rows: [mail().rows[0], { ...mail().rows[1], fresh: false }] })]).title, /^New artwork/);
});

test('more than three jobs are counted, not listed; an unknown customer is "a customer"', () => {
  const rows = [1, 2, 3, 4, 5].map(n => ({ job_no: `CI-AW-000${n}`, label: 'R0.1', product_name: `P${n}`, fresh: true }));
  const a = newArtworkAlert([mail({ customer: null, rows })]);
  assert.equal(a.title, 'New artwork: a customer — 5 items');
  assert.match(a.body, /P3 \(R0\.1\) \+2 more/);
  assert.doesNotMatch(a.body, /P4/);
});

test('several mails in one run are one alert that names each customer', () => {
  const a = newArtworkAlert([mail(), mail({ mail_id: 9, customer: 'Other Labs', rows: [mail().rows[0]] })]);
  assert.equal(a.title, '2 artwork mails in the register');
  assert.match(a.body, /Example Pharma Ltd \(2 items\), Other Labs \(1 item\)/);
  assert.equal(a.refId, 9);
});

test('an item\'s code and revision: what AVS read first, else the file names, else the subject', () => {
  assert.deepEqual(itemIdentity({ client_item_code: 'pcs-x001', client_rev: 'r2', product_name: ' ALPHA ', pack_type: 'carton' }, 'x'),
    { code: 'PCS-X001', rev: 'R2', pack: 'carton', product: 'ALPHA' });
  assert.deepEqual(itemIdentity({ files: [{ file_name: 'PML-X012-R1 - BETA label.cdr' }] }, 'no code here'),
    { code: 'PML-X012', rev: 'R1', pack: 'label', product: 'BETA label' });
  assert.deepEqual(itemIdentity({ product_name: 'Skin Kit' }, 'PMC-X028 - GAMMA - R0'),
    { code: 'PMC-X028', rev: 'R0', pack: 'carton', product: 'Skin Kit' });
  assert.deepEqual(itemIdentity({}, 'artwork attached'), { code: null, rev: '', pack: null, product: '' });
  assert.equal(AVS_RUNNER, 'AVS (office)');
});

test('with no product name from AVS, the first file\'s name without its code, revision and ending is the name', () => {
  const name = n => itemIdentity({ files: [{ file_name: n }] }, '').product;
  assert.equal(name('PCS-X398-R3 - ALPHA SUSPENSION - 200ML -SALE - CARTON.cdr'), 'ALPHA SUSPENSION - 200ML -SALE - CARTON');
  assert.equal(name('PMC-X028 - BETA 10 -R1 - Carton.pdf'), 'BETA 10 - Carton');
  assert.equal(name('Backup_of_PCS-X414 - GAMMA CARTON.cdr'), 'GAMMA CARTON');
  assert.equal(name('PCS-X001-R0.cdr'), '');
  assert.equal(name('Skin Hydra boost.pdf'), '');            // no code: a kit name is AVS's to give, not guessed here
});

test('the subject names the job only when the mail carries one item', () => {
  assert.equal(itemIdentity({ product_name: 'Skin Kit' }, 'PMC-X028 - GAMMA - R0', true).code, 'PMC-X028');
  assert.deepEqual(itemIdentity({ product_name: 'Skin Kit' }, 'PMC-X028 - GAMMA - R0', false), { code: null, rev: '', pack: null, product: 'Skin Kit' });
  assert.equal(itemIdentity({ files: [{ file_name: 'scan0001.pdf' }] }, 'RE: PMC-X028 artwork', false).code, null);
});

test('a code AVS read that is not in the usual pattern is kept as written, and so is a two-digit revision', () => {
  assert.deepEqual(itemIdentity({ client_item_code: ' sp103759 ', client_rev: 'r12', product_name: 'DELTA CARTON' }, ''),
    { code: 'SP103759', rev: 'R12', pack: null, product: 'DELTA CARTON' });
});

test('only http and https addresses are kept as links', async () => {
  const { safeUrl } = await import('./artwork-intake.js');
  assert.equal(safeUrl(' https://drive.test/x '), 'https://drive.test/x');
  assert.equal(safeUrl('http://files.test/a'), 'http://files.test/a');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(safeUrl(null), null);
});
