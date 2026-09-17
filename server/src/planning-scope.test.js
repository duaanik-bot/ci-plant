// GET /planning?scope= — the queue first, the Completed tab when it is opened.
//
// Live /planning was 1,516 KB for 370 lines, and 269 of those lines were
// in_production: 72% of every Planning load (and every realtime refetch) was
// the Completed tab, which the planner's default To Plan view never renders.
// The opt-in `scope` splits the list in two; no param keeps today's bare array
// for the tablets still running an old bundle.
//
// Three rules here fail QUIETLY, which is why they are tested, not trusted:
//  1. the split is BY RUN — stampBoardState / stampPlateState collapse a gang to
//     its weakest member, so a run whose members straddled the two scopes would
//     read two different verdicts depending on which half was asked for;
//  2. no param is byte-for-byte the legacy response;
//  3. the client's merge puts the two halves back in the server's own order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planningScopeOf, partitionPlanningLines, planningCounts, planningResponse,
} from './planning-scope.js';
import { stampBoardState } from './helpers.js';
import {
  mergePlanningScopes, readPlanningScope, planningScopeOfRun, planningFocusState,
  createDoneFreshness,
} from '../../client/src/lib/planningScope.js';

// Rows as LINE_VIEW orders them: newest order first, lines in id order within it.
const L = (id, order_id, status, gang_run_id = null) => ({ id, order_id, status, gang_run_id });
const ROWS = [
  L(101, 90, 'pending'),
  L(102, 90, 'in_production'),
  L(95, 88, 'planned', 7),          // run 7 STRADDLES: one member still planned…
  L(96, 88, 'in_production', 7),    // …one already pushed to a card
  L(80, 70, 'in_production', 5),    // run 5 is wholly pushed
  L(81, 70, 'in_production', 5),
  L(60, 50, 'ready'),
  L(61, 50, 'in_production'),
];
const ids = rows => rows.map(r => r.id);

test('no scope (or an empty one) is the legacy request; a typo is not silently the whole list', () => {
  assert.equal(planningScopeOf(undefined), null);
  assert.equal(planningScopeOf(''), null);
  assert.equal(planningScopeOf('queue'), 'queue');
  assert.equal(planningScopeOf('completed'), 'completed');
  assert.throws(() => planningScopeOf('done'), /scope/);
  assert.throws(() => planningScopeOf(['queue', 'completed']), /scope/);
});

test('the split is by RUN: a straddling run stays wholly in the queue', () => {
  const { queue, completed } = partitionPlanningLines(ROWS);
  assert.deepEqual(ids(queue), [101, 95, 96, 60],
    'run 7 has a planned member, so its in_production member rides with it');
  assert.deepEqual(ids(completed), [102, 80, 81, 61],
    'only lines — and whole runs — that have ALL left the queue');
});

test('the two scopes partition the list: disjoint, and together every row once', () => {
  const { queue, completed } = partitionPlanningLines(ROWS);
  const seen = [...ids(queue), ...ids(completed)];
  assert.equal(new Set(seen).size, seen.length, 'no line in both scopes');
  assert.deepEqual([...seen].sort(), ids(ROWS).sort(), 'no line in neither');
});

test('counts are whole-tab line counts, served with the queue so badges need no second fetch', () => {
  assert.deepEqual(planningCounts(ROWS), { pending: 1, planned: 2, completed: 5, all: 8 },
    'Completed counts in_production LINES, straddlers included — what the tab badge counts today');
});

// A build that only decorates each row, like the real one per line.
const build = async rows => rows.map(r => ({ ...r, light: `L${r.id}` }));

test('no param answers exactly what the route always answered — a bare array', async () => {
  const legacy = await build(ROWS);
  const out = await planningResponse(undefined, ROWS, build);
  assert.ok(Array.isArray(out), 'old bundles call setLines() on this directly');
  assert.equal(JSON.stringify(out), JSON.stringify(legacy), 'byte-identical');
});

