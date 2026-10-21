// COA Register sync — mirrors the Drive COA register and its PDFs into CI Plant.
//
// The register is kept in Google Drive (mppchd › Other computers › CARTON PC MAIN
// › COLOUR IMPRESSION › COA). This reads COA Register.xlsx from that folder, finds
// each COA's PDF where the register's Folder column says it is filed, and makes
// coa_register / coa_register_files say exactly what the register says: new COAs
// are added, changed ones updated, and a COA no longer in the register removed.
//
//   node scripts/coa-register-sync.mjs                 dry run against $DATABASE_URL (default local)
//   node scripts/coa-register-sync.mjs --apply         write it
//   node scripts/coa-register-sync.mjs --dir <path>    a different COA folder (or set COA_DRIVE_DIR)
//
// A database that is not local is written only with --apply AND --remote: the
// live plant is never synced by accident.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import pg from 'pg';
import ExcelJS from 'exceljs';
import { parseRegister, pickPdf, folderWithinCoa, REGISTER_FIELDS } from '../server/src/coa-register.js';

const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const DEFAULT_DIR = path.join(os.homedir(),
  'Library/CloudStorage/GoogleDrive-mppchd@gmail.com/Other computers/CARTON PC MAIN/COLOUR IMPRESSION/COA');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const REMOTE_OK = argv.includes('--remote');
const dirArg = argv.indexOf('--dir');
const dir = dirArg >= 0 ? argv[dirArg + 1] : (process.env.COA_DRIVE_DIR || DEFAULT_DIR);
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);

if (!dir || !fs.existsSync(dir)) {
  console.error(`The COA folder is not there: ${dir}\nIs Google Drive for mppchd@gmail.com running and signed in?`);
  process.exit(1);
}
if (APPLY && isRemote && !REMOTE_OK) {
  console.error('That DATABASE_URL is not local. Writing to it needs --remote as well as --apply.');
  process.exit(1);
}

// The register: "COA Register.xlsx", or Drive's re-saved "COA Register (1).xlsx" —
// the newest one wins.
const registerFile = fs.readdirSync(dir, { withFileTypes: true })
  .filter(e => e.isFile() && /^coa register.*\.xlsx$/i.test(e.name) && !e.name.startsWith('~$'))
  .map(e => ({ name: e.name, mtimeMs: fs.statSync(path.join(dir, e.name)).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
if (!registerFile) {
  console.error(`No "COA Register.xlsx" in ${dir}`);
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.join(dir, registerFile.name));
const ws = wb.worksheets.find(s => /coa/i.test(s.name)) || wb.worksheets[0];
const sheetRows = [];
ws.eachRow({ includeEmpty: true }, (row, n) => { sheetRows[n - 1] = row.values.slice(1); });
const { records, missing, duplicates } = parseRegister(sheetRows.map(r => r || []));

// Every PDF under the COA folder — the fallback when a COA is not in the folder
// its register row names (a folder renamed or moved in Drive).
const allPdfs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && /\.pdf$/i.test(e.name)) allPdfs.push({ name: e.name, path: p, mtimeMs: fs.statSync(p).mtimeMs });
  }
})(dir);

const found = [];
const notFound = [];
for (const rec of records) {
  const folder = path.join(dir, folderWithinCoa(rec.folder));
  const inFolder = allPdfs.filter(f => path.dirname(f.path) === path.resolve(folder));
  const hit = pickPdf(rec.file_name, inFolder) || pickPdf(rec.file_name, allPdfs);
  if (!hit) { notFound.push(rec); rec.pdf_path = null; continue; }
  const bytes = fs.readFileSync(hit.path);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') { notFound.push(rec); rec.pdf_path = null; continue; }
  rec.pdf_path = path.relative(dir, hit.path);
  found.push({ rec, name: hit.name, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}

console.log('\nCOA Register sync');
console.log(`Register ${path.join(dir, registerFile.name)}  (sheet "${ws.name}")`);
console.log(`Target   ${url.replace(/^[^@]*@/, '').replace(/[:/].*$/, '')}${isRemote ? '' : ' (local)'}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}\n`);
console.log(`COAs in the register   ${records.length}`);
console.log(`  with their PDF       ${found.length}`);
console.log(`  PDF not found        ${notFound.length}${notFound.length ? '  → ' + notFound.map(r => r.coa_no).join(', ') : ''}`);
if (missing.length) console.log(`Headings not in the register (left blank): ${missing.join(', ')}`);
if (duplicates.length) console.log(`COA No. written more than once (the last row kept): ${[...new Set(duplicates)].join(', ')}`);

const client = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await client.connect();
const q = async (s, p) => (await client.query(s, p)).rows;
try {
  const [{ ok }] = await q("SELECT to_regclass('public.coa_register') IS NOT NULL AS ok");
  if (!ok) throw new Error('coa_register is not in this database — the migration 20261017120000_coa_register.sql has not been applied to it.');

  const before = await q('SELECT c.coa_no, f.sha256 FROM coa_register c LEFT JOIN coa_register_files f USING (coa_no)');
  const had = new Map(before.map(r => [r.coa_no, r.sha256]));
  const keep = new Set(records.map(r => r.coa_no));
  const added = records.filter(r => !had.has(r.coa_no)).length;
  const removed = before.filter(r => !keep.has(r.coa_no)).map(r => r.coa_no);
  const pdfChanged = found.filter(f => had.get(f.rec.coa_no) !== f.sha256).length;
  console.log(`\nNew COAs ${added} · updated ${records.length - added} · removed ${removed.length}${removed.length ? ' (' + removed.join(', ') + ')' : ''} · PDFs new or changed ${pdfChanged}`);

  if (!APPLY) { console.log('\nDry run — run again with --apply to write it.\n'); }
  else {
    const cols = [...REGISTER_FIELDS, 'pdf_path'];
    await q('BEGIN');
    try {
      if (removed.length) await q('DELETE FROM coa_register WHERE coa_no <> ALL($1::text[])', [[...keep]]);
      for (const rec of records) {
        await q(
          `INSERT INTO coa_register (${cols.join(', ')}, synced_at)
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, now())
           ON CONFLICT (coa_no) DO UPDATE SET
             ${cols.filter(c => c !== 'coa_no').map(c => `${c} = EXCLUDED.${c}`).join(', ')}, synced_at = now()`,
          cols.map(c => rec[c]));
      }
      for (const f of found) {
        if (had.get(f.rec.coa_no) === f.sha256) continue;
        await q(
          `INSERT INTO coa_register_files (coa_no, file_name, bytes, size_bytes, sha256, synced_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (coa_no) DO UPDATE SET file_name = EXCLUDED.file_name, bytes = EXCLUDED.bytes,
             size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, synced_at = now()`,
          [f.rec.coa_no, f.rec.file_name || f.name, f.bytes, f.bytes.length, f.sha256]);
      }
      // A COA whose PDF has gone from Drive keeps no stale copy.
      const gone = notFound.map(r => r.coa_no);
      if (gone.length) await q('DELETE FROM coa_register_files WHERE coa_no = ANY($1::text[])', [gone]);
      await q('COMMIT');
    } catch (e) { await q('ROLLBACK'); throw e; }
    const [{ n, p }] = await q('SELECT count(*)::int AS n, (SELECT count(*)::int FROM coa_register_files) AS p FROM coa_register');
    console.log(`\nWritten. The register now holds ${n} COAs, ${p} with their PDF.\n`);
  }
} finally {
  await client.end();
}
