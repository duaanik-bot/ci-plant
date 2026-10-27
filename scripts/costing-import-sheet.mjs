// Load the plant's cost sheet workbook into the Costing module:
//   "Size chart" tab        → the Size Library (costing_sizes)
//   "Multi costing sheet"   → one costing on record per row (costings, OLD-<row>), each with the
//                             figures the sheet showed, its formula version, and a note wherever the
//                             sheet broke its own rule (server/src/costing-sheet.js)
//
//   node scripts/costing-import-sheet.mjs --file "<workbook.xlsx>"            dry run: what would load
//   node scripts/costing-import-sheet.mjs --file "<workbook.xlsx>" --apply    load it
//
// A copy of the workbook that holds only the Size chart (no Multi costing sheet) loads its sizes alone.
//
// Against $DATABASE_URL (default: the local database). A database that is not local is written only
// with --apply AND --remote, so the live plant is never loaded by accident.
//
// Safe to run again, e.g. on a newer copy of the workbook: a size entry already in the library and a
// costing already loaded (same fingerprint — date, party, product, size, quantity, layout, board) are
// left as they are; only what is new is added. Nothing is ever deleted or overwritten.
//
// The workbook stays where it is (Drive). Nothing from it is written into the repository, and the
// report prints counts only.
import crypto from 'crypto';
import path from 'path';
import pg from 'pg';
import ExcelJS from 'exceljs';
import { readCostingRow, readSizeChartRow, buildSizeLibrary, sizeEntryKey } from '../server/src/costing-sheet.js';

const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const REMOTE_OK = argv.includes('--remote');
const fileArg = argv.indexOf('--file');
const file = fileArg >= 0 ? argv[fileArg + 1] : process.env.COSTING_SHEET;
const SIZE_TAB = 'Size chart ';
const COST_TAB = 'Multi costing sheet ';

if (!file) {
  console.error('Give the workbook: --file "<Cost Sheet … .xlsx>" (or set COSTING_SHEET).');
  process.exit(2);
}

// exceljs cell → { v: cached value, f: formula text }. Shared formulas come back translated to the
// row (cell.formula), error results (#N/A, #REF!) as null.
function cellOf(cell) {
  const val = cell.value;
  let v = val, f;
  if (val && typeof val === 'object' && !(val instanceof Date)) {
    if ('result' in val || 'formula' in val || 'sharedFormula' in val) { v = val.result; f = cell.formula; }
    else if (val.richText) v = val.richText.map(t => t.text).join('');
    else if ('error' in val) v = null;
    else if ('text' in val) v = val.text;
  }
  if (v && typeof v === 'object' && !(v instanceof Date) && 'error' in v) v = null;
  return { v, f };
}
const rowGetter = ws => r => { const row = ws.getRow(r); return col => cellOf(row.getCell(col)); };