test('no param hands build EVERY row in the view\'s order and returns its answer untouched', async () => {
  const seen = [];
  const answer = [{ sentinel: true }];
  const out = await planningResponse(undefined, ROWS, async rows => { seen.push(ids(rows)); return answer; });
  assert.deepEqual(seen, [ids(ROWS)], 'one build over the whole list, not two halves');
  assert.strictEqual(out, answer, 'no wrapper, no copy — the same array the route used to res.json()');
});

test('a scoped answer carries its lines and the counts; queue ∪ completed rebuilds the legacy list', async () => {
  const legacy = await build(ROWS);
  const queue = await planningResponse('queue', ROWS, build);
  const completed = await planningResponse('completed', ROWS, build);
  assert.equal(queue.scope, 'queue');
  assert.deepEqual(queue.counts, planningCounts(ROWS));
  assert.deepEqual(ids(queue.lines), [101, 95, 96, 60]);
  assert.deepEqual(ids(completed.lines), [102, 80, 81, 61]);
  assert.deepEqual(mergePlanningScopes(queue.lines, completed.lines), legacy,
    'the All tab sees the same rows, in the same order, as before the split');
});

test('each scope builds ONLY its own rows — the point of the change', async () => {
  const asked = [];
  await planningResponse('queue', ROWS, async rows => { asked.push(ids(rows)); return rows; });
  assert.deepEqual(asked, [[101, 95, 96, 60]]);
});

// The verdict the verifier flagged: stampBoardState collapses a run to its
// WEAKEST member. Run 7's planned member has board; its pushed member does not.
test('stampBoardState sees the same run in a scope as in the whole list', async () => {
  const gates = { 95: { material: true, available_sheets: 900 }, 96: { material: false, available_sheets: 0 } };
  const stamp = async rows => {
    const copy = rows.map(r => ({ ...r }));
    await stampBoardState(copy, {
      lineIdOf: l => l.id, gangIdOf: l => l.gang_run_id,
      gatesOf: l => (gates[l.id] ? { ...gates[l.id] } : { material: true, available_sheets: 0 }),
      qc: async () => [],   // no PRs, nothing drawn, no run need on record
    });
    return new Map(copy.map(r => [r.id, r.board_state]));
  };
  const whole = await stamp(ROWS);
  assert.equal(whole.get(95), 'short', 'fixture sanity: the run reads its weakest member');

  const { queue } = partitionPlanningLines(ROWS);
  const scoped = await stamp(queue);
  assert.equal(scoped.get(95), whole.get(95), 'the planned member keeps the run verdict');
  assert.equal(scoped.get(96), whole.get(96));

  // …and why a by-STATUS split would have been wrong.
  const naive = await stamp(ROWS.filter(r => r.status !== 'in_production'));
  assert.equal(naive.get(95), 'covered', 'split by status, the run would read Board OK on To Plan');
});

// ── The client half ───────────────────────────────────────────────────────
test('merge restores the server order: newest order first, lines by id within it', () => {
  const merged = mergePlanningScopes([L(3, 10, 'pending'), L(1, 12, 'pending')], [L(2, 10, 'in_production'), L(9, 12, 'in_production')]);
  assert.deepEqual(ids(merged), [1, 9, 2, 3]);
});

test('merge with the completed scope not loaded is the queue alone', () => {
  const q = [L(1, 12, 'pending')];
  assert.deepEqual(ids(mergePlanningScopes(q, null)), [1]);
});

test('a line in both fetches (it moved between them) appears once — the queue copy', () => {
  const merged = mergePlanningScopes([L(5, 10, 'pending')], [L(5, 10, 'in_production'), L(6, 10, 'in_production')]);
  assert.deepEqual(merged.map(r => [r.id, r.status]), [[5, 'pending'], [6, 'in_production']]);
});

