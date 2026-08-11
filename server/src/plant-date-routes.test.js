import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { plantDateStr, PLANT_TODAY_SQL } from './plant-calendar.js';

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), 'routes');

// A route runs on Vercel, and Vercel runs the function in UTC — plant-calendar.js
// says so in its own header: "The database runs in UTC but the plant runs on IST."
// So `new Date().toISOString().slice(0, 10)` in a route is NOT today. Between
// 00:00 and 05:30 IST it is yesterday, and every one of these values is either
// written to a date column (po_date, invoice_date, creation_date, wip_date,
// effective_from) or compared against one. plantDateStr() is the plant's day and
// is correct whatever zone the process happens to be in.
//
// This is a lint-shaped invariant, not a behavioural claim: the routes need a
// database to exercise, so the guard is that none of them derives a calendar day
// from the process clock. A BARE toISOString() is a real instant — an audit
// stamp, a backup filename, decided_at — and is deliberately not matched here.
const CALENDAR_DAY_FROM_CLOCK = /toISOString\(\)\.slice\(0,\s*10\)/;

test('no route derives a calendar day from the process clock', () => {
  const offenders = [];
  for (const file of readdirSync(ROUTES).filter(f => f.endsWith('.js'))) {
    const lines = readFileSync(join(ROUTES, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (CALENDAR_DAY_FROM_CLOCK.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `use plantDateStr() instead:\n  ${offenders.join('\n  ')}`);
});

test('plantDateStr is the plant day whatever zone the process runs in', () => {
  // The point of the swap. 22:00 UTC is already the next day in IST (03:30), and
  // the answer must not depend on TZ — a UTC Lambda and an IST laptop agree.
  const nightShift = new Date('2026-08-10T22:00:00Z');
  assert.equal(plantDateStr(nightShift), '2026-08-11');
  // ...whereas the expression this guard bans would call that the 10th.
  assert.equal(nightShift.toISOString().slice(0, 10), '2026-08-10');
});

// ── The SQL half of the same rule ────────────────────────────────────────────
// `now()::date` is the DATABASE's today, and the database is UTC. Every figure
// counted from it is a day short between midnight and 05:30 IST — an order one
// day overdue reads as on time on the shift least able to notice.
const DB_TODAY = /now\(\)::date/;

test('no route counts a day from the database clock', () => {
  const offenders = [];
  for (const file of readdirSync(ROUTES).filter(f => f.endsWith('.js'))) {
    readFileSync(join(ROUTES, file), 'utf8').split('\n').forEach((line, i) => {
      if (DB_TODAY.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `use \${PLANT_TODAY_SQL} instead:\n  ${offenders.join('\n  ')}`);
});

test('PLANT_TODAY_SQL is interpolated, never left as literal text', () => {
  // A SQL fragment only works inside a TEMPLATE literal. Dropped into a quoted
  // string it ships the characters "${PLANT_TODAY_SQL}" straight to Postgres and
  // 500s the endpoint — and no unit test would catch it, because these routes
  // need a database to run. So check statically: every use must sit inside an
  // odd number of backticks, i.e. within an open template literal.
  for (const file of readdirSync(ROUTES).filter(f => f.endsWith('.js'))) {
    const src = readFileSync(join(ROUTES, file), 'utf8');
    let idx = src.indexOf('${PLANT_TODAY_SQL}');
    while (idx !== -1) {
      const backticks = (src.slice(0, idx).match(/(?<!\\)`/g) || []).length;
      assert.equal(backticks % 2, 1,
        `${file}: \${PLANT_TODAY_SQL} at offset ${idx} is NOT inside a template literal`);
      idx = src.indexOf('${PLANT_TODAY_SQL}', idx + 1);
    }
  }
});

test('the fragment shifts the clock, not the column', () => {
  // Wrapping the COLUMN (to_char(col,…) / col AT TIME ZONE) would make an index
  // on it unusable and force a sequential scan; wrapping now() does not.
  assert.match(PLANT_TODAY_SQL, /now\(\)\s+AT TIME ZONE 'Asia\/Kolkata'/);
  assert.doesNotMatch(PLANT_TODAY_SQL, /to_char/);
});
