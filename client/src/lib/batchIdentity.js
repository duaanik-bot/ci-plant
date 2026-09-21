// Batch identity — the client's mirror of server/src/merge-rules.js, which is
// the authority. Kept in step with it deliberately (same contract as
// gangPreview mirroring gangCompat): the planner must see the right BUTTON
// before the server ever gets asked.
//
// A pharma customer books ONE purchase order as several lines, one per BATCH,
// and the batch number is PRINTED AT PRESS. Two lines of one product code
// with two batch numbers are therefore two different cartons: they want a
// gang, where each batch takes its own slot on the shared sheet and the pile
// splits back apart after die cutting — never a combined run, which would
// print every carton with a single batch number.
//
// The number rides in `line_remark`, free text the PO import writes, so only
// an explicit batch marker counts. A remark that is not a batch reads as null
// and changes nothing — absent data must never fork a run.
const BATCH_RE = /\b(?:BATCH|B\.?\s*N[O0]\.?)\s*(?:NO\.?|NUMBER|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/-]*)/i;

export function batchOf(line = {}) {
  const raw = String(line.line_remark ?? '').trim();
  if (!raw) return null;
  const m = BATCH_RE.exec(raw);
  return m ? m[1].toUpperCase() : null;
}

// The distinct batch numbers a selection names, in a stable order.
export const batchesOf = lines => [...new Set(lines.map(batchOf).filter(Boolean))].sort();

// One product AND at most one named batch. A single named batch beside
// unmarked lines stays one carton — only a genuine SECOND batch forks the run.
export function sameCarton(lines = []) {
  if (new Set(lines.map(l => l.product_id)).size > 1) return false;
  return batchesOf(lines).length <= 1;
}

// Which build does this selection want? 'merge' = one pile, 'gang' = one sheet.
export const runKindFor = (lines = []) => (sameCarton(lines) ? 'merge' : 'gang');
