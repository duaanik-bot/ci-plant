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

// The running-balance ceiling, as pure arithmetic (upstreamAvailable in
// helpers.js is the thin DB wrapper that gathers these four inputs and
// delegates here). Cutting keeps its own over/under-cut variance flow, so it
// is always uncapped. Otherwise the ceiling tracks what upstream has
// produced — plus anything CI-XS has issued straight to this stage, since
// that is legitimate input the previous stage never saw.
//
// When there IS a previous stage, extraIssued is added on top of its
// qty_out: the extra sheets never touched the previous stage's own output,
// so there is no double count.
//
// When there is NO previous stage (this is the first stage of the job card),
// CI-XS issues extras straight onto THIS stage's own qty_in (see
// extrasheets.js), so qty_in already carries them — adding extraIssued again
// would double-count. We only fall back to extraIssued when qty_in is still
// null, as a floor. A null/undefined qty_in with nothing issued is the
// inline-start decoupling's deferred-input state, not a real zero, so it
// stays uncapped.
export function availableCeiling({ isCutting, prevExists, prevQtyOut, ownQtyIn, extraIssued }) {
  if (isCutting) return null;
  if (prevExists) {
    const base = prevQtyOut === null || prevQtyOut === undefined ? 0 : n(prevQtyOut);
    return base + n(extraIssued);
  }
  if ((ownQtyIn === null || ownQtyIn === undefined) && n(extraIssued) === 0) return null;
  return Math.max(n(ownQtyIn), n(extraIssued));
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
