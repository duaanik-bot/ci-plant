import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('operational screens subscribe to the shared realtime invalidation feed', () => {
  const files = [
    'client/src/components/AppLayout.jsx',
    'client/src/components/FgStockPanel.jsx',
    'client/src/pages/Dashboard.jsx',
    'client/src/pages/Dispatch.jsx',
    'client/src/pages/ExtraSheets.jsx',
    'client/src/pages/Floor.jsx',
    'client/src/pages/Inventory.jsx',
    'client/src/pages/Invoices.jsx',
    'client/src/pages/Orders.jsx',
    'client/src/pages/Planning.jsx',
    'client/src/pages/PrintPlanning.jsx',
    'client/src/pages/Procurement.jsx',
    'client/src/pages/Production.jsx',
    'client/src/pages/Reports.jsx',
    'client/src/pages/Section.jsx',
    'client/src/pages/ShadeCards.jsx',
    'client/src/pages/SortPaste.jsx',
    'client/src/pages/StatusSheet.jsx',
    'client/src/pages/Tooling.jsx',
  ];

  for (const file of files) {
    const source = read(file);
    assert.match(source, /useRealtimeRefresh\(/, `${file} should subscribe to database changes`);
    assert.match(source, /OPERATIONS_REALTIME_TABLES/, `${file} should use the shared table list`);
  }
});

test('realtime migration sends metadata only and keeps the trigger function private', () => {
  const migration = read('supabase/migrations/20260807100428_realtime_broadcast.sql');
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /revoke all on function public\.ci_erp_realtime_ping\(\) from public/);
  assert.match(migration, /'table', TG_TABLE_NAME/);
  assert.doesNotMatch(migration, /row_to_json|NEW,\s*OLD/i);
});

