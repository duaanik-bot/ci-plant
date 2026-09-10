// The over-issue alarm's rule: when has a hand-typed parent-sheet figure
// strayed far enough from the planning engine's own figure to stop and ask?
//
// Born of CI-GANG-0051 (Q MET 500 + METGAIN-G2). The run engine worked the job
// out at 1,200 print sheets → 400 parent sheets; 1,200 was typed into "Parent
// sheets to issue" — the PRINT-sheet count, three times the board the job
// needed — and it saved on 26 Aug, locked on 2 Sep and was cut and printed on
// 5 Sep without a word. The audit trail held nine more runs typed to double or
// more of their own requirement.
//
// A flag, never a block — Anik: "It should be a flag. It should not be a hard
// block." More than 15% over asks one "Are you sure?"; double or more asks
// twice, the second time by typing the number back. Anyone holding the
// planning module may answer, and the answer is audited (over-issue-gate.js).
//
// TWIN: client/src/lib/overIssue.js carries this logic verbatim so the live
// warning on the planning screen and the server's refusal judge by one rule —
// over-issue.test.js holds the two to identical output. Change both or neither.

export const OVER_ISSUE_CONFIRM_PCT = 15;   // MORE than this over → one confirmation
export const OVER_ISSUE_DOUBLE_PCT = 100;   // this much over (double) OR MORE → two, the second typed

const int = v => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

// { level: 'none' | 'confirm' | 'double', required, issuing, excess, pct, ratio }
//
// Integer arithmetic throughout: 60 / 400 * 100 is 15.000000000000002 in
// floating point, and "exactly 15% over" must not trip a "more than 15%" rule.
// "Double or more" rather than "more than double" on purpose — a print count
// typed at 2 print sheets per parent lands on EXACTLY double, and it is the
// commonest slip in the history (725 → 1,450; 800 → 1,600; 2,600 → 5,200).
export function overIssueLevel({ required, issuing } = {}) {
  const r = int(required);
  const i = int(issuing);
  if (!(r > 0) || !Number.isFinite(i)) {
    return { level: 'none', required: r, issuing: i, excess: 0, pct: 0, ratio: null };
  }
  const excess = Math.max(0, i - r);
  const level = excess * 100 >= r * OVER_ISSUE_DOUBLE_PCT ? 'double'
    : excess * 100 > r * OVER_ISSUE_CONFIRM_PCT ? 'confirm'
      : 'none';
  const pct = Math.round(excess * 1000 / r) / 10;   // one decimal, for the sentence
  const ratio = Math.round(i * 100 / r) / 100;      // 3 for 1,200 against 400
  // …never rounded UP into a threshold the figure did not reach: 3,433 over
  // 3,434 is 99.97%, and "+100%, 2×" beside a one-step alarm would contradict
  // the very rule it is quoting.
  const below = level !== 'double';
  return {
    level, required: r, issuing: i, excess,
    pct: below ? Math.min(pct, 99.9) : pct,
    ratio: below ? Math.min(ratio, 1.99) : ratio,
  };
}

// The whole verdict the alarm speaks: the level by the percentage, escalated to
// the two-step form whenever the figure is this job's PRINT-sheet count typed
// as parents. That slip is the confusion the second step exists to catch — and
// at 2 print sheets per parent an odd print count lands it one sheet short of
// double (6,867 against 3,434), where the percentage alone would ask only once.
export function overIssueVerdict({ required, issuing, childSheets, cpp } = {}) {
  const j = overIssueLevel({ required, issuing });
  const slip = j.level !== 'none' && childCountSlip({ required, issuing, childSheets, cpp });
  return { ...j, slip, level: slip ? 'double' : j.level };
}

// Did the planner type the PRINT (child) sheet count where the PARENT count
// belongs? CI-GANG-0051 exactly: 1,200 print sheets cut 3 to a parent is 400
// parent sheets, and 1,200 went in. Only meaningful when a parent cuts into
// more than one print sheet (at 1 per parent the two counts are one number)
// and when the figure is over the requirement at all. A 2% band forgives the
// rounding a planner does retyping a number off the screen.
export function childCountSlip({ required, issuing, childSheets, cpp } = {}) {
  const r = int(required);
  const i = int(issuing);
  const c = int(childSheets);
  const k = int(cpp);
  if (!(k > 1) || !(c > 0) || !(r > 0) || !(i > r)) return false;
  return Math.abs(i - c) * 50 <= c;
}

// Cartons a parent-sheet count yields: every parent cuts into `cpp` print
// sheets, the wastage allowance is spent bringing the press to colour, and
// each print sheet left carries `ups` cartons — the plan's own arithmetic run
// backwards (sheetsRequired adds the wastage on; this takes it back off).
export function sheetYield({ parents, cpp, ups, wastage = 0 } = {}) {
  const p = Math.max(0, int(parents) || 0);
  const k = Math.max(1, int(cpp) || 1);
  const u = Math.max(1, int(ups) || 1);
  const w = Math.max(0, int(wastage) || 0);
  return Math.max(0, p * k - w) * u;
}
