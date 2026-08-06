// Job Cards timeline — the register narrowed to a stretch of days.
//
// The anchor is the PLANNED DATE: the day the job is meant to run on the press.
// That is what "print today's job cards" means on the floor — the travelers for
// the work about to happen, not the cards Planning happened to raise today.
// created_at (the traveler's "Released" line) and delivery_date are deliberately
// NOT the anchor: the first says when paperwork moved, the second is the
// customer's date and is null on most of the register.
//
// A card with NO planned date is outside every preset. It is not a bug and not
// a silent drop — the screen counts them and says so, because an unplanned card
// is exactly the thing a planner wants to notice.
//
// Dates are compared as local YYYY-MM-DD strings, never as Date objects. The
// plant is one site in one timezone; a card planned for "2026-08-06" is planned
// for that day whatever the browser's clock offset does to a parsed timestamp.

// Local calendar day of a Date — NOT toISOString(), which shifts to UTC and
// would file an evening job under tomorrow for half the year.
export const isoDay = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// A stored date reduced to its calendar day. Postgres hands back either a bare
// 'YYYY-MM-DD' (a date column) or a full timestamp; both start with the day, so
// the slice is the whole conversion and it never re-parses.
export const dayOf = v => {
  if (!v) return null;
  const s = typeof v === 'string' ? v : isoDay(new Date(v));
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

// The presets, in the order they read on screen. `all` carries no range at all
// — it is the absence of a filter, not a range wide enough to look like one.
export const TIMELINE_PRESETS = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This Week' },
  { key: 'custom', label: 'Custom' },
];

// { from, to } inclusive, or null for 'all' / 'custom' (custom's range is the
// planner's own two inputs, so there is nothing to derive).
//
// `now` is injectable so this is testable without touching the clock — the
// screen never passes it.
export function presetRange(key, now = new Date()) {
  const today = isoDay(now);
  if (key === 'today') return { from: today, to: today };
  if (key === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return { from: isoDay(d), to: isoDay(d) };
  }
  // Monday → today, the plant's own week. NOT a rolling 7 days: "this week"
  // means the week we are in, and on a Tuesday that is two days, not seven.
  // getDay() is 0 for Sunday, so Sunday counts back six days to ITS Monday
  // rather than forward into the week that has not started.
  if (key === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return { from: isoDay(d), to: today };
  }
  return null;
}

// Does this card's planned date fall inside the range? A null range accepts
// everything (that is 'all'); a card with no planned date is accepted ONLY by a
// null range. A half-open custom range (one input filled) bounds on the side it
// was given and leaves the other open, so typing a From before a To never
// blanks the list mid-keystroke.
export function inTimeline(jc, range) {
  if (!range || (!range.from && !range.to)) return true;
  const d = dayOf(jc?.planned_date);
  if (!d) return false;
  if (range.from && d < range.from) return false;
  if (range.to && d > range.to) return false;
  return true;
}

// How many of `jobs` each preset would show — the chip counts. Computed off the
// SAME inTimeline the list filters with, so a chip can never promise a number
// the list then contradicts.
export function timelineCounts(jobs, now = new Date()) {
  const out = { all: jobs.length };
  for (const p of TIMELINE_PRESETS) {
    if (p.key === 'all' || p.key === 'custom') continue;
    const r = presetRange(p.key, now);
    out[p.key] = jobs.filter(j => inTimeline(j, r)).length;
  }
  return out;
}

// Cards the active timeline is hiding purely because nobody planned them. The
// screen names this number rather than letting the rows evaporate.
export function unplannedCount(jobs) {
  return jobs.filter(j => !dayOf(j?.planned_date)).length;
}