// One old costing's identity across copies of the workbook: everything it says — date, party, product,
// size, pasting and every input. Two rows that agree on all of it are the same costing typed twice.
function fingerprint(c) {
  const inputs = Object.keys(c.inputs).sort().map(k => [k, c.inputs[k]]);
  const parts = [c.date, c.party, c.product, c.size?.key ?? c.size_text, c.style, inputs];
  return 'sheet:' + crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const sizeWs = wb.getWorksheet(SIZE_TAB), costWs = wb.getWorksheet(COST_TAB);
if (!sizeWs) {
  console.error(`The workbook has no "${SIZE_TAB.trim()}" tab.`);
  process.exit(2);
}
if (!costWs) console.log(`No "${COST_TAB.trim()}" tab in this copy — loading its sizes only.`);
const chart = [];
for (let r = 2; r <= sizeWs.rowCount; r++) { const x = readSizeChartRow(rowGetter(sizeWs)(r), r); if (x) chart.push(x); }
const rows = [];
for (let r = 2; r <= (costWs?.rowCount ?? 0); r++) { const x = readCostingRow(rowGetter(costWs)(r), r); if (x) rows.push(x); }
const library = buildSizeLibrary(chart, rows);

const tally = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const withFigure = rows.filter(c => c.result.ok && c.sheet_result.cost_per_unit != null);
console.log(`Workbook: ${path.basename(file)}`);
console.log(`  Size chart rows ${chart.length} → library entries ${library.length} (${tally(library, e => e.source).size_chart || 0} from the chart, ${tally(library, e => e.source).costing || 0} layouts found only in costings)`);
console.log(`  Costing rows ${rows.length}; complete ${rows.filter(c => c.result.ok).length}; with a sheet figure ${withFigure.length}`);
console.log(`  Reproduced to the sheet's own figure: ${withFigure.filter(c => c.reproduced).length} of ${withFigure.length}`);
console.log(`  Formula versions: ${JSON.stringify(tally(rows, c => c.formula))}`);
console.log(`  Notes on rows: ${JSON.stringify(tally(rows.flatMap(c => c.notes), n => n.kind))}`);

const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (APPLY && isRemote && !REMOTE_OK) {
  console.error('That DATABASE_URL is not local. Writing to it needs --remote as well as --apply.');
  process.exit(2);
}
const client = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await client.connect();
const host = new URL(url.replace(/^postgres(ql)?:/, 'http:')).hostname;
console.log(`Database: ${isRemote ? 'REMOTE' : 'local'} (${host})`);

try {
  const have = await client.query(`SELECT size_key, style, sheet_l::float8 AS sheet_l, sheet_w::float8 AS sheet_w, ups::float8 AS ups FROM costing_sizes`);
  const haveSizes = new Set(have.rows.map(e => sizeEntryKey(e.size_key, e.style, e.sheet_l, e.sheet_w, e.ups)));
  const haveKeys = new Set((await client.query(`SELECT source_key FROM costings WHERE source_key IS NOT NULL`)).rows.map(x => x.source_key));
  const newSizes = library.filter(e => !haveSizes.has(e.key));
  // A costing typed on more than one row is loaded once; the rows it also sits on go into its notes.
  const firstOf = new Map();
  for (const c of rows) {
    const key = fingerprint(c);
    const first = firstOf.get(key);
    if (!first) { firstOf.set(key, { c, key, repeats: [] }); continue; }
    first.repeats.push(c.row);
  }
  for (const f of firstOf.values()) {
    if (f.repeats.length) f.c.notes.push({ kind: 'repeated_rows', text: `The same costing is typed again on row${f.repeats.length > 1 ? 's' : ''} ${f.repeats.join(', ')}.` });
  }
  const unique = [...firstOf.values()];
  const newRows = unique.filter(({ key }) => !haveKeys.has(key));
  console.log(`  Typed more than once: ${rows.length - unique.length} rows repeat an earlier row exactly (loaded once, noted on it)`);
  console.log(`To add: ${newSizes.length} size entries (${library.length - newSizes.length} already there), ${newRows.length} costings (${unique.length - newRows.length} already there)`);
  if (!APPLY) { console.log('Dry run — nothing written. Add --apply to load.'); process.exit(0); }

  await client.query('BEGIN');
  const source = path.basename(file);
  const CHUNK = 400;
  for (let i = 0; i < newSizes.length; i += CHUNK) {
    const batch = newSizes.slice(i, i + CHUNK).map(e => ({
      size_key: e.size.key, kind: e.size.kind, l_mm: e.size.l, w_mm: e.size.w, h_mm: e.size.h, style: e.style,
      sheet_l: e.sheet_l, sheet_w: e.sheet_w, ups: e.ups, source: e.source,
      source_refs: e.refs.map(r => ({ ...r, file: source })),
    }));
    await client.query(`
      INSERT INTO costing_sizes (size_key, kind, l_mm, w_mm, h_mm, style, sheet_l, sheet_w, ups, source, source_refs)
      SELECT size_key, kind, l_mm, w_mm, h_mm, style, sheet_l, sheet_w, ups, source, source_refs
        FROM jsonb_to_recordset($1::jsonb) AS x(size_key text, kind text, l_mm numeric, w_mm numeric, h_mm numeric,
             style text, sheet_l numeric, sheet_w numeric, ups numeric, source text, source_refs jsonb)
      ON CONFLICT DO NOTHING`, [JSON.stringify(batch)]);
  }
  const ids = new Map((await client.query(`SELECT id, size_key, style, sheet_l::float8 AS sheet_l, sheet_w::float8 AS sheet_w, ups::float8 AS ups FROM costing_sizes`))
    .rows.map(e => [sizeEntryKey(e.size_key, e.style, e.sheet_l, e.sheet_w, e.ups), e.id]));
  const taken = new Set((await client.query(`SELECT costing_no FROM costings WHERE costing_no LIKE 'OLD-%'`)).rows.map(x => x.costing_no));
  const numberFor = row => {
    let no = `OLD-${row}`, n = 1;
    while (taken.has(no)) no = `OLD-${row}.${++n}`;
    taken.add(no);
    return no;
  };
  for (let i = 0; i < newRows.length; i += CHUNK) {
    const batch = newRows.slice(i, i + CHUNK).map(({ c, key }) => {
      const s = c.sheet_result, ok = c.result.ok;
      return {
        costing_no: numberFor(c.row), source_file: source, source_row: c.row, source_key: key,
        customer_name: c.party, product_name: c.product || '(no product name on the sheet)',
        size_text: c.size_text, size_key: c.size?.key ?? null, size_kind: c.size?.kind ?? null,
        l_mm: c.size?.l ?? null, w_mm: c.size?.w ?? null, h_mm: c.size?.h ?? null, style: c.style,
        size_id: c.size ? ids.get(sizeEntryKey(c.size.key, c.style, c.inputs.sheet_l, c.inputs.sheet_w, c.inputs.ups)) ?? null : null,
        costed_on: c.date, formula: c.formula, inputs: c.inputs, result: c.result, sheet_result: s,
        reproduced: ok && s.cost_per_unit != null ? c.reproduced : null, notes: c.notes, complete: ok,
        qty: c.inputs.qty, gsm: c.inputs.gsm,
        // The record is what the sheet showed; where the sheet showed nothing, what its inputs give.
        cost_per_unit: s.cost_per_unit ?? (ok ? c.result.cost_per_unit : null),
        quote_per_unit: s.quote_per_unit ?? (ok && c.inputs.margin != null ? c.result.quote_per_unit : null),
        cost_value: s.cost_value ?? (ok ? c.result.cost_value : null),
      };
    });
    await client.query(`
      INSERT INTO costings (costing_no, source, source_file, source_row, source_key, customer_name, product_name, size_text,
                            size_key, size_kind, l_mm, w_mm, h_mm, style, size_id, costed_on, version, formula, inputs, result,
                            sheet_result, reproduced, notes, complete, qty, gsm, cost_per_unit, quote_per_unit, cost_value,
                            created_by_name, updated_by_name)
      SELECT costing_no, 'sheet', source_file, source_row, source_key, customer_name, product_name, size_text,
             size_key, size_kind, l_mm, w_mm, h_mm, style, size_id, costed_on, 1, formula, inputs, result,
             sheet_result, reproduced, notes, complete, qty, gsm, cost_per_unit, quote_per_unit, cost_value,
             'Cost sheet import', 'Cost sheet import'
        FROM jsonb_to_recordset($1::jsonb) AS x(costing_no text, source_file text, source_row int, source_key text,
             customer_name text, product_name text, size_text text, size_key text, size_kind text, l_mm numeric,
             w_mm numeric, h_mm numeric, style text, size_id int, costed_on date, formula text, inputs jsonb, result jsonb,
             sheet_result jsonb, reproduced boolean, notes jsonb, complete boolean, qty numeric, gsm numeric,
             cost_per_unit numeric, quote_per_unit numeric, cost_value numeric)
      ON CONFLICT DO NOTHING`, [JSON.stringify(batch)]);
  }
  const versions = await client.query(`
    INSERT INTO costing_versions (costing_id, version, formula, inputs, result, note, created_by_name)
    SELECT c.id, 1, c.formula, c.inputs, c.result, 'Loaded from the cost sheet, row ' || c.source_row, 'Cost sheet import'
      FROM costings c
     WHERE c.source = 'sheet' AND NOT EXISTS (SELECT 1 FROM costing_versions v WHERE v.costing_id = c.id)`);
  await client.query(`INSERT INTO audit_log (entity, entity_id, action, detail, user_name) VALUES ('costing', NULL, 'import', $1, 'Cost sheet import')`,
    [`${newSizes.length} size entries and ${newRows.length} costings loaded from ${source}`]);
  await client.query('COMMIT');
  const after = (await client.query(`SELECT (SELECT count(*) FROM costing_sizes)::int AS sizes, (SELECT count(*) FROM costings WHERE source = 'sheet')::int AS costings`)).rows[0];
  console.log(`Loaded. ${versions.rowCount} revision records written. Library now ${after.sizes} entries; old costings ${after.costings}.`);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Nothing was written:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
