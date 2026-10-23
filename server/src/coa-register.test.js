// COA Register: reading the Drive register, finding each COA's PDF, and who may
// view or download. Pure rules, plus pins on the route and the user save.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRegister, pickPdf, registerDate, folderWithinCoa, mayViewCoa, mayDownloadCoa, REGISTER_COLUMNS, autoSyncRefusal, driveFingerprint, isNetworkError } from './coa-register.js';

const HEAD = REGISTER_COLUMNS.map(c => c[0]);
const row = over => HEAD.map(h => over[h] ?? null);

test('register dates read as the register writes them, and nonsense is blank', () => {
  assert.equal(registerDate('16-10-2026'), '2026-10-16');
  assert.equal(registerDate('03/09/2026'), '2026-09-03');
  assert.equal(registerDate('2026-10-17'), '2026-10-17');
  assert.equal(registerDate(new Date(Date.UTC(2026, 9, 16))), '2026-10-16');
  assert.equal(registerDate('31-02-2026'), null, 'not a real day');
  assert.equal(registerDate('-'), null);
  assert.equal(registerDate(''), null);
});

test('the register parses every column, finds its heading row, and skips blank rows', () => {
  const rows = [
    ['COA Register — Colour Impressions'],
    HEAD,
    row({ 'COA No.': 'CI-COA-0586-01', Customer: 'Acme Pharma', Invoice: 'CI/26-27/0586', 'Invoice date': '16-10-2026',
      Line: 1, Qty: '19,650', 'Std GSM': 300, 'COA status': 'Draft - ready for QC signature', 'Rows on hold': '-',
      'QC signed': 'No', 'COA file': 'COA_X_01.pdf', Folder: 'COA/Colour Impressions/2026/10_October/Acme Pharma/INV X' }),
    [],
    row({ Customer: 'no coa number' }),
  ];
  const { records, missing, duplicates } = parseRegister(rows);
  assert.equal(records.length, 1);
  assert.deepEqual(missing, []);
  assert.deepEqual(duplicates, []);
  const r = records[0];
  assert.equal(r.coa_no, 'CI-COA-0586-01');
  assert.equal(r.invoice_date, '2026-10-16');
  assert.equal(r.qty, 19650);
  assert.equal(r.std_gsm, 300);
  assert.equal(r.line_no, 1);
  assert.equal(r.date_approved, null);
});

test('a COA No. written twice keeps the later row and is reported', () => {
  const { records, duplicates } = parseRegister([HEAD,
    row({ 'COA No.': 'A', Remarks: 'first' }), row({ 'COA No.': 'A', Remarks: 'second' })]);
  assert.equal(records.length, 1);
  assert.equal(records[0].remarks, 'second');
  assert.deepEqual(duplicates, ['A']);
});

test('a sheet that is not the register is refused, a missing heading is reported', () => {
  assert.throws(() => parseRegister([['Name', 'Pay']]), /COA No\./);
  const { missing } = parseRegister([['COA No.', 'Customer'], ['X', 'Y']]);
  assert.ok(missing.includes('Invoice'));
});

test('the PDF is the exact name, else Drive\'s newest "(n)" copy — never a neighbour', () => {
  const files = [
    { name: 'COA_7_02_Telflor-H (1).pdf', mtimeMs: 2 },
    { name: 'COA_7_01_Acebrobid (1).pdf', mtimeMs: 5 },
    { name: 'COA_7_01_Acebrobid.pdf', mtimeMs: 1 },
    { name: 'COA_7_02_Telflor-H (2).pdf', mtimeMs: 9 },
    { name: 'COA_7_02_Telflor-H-Kid.pdf', mtimeMs: 99 },
  ];
  assert.equal(pickPdf('COA_7_01_Acebrobid.pdf', files).name, 'COA_7_01_Acebrobid.pdf');
  assert.equal(pickPdf('COA_7_02_Telflor-H.pdf', files).name, 'COA_7_02_Telflor-H (2).pdf');
  assert.equal(pickPdf('COA_7_03_None.pdf', files), null);
  assert.equal(pickPdf(null, files), null);
});

test('the register Folder is read from inside the COA folder', () => {
  assert.equal(folderWithinCoa('COA/Colour Impressions/2026/10_October'), 'Colour Impressions/2026/10_October');
  assert.equal(folderWithinCoa('Colour Impressions/2026'), 'Colour Impressions/2026');
  assert.equal(folderWithinCoa(null), '');
});

