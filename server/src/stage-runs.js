// Pure decision logic for the day-wise production run log. No DB, no Express —
// mirrors production-variance.js / tolerance-cascade.js so it stays unit-testable.

const n = v => Math.max(0, Math.round(+v || 0));

// Sum a stage's run log into the cached rollup that lives on job_stages.
export function rollupRuns(runs = []) {
  let qty_good = 0, qty_scrap = 0, last_run_date = null;
  for (const r of runs) {
    qty_good += n(r.qty_good);
    qty_scrap += n(r.qty_scrap);
    const d = r.run_date ? String(r.run_date).slice(0, 10) : null;
    if (d && (!last_run_date || d > last_run_date)) last_run_date = d;
  }
  return { qty_good, qty_scrap, run_count: runs.length, last_run_date };
}

// What this station has RECEIVED, in its own unit — the single definition, and
// the one figure the floor is shown. Two ingredients, never more:
//
//   • what the station before it has counted SO FAR (live, partial or final),
//     already converted into this stage's unit by the caller, and
//   • anything CI-XS has issued straight to this stage, which is real input the
//     previous stage never saw.
//
// It is deliberately derived on every read rather than cached on the row. A
// stored figure is a snapshot of one moment: printing starts while cutting is
// at 100, cutting counts on to 27,000, and the snapshot still says 100. The
// running-balance cap always read upstream live, so a frozen qty_in put the
// number the operator is SHOWN and the number he is ALLOWED to run on two
// different formulas — which is exactly how a press came to be cleared for
// 25,000 sheets under a header that said it had received 100.
//
// The first stage of a job card has no upstream: its receipt is the board the
// warehouse actually issued (qty_in), plus its extras. qty_in is a live fact
// there — the cutting variance flow rewrites it to the parents truly cut.
export function stageReceived({ prevExists, prevQtyOut, ownQtyIn, extraIssued }) {
  const base = prevExists ? prevQtyOut : ownQtyIn;
  return (base === null || base === undefined ? 0 : n(base)) + n(extraIssued);
}

// The running-balance ceiling (upstreamAvailable in helpers.js is the thin DB
// wrapper that gathers these inputs and delegates here). A stage may only
// consume what it has received — so the ceiling IS the receipt, with two
// exceptions that return null for "uncapped":
//
//   • cutting, which keeps its own over/under-cut variance flow, and
//   • a first stage whose qty_in is still unset and which has no extras — the
//     inline-start decoupling's deferred-input state, not a real zero.
export function availableCeiling({ isCutting, prevExists, prevQtyOut, ownQtyIn, extraIssued }) {
  if (isCutting) return null;
  if (!prevExists && (ownQtyIn === null || ownQtyIn === undefined) && n(extraIssued) === 0) return null;
  return stageReceived({ prevExists, prevQtyOut, ownQtyIn, extraIssued });
}

// The two unit conversions, in one place, so no caller has to remember them:
//
//   • a cartons stage (sorting / pasting / QC) fed by a sheets stage multiplies
//     by `ups` — cartons printed up on one sheet;
//   • CI-XS always REQUESTS parent sheets. Cutting counts parents as-is; every
//     later sheet stage counts the children they were cut down into, so the
//     extras arrive there multiplied by children-per-parent.
export function toStageUnit({ prevQtyOut, prevUnit, unit, ups }) {
  if (prevQtyOut === null || prevQtyOut === undefined) return null;
  return prevUnit === 'sheets' && unit === 'cartons'
    ? n(prevQtyOut) * Math.max(1, n(ups) || 1)
    : n(prevQtyOut);
}
export function extrasInStageUnit({ stage, extraParents, childrenPerParent }) {
  return n(extraParents) * (stage === 'cutting' ? 1 : Math.max(1, n(childrenPerParent) || 1));
}

// A whole receipt from plain row values — the shape every non-DB caller wants.
// `stage` is the job_stages row; `prev` the stage before it (already found by
// the caller, since it comes from a list on one page and a query on another).
export function receiptFor({ stage, prev, ups, childrenPerParent, extraParents, extraStageQty = null }) {
  const extra_issued = extraStageQty == null
    ? extrasInStageUnit({ stage: stage.stage, extraParents, childrenPerParent })
    : n(extraStageQty);
  const upstream_available = prev
    ? toStageUnit({ prevQtyOut: prev.qty_out, prevUnit: prev.unit, unit: stage.unit, ups })
    : null;
  const parts = {
    prevExists: !!prev, prevQtyOut: upstream_available,
    ownQtyIn: stage.qty_in, extraIssued: extra_issued,
  };
  const live = stageReceived(parts);
  return {
    upstream_available,
    extra_issued,
    live,
    // A completed stage keeps the input it closed against; an open one tracks
    // upstream live.
    received: stage.status === 'completed' && stage.qty_in != null ? stage.qty_in : live,
    ceiling: availableCeiling({ isCutting: stage.stage === 'cutting', ...parts }),
  };
}

// The stage before this one, from rows already in hand: nearest earlier stage,
// skipping QC (QC inspects, it does not hand material on). The in-memory twin of
// previousStage() in helpers.js. `list` need not be sorted.
export function previousOf(list, stage) {
  let best = null;
  for (const x of list)
    if (x.stage !== 'qc' && x.seq < stage.seq && (!best || x.seq > best.seq)) best = x;
  return best;
}

// Once every stage produces daily, a stage's input is no longer fixed at start —
// it is whatever the previous stage has cumulatively produced so far. A null
// ceiling means uncapped (cutting, which has its own variance flow).
export function runCapacity({ upstreamAvailable, priorGood, priorScrap, thisGood, thisScrap }) {
  const ceiling = upstreamAvailable === null || upstreamAvailable === undefined
    ? Infinity : n(upstreamAvailable);
  const consumed = n(priorGood) + n(priorScrap) + n(thisGood) + n(thisScrap);
  return { consumed, ceiling, ok: consumed <= ceiling, overBy: Math.max(0, consumed - ceiling) };
}
