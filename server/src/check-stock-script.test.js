import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The stock-invariant script's own subtleties, pinned. Each of these was got
// WRONG on the first draft and corrected by replaying the day it was written
// for — a check that cannot catch the incident that prompted it is decoration.
const src = readFileSync(new URL('../../scripts/check-stock.mjs', import.meta.url), 'utf8');

test('phantom stock: a ref\'d adjustment is NOT an arrival', () => {
  const i = src.indexOf("key: 'phantom'");
  const chk = src.slice(i, src.indexOf("key: 'uncounted'"));
  assert.match(chk, /sm\.type='grn' OR \(sm\.type='adjustment' AND sm\.ref_type IS NULL\)/,
    'legitimate inbound is a GRN or an OPENING count. Counting every adjustment as arrival lets '
    + 'the phantom vouch for itself: batch 171 was CREATED by a job_stage adjustment, so a check '
    + 'that trusted adjustments would have reported material 104 as perfectly sourced');
  assert.doesNotMatch(chk, /sm\.type IN \('grn','adjustment'\)/, 'the first draft\'s spelling is gone');
});

test('the ledger check compares movements against batch levels, both sides', () => {
  const i = src.indexOf("key: 'ledger'");
  const chk = src.slice(i, src.indexOf("key: 'loose'"));
  assert.match(chk, /FROM stock_movements/);
  assert.match(chk, /FROM stock_batches/);
  assert.match(chk, /COALESCE\(mv\.q,0\) <> COALESCE\(bt\.q,0\)/,
    'a material with movements and no batches must fail too — COALESCE on both sides');
});

test('the loose check is the definitional rule, not a tolerance', () => {
  const i = src.indexOf("key: 'loose'");
  const chk = src.slice(i, src.indexOf("key: 'phantom'"));
  assert.match(chk, /sb\.qty::int % m\.sheets_per_packet/, 'loose ≡ qty (mod P)');
  assert.match(chk, /sb\.loose_sheets > sb\.qty/, 'and loose can never exceed the pile');
  assert.match(chk, /sb\.loose_sheets IS NOT NULL/,
    'NULL means never counted and is legitimately re-derived — only an explicit figure is a claim');
});

test('human-answerable findings warn, they do not fail the run', () => {
  // An unbooked delivery, an open recount and a vendor over-ship are states of
  // the PLANT, not broken arithmetic. Failing on them would leave the check
  // permanently red, and a permanently red check stops being read.
  for (const k of ['uncounted', 'recounts', 'overreceipt']) {
    const i = src.indexOf(`key: '${k}'`);
    const chk = src.slice(i, i + 2200);
    assert.match(chk, /warnOnly: true/, `${k} needs a person, not a patch`);
  }
  const ledger = src.slice(src.indexOf("key: 'ledger'"), src.indexOf("key: 'loose'"));
  assert.doesNotMatch(ledger, /warnOnly/, 'a self-contradicting ledger IS a failure');
});

test('it is wired as a command and exits non-zero on a broken invariant', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['check:stock'], 'node scripts/check-stock.mjs');
  assert.match(src, /process\.exit\(1\)/, 'so it can gate a deploy or a schedule');
  assert.match(src, /raw\.replace\(\/\\\\n\/g, ''\)\.trim\(\)/,
    'a prod .env value can end in a LITERAL backslash-n — same trim as check:holds');
});
