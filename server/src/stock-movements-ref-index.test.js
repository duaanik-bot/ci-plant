// The ledger lookup every job card makes: stock_movements by (ref_type, ref_id).
//
// "Has this job's board been drawn?" (BOARD_DRAWN_EXISTS), what a card consumed,
// what a stage returned — they all join the stock ledger to its job card by
// ref_type='job_card' AND ref_id = jc.id. There was no index for it, so each
// check read the WHOLE ledger once per order line: 10.3 billion rows read over
// the life of the database, and on 2026-09-16 the single largest cost in the
// plant — 50% of all database time while screens refreshed together, 142 ms per
// Planning refresh for a question the index answers in 2.9 ms (same 238 lines).
//
// Production is migrated by a named Supabase migration, never by init(), so the
// index has to exist in all three places or it is missing somewhere real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const INDEX = /CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements\s*\(ref_type, ref_id\)/;
const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('init() creates the ledger reference index, after the ledger itself', () => {
  const db = read('./db.js');
  const table = db.indexOf('CREATE TABLE IF NOT EXISTS stock_movements');
  const index = db.search(INDEX);
  assert.ok(table >= 0, 'stock_movements is created in init()');
  assert.ok(index >= 0, 'init() must create idx_stock_movements_ref');
  assert.ok(index > table, 'the index must come after the table it indexes');
});

test('the committed baseline carries it', () => {
  assert.match(read('../../supabase/migrations/0001_baseline_schema.sql'), INDEX);
});

test('a named migration carries it to production', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const hit = readdirSync(dir)
    .filter(f => f !== '0001_baseline_schema.sql' && f.endsWith('.sql'))
    .filter(f => INDEX.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.equal(hit.length, 1, 'exactly one migration adds idx_stock_movements_ref');
});
