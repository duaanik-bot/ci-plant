// GET /print-planning?completed=today|none — the press board without the 60-day
// history it only reads today's rows of.
//
// On live prod the endpoint was 346 KB and 262 KB of it was `completed`: 315
// printed runs over 60 days, of which the Board tab reads only the ones printed
// TODAY (the green "N sh today" on each lane) and the Press Line-up reads none.
// The Completed tab is the one screen that lists them all.
//
// Pinned here:
//  - no param is the legacy answer — the same query, the same keys in the same
//    order (plant tablets run an old bundle for days);
//  - `today` is the legacy query with a 36-hour window and nothing else changed,
//    plus the 60-day count the Completed badge shows. 36 h, not "since midnight":
//    the day is the BROWSER's day (isToday on the client), and the server must
//    never be the one deciding where it starts. Local midnight is at most 24 h
//    back on any clock, so 36 h always covers it and the client's own filter
//    keeps the stats exact;
//  - `none` asks the database nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { printedRuns, PRINTED_RUN_SCOPES } from './routes/production.js';
import { GANG_ANCHOR_LINE, MIX_CUTS_LATERAL } from './helpers.js';
import { printPlanningPath, completedBadgeCount } from '../../client/src/lib/printPlanningScope.js';

const fakeQ = () => {
  const calls = [];
  const qc = async (sql, params) => {
    calls.push({ sql, params });
    if (/COUNT\(\*\)/.test(sql)) return [{ n: 315 }];
    return [{ id: 1, completed_at: '2026-09-17T05:00:00.000Z', machine_id: 4, printed_sheets: 900 }];
  };
  return { calls, qc };
};

test('no scope runs the legacy 60-day query and answers only `completed`', async () => {
  const { calls, qc } = fakeQ();
  const out = await printedRuns(undefined, qc);
  assert.deepEqual(Object.keys(out), ['completed']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE js\.status='completed' AND js\.completed_at > now\(\) - interval '60 days'\n/);
  assert.match(calls[0].sql, /ORDER BY COALESCE\(js\.machine_id, jc\.machine_id\) NULLS LAST, js\.completed_at DESC, jc\.id$/);
  // An unknown value is not a contract either.
  const other = fakeQ();
  await printedRuns('yesterday', other.qc);
  assert.equal(other.calls[0].sql, calls[0].sql);
});

test('completed=today is the same query over 36 hours, plus the 60-day count for the badge', async () => {
  const legacy = fakeQ();
  await printedRuns(undefined, legacy.qc);
  const { calls, qc } = fakeQ();
  const out = await printedRuns('today', qc);
  assert.deepEqual(Object.keys(out), ['completed', 'completed_count']);
  assert.equal(out.completed_count, 315);
  const list = calls.find(c => !/COUNT\(\*\)/.test(c.sql));
  assert.equal(list.sql, legacy.calls[0].sql.replace("interval '60 days'", "interval '36 hours'"),
    'only the window may differ from the legacy list');
  const count = calls.find(c => /COUNT\(\*\)/.test(c.sql));
  assert.ok(count, 'the Completed badge needs the 60-day count');
  // The count must drop exactly the rows the list drops: the list's only inner
  // joins are the printing stage and the product.
  assert.match(count.sql, /JOIN job_stages js ON js\.job_card_id = jc\.id AND js\.stage='printing'/);
  assert.match(count.sql, /JOIN products p ON p\.id = jc\.product_id/);
  assert.match(count.sql, /js\.status='completed' AND js\.completed_at > now\(\) - interval '60 days'/);
  // The two shared laterals are LEFT JOINs of one row per card (the gang's lead
  // line, LIMIT 1; the mix as one JSON array) — their own inner joins are inside
  // the subquery and cannot drop a run.
  assert.match(GANG_ANCHOR_LINE.trim(), /^LEFT JOIN LATERAL[\s\S]*LIMIT 1\s*\) gol ON/);
  assert.match(MIX_CUTS_LATERAL.trim(), /^LEFT JOIN LATERAL[\s\S]*\) mxc ON true$/);
  const innerInList = legacy.calls[0].sql.replace(GANG_ANCHOR_LINE, '').replace(MIX_CUTS_LATERAL, '')
    .split('\n').filter(l => /^\s*JOIN /.test(l)).map(l => l.trim());
  assert.deepEqual(innerInList, [
    "JOIN job_stages js ON js.job_card_id = jc.id AND js.stage='printing'",
    'JOIN products p ON p.id = jc.product_id',
  ]);
});

test('completed=none asks the database nothing', async () => {
  const { calls, qc } = fakeQ();
  assert.deepEqual(await printedRuns('none', qc), {});
  assert.equal(calls.length, 0);
  assert.deepEqual([...PRINTED_RUN_SCOPES].sort(), ['none', 'today']);
});

test('the route spreads the printed runs after cards and presses, so the legacy key order holds', () => {
  const src = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("r.get('/print-planning'"), src.indexOf("r.post('/print-planning/assign'"));
  assert.match(route, /res\.json\(\{ cards, presses, \.\.\.\(await printedRuns\(req\.query\.completed\)\) \}\)/);
});

test('the board asks for today, the Completed tab for the whole 60 days', () => {
  assert.equal(printPlanningPath('board'), '/print-planning?completed=today');
  assert.equal(printPlanningPath('completed'), '/print-planning');
  assert.equal(completedBadgeCount({ completed: [{}, {}], completed_count: 315 }), 315);
  assert.equal(completedBadgeCount({ completed: [{}, {}] }), 2, 'the full list counts itself');
  assert.equal(completedBadgeCount({}), 0);
});

test('the Press Line-up asks for no printed runs at all', () => {
  const src = readFileSync(new URL('../../client/src/pages/PressLineup.jsx', import.meta.url), 'utf8');
  assert.match(src, /api\.get\('\/print-planning\?completed=none'\)/);
});
