// Client twin of server/src/partial-entry.js — keep the two identical.
// Parity is asserted by server/src/partial-entry.test.js.
//
// How an operator types a partial count. A stage is filled over several entries
// ("20,000 today, 10,000 tomorrow, 1 to finish the bundle"), and there are two
// honest ways to type the second one:
//
//   'delta' — what came off the machine THIS time.        Operator types 10000.
//   'total' — the cumulative machine-counter reading.     Operator types 30000.
//
// Both describe the same run. The counter stations were originally 'total'-only,
// which meant an operator who typed today's real figure was told his entry read
// "below the log" and the save button went dead — the stage could only ever take
// ONE partial without mental arithmetic. 'delta' is the default now; 'total'
// stays for the operator who reads the number off the machine.
export const ENTRY_BASES = ['delta', 'total'];

const n = v => Math.max(0, Math.round(+v || 0));

// Resolve a typed figure into the run that will actually be recorded.
// `adding` is what gets posted; `total` is where the stage lands afterwards.
// A blank entry is "nothing typed yet", NOT zero — the forms need that apart so
// an untouched field is neutral rather than an error.
export function resolveEntry({ basis = 'delta', entered, priorGood = 0 } = {}) {
  const prior = n(priorGood);
  const blank = entered === '' || entered === null || entered === undefined;
  const typed = blank ? null : Math.round(+entered || 0);

  if (typed === null) return { typed: null, adding: 0, total: prior, belowLog: false };

  // Cumulative basis: the delta is the reading minus what the log already holds.
  // A reading below the log is a real typo (a counter never runs backwards), so
  // it is reported — but as `belowLog`, for the form to offer the delta basis
  // instead, never as a dead end.
  if (basis === 'total') {
    const adding = typed - prior;
    return { typed, adding, total: typed, belowLog: adding < 0 };
  }

  const adding = Math.max(0, typed);
  return { typed, adding, total: prior + adding, belowLog: false };
}

// What genuinely stops a partial from being saved. Deliberately short: an entry
// of 1 is valid, an entry that leaves the stage short is valid (that is the
// whole point of a partial), and a stage that already holds partials takes as
// many more as the operator needs.
export function partialBlockers({
  basis = 'delta', entered, priorGood = 0, scrap = 0, scrapReason = '',
} = {}) {
  const { typed, adding, belowLog } = resolveEntry({ basis, entered, priorGood });
  const waste = n(scrap);
  const blockers = [];
  if (typed === null && waste <= 0) blockers.push('nothing_entered');
  if (belowLog) blockers.push('below_log');
  // A below-the-log reading already has its own, more useful blocker — don't
  // stack a second one saying the entry is empty when it plainly is not.
  if (typed !== null && !belowLog && adding <= 0 && waste <= 0) blockers.push('nothing_entered');
  if (waste > 0 && !String(scrapReason || '').trim()) blockers.push('scrap_reason');
  return blockers;
}
