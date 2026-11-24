import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const NAME = '20261121090000_hr_paid_from.sql';
const path = new URL(`../../supabase/migrations/${NAME}`, import.meta.url);
const sql = existsSync(path) ? readFileSync(path, 'utf8') : '';
const dbjs = readFileSync(new URL('./db.js', import.meta.url), 'utf8');

test('the file exists and sorts after the newest earlier migration', () => {
  assert.ok(existsSync(path), `${NAME} missing`);
  assert.ok(NAME > '20261120100000', NAME);
});

test('standard header, short lock, idempotent, no drop', () => {
  assert.match(sql, /^-- /);
  assert.match(sql, /set local lock_timeout = '1s';/);
  assert.match(sql, /Mirrored locally by server\/src\/db\.js init\(\)/);
  assert.doesNotMatch(sql, /drop/i);
});

test('four nullable text columns, added only when missing', () => {
  for (const [t, c] of [['advance_txns', 'paid_via'], ['loan_txns', 'paid_via'], ['payment_batches', 'paid_from'], ['run_lines', 'paid_from']]) {
    assert.match(sql, new RegExp(`alter table hr\\.${t}\\s+add column if not exists ${c} text\\s*;`, 'i'), `${t}.${c}`);
  }
});

test('db.js replays it after the HR files and before the finance core', () => {
  const at = dbjs.indexOf(`migration('${NAME}')`);
  assert.ok(at > -1, 'db.js line missing');
  assert.ok(at > dbjs.indexOf("migration('20261115120000_hr_sub_account.sql')"));
  assert.ok(at < dbjs.indexOf("migration('20261027104320_finance_ledger_core.sql')"));
});
