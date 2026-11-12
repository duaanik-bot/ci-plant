// Load the plant's die register (the Drive sheet "DIE DATA", exported as JSON rows) into die_register, the reference
// list the size proposals check before proposing a new die (routes/sizing.js). The data is the plant's own and is
// never committed: pass the file's path.
//
//   node scripts/load-die-register.mjs <rows.json>            dry run: counts what it would load
//   node scripts/load-die-register.mjs <rows.json> --apply    upserts into DATABASE_URL's die_register
//
// Rows: [{ die, L, W, H, past, ups, size }] as the sheet's first table has them. A die number appears once (the first
// row wins); a row without all three sizes is left out. 'Lock' is the plant's LOCK pasting, 'RTF' its SIDE pasting.
// Never run --apply against production without the owner's word for that session.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const STYLE = { LOCK: 'LOCK', RTF: 'SIDE', SIDE: 'SIDE' };
const pos = x => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };

export function registerRows(raw) {
  const out = [], seen = new Set();
  for (const r of raw || []) {
    const die = String(r?.die ?? '').trim();
    const l = pos(r?.L), w = pos(r?.W), h = pos(r?.H);
    if (!die || !l || !w || !h || seen.has(die)) continue;
    seen.add(die);
    const past = String(r?.past ?? '').trim().toUpperCase();
    const ups = Math.round(Number(r?.ups));
    out.push({ die_no: die, l_mm: l, w_mm: w, h_mm: h, style: STYLE[past] || past || null, ups: ups > 0 ? ups : null, size_text: String(r?.size ?? '').trim() || null });
  }
  return out;
}

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file) { console.error('usage: node scripts/load-die-register.mjs <rows.json> [--apply]'); process.exit(1); }
  const rows = registerRows(JSON.parse(fs.readFileSync(file, 'utf8')));
  const styles = rows.reduce((m, r) => ({ ...m, [r.style]: (m[r.style] || 0) + 1 }), {});
  console.log(`${rows.length} dies to load`, styles);
  if (flag !== '--apply') { console.log('Dry run — add --apply to load them.'); return; }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5439/cierp' });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(`INSERT INTO die_register (die_no, l_mm, w_mm, h_mm, style, ups, size_text, source, loaded_at)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, 'DIE DATA 2024', now())
                          ON CONFLICT (die_no) DO UPDATE SET l_mm = EXCLUDED.l_mm, w_mm = EXCLUDED.w_mm, h_mm = EXCLUDED.h_mm,
                            style = EXCLUDED.style, ups = EXCLUDED.ups, size_text = EXCLUDED.size_text, source = EXCLUDED.source, loaded_at = now()`,
      [r.die_no, r.l_mm, r.w_mm, r.h_mm, r.style, r.ups, r.size_text]);
    }
    await client.query('COMMIT');
    console.log(`Loaded ${rows.length} dies.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e.message); process.exit(1); });
