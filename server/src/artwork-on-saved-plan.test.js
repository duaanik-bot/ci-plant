import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A SAVED plan reaches the designer — Anik, 2026-08-06: "once the planning
// engine items is saved should be automatically pushed to artwork, as sometimes
// when we are making gang we can cover the board later but we can save the setup
// so that designer can do his job on time by getting the right info."
//
// The designer's work depends on the SPEC (child size, ups, colours, die,
// artwork code, shade card) and every one of those is written by the plan SAVE.
// Board coverage is a slower, separate question. So the artwork gate is "the
// plan is saved", not "the plan is locked".
//
// Source assertions, deliberately: every claim below is about two files agreeing
// — the artwork gate and LINE_VIEW's plan_draft rule, the two plan-lock sites
// and artwork/lock's promotion condition — which no unit test on either one
// alone can make. The behaviour itself is walked on a sandbox.

const SRC = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(SRC, p), 'utf8');
const orders = read('routes/orders.js');
const gangs = read('routes/gangs.js');
const helpers = read('helpers.js');
const ui = read('../../client/src/components/ui.jsx');
const artworkPage = read('../../client/src/pages/Artwork.jsx');
const planningPage = read('../../client/src/pages/Planning.jsx');

const artworkRoute = orders.slice(orders.indexOf("r.get('/artwork'"), orders.indexOf("r.post('/order-lines/:id/artwork'"));

