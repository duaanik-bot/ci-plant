// The over-issue alarm's server half. Judges a hand-typed parent-sheet figure
// by over-issue.js's rule and refuses it with a structured 409 until the
// planner has answered — the same acknowledge-and-retry shape the shade-card
// alarm uses at printing start (production.js, ack_shade). Every caller runs
// this BEFORE it writes the figure, so a refusal leaves nothing behind, and
// the answer, when it comes, is recorded with the name of whoever gave it.
//
// Soft on purpose. The plant sometimes means to run over — a spoilage-prone
// job, a carton it wants in stock — and that is the planner's call. What the
// alarm removes is doing it without noticing: CI-GANG-0051 went to the floor
// at three times its board because nothing ever said the number out loud.
import { overIssueVerdict } from './over-issue.js';

export const OVER_ISSUE = 'OVER_ISSUE';

const num = v => Math.round(Number(v)).toLocaleString('en-IN');

// A confirmed alarm re-sends the two figures the planner was shown. Bound to
// BOTH, so a yes given to "1,200 against 400" can never be replayed onto
// 1,500, nor onto a plan whose requirement moved while the dialog was open —
// either way the figures differ, and the planner is simply asked again.
export function ackMatches(ack, required, issuing) {
  if (!ack || typeof ack !== 'object') return false;
  const a = Math.round(Number(ack.required));
  const b = Math.round(Number(ack.issuing));
  return Number.isFinite(a) && Number.isFinite(b)
    && a === Math.round(Number(required)) && b === Math.round(Number(issuing));
}

// Inside the rule → { judged, acked: false }. Answered with matching figures →
// { judged, acked: true }, and the caller audits it. Otherwise it throws — and
// the message is written for a screen with no dialog for it (a tablet still on
// an old bundle): both numbers and what to do, because the central toast is
// all that client can show.
//
// `context` rides along to the dialog untouched: where the figure came from
// (where/ref/action/via), the print-sheet count and cut for the slip check, and
// per-product yields so the planner sees the loss in cartons, not just sheets.
export function overIssueRefusal({ required, issuing, ack, context = {} } = {}) {
  const judged = overIssueVerdict({ required, issuing, childSheets: context.child_sheets, cpp: context.cpp });
  if (judged.level === 'none') return { judged, acked: false };
  if (ackMatches(ack, judged.required, judged.issuing)) return { judged, acked: true };
  throw Object.assign(
    new Error(`Over-issue alarm — ${num(judged.issuing)} parent sheets against the planning engine's `
      + `${num(judged.required)} (+${judged.pct}%). Confirm it in the alarm, or reload the page if no alarm appears.`),
    { status: 409, body: { code: OVER_ISSUE, over_issue: { ...context, ...judged } } });
}

// The audit line a confirmed over-issue leaves. WHO is on the audit row itself;
// this names the job, both figures, and how hard the planner was asked.
export function overIssueAuditText({ ref, judged, action, via, wastage, standard } = {}) {
  const how = judged?.level === 'double' ? 'confirmed twice, the number typed back' : 'confirmed';
  const through = via === 'mix' ? ' (Board Mix total)'
    : via === 'wastage' && wastage != null
      ? ` (wastage ${num(wastage)} against the standard ${num(standard)})`
      : '';
  return `${ref ? `${ref}: ` : ''}issuing ${num(judged.issuing)} parent sheets${through} against the planning engine's `
    + `${num(judged.required)} (+${judged.pct}%, ${judged.ratio}×) — over-issue alarm ${how}`
    + (action ? ` · ${action}` : '');
}