test('viewing is the module tick; downloading needs the Download COA right too', () => {
  const unrestricted = { role: 'planner', modules: null, coa_download: 0 };
  const ticked = { role: 'viewer', modules: ['coa_register'], coa_download: 0 };
  const notTicked = { role: 'viewer', modules: ['orders'], coa_download: 1 };
  assert.equal(mayViewCoa(unrestricted), true);
  assert.equal(mayDownloadCoa(unrestricted), false, 'an unrestricted login still needs the right');
  assert.equal(mayViewCoa(ticked), true);
  assert.equal(mayDownloadCoa(ticked), false);
  assert.equal(mayDownloadCoa({ ...ticked, coa_download: 1 }), true);
  assert.equal(mayViewCoa(notTicked), false);
  assert.equal(mayDownloadCoa(notTicked), false, 'no module, no download — whatever the flag');
  assert.equal(mayDownloadCoa({ role: 'admin', modules: null, coa_download: 0 }), true);
  assert.equal(mayDownloadCoa(null), false);
});

test('the route reads the right fresh from users and refuses a download without it', () => {
  const route = fs.readFileSync(new URL('./routes/coa-register.js', import.meta.url), 'utf8');
  assert.match(route, /SELECT id, role, active, modules, coa_download FROM users WHERE id = \$1 AND active = 1/);
  assert.match(route, /if \(download && !mayDownloadCoa\(u\)\)/);
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /app\.use\('\/api', coaRegister\)/);
});

test('the Download COA right travels with the user save, like the other grants', () => {
  const auth = fs.readFileSync(new URL('./auth.js', import.meta.url), 'utf8');
  assert.match(auth, /if \('coa_download' in req\.body\) \{ sets\.push\(`coa_download=\$\$\{i\+\+\}`\); vals\.push\(cleanFlag\(req\.body\.coa_download\)\); \}/);
  assert.match(auth, /coa_download: \+\(u\.coa_download \?\? 0\)/);
  const masters = fs.readFileSync(new URL('../../client/src/pages/Masters.jsx', import.meta.url), 'utf8');
  assert.match(masters, /body\.coa_download = \+editing\.coa_download \? 1 : 0;/);
});

test('the automatic sync refuses what looks like an accident, and lets ordinary changes through', () => {
  const recs = n => Array.from({ length: n }, (_, i) => ({ coa_no: `C${i}` }));
  assert.equal(autoSyncRefusal({ before: 25, records: recs(27), removed: [] }), null, 'new COAs');
  assert.equal(autoSyncRefusal({ before: 25, records: recs(24), removed: ['C9'] }), null, 'one COA taken out');
  assert.equal(autoSyncRefusal({ before: 0, records: recs(25), removed: [] }), null, 'the first sync');
  assert.match(autoSyncRefusal({ before: 25, records: [], removed: [] }), /empty/);
  assert.match(autoSyncRefusal({ before: 25, records: recs(21), removed: ['a', 'b', 'c', 'd'] }), /remove 4 of 25/);
  assert.match(autoSyncRefusal({ before: 5, records: recs(3), removed: ['a', 'b'] }), /remove 2 of 5/, 'a fifth of a small register');
  assert.match(autoSyncRefusal({ before: 25, records: recs(25), missing: ['COA file'] }), /COA file heading/);
});

test('the Drive fingerprint moves with any register or PDF change and ignores listing order', () => {
  const reg = { name: 'COA Register.xlsx', size: 9000, mtimeMs: 1000 };
  const a = { rel: 'x/a.pdf', size: 10, mtimeMs: 1 };
  const b = { rel: 'x/b.pdf', size: 20, mtimeMs: 2 };
  const fp = driveFingerprint(reg, [a, b]);
  assert.equal(driveFingerprint(reg, [b, a]), fp);
  assert.notEqual(driveFingerprint({ ...reg, mtimeMs: 2000 }, [a, b]), fp, 'register re-saved');
  assert.notEqual(driveFingerprint(reg, [a, b, { rel: 'y/c.pdf', size: 5, mtimeMs: 3 }]), fp, 'a PDF added');
  assert.notEqual(driveFingerprint(reg, [a, { ...b, size: 21 }]), fp, 'a PDF replaced');
});

test('no network after waking is not a sync failure; a real error still is', () => {
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND aws-1-ap-south-1.pooler.supabase.com'), { code: 'ENOTFOUND' });
  assert.equal(isNetworkError(dns), true, 'the alert Anik saw');
  assert.equal(isNetworkError(Object.assign(new Error(''), { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] })), true);
  assert.equal(isNetworkError(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isNetworkError(Object.assign(new Error('relation "coa_register" does not exist'), { code: '42P01' })), false);
  assert.equal(isNetworkError(new Error('password authentication failed for user "postgres"')), false);
  assert.equal(isNetworkError(null), false);
});
