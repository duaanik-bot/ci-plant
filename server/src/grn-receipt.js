// GRN document logic — pure, DB-free, so it unit-tests like helpers.js.
// A GRN is a header with priced lines, mirroring a purchase order on the
// receiving side. Everything decidable about that document lives here; the
// routes in routes/procurement.js stay thin wrappers around it.
const round2 = n => Math.round((+n || 0) * 100) / 100;

// ── Derived header status ────────────────────────────────────────────────────
// NEVER stored. Storing it would let it drift from the lines that produce it,
// the same rule this ERP follows for a stage's Received.
//
// 'part_qc' and 'partly_accepted' are deliberately distinct: the first means
// work is still owed, the second means the receipt is settled and some of it
// was refused. One label for both would hide an outstanding QC decision behind
// a finished-looking chip.
export function grnHeaderStatus(lines = []) {
  if (!lines.length) return 'in_qc';
  const n = lines.length;
  const q = lines.filter(l => l.status === 'quarantine').length;
  const a = lines.filter(l => l.status === 'accepted').length;
  const r = lines.filter(l => l.status === 'rejected').length;
  if (q === n) return 'in_qc';
  if (a === n) return 'accepted';
  if (r === n) return 'rejected';
  if (q > 0) return 'part_qc';
  return 'partly_accepted';
}

// ── Batch numbering ──────────────────────────────────────────────────────────
// The supplier's own batch number wins when supplied. Otherwise the line gets
// its own suffix — the single-line code always produced "-B1", which two lines
// of one receipt would collide on.
export function grnBatchNo(grnNumber, index, supplied) {
  const s = String(supplied ?? '').trim();
  return s || `${grnNumber}-B${index + 1}`;
}

// ── Guards ───────────────────────────────────────────────────────────────────
// Each returns a list of human blocker strings; an empty list means safe.
// Same shape as rollbackBlockers / printReverseBlockers in helpers.js.

export function grnEditBlockers({ lines = [] } = {}) {
  const out = [];
  const decided = lines.filter(l => l.status !== 'quarantine').length;
  if (decided > 0)
    out.push(`${decided} line${decided > 1 ? 's have' : ' has'} already been QC-decided — a receipt can only be edited before QC`);
  return out;
}

export function grnDeleteBlockers({ lines = [] } = {}) {
  const out = [];
  if (lines.some(l => l.status === 'accepted'))
    out.push('This GRN has lines accepted into stock — roll it back instead of deleting it');
  const used = lines.filter(l => l.batchConsumed).length;
  if (used > 0)
    out.push(`Stock from ${used} line${used > 1 ? 's' : ''} on this GRN has already been used`);
  return out;
}

// Rollback deletes the whole header, so a receipt still holding an undecided
// line must be refused — otherwise that line is silently discarded.
export function grnRollbackBlockers({ lines = [] } = {}) {
  if (!lines.length) return ['This GRN has no lines to roll back'];
  const out = [];
  const undecided = lines.filter(l => l.status === 'quarantine').length;
  if (undecided > 0)
    out.push(`${undecided} line${undecided > 1 ? 's are' : ' is'} still in QC — finish QC on this receipt before rolling it back`);
  if (!lines.some(l => l.status === 'accepted'))
    out.push('Nothing on this GRN was accepted into stock — delete it instead of rolling it back');
  for (const l of lines.filter(x => x.status === 'accepted' && x.batchTouched))
    out.push(`Stock from ${l.material_name || 'a line on this GRN'} has already been used — it cannot be rolled back`);
  return out;
}

// ── Purchase-register value ──────────────────────────────────────────────────
// Gross of discount and tax, matching the SUM(pl.qty * pl.rate) convention the
// PO half of the register already uses, so the two halves are comparable.
//
// Rejected lines are excluded: that board went back to the supplier and was
// never a purchase. Quarantine lines ARE counted — they have arrived and been
// invoiced, and the register reports what was bought, not what has cleared QC.
export function grnRegisterValue(lines = []) {
  return round2(lines
    .filter(l => l.status !== 'rejected')
    .reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0));
}

// ── Rate variance ────────────────────────────────────────────────────────────
// What the supplier invoiced minus what the PO ordered. Null when there is
// nothing to compare or the gap is inside money tolerance — the same 0.005 the
// PO form's RateProvenance uses before it calls a rate overridden.
export function rateVariance(received, ordered) {
  if (received == null || received === '' || ordered == null || ordered === '') return null;
  const d = round2(+received - +ordered);
  return Math.abs(d) > 0.005 ? d : null;
}
