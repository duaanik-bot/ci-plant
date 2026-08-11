// A fresh database must be able to run the Plates module.
//
// init() builds the local/embedded database, and it already replays ONE
// migration file wholesale (0035, tooling procurement) rather than duplicating a
// large schema block in the bootstrap. The plate lifecycle migrations landed
// afterwards and were never added to that list, so `npm run seed` — and every
// throwaway database stood up to verify something — came up with no
// plate_masters, no plate_request_components and no plate_assets at all.
//
// The cost is not a broken feature; production has the tables via Supabase. The
// cost is that plates work CANNOT BE VERIFIED against a disposable database,
// which is the safety net every other change in this area has relied on. It
// surfaced as `relation "plate_request_components" does not exist` on a freshly
// seeded Artwork queue.
//
// The BACKFILL migration is deliberately NOT replayed: it repairs one legacy
// row shape, carries no IF NOT EXISTS, and has nothing to do on an empty
// database. Schema is replayable; a one-off data repair is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const db = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
const migrationsDir = new URL('../../supabase/migrations/', import.meta.url);

test('init() replays every PLATE SCHEMA migration, so a fresh database has the module', () => {
  const schema = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && /plate/i.test(f) && !/backfill/i.test(f));
  assert.ok(schema.length >= 3, `expected the plate schema migrations, found ${schema.length}`);
  for (const file of schema) {
    assert.ok(db.includes(file),
      `db.js init() does not replay ${file}. A fresh database will have no plate tables, and any `
      + 'throwaway database stood up to verify plates work will fail with '
      + '`relation "plate_request_components" does not exist`.');
  }
});

test('the one-off legacy backfill is NOT replayed into a fresh database', () => {
  const backfill = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && /plate/i.test(f) && /backfill/i.test(f));
  for (const file of backfill) {
    assert.ok(!db.includes(file),
      `db.js replays ${file}. That migration repairs one legacy row shape and carries no `
      + 'IF NOT EXISTS — it is a data repair, not schema, and has nothing to do on an empty database.');
  }
});
