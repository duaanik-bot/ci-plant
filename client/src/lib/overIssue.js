// Client twin of server/src/over-issue.js — the over-issue alarm's rule. PURE:
// figures in, verdict out. The run engine uses it to warn while the planner is
// still typing; the server uses its twin to refuse the save until they answer.
// server/src/over-issue.test.js holds the two to identical output, so change
// both or neither. The why lives in the server file.

export const OVER_ISSUE_CONFIRM_PCT = 15;   // MORE than this over → one confirmation
export const OVER_ISSUE_DOUBLE_PCT = 100;   // this much over (double) OR MORE → two, the second typed

const int = v => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

// { level: 'none' | 'confirm' | 'double', required, issuing, excess, pct, ratio }
// Integer arithmetic: "exactly 15% over" must not trip on floating-point dust.
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
  const pct = Math.round(excess * 1000 / r) / 10;
  const ratio = Math.round(i * 100 / r) / 100;
  // Never rounded UP into a threshold the figure did not reach.
  const below = level !== 'double';
  return {
    level, required: r, issuing: i, excess,
    pct: below ? Math.min(pct, 99.9) : pct,
    ratio: below ? Math.min(ratio, 1.99) : ratio,
  };
}

// The level, escalated to the two-step form when the figure is this job's
// PRINT-sheet count typed as parents (see the server twin for why).
export function overIssueVerdict({ required, issuing, childSheets, cpp } = {}) {
  const j = overIssueLevel({ required, issuing });
  const slip = j.level !== 'none' && childCountSlip({ required, issuing, childSheets, cpp });
  return { ...j, slip, level: slip ? 'double' : j.level };
}

// The PRINT-sheet count typed where the PARENT count belongs (CI-GANG-0051).
export function childCountSlip({ required, issuing, childSheets, cpp } = {}) {
  const r = int(required);
  const i = int(issuing);
  const c = int(childSheets);
  const k = int(cpp);
  if (!(k > 1) || !(c > 0) || !(r > 0) || !(i > r)) return false;
  return Math.abs(i - c) * 50 <= c;
}

// Cartons a parent-sheet count yields — the plan's arithmetic run backwards.
export function sheetYield({ parents, cpp, ups, wastage = 0 } = {}) {
  const p = Math.max(0, int(parents) || 0);
  const k = Math.max(1, int(cpp) || 1);
  const u = Math.max(1, int(ups) || 1);
  const w = Math.max(0, int(wastage) || 0);
  return Math.max(0, p * k - w) * u;
}