test('reading a response: the wrapper, or a bare array from a server that predates scope', () => {
  const wrapped = readPlanningScope({ scope: 'queue', lines: [L(1, 1, 'pending')], counts: { all: 3 } });
  assert.deepEqual(ids(wrapped.lines), [1]);
  assert.deepEqual(wrapped.counts, { all: 3 });
  assert.equal(wrapped.legacy, false);
  const bare = readPlanningScope([L(1, 1, 'pending'), L(2, 1, 'in_production')]);
  assert.deepEqual(ids(bare.lines), [1, 2], 'an old server answered EVERYTHING');
  assert.equal(bare.counts, null);
  assert.equal(bare.legacy, true, 'so there is no completed half left to fetch');
});

test("the client's run rule is the server's: which scope holds a gang member", () => {
  const { completed } = partitionPlanningLines(ROWS);
  const inCompleted = new Set(ids(completed));
  for (const r of ROWS) {
    const members = r.gang_run_id ? ROWS.filter(x => x.gang_run_id === r.gang_run_id) : [r];
    assert.equal(planningScopeOfRun(members), inCompleted.has(r.id) ? 'completed' : 'queue', `line ${r.id}`);
  }
  // A member already past planning (dispatched) never reaches /planning at all.
  assert.equal(planningScopeOfRun([L(1, 1, 'in_production', 3), L(2, 1, 'dispatched', 3)]), 'completed');
});

// A bell deep link names a JOB. With the list in two halves, "not in what the
// page holds" is not yet "left the queue": a pushed job is simply not fetched.
test('deep link: a job missing from the queue is PENDING until the completed half has loaded', () => {
  const queue = [L(1, 9, 'pending'), L(96, 88, 'in_production', 7)];
  const notYet = { doneLoaded: false, doneStale: false };
  const loaded = { doneLoaded: true, doneStale: false };
  assert.equal(planningFocusState(queue, 102, notYet).state, 'wait',
    'completed half never fetched — the card must not say the job left the queue');
  assert.equal(planningFocusState(queue, 102, { doneLoaded: true, doneStale: true }).state, 'wait',
    'a completed half older than the last refresh is refetched before anyone is told "not found"');
  assert.equal(planningFocusState(queue, 102, loaded).state, 'absent', 'looked in both halves: truly gone');
  assert.equal(planningFocusState(queue, 1, notYet).state, 'found');
  assert.equal(planningFocusState(queue, 1, notYet).line.id, 1);
});

test('deep link: a pushed job riding in the queue half (straddling run) waits for its tab to have rows', () => {
  const queue = [L(95, 88, 'planned', 7), L(96, 88, 'in_production', 7)];
  const s = planningFocusState(queue, 96, { doneLoaded: false, doneStale: false });
  assert.equal(s.state, 'wait', 'Completed lists nothing until its half lands, so there is no row to scroll to');
  assert.equal(s.line.id, 96);
  assert.equal(planningFocusState(queue, 96, { doneLoaded: true, doneStale: true }).state, 'found',
    'a stale half still draws the tab — stale rows are refreshed, not blank');
});

test('deep link ids arrive as strings from the URL and numbers from the bell — both match', () => {
  assert.equal(planningFocusState([{ id: '7', status: 'pending' }], 7, { doneLoaded: false }).state, 'found');
});

// The completed half on hand goes out of date the moment a refresh STARTS that
// skips it — not when that refresh answers. A planner who pushes a job and then
// clicks Completed inside the few hundred ms the queue refresh takes must get a
// fresh completed half, or the job they just pushed is missing from Completed
// until some other change on the floor happens to trigger a refresh.
test('completed half: stale from the moment a queue-only refresh STARTS, not when it answers', () => {
  const f = createDoneFreshness();
  const t0 = f.doneFetchStarting();   // an earlier visit to Completed
  f.doneFetchLanded(t0);
  assert.equal(f.isStale(), false, 'just fetched: fresh');
  f.queueOnlyRefreshStarting();       // the push fires a refresh; nobody is on Completed
  // …the queue answer is still on the wire when the planner clicks Completed:
  assert.equal(f.isStale(), true,
    'a refresh that skips the completed half has started — opening Completed must refetch it');
  const t1 = f.doneFetchStarting();   // that refetch
  f.doneFetchLanded(t1);
  assert.equal(f.isStale(), false, 'fetched after the refresh started: fresh');
});

