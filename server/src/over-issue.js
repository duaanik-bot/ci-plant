// The over-issue alarm's rule: when has a parent-sheet figure strayed far
// enough from the planning engine's own to stop and ask?
//
// Born of CI-GANG-0051 (Q MET 500 + METGAIN-G2). The run engine worked the job
// out at 1,200 print sheets → 400 parent sheets; 1,200 was typed into "Parent
// sheets to issue" — the PRINT-sheet count, three times the board the job
// needed — and it saved on 26 Aug, locked on 2 Sep and was cut and printed on
// 5 Sep without a word. The audit trail held nine more runs typed to double or
// more of their own requirement.
//
// A flag, never a block — Anik: "It should be a flag. It should not be a hard
// block." Anything MORE than 15% over the engine takes the full two-step form:
// "Are you sure?", then the number typed back before the final Yes is live.
// (The first cut asked once past 15% and twice only at double; Anik's second
// pass the same day: "instead of 100%, we should reduce that to 15%".) The
// engine's figure is the plan at the plant's STANDARD wastage, so a wastage
// raised above it is weighed like a typed override (the routes price that).
// Anyone holding the planning module may answer; the answer is audited
// (over-issue-gate.js).
//
// TWIN: client/src/lib/overIssue.js carries this logic verbatim so the live
// warning on the planning screen and the server's refusal judge by one rule —
// over-issue.test.js holds the two to identical output. Change both or neither.

// Two dials. MORE than OVER_ISSUE_DOUBLE_PCT over → the two-step form; MORE
// than OVER_ISSUE_CONFIRM_PCT but not past the other → one "Are you sure?".
// Set level, as now, every alarm is the two-step form and the one-step band is
// empty — kept as a dial rather than deleted, because the plant has already
// moved these once.
export const OVER_ISSUE_CONFIRM_PCT = 15;
export const OVER_ISSUE_DOUBLE_PCT = 15;

const int = v => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

// { level: 'none' | 'confirm' | 'double', required, issuing, excess, pct, ratio }
// 'double' is the DOUBLE CONFIRMATION — the two-step form — not "twice the
// requirement".
//
// Integer arithmetic throughout: 60 / 400 * 100 is 15.000000000000002 in
// floating point, and "exactly 15% over" must not trip a "more than 15%" rule.
export function overIssueLevel({ required, issuing } = {}) {
  const r = int(required);
  const i = int(issuing);
  if (!(r > 0) || !Number.isFinite(i)) {
    return { level: 'none', required: r, issuing: i, excess: 0, pct: 0, ratio: null };
  }
  const excess = Math.max(0, i - r);
  const level = excess * 100 > r * OVER_ISSUE_DOUBLE_PCT ? 'double'
    : excess * 100 > r * OVER_ISSUE_CONFIRM_PCT ? 'confirm'
      : 'none';
  // One decimal for the sentence — and an alarm never shows its figure rounded
  // DOWN onto the line it crossed: 11,501 against 10,000 is 15.01%, and "+15%"
  // beside "more than 15%" would read as inside the rule.
  const crossed = level === 'double' ? OVER_ISSUE_DOUBLE_PCT
    : level === 'confirm' ? OVER_ISSUE_CONFIRM_PCT : null;
  const rounded = Math.round(excess * 1000 / r) / 10;
  return {
    level, required: r, issuing: i, excess,
    pct: crossed == null ? rounded : Math.max(rounded, crossed + 0.1),
    ratio: Math.round(i * 100 / r) / 100,      // 3 for 1,200 against 400
  };
}

// The whole verdict the alarm speaks: the level by the percentage, escalated to
// the two-step form whenever the figure is this job's PRINT-sheet count typed
// as parents. That slip is the confusion the second step exists to catch; at 2
// print sheets per parent an odd print count lands it one sheet short of
// double (6,867 against 3,434), which the first cut's percentage asked only
// once. With the dials level the escalation is moot, and it stays for when
// they are not.
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
