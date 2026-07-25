// ─── Plant-local calendar boundaries ────────────────────────────────────────
// The database runs in UTC but the plant runs on IST. Bucketing a KPI with
// `closed_at::date = current_date` therefore cuts the day at 05:30 IST, so the
// night shift's output lands in the previous day's numbers. These helpers hand
// SQL an explicit half-open [start, end) range in real IST terms instead.
//
// The range form is also what makes the queries fast: a bare column compared
// against constants can use an index on that column, whereas to_char(col,…) or
// col::date wraps the column in a function and forces a sequential scan.
//
// India has no DST and has held a fixed +05:30 offset since 1945, so a constant
// offset is exact here — no zone database lookup required.
const IST_OFFSET_MIN = 5 * 60 + 30;

// The wall-clock date the plant is living in at instant `now`.
function plantParts(now) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-indexed
    day: shifted.getUTCDate(),
  };
}

// The UTC instant at which the given IST wall-clock midnight occurs.
function istMidnightUtc(year, month, day) {
  return new Date(Date.UTC(year, month, day) - IST_OFFSET_MIN * 60_000);
}

// [start, end) covering the plant's current day.
export function plantDay(now = new Date()) {
  const { year, month, day } = plantParts(now);
  return { start: istMidnightUtc(year, month, day), end: istMidnightUtc(year, month, day + 1) };
}

// [start, end) covering the plant's current calendar month.
export function plantMonth(now = new Date()) {
  const { year, month } = plantParts(now);
  return { start: istMidnightUtc(year, month, 1), end: istMidnightUtc(year, month + 1, 1) };
}

// Plant-local calendar date as YYYY-MM-DD, offset by `addDays`. Used for the
// text delivery_date column, which stores plain dates with no zone.
export function plantDateStr(now = new Date(), addDays = 0) {
  const { year, month, day } = plantParts(now);
  const d = new Date(Date.UTC(year, month, day + addDays));
  return d.toISOString().slice(0, 10);
}

// Half-open [start, end) for a user-supplied YYYY-MM-DD report range. `to` is
// inclusive to the reader — asking for "to the 24th" means through the end of
// the 24th — so the exclusive bound is the following IST midnight. Defaults to
// the trailing `daysBack` days through today.
export function plantRange(from, to, daysBack = 30, now = new Date()) {
  const { year, month, day } = plantParts(now);
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? { y: +m[1], mo: +m[2] - 1, d: +m[3] } : null;
  };
  const f = parse(from), t = parse(to);
  return {
    start: f ? istMidnightUtc(f.y, f.mo, f.d) : istMidnightUtc(year, month, day - daysBack),
    end: t ? istMidnightUtc(t.y, t.mo, t.d + 1) : istMidnightUtc(year, month, day + 1),
  };
}
