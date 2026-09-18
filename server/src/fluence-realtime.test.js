// Every Fluence table announces its changes on the realtime feed. The heartbeat
// vouches only for a table whose ping triggers cover insert, update, delete AND
// truncate; a table left out is never answered from the browser cache and never
// refreshes another person's open screen (20260918120000_fluence_realtime_ping.sql).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const TABLES = 'supabase/migrations/20260917120000_fluence_prescription_kits.sql';
const PING = 'supabase/migrations/20260918120000_fluence_realtime_ping.sql';

test('every table the Fluence migration creates is bound to the realtime ping', () => {
  const created = [...read(TABLES).matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  assert.ok(created.length >= 8, `found ${created.length} fluence tables`);
  const code = read(PING).replace(/--[^\n]*/g, '');
  const bound = [...code.matchAll(/'(fluence_\w+)'/g)].map(m => m[1]);
  for (const table of created) assert.ok(bound.includes(table), `${table} must announce its changes`);
});

test('the Fluence ping covers insert, update, delete and truncate, and never blocks a reader', () => {
  const code = read(PING).replace(/--[^\n]*/g, '');
  assert.match(code, /create or replace trigger ci_erp_realtime_ping after insert or update or delete on public\.%I for each row execute function public\.ci_erp_realtime_ping\(\)/);
  assert.match(code, /create or replace trigger ci_erp_realtime_ping_truncate after truncate on public\.%I for each statement execute function public\.ci_erp_realtime_ping\(\)/);
  assert.match(code, /to_regprocedure\('public\.ci_erp_realtime_ping\(\)'\) is null then\s+return;/, 'a database without the feed skips it');
  assert.doesNotMatch(code, /\bdrop\s+trigger\b/i, 'DROP TRIGGER takes ACCESS EXCLUSIVE, blocking every SELECT');
  assert.doesNotMatch(code, /(^|\n)\s*create\s+trigger\b/i);
  assert.match(code, /set local lock_timeout/);
  assert.doesNotMatch(code, /(^|\n)\s*set\s+lock_timeout/i, 'a plain SET survives on a pooled connection');
});
