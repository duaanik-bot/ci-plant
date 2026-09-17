// The Supabase Data API (PostgREST REST + GraphQL) is OFF for this project.
//
// Switched off 2026-09-17 at the database (migration 20260917103401): the authenticator
// role exposes one empty schema, so /rest/v1 and /graphql/v1 reach no table, view or
// function with any key. Nothing needed it — the server talks to Postgres directly and
// the browser uses Realtime only — and leaving it up kept a public surface that one
// accidental GRANT could have opened.
//
// So a supabase-js `.from()` / `.rpc()` or a raw /rest/v1 or /graphql/v1 call added
// anywhere in the app would fail in production with PGRST205/PGRST106, not at review.
// This test fails first instead. To really use the Data API again, turn it back on
// (the reverse statements are in the migration) and change this test deliberately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/20260917103401_data_api_expose_no_schemas.sql';

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(m?js|jsx)$/.test(name) && !name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

test('the migration that switched the Data API off is recorded, with its way back', () => {
  const sql = readFileSync(join(ROOT, MIGRATION), 'utf8');
  assert.match(sql, /create schema if not exists pgrst_no_exposed_schemas;/);
  assert.match(sql, /alter role authenticator set pgrst\.db_schemas = 'pgrst_no_exposed_schemas';/);
  assert.match(sql, /\nnotify pgrst;/);
  assert.match(sql, /alter role authenticator reset pgrst\.db_schemas;/, 'the reverse is written down');
});

test('no app code calls the Data API it can no longer reach', () => {
  const offenders = [];
  for (const dir of ['client/src', 'server/src', 'api', 'scripts']) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      if (/\/rest\/v1|\/graphql\/v1|@supabase\/supabase-js|@supabase\/postgrest-js|\bPostgrestClient\b/.test(src)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
  }
  assert.deepEqual(offenders, [], 'these files call the Data API, which is switched off for this project');
});
