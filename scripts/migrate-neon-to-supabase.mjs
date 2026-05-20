#!/usr/bin/env node
// Migrate Neon → Supabase Mumbai.
// Reads SOURCE_DATABASE_URL (Neon) and TARGET_DATABASE_URL (Supabase).
// Schema must already exist on TARGET (via `prisma migrate deploy`).
// Copies all rows in FK-dependency order, then resets sequences.

import pg from 'pg';
const { Client } = pg;

const SRC = process.env.SOURCE_DATABASE_URL;
const DST = process.env.TARGET_DATABASE_URL;
if (!SRC || !DST) {
  console.error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');
  process.exit(1);
}

const src = new Client({ connectionString: SRC });
const dst = new Client({ connectionString: DST });

const BATCH = 500;

async function topoSortTables(client) {
  const { rows } = await client.query(`
    WITH RECURSIVE deps AS (
      SELECT tc.table_name AS child,
             ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name <> ccu.table_name
    ),
    all_tables AS (
      SELECT tablename AS t FROM pg_tables WHERE schemaname='public'
        AND tablename NOT LIKE '_prisma%'
    )
    SELECT t FROM all_tables;
  `);
  const tables = rows.map(r => r.t);
  const deps = (await client.query(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'
      AND tc.table_name <> ccu.table_name
  `)).rows;
  // Kahn's algorithm
  const adj = new Map(tables.map(t => [t, new Set()]));
  const indeg = new Map(tables.map(t => [t, 0]));
  for (const { child, parent } of deps) {
    if (!adj.has(parent) || !adj.has(child)) continue;
    if (!adj.get(parent).has(child)) {
      adj.get(parent).add(child);
      indeg.set(child, indeg.get(child) + 1);
    }
  }
  const queue = tables.filter(t => indeg.get(t) === 0);
  const out = [];
  while (queue.length) {
    const t = queue.shift();
    out.push(t);
    for (const c of adj.get(t)) {
      indeg.set(c, indeg.get(c) - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  if (out.length !== tables.length) {
    // cycle — fall back to original order and disable FK checks
    return { ordered: tables, hasCycle: true };
  }
  return { ordered: out, hasCycle: false };
}

function encodeValue(v, dataType) {
  if (v === null || v === undefined) return null;
  // JSONB/JSON: pg-node returns objects/arrays; stringify so they round-trip cleanly.
  if (dataType === 'jsonb' || dataType === 'json') {
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  return v;
}

async function copyTable(name) {
  const { rows: cols } = await src.query(
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
       ORDER BY ordinal_position`,
    [name]
  );
  if (cols.length === 0) return 0;
  const colNames = cols.map(c => `"${c.column_name}"`).join(',');
  const { rows } = await src.query(`SELECT ${colNames} FROM "${name}"`);
  if (rows.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = [];
    const placeholders = slice.map((r, ri) => {
      const ph = cols.map((c, ci) => {
        values.push(encodeValue(r[c.column_name], c.data_type));
        return `$${ri * cols.length + ci + 1}`;
      });
      return `(${ph.join(',')})`;
    });
    const sql = `INSERT INTO "${name}" (${colNames}) VALUES ${placeholders.join(',')}`;
    try {
      await dst.query(sql, values);
      inserted += slice.length;
    } catch (e) {
      // Fall back to row-by-row so one bad row doesn't kill the whole batch.
      for (const r of slice) {
        const v = cols.map(c => encodeValue(r[c.column_name], c.data_type));
        const ph = cols.map((_, ci) => `$${ci + 1}`).join(',');
        try {
          await dst.query(`INSERT INTO "${name}" (${colNames}) VALUES (${ph})`, v);
          inserted++;
        } catch (rowErr) {
          console.error(`  ! row failed in ${name}: ${rowErr.message}`);
        }
      }
    }
  }
  return inserted;
}

async function resetSequences() {
  const { rows } = await dst.query(`
    SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid
    JOIN pg_class t ON d.refobjid = t.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind='S' AND t.relkind='r'
      AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
  `);
  for (const { seq, tbl, col } of rows) {
    await dst.query(
      `SELECT setval('"${seq}"', COALESCE((SELECT MAX("${col}") FROM "${tbl}"), 1), true)`
    );
  }
  return rows.length;
}

(async () => {
  console.log('Connecting…');
  await src.connect();
  await dst.connect();

  console.log('Computing table order…');
  const { ordered, hasCycle } = await topoSortTables(src);
  if (hasCycle) {
    console.log('FK cycle detected — disabling triggers on target for the load');
    await dst.query('SET session_replication_role = replica');
  }
  console.log(`Tables to copy: ${ordered.length}`);

  let total = 0;
  for (const t of ordered) {
    const n = await copyTable(t);
    total += n;
    if (n > 0) console.log(`  ${n.toString().padStart(6)}  ${t}`);
  }

  if (hasCycle) {
    await dst.query('SET session_replication_role = origin');
  }

  console.log('\nResetting sequences…');
  const nSeq = await resetSequences();
  console.log(`Reset ${nSeq} sequences.`);

  console.log(`\nDone. Migrated ${total} rows across ${ordered.length} tables.`);
  await src.end();
  await dst.end();
})().catch(async e => {
  console.error('\nFAILED:', e.message);
  try { await src.end(); } catch {}
  try { await dst.end(); } catch {}
  process.exit(1);
});
