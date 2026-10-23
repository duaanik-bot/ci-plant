// ─── COA Register — the rules, kept pure so they are tested on their own ────
// The Drive register (mppchd › COLOUR IMPRESSION › COA › COA Register.xlsx) is
// the source. scripts/coa-register-sync.mjs reads it with these helpers and
// mirrors it into coa_register / coa_register_files; routes/coa-register.js
// answers the screen. Nothing here touches the plant's own data.
import { canAccess } from '../../client/src/modules.js';

// The register's headings, in its own words, and the column each lands in.
// Matched case- and space-insensitively, so "Invoice Date" still finds its column.
export const REGISTER_COLUMNS = [
  ['COA No.', 'coa_no'],
  ['Company', 'company'],
  ['Customer', 'customer'],
  ['Invoice', 'invoice_no'],
  ['Invoice date', 'invoice_date', 'date'],
  ['Line', 'line_no', 'int'],
  ['Product', 'product'],
  ['Party item code', 'party_item_code'],
  ['PO No.', 'po_no'],
  ['PO date', 'po_date', 'date'],
  ['Job card', 'job_card'],
  ['Qty', 'qty', 'num'],
  ['Std GSM', 'std_gsm', 'num'],
  ['COA status', 'status'],
  ['Rows on hold', 'rows_on_hold'],
  ['QC signed', 'qc_signed'],
  ['Remarks', 'remarks'],
  ['COA file', 'file_name'],
  ['Folder', 'folder'],
  ['Date generated', 'date_generated', 'date'],
  ['Date approved', 'date_approved', 'date'],
];
export const REGISTER_FIELDS = REGISTER_COLUMNS.map(c => c[1]);

const headKey = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A register date: 'dd-mm-yyyy' (as the register writes it), 'dd/mm/yyyy',
// 'yyyy-mm-dd', or a real spreadsheet date. Returned as 'yyyy-mm-dd', or null
// for a blank or a value that is not a real calendar day.
export function registerDate(v) {
  if (v == null || v === '' || v === '-') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // ExcelJS hands a date cell back as UTC midnight of that day.
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let y, m, d;
  let hit = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (hit) [, d, m, y] = hit;
  else if ((hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [, y, m, d] = hit;
  else return null;
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null;
  return dt.toISOString().slice(0, 10);
}

function cellValue(v, kind) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    // ExcelJS rich text, hyperlinks and formula results.
    if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
    else if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
  }
  if (kind === 'date') return registerDate(v);
  if (v == null) return null;
  if (kind === 'int' || kind === 'num') {
    const n = Number(String(v).replace(/,/g, '').trim());
    if (String(v).trim() === '' || !Number.isFinite(n)) return null;
    return kind === 'int' ? Math.trunc(n) : n;
  }
  const s = (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).trim();
  return s === '' ? null : s;
}

// The register's rows (an array of arrays, heading row first, as a sheet reads)
// → one record per COA No. The heading row is found, not assumed to be row 1.
// A row without a COA No. is skipped; a COA No. written twice keeps its last row
// (the register is appended to, so the later one is the newer word) and is
// reported in `duplicates`.
export function parseRegister(rows) {
  const want = new Map(REGISTER_COLUMNS.map(([h, f, kind]) => [headKey(h), { f, kind }]));
  const headAt = rows.findIndex(r => Array.isArray(r) && r.some(c => headKey(cellValue(c)) === 'coano'));
  if (headAt === -1) throw new Error('The register has no "COA No." heading — is this the COA Register?');
  const cols = rows[headAt].map(c => want.get(headKey(cellValue(c))) || null);
  const missing = REGISTER_COLUMNS.filter(([h]) => !rows[headAt].some(c => headKey(cellValue(c)) === headKey(h))).map(([h]) => h);
  const byNo = new Map();
  const duplicates = [];
  for (const row of rows.slice(headAt + 1)) {
    if (!Array.isArray(row)) continue;
    const rec = Object.fromEntries(REGISTER_FIELDS.map(f => [f, null]));
    cols.forEach((col, i) => { if (col) rec[col.f] = cellValue(row[i], col.kind); });
    if (!rec.coa_no) continue;
    if (byNo.has(rec.coa_no)) duplicates.push(rec.coa_no);
    byNo.set(rec.coa_no, rec);
  }
  return { records: [...byNo.values()], missing, duplicates };
}