test('completed half: an answer asked for BEFORE a queue-only refresh started lands stale', () => {
  const f = createDoneFreshness();
  const t0 = f.doneFetchStarting();   // opening Completed; slow on a tablet
  f.queueOnlyRefreshStarting();       // planner is back on To Plan, a change lands, queue-only refresh
  f.doneFetchLanded(t0);              // the older completed answer arrives last
  assert.equal(f.isStale(), true,
    'the completed list predates the refresh — it must not count as fresh on the way back in');
});

test('completed half: a pre-scope server answer carries the whole list, so it is as fresh as its request', () => {
  const f = createDoneFreshness();
  f.queueOnlyRefreshStarting();
  const t = f.doneFetchStarting();    // the queue request's own token
  f.doneFetchLanded(t);               // it answered with a bare array: every line
  assert.equal(f.isStale(), false);
  assert.equal(createDoneFreshness().isStale(), false, 'nothing held yet is "not loaded", not "stale"');
});

// A bell on a job that has since been dispatched: once both halves were looked
// in and it was not there, that answer stands. Re-asking on every refresh sent
// the ~1.1 MB completed half again each time and blinked "left the planning
// queue" off and on for as long as the card stayed open.
test('deep link: once a job was found ABSENT, later refreshes do not reopen the question', () => {
  const queue = [L(1, 9, 'pending')];
  assert.equal(planningFocusState(queue, 102, { doneLoaded: true, doneStale: false }).state, 'absent');
  // A queue-only refresh has since made the completed half stale:
  assert.equal(planningFocusState(queue, 102, { doneLoaded: true, doneStale: true, absentOnce: 102 }).state, 'absent',
    'already looked in both halves for this job — a refresh must not send the completed half again');
  assert.equal(planningFocusState(queue, '102', { doneLoaded: true, doneStale: true, absentOnce: 102 }).state, 'absent',
    'the URL id is a string');
  assert.equal(planningFocusState(queue, 103, { doneLoaded: true, doneStale: true, absentOnce: 102 }).state, 'wait',
    'a DIFFERENT job is a new question');
  assert.equal(planningFocusState([L(102, 90, 'pending')], 102, { doneLoaded: true, doneStale: true, absentOnce: 102 }).state, 'found',
    'a job that comes back (a rollback) is found, whatever was settled before');
});

// The route is the one place that could forget to use all of the above.
test('GET /planning routes through planningResponse with the raw query param', () => {
  const src = readFileSync(new URL('./routes/orders.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("r.get('/planning',"), src.indexOf("r.get('/spec-options'"));
  assert.match(route, /planningResponse\(req\.query\.scope,/);
});

// The helpers above only matter if Planning.jsx calls them where the races happen.
// A page-level revert of either fix would leave every test above green, so the wiring
// is pinned too.
test('Planning.jsx wires the staleness and deep-link helpers where the races happen', () => {
  const page = readFileSync(new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');
  const loadLines = page.slice(page.indexOf('const loadLines = () => {'), page.indexOf('}, [wantDone]);'));
  assert.ok(loadLines.length > 0, 'loadLines and the [wantDone] effect are found');
  // Stale is marked when a queue-only refresh STARTS, before its request goes out.
  assert.match(loadLines, /if \(!wantDone\) \{ doneFresh\.queueOnlyRefreshStarting\(\); return fetchQueue\(\); \}/);
  // Opening Completed/All refetches a half that went stale, not only a missing one.
  assert.match(loadLines, /if \(!wantDone \|\| \(doneLines && !doneFresh\.isStale\(\)\)\) return;/);
  // Both deep-link readers settle once a job was found absent.
  const focusCalls = page.match(/planningFocusState\(lines, focusLineId, \{[\s\S]*?\}\)/g) || [];
  assert.ok(focusCalls.length >= 2, `found ${focusCalls.length} planningFocusState calls`);
  for (const call of focusCalls) assert.match(call, /absentOnce: focusAbsent\.current/, call.slice(0, 80));
});
