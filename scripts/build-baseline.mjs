// Regenerate supabase/migrations/0001_baseline_schema.sql from server/src/db.js.
//
// db.js init() is the schema's source of truth: 20 sequential pool.query() blocks
// of pure SQL (schema + idempotent data backfills, no JS interpolation). This
// script extracts them verbatim, in order, into one canonical .sql file so the
// schema is version-controlled and can be replayed against an empty database.
//
// Run it whenever init() changes:   npm run db:baseline
// CI fails if the committed file is stale (see .github/workflows/ci.yml).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'server/src/db.js'), 'utf8');

const start = src.indexOf('export async function init()');
if (start === -1) throw new Error('init() not found in server/src/db.js');
const body = src.slice(start);

const blocks = [...body.matchAll(/await pool\.query\(`([\s\S]*?)`\)/g)].map(m => m[1].trim());
if (!blocks.length) throw new Error('no pool.query() blocks found in init()');

// Safety: extraction is only valid while the SQL itself stays a pure literal.
// Surrounding JS may interpolate freely — only the query bodies must not.
blocks.forEach((b, i) => {
  if (/\$\{/.test(b)) throw new Error(`SQL block ${i + 1} contains \${} interpolation — extraction is unsafe`);
});

const out = `-- ============================================================================
-- ci-erp baseline schema — GENERATED FILE, DO NOT EDIT BY HAND
-- ============================================================================
-- Source of truth: server/src/db.js  ->  init()
-- Regenerate with: npm run db:baseline
--
-- This is the complete schema plus the idempotent data backfills that init()
-- applies. Every statement is IF NOT EXISTS / idempotent, so replaying this
-- file against an existing database is a no-op, and replaying it against an
-- empty database reproduces the full ci-erp schema.
--
-- Blocks below appear in the exact order init() executes them.
-- ============================================================================

${blocks.map((b, i) => `-- ─── block ${String(i + 1).padStart(2, '0')} of ${blocks.length} ${'─'.repeat(50)}\n\n${b}`).join('\n\n')}
`;

const dest = path.join(root, 'supabase/migrations/0001_baseline_schema.sql');
fs.mkdirSync(path.dirname(dest), { recursive: true });

const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
fs.writeFileSync(dest, out);

const changed = prev !== out;
console.log(`${changed ? 'updated' : 'unchanged'}: supabase/migrations/0001_baseline_schema.sql`);
console.log(`  ${blocks.length} SQL blocks, ${out.split('\n').length} lines`);
if (process.argv.includes('--check') && changed) {
  console.error('\nERROR: the committed baseline is stale. Run `npm run db:baseline` and commit the result.');
  process.exit(1);
}