// Which file in a folder is the COA the register names. Drive keeps a re-saved
// copy beside the old one as "name (1).pdf", so the exact name wins and,
// failing that, the newest "name (n).pdf". `files` = [{ name, mtimeMs }].
export function pickPdf(fileName, files) {
  if (!fileName) return null;
  const want = String(fileName).trim();
  const exact = files.find(f => f.name === want);
  if (exact) return exact;
  const dot = want.lastIndexOf('.');
  const stem = (dot > 0 ? want.slice(0, dot) : want).toLowerCase();
  const ext = (dot > 0 ? want.slice(dot) : '.pdf').toLowerCase();
  const copies = files.filter(f => {
    const n = f.name.toLowerCase();
    if (!n.endsWith(ext)) return false;
    const base = n.slice(0, -ext.length);
    return base === stem || new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)$`).test(base);
  });
  return copies.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

// The register's Folder is written from the Drive root ("COA/Colour Impressions/…");
// the sync reads from the COA folder itself, so the leading "COA/" goes.
export function folderWithinCoa(folder) {
  return String(folder ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^coa\//i, '');
}

// ─── Who may do what ────────────────────────────────────────────────────────
// Opening the module (Masters → Users, "COA Register") shows the register and a
// COA on screen. Downloading the PDF needs the "Download COA" right as well
// (users.coa_download); admins always may.
export const mayViewCoa = u => canAccess(u, 'coa_register');
export const mayDownloadCoa = u => mayViewCoa(u) && (u?.role === 'admin' || +(u?.coa_download ?? 0) === 1);

// ─── The automatic sync's brakes ────────────────────────────────────────────
// The background sync (scripts/coa-register-sync.mjs --auto, run every few
// minutes on the Mac that holds the Drive) writes to the live plant with nobody
// watching. A register caught half-saved by Drive, or a sheet emptied by
// mistake, would otherwise mirror straight through and remove COAs from CI Plant.
// So the automatic run refuses — and says why — when what it is about to do
// looks like an accident. A person can still run the sync by hand.
export const AUTO_MAX_REMOVALS = 3;
export function autoSyncRefusal({ before = 0, records = [], removed = [], missing = [] }) {
  if (!records.length) return 'the register reads as empty';
  const needed = ['Customer', 'Invoice', 'COA file', 'Folder'].filter(h => missing.includes(h));
  if (needed.length) return `the register has lost its ${needed.join(', ')} heading${needed.length > 1 ? 's' : ''}`;
  if (removed.length > AUTO_MAX_REMOVALS || (removed.length && removed.length > before * 0.2)) {
    return `it would remove ${removed.length} of ${before} COAs (${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ', …' : ''})`;
  }
  return null;
}

// What the Drive folder looks like right now, as one string — the register's
// size and time and every PDF's path, size and time. The automatic sync keeps the
// last one it wrote and does nothing while it has not changed.
export function driveFingerprint(registerStat, pdfs) {
  const parts = [`${registerStat.name}|${registerStat.size}|${Math.round(registerStat.mtimeMs)}`,
    ...pdfs.map(f => `${f.rel}|${f.size}|${Math.round(f.mtimeMs)}`).sort()];
  return parts.join('\n');
}

// A sync that could not reach the database because the Mac had no network yet —
// the first round after waking from sleep runs before Wi-Fi and DNS are back.
// That is not a failure of the sync: the next round, three minutes on, does it.
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE']);
export function isNetworkError(e) {
  if (!e) return false;
  if (NETWORK_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.some(isNetworkError)) return true;   // AggregateError (IPv4 + IPv6)
  return /getaddrinfo|Connection terminated unexpectedly|timeout expired|connect ETIMEDOUT/i.test(String(e.message || ''));
}
// How long the Mac may be offline before the sync says so.
export const OFFLINE_ALERT_MS = 30 * 60_000;
