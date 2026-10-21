// Calendar dates and the Indian financial year, the way the ledger keeps them: 'YYYY-MM-DD'
// text, and a year that runs 1 April to 31 March (label '2026-27', number-series tag '2627').
//
// All date arithmetic runs on UTC Dates and is read back with the UTC getters, so the
// machine's timezone can never move a day: the server is UTC, the plant is IST and the
// browser is wherever the accountant happens to be. Nothing here reads the clock; what
// "today" is stays the caller's business (plantDateStr() on the server).
//
// Pure ESM, no React, no DOM, no imports: the server tests import this file by relative
// path and the browser bundles it as written.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n, width = 2) => String(n).padStart(width, '0');

// Midnight UTC on a calendar day. month0 is 0-based, and a day or month out of range rolls
// over (day 0 is the last day of the month before), which the callers lean on. It is
// setUTCFullYear and not Date.UTC because Date.UTC reads the years 0 to 99 as 1900 to 1999.
function utcDay(year, month0, day) {
  const t = new Date(0);
  t.setUTCFullYear(year, month0, day);
  return t;
}

const isoOf = t => `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;

// True for a real calendar day written exactly as 'YYYY-MM-DD'. Leap years count
// (2028-02-29 is a day, 2027-02-29 is not), and '2027-1-5', '27-01-05', '', null and a Date
// object are all refused.
export function finIsValidDate(s) {
  const m = typeof s === 'string' ? DATE.exec(s) : null;
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = utcDay(year, month - 1, day);
  // An impossible day rolls into the next month, so a date that reads back differently was never real.
  return t.getUTCFullYear() === year && t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
}

// [year, month, day] of a date, or a refusal that names it. Callers that take a date from a
// person check finIsValidDate first and answer in their own words; this is the backstop.
function ymdOf(date) {
  if (!finIsValidDate(date)) throw new Error(`"${date}" is not a date; write it as YYYY-MM-DD`);
  return date.split('-').map(Number);
}

// The financial year a date falls in. April starts it: 2027-03-31 is in 2026-27 and
// 2027-04-01 is in 2027-28.
export function finFyOf(date) {
  const [year, month] = ymdOf(date);
  const from = month >= 4 ? year : year - 1;
  const to = from + 1;
  return {
    label: `${pad(from, 4)}-${pad(to % 100)}`,
    short: `${pad(from % 100)}${pad(to % 100)}`,
    start: `${pad(from, 4)}-04-01`,
    end: `${pad(to, 4)}-03-31`,
  };
}

// The twelve months of a financial year label, April first. A label that is not a real
// year ('2027-29', '27-28', '2026') is refused.
export function finMonthsOfFy(label) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(label));
  const from = m ? Number(m[1]) : NaN;
  // The part after the dash is the last two digits of the following year, so '2027-29' is no year.
  if (!m || Number(m[2]) !== (from + 1) % 100) {
    throw new Error(`"${label}" is not a financial year; write it like 2026-27`);
  }
  return Array.from({ length: 12 }, (_, i) => {
    const month = ((i + 3) % 12) + 1; // April (4) first, March (3) last
    const year = month >= 4 ? from : from + 1;
    const last = utcDay(year, month, 0).getUTCDate(); // day 0 of the next month: this month's last day
    return {
      month_no: i + 1,
      label: `${MONTH_NAMES[month - 1]} ${pad(year, 4)}`,
      start_date: `${pad(year, 4)}-${pad(month)}-01`,
      end_date: `${pad(year, 4)}-${pad(month)}-${pad(last)}`,
    };
  });
}

// The calendar day before a date, across month, year and leap-day boundaries: the day
// before 2027-01-01 (when the books begin) is 2026-12-31, the date of the Opening voucher.
export function finDayBefore(date) {
  const [year, month, day] = ymdOf(date);
  return isoOf(utcDay(year, month - 1, day - 1));
}