test('database and client use the same public Broadcast channel mode', () => {
  const migration = read('supabase/migrations/20260807100428_realtime_broadcast.sql');
  const client = read('client/src/lib/realtime.js');
  assert.match(migration, /'ci-erp:db-changes',\s*false/);
  assert.match(client, /channel\(topic,\s*\{\s*config:\s*\{\s*private:\s*false/);
});

// ── 2026-09-16: one message per table per transaction, a heartbeat, full coverage ──
const LATEST = 'supabase/migrations/20260917024744_realtime_once_per_transaction.sql';

test('the ping announces a table once per transaction, keyed safely, with no row data', () => {
  const m = read(LATEST);
  assert.match(m, /'ci_erp_rt\.t' \|\| TG_RELID::text/, 'flag keyed by table OID, never by name');
  assert.match(m, /pg_current_xact_id\(\)::text/, 'flag compared with this transaction');
  assert.match(m, /set_config\(flag, xact, true\)/, 'transaction-local flag');
  assert.match(m, /current_setting\(flag, true\) is not distinct from xact/);
  assert.match(m, /set search_path = ''/);
  assert.match(m, /'table', TG_TABLE_NAME/);
  assert.match(m, /'ci-erp:db-changes',\s*false/);
  assert.doesNotMatch(m, /to_jsonb\(new\)->>|row_to_json|'id',/i, 'no row id or row data on a public channel');
  assert.doesNotMatch(m, /set ci_erp_rt|ci_erp_rt\.[^']*=/i, 'the flag must never sit in a SET clause');
  for (const fn of ['ci_erp_realtime_ping', 'ci_erp_realtime_heartbeat'])
    for (const role of ['public', 'anon', 'authenticated'])
      assert.match(m, new RegExp(`revoke all on function public\\.${fn}\\(\\) from ${role}`));
});

test('the heartbeat is rate-limited in the database and names the announced tables', () => {
  const m = read(LATEST);
  assert.match(m, /event = 'db-heartbeat'[\s\S]*interval '45 seconds'/);
  assert.match(m, /tgfoid = 'public\.ci_erp_realtime_ping\(\)'::pg_catalog\.regprocedure/);
  assert.match(m, /'db-heartbeat',\s*'ci-erp:db-changes',\s*false/);
  assert.match(m, /t\.tgenabled in \('O', 'A'\)/, 'a disabled or replica-only trigger vouches for nothing');
  assert.match(m, /having \(pg_catalog\.bit_or\(t\.tgtype::int\) & 60\) = 60/, 'insert, delete, update AND truncate covered');
});

test('the migration never blocks readers, cannot leak a setting, and announces TRUNCATE', () => {
  const m = read(LATEST);
  const code = m.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /\bdrop\s+trigger\b/i, 'DROP TRIGGER takes ACCESS EXCLUSIVE, blocking every SELECT');
  assert.doesNotMatch(code, /(^|\n)\s*create\s+trigger\b/i, 'CREATE OR REPLACE TRIGGER, so a re-run needs no drop');
  assert.match(code, /set local lock_timeout/, 'SET LOCAL: a plain SET survives on a pooled connection');
  assert.doesNotMatch(code, /(^|\n)\s*set\s+lock_timeout/i);
  assert.match(code, /create or replace trigger ci_erp_realtime_ping_truncate after truncate on %I\.%I for each statement/);
  assert.match(code, /where t\.tgfoid = 'public\.ci_erp_realtime_ping\(\)'::pg_catalog\.regprocedure\s+and not t\.tgisinternal\s+loop/,
    'every announcing table gets one, including the original feed\'s');
});

test('presence stamps are filtered at the trigger, and the server refuses to cache what reads them', () => {
  const m = read(LATEST);
  assert.match(m, /to_jsonb\(old\) - 'last_active_at'\) is distinct from \(pg_catalog\.to_jsonb\(new\) - 'last_active_at'\)/);
  assert.match(m, /to_jsonb\(old\) - 'last_seen_at' - 'typing_at'\) is distinct from/);
  assert.doesNotMatch(m, /'push_subscriptions'/);
  const dt = read('server/src/data-tables.js');
  assert.match(dt, /last_active_at\|last_seen_at\|typing_at/);
});

test('server: every statement is ledgered, headers exposed, heartbeat after auth, stamp outside the ledger', () => {
  const app = read('server/src/app.js');
  const ledger = app.indexOf("app.use('/api', dataTablesMiddleware)");
  const firstRoute = app.indexOf("app.use('/api', authRouter)");
  assert.ok(ledger > 0 && ledger < firstRoute, 'the ledger wraps every /api route');
  assert.ok(app.indexOf("app.use('/api', heartbeatMiddleware)") > app.indexOf("app.use('/api', requireAuth)"));
  assert.match(app, /exposedHeaders: \['X-Data-Tables', 'X-Data-Wrote'\]/);
  const db = read('server/src/db.js');
  assert.match(db, /instrumentPool\(pool\)/);
  assert.match(db, /setKnownTables\(/);
  assert.match(db, /FROM pg_views WHERE schemaname = 'public'[\s\S]*FROM pg_matviews[\s\S]*FROM pg_proc/, 'views and functions are opaque');
  const dt = read('server/src/data-tables.js');
  assert.match(dt, /rest\[cbIndex\] = AsyncResource\.bind\(/, 'callbacks keep the caller\'s request');
  assert.match(dt, /res\.end = function endWithLedger/, 'headers on res.end: Vercel\'s res.json never calls res.send');
  assert.doesNotMatch(dt, /res\.send = function/, 'a res.send hook is dead code on Vercel');
  assert.match(dt, /const cb = AsyncResource\.bind\(args\[0\]\)/, 'pool.query\'s own checkout keeps the caller\'s request');
  assert.match(read('server/src/auth.js'), /withoutLedger\(\(\) => q\('UPDATE users SET last_active_at/);
});

test('client: GETs go through the cache, every write voids it, the feed feeds it', () => {
  const api = read('client/src/api.js');
  assert.match(api, /cachedGet\(\{ url, token, cache: responseCache, doFetch \}\)/);
  assert.equal((api.match(/responseCache\.noteMutation\(\)/g) || []).length, 2, 'request() and upload()');
  const rt = read('client/src/lib/realtime.js');
  assert.match(rt, /responseCache\.noteChange\(payload\?\.table\)/);
  assert.match(rt, /event: 'db-heartbeat' \}, noteHeartbeat/);
  assert.match(rt, /responseCache\.noteStatus\(next\)/);
  assert.match(rt, /tracker\.next\(next\)\.catchUp/);
  assert.match(rt, /watchResume\(\{ onResume: \(\) => responseCache\.noteResume\(\) \}\)/, 'a wake-up distrusts the cache');
  assert.match(read('client/src/lib/cachedGet.js'), /now = cache\.now \?\?/, 'startedAt on the cache\'s clock');
  const change = rt.indexOf('responseCache.noteChange(payload?.table)');
  const listeners = rt.indexOf('for (const { listener, tables } of changeListeners)');
  assert.ok(change > 0 && change < listeners, 'the cache hears a change before any screen refetches');
});
