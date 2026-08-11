// How many parent sheets a line is short, from its readiness gate.
//
// ONE spelling, in a plain module, because there were two readers and they DID
// drift: the row's ReadinessCell had three branches and the KPI strip had two,
// under a comment claiming they were "the same arithmetic, so the queue's red
// '−725' on a row and the strip's total are the same number counted the same
// way". They were not. A MIXED line's shortfall is mix_short — the summed truth
// across every board in the mix — and the strip fell through to the single-board
// subtraction (parent_needed − available_sheets), which measures the planned
// board's own gap while the real hole sits on an emptied substitute. So a job
// covered by its mix still added a phantom shortage to the plant-wide total, and
// a job genuinely short on a substitute added the wrong number.
//
// Lives here rather than being exported from Planning.jsx because a .jsx file
// cannot be imported by `node --test` — the same reason lib/boardState.js exists
// apart from components/BoardStatus.jsx, and lib/odDays.js apart from ui.jsx.
export function boardShortOf(readiness) {
  if (!readiness) return 0;
  // Covered is covered: readiness.material is already mix-aware and already
  // blind to stock earmarked for other jobs.
  if (readiness.material) return 0;
  if (readiness.mix_active) return Math.max(0, Math.round(+readiness.mix_short || 0));
  return Math.max(0, Math.round((+readiness.parent_needed || 0) - (+readiness.available_sheets || 0)));
}
