// The artwork register's identity rules (Artwork Manager P1, owner's brief of 14 Nov 2026): which job a file belongs
// to, and whether it is a version the register already holds.
//
// A customer often sends a changed file under the same item code AND the same revision (one code was proofed under two
// product names a week apart), and re-attaches an unchanged file to a reminder. So a version is not the customer's
// revision alone: it is the revision plus a receipt number, and the files' bytes decide. The same bytes are the same
// version; new bytes under one revision are the next receipt (R0.1, R0.2). Nothing is ever overwritten.
//
// Pure: the copier (artwork-intake.js) does the reading and writing. Text is compared here in JavaScript, never in
// SQL — the plant database's SQL_ASCII encoding lower-cases and splits spaces byte by byte.

const PACK_OF = { PCS: 'carton', PMC: 'carton', PML: 'label', PMLF: 'insert' };
const CODE = /(?<![A-Z0-9])(PMLF|PCS|PMC|PML)-([A-Z]\d{3})(?![A-Z0-9])/i;
const REV = /(?<![A-Z0-9])R(\d)(?![A-Z0-9])/i;

// The customer's item code (PCS-X398, PMC-X028, PML-X012, PMLF-X001), the revision written after it (R0…R9) and the
// pack the prefix names. A file name, a subject or a line of a mail: whatever carries the code.
export function parseItemCode(text) {
  const s = String(text ?? '');
  const m = CODE.exec(s);
  if (!m) return { code: null, rev: null, pack: null };
  const prefix = m[1].toUpperCase();
  const rev = REV.exec(s.slice(m.index + m[0].length));
  return { code: `${prefix}-${m[2].toUpperCase()}`, rev: rev ? `R${rev[1]}` : null, pack: PACK_OF[prefix] };
}

// The product a file is named for, when its name carries the item code: what follows the code, without the revision
// and the ending ("PCS-X398-R3 - ALPHA SUSPENSION - 200ML -SALE - CARTON.cdr" → "ALPHA SUSPENSION - 200ML -SALE -
// CARTON"). A name with no code gives nothing: a kit name is for the reader of the mail to give, not guessed here.
export function productFromFileName(fileName) {
  const s = String(fileName ?? '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const m = CODE.exec(s);
  if (!m) return '';
  return s.slice(m.index + m[0].length)
    .replace(/\s*-?\s*(?<![A-Z0-9])R\d(?![A-Z0-9])/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_,.]+|[\s\-_,.]+$/g, '');
}

// A version's files as one print: their sha256 values, sorted, each once. No print ('') when there is no file, or when
// any file could not be hashed — a set with an unknown file cannot be told from another set, so it is never "the same".
export function sourcePrint(files) {
  const all = (Array.isArray(files) ? files : []).map(f => String(f?.sha256 ?? '').trim().toLowerCase());
  if (!all.length || all.some(h => !h)) return '';
  return [...new Set(all)].sort().join('|');
}

const revOf = v => String(v ?? '').trim().toUpperCase();

// Where an incoming set of files sits among a job's versions: the version it already is (the same non-empty print), or
// the next receipt number under its revision. Files that could not be hashed never match — they are a new version.
export function placeVersion(existing, incoming) {
  const list = Array.isArray(existing) ? existing : [];
  const print = String(incoming?.source_print ?? '');
  const same = print ? list.find(v => v.source_print === print) : null;
  if (same) return { sameAs: same.id, receipt_no: same.receipt_no };
  const rev = revOf(incoming?.client_rev);
  const last = Math.max(0, ...list.filter(v => revOf(v.client_rev) === rev).map(v => Number(v.receipt_no) || 0));
  return { sameAs: null, receipt_no: last + 1 };
}

export const versionLabel = (clientRev, receiptNo) => (revOf(clientRev) ? `${revOf(clientRev)}.${receiptNo}` : `v${receiptNo}`);

const flat = v => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// One job per customer and item code; a customer who uses no codes (kit names only) gets one job per product name.
export const jobKey = (customerName, code, productName) =>
  (flat(code) ? `${flat(customerName)}|${flat(code)}` : `${flat(customerName)}|name:${flat(productName)}`);
