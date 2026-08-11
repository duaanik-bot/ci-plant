// The ONE way, on the client, to read a calendar day out of a date-ish value.
// Browser counterpart of server/src/day-of.js — the client cannot import server
// code (nothing under client/src does), so the rule is duplicated deliberately
// and this is the only place it is spelled on this side. Import it; never write
// a fresh inline copy, which is how the family got three variants to begin with.
//
// LOCAL parts, never toISOString(). We are UTC+5:30, so for any local time
// before 05:30 the ISO form is still YESTERDAY: at 03:00 IST on 11 Aug,
// new Date().toISOString() reads '2026-08-10'. Anything comparing "today"
// against a stored date is then a day out for the whole early shift — which is
// what dropped a rate effective today out of the Plate PO modal.
export function dayOf(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  // A bare 'YYYY-MM-DD' is already a calendar day and has no instant to shift —
  // it is what an endpoint sends when it formats the column server-side (as
  // GET /plate-rates does, via to_char). Anything else is an ISO instant, so
  // take it back through a Date and read its LOCAL parts, or a timestamp that
  // is IST-midnight-in-UTC would slice to the previous day.
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : dayOf(parsed);
}
