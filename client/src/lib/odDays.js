// Overdue days — how long a customer has been waiting since they raised the PO.
// The ONE definition, now that five screens ask the question: Planning, Artwork,
// Sort & Paste, the Job Card register and Print Planning.
//
// Split out of components/ui.jsx so it can actually be tested: ui.jsx is JSX and
// `node --test` cannot import it, which left the arithmetic behind every OD on
// the plant floor with no test at all. ui.jsx re-exports both of these, so every
// existing `import { odDays } from '../components/ui.jsx'` keeps working.
//
// Why the PO date at all: delivery_date is null on 117 of 127 open lines, so for
// ~92% of the book the PO date is the only clock a job has.

// Bands, measured against the live order book rather than guessed. The obvious
// move was to reuse AgeChip's 30/60/90; it would have been a wash, because the
// median open line is 20 days old and 87% are under 30 — a 30-day amber paints
// almost the whole board and tells a planner nothing. These colour ~13% of rows
// (14 amber, 2 red of 127), so the few that light up mean it.
const OD_AMBER = 31;
const OD_RED = 61;

// Calendar-day difference, matching the server's (now()::date - po_date::date).
//
// The two sides are read differently ON PURPOSE. po_date is a plain
// 'YYYY-MM-DD', which Date parses as UTC midnight, so its UTC parts are the
// intended calendar date. "Today" is the plant's wall clock, so it is read from
// LOCAL parts. Reading either one the other way drifts a day around midnight —
// local parts on the PO date would shift it west of Greenwich, and toISOString()
// on today would report yesterday for the whole early shift east of it.
//
// Clamped at zero: a PO dated tomorrow has not kept anyone waiting -1 days.
export function odDays(poDate) {
  if (!poDate) return null;
  const d = new Date(poDate);
  if (!Number.isFinite(d.getTime())) return null;
  const then = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const n = new Date();
  const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.max(0, Math.round((today - then) / 86400000));
}

// The same bands in text-only form, for a dense card face where a filled pill
// would shout over everything around it. Reads the SAME two constants as the
// <OverdueDays> pill, so the two can never drift about what counts as late.
// Returns null inside the plain band — the caller then keeps its own colour
// rather than being handed a "normal" class to fight with.
export function odTone(days) {
  if (days == null) return null;
  return days >= OD_RED ? 'text-red-600' : days >= OD_AMBER ? 'text-amber-600' : null;
}

// Exported for the pill in ui.jsx, so the chip and the text form share them.
export const OD_BANDS = { amber: OD_AMBER, red: OD_RED };

// OD as a REPORT carries it: a bare number, never "47d".
//
// The screen keeps the "d" because a pill has no column heading to say what the
// figure is. A spreadsheet does, and there the suffix is not shorthand but
// damage: "47d" is text, so Excel will not sort it (47d sorts beside 4d and
// before 5d), will not filter it by range, will not sum or average it. Six
// screens print this column, so it is defined once here rather than six times
// as a template string that only five of them would ever get fixed.
//
// A number is returned as a NUMBER, not a formatted string — the exporter's
// xlNumber passes it straight through to a real numeric cell. Nothing to
// measure means an em dash, which is the same "no value" every other column
// prints.
export function odExport(days) {
  return days == null ? '—' : days;
}
