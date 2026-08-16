// What banked a leftover strip, read off its batch key.
//
// A leftover lot's batch_no IS the record of where it came from — there is no
// FK. Three shapes are minted today:
//
//   LO-PLAN-<lineId>                  a single line, v1 (whole-board decision)
//   LO-PLAN-<lineId>-<materialId>     a single line, v2 (one board of its mix)
//   LO-PLAN-RUN-<runId>-<materialId>  a RUN — combined, or co-printed gang
//   LO-<jcNumber>[-<materialId>]      confirmed at cutting, whatever banked it
//
// The Warehouse's From column used to strip `LO-PLAN-` and print `line ` in
// front of whatever was left, which read `line RUN-8-1` for a run — wrong noun,
// and an id the planner cannot look anything up by. Run banking was rare enough
// to hide it (a combined run could bank only through a board mix); with gangs
// and unmixed runs banking too, it is the common row.
//
// `runNumber` is the run's own document number when the caller has resolved it
// (the API attaches it for exactly these rows) — CI-GANG-0006 is what the
// planner has on screen everywhere else. Without it the id still names the run
// honestly rather than calling it a line.
export function leftoverSourceLabel(batchNo, runNumber = null) {
  const s = String(batchNo || '');
  if (!s.startsWith('LO-')) return '—';
  if (s.startsWith('LO-PLAN-RUN-')) {
    if (runNumber) return runNumber;
    const runId = s.slice('LO-PLAN-RUN-'.length).split('-')[0];
    return runId ? `run #${runId}` : 'run';
  }
  if (s.startsWith('LO-PLAN-')) {
    // v2 appends the board — the LINE is the first segment, and it is the line
    // the planner knows. `line 261-89` would name a board id as if it were part
    // of the job number.
    const lineId = s.slice('LO-PLAN-'.length).split('-')[0];
    return lineId ? `line ${lineId}` : 'line';
  }
  // Confirmed: LO-<jcNumber>[-<materialId>]. The job card number carries its own
  // dashes (CI-GANG-JC-0003), so the board suffix cannot be split off by
  // counting them — and the card number alone is the answer anyway.
  return s.slice(3);
}