test('the artwork queue admits a job whose plan is SAVED but not locked', () => {
  // The pair is LINE_VIEW's own plan_draft rule, spelled out. If that view's
  // definition of a saved plan ever changes, this is what says the artwork gate
  // has to follow it — otherwise the badge and the queue disagree about which
  // jobs are saved.
  assert.match(artworkRoute,
    /ol\.status = 'pending'\s*\n\s*AND \(ol\.parent_sheets_required IS NOT NULL/,
    'a pending line carrying a written parent requirement must reach the artwork queue');
  assert.match(orders,
    /\(ol\.status = 'pending' AND ol\.parent_sheets_required IS NOT NULL\) AS plan_draft/,
    'LINE_VIEW.plan_draft is the rule the gate is written against');
  // The original three statuses stay — this widened the door, it did not move it.
  assert.match(artworkRoute, /ol\.status IN \('planned','ready','in_production'\)/);
});

test('finished artwork cannot be yanked out of the queue by a discard', () => {
  // Discard nulls parent_sheets_required, so a pending line whose artwork the
  // designer already locked would vanish from the Locked tab mid-flight. Its own
  // clause keeps completed work visible.
  assert.match(artworkRoute, /OR ol\.artwork_locked = 1/,
    'a pending line with locked artwork must stay in the queue');
});

test('a saved draft still cannot reach the floor — the plan lock stays mandatory', () => {
  // This is the property that makes opening the queue safe. Everything else is
  // reversible; a job card is not.
  const mint = helpers.slice(helpers.indexOf('export async function createJobCardForLine'));
  assert.match(mint, /if \(!\['planned', 'ready'\]\.includes\(line\.status\)\)/,
    'createJobCardForLine must keep refusing any status outside planned/ready');
  // And a draft claims no board: 'pending' sits below the demand statuses, which
  // is what lets a job be designed while its board is still an open question.
  assert.doesNotMatch(helpers, /BOARD_DEMAND_STATUSES\s*=\s*\[[^\]]*'pending'/,
    "'pending' must stay out of BOARD_DEMAND_STATUSES");
});

// ── The promotion hole this opened, and its fix ──────────────────────────────

test("locking the plan promotes to 'ready' when the designer got there first", () => {
  // Every promotion to 'ready' in the codebase requires the line to be 'planned'
  // when it runs. artwork/lock checked that and found 'pending', so without this
  // a job designed BEFORE its plan was locked would land on 'planned' and stop
  // there for good — the artwork lock has already happened and will not fire
  // again. Both lock sites re-check.
  for (const [name, src] of [['single line', orders], ['run', gangs]]) {
    assert.match(src,
      /await setLineStatus\(line\.id, 'planned', qc, oc, req\.user\.name\);[\s\S]{0,1400}?const gate = await readiness\(fresh, oc\);\s*\n\s*if \(gate\.artwork && gate\.tooling && \(gate\.material \|\| gate\.material_pending\)\) \{\s*\n\s*await setLineStatus\(fresh\.id, 'ready'/,
      `the ${name} plan lock must re-check the gate and promote`);
  }
});

test('every route that promotes to ready uses the SAME condition', () => {
  // The point is convergence, not a count: whichever order the work happens in —
  // artwork first, tooling first, or the plan locked last — a job must land in
  // the same state. Asserted per named site rather than by tallying occurrences,
  // because a tally breaks the moment a fourth legitimate site appears (this
  // test was first written expecting two in orders.js and found three: the
  // tooling route has always carried the same rule).
  const cond = /gate\.artwork && gate\.tooling && \(gate\.material \|\| gate\.material_pending\)/;
  const sites = [
    ['orders.js  artwork/lock', orders, "r.post('/order-lines/:id/artwork/lock'"],
    ['orders.js  tooling',      orders, "r.post('/order-lines/:id/tooling'"],
    ['orders.js  plan lock',    orders, "r.post('/order-lines/:id/plan'"],
    ['gangs.js   run plan lock', gangs, "r.post('/gang-runs/:id/plan'"],
  ];
  // Each route is bounded by where the NEXT one starts, not by a character
  // count: the plan route runs 500+ densely-commented lines, so any fixed window
  // is either too small to reach its promotion or big enough to borrow a
  // neighbour's and pass for the wrong reason.
  const nextRouteAfter = (src, at) => {
    const m = /\n\s*r\.(get|post|put|patch|delete)\(/.exec(src.slice(at + 10));
    return m ? at + 10 + m.index : src.length;
  };
  for (const [name, src, anchor] of sites) {
    const at = src.indexOf(anchor);
    assert.notEqual(at, -1, `${name}: route not found`);
    const body = src.slice(at, nextRouteAfter(src, at));
    assert.match(body, cond, `${name} must promote on the one shared condition`);
  }
});

test('the promotion cannot over-reach — the artwork gate IS the lock', () => {
  // If `gate.artwork` were merely "approvals ticked", locking a plan would
  // promote jobs whose artwork nobody had finished. It is the lock itself, so a
  // plan locked before any artwork is done still stops at 'planned'.
  assert.match(helpers, /artwork: !!line\.artwork_locked,/,
    'readiness().artwork must stay bound to artwork_locked');
});

// ── One badge, two queues ────────────────────────────────────────────────────

test('PlanSavedBadge lives in ui.jsx and is imported, never re-declared', () => {
  assert.match(ui, /export function PlanSavedBadge\(\{ hint \}\)/,
    'the badge belongs beside StatusBadge, the sibling it copies');
  for (const [name, src] of [['Planning', planningPage], ['Artwork', artworkPage]]) {
    assert.doesNotMatch(src, /function PlanSavedBadge/,
      `${name} must not keep a local copy to drift from`);
    assert.match(src, /import \{[^}]*\bPlanSavedBadge\b[^}]*\} from '\.\.\/components\/ui\.jsx'/,
      `${name} must import the shared badge`);
  }
});

test('the artwork row says "saved", never "pending", on a draft', () => {
  // "pending" on a job sitting in the artwork queue reads as "nobody has planned
  // this" — the one thing that cell must not say about a job that reached the
  // queue precisely because its setup IS settled.
  assert.match(artworkPage, /m\.plan_draft\s*\n?\s*\?\s*<PlanSavedBadge/,
    'a draft member must wear the badge instead of its raw status');
  // And the hint is the DESIGNER's, not the planner's — different reader, same
  // fact. The planner is told to go and lock it; the designer is told what can
  // still move under them.
  assert.match(artworkPage, /the cut plan can still change/,
    'the artwork hint must warn that the spec is not frozen');
});
