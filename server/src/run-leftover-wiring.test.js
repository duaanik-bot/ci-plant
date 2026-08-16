import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The wiring behind a run's offcut bank — the five places the rule is applied,
// and the one place a strip is taken back.
//
// A banked strip is LIVE warehouse stock from the instant the lock writes it,
// so every path that changes the geometry it was measured on has to give it
// back. Miss one and the leftover rack carries a size the run no longer cuts,
// with no screen able to correct it.

const gangs = readFileSync(new URL('./routes/gangs.js', import.meta.url), 'utf8');
const production = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
const planning = readFileSync(
  new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');

const slice = (src, from, len = 6000) => {
  const i = src.indexOf(from);
  assert.notEqual(i, -1, `anchor not found: ${from}`);
  return src.slice(i, i + len);
};

// ── The plan route ──────────────────────────────────────────────────────────

const planRoute = slice(gangs, "r.post('/gang-runs/:id/plan'", 48000);

test('the basis is captured by the branch that computed the run’s fit', () => {
  // Co-printed: the SAME (board, child) childFit was struck on, one line apart.
  assert.match(planRoute,
    /const fit = childFit\(board, \{ child_l: child\.l, child_w: child\.w \}\);[\s\S]{0,300}?loBasis = runLeftoverBasis\(gang, board, \{ sharedChild: child \}\)/,
    'a shared gang measures on the board it actually buys');
  // Combined: the lead member's own board + effective product.
  assert.match(planRoute,
    /if \(i === 0\) loBasis = runLeftoverBasis\(gang, board, \{ mergeChild: eff \}\)/,
    'a combined run measures on the lead member’s parent');
});

test('the NO-MIX arm banks instead of only sweeping', () => {
  const arm = slice(planRoute, '} else if (runBanksLeftover(gang)', 4000);
  assert.match(arm, /req\.body\.leftover\?\.push && req\.body\.leftover\?\.strip/,
    'it reads the single line’s own {push, strip} shape');
  assert.match(arm, /leftoverStrips\(loBasis\.parent, loBasis\.child\)/,
    'strips come from the run’s basis, never the raw board');
  assert.match(arm, /s\.usable\s*$/m, 'and an unbankable strip is not offered');
  assert.match(arm, /Leftover strip does not match this run\\?'s cut plan[\s\S]{0,80}status: 409/,
    'a stale pick is refused, not silently re-measured');
  assert.match(arm, /banked\.spp \* issuedTotal/,
    'qty is priced on the ISSUED total, so an issue override rides along');
  assert.match(arm, /unbankRunLeftover\([\s\S]{0,220}?banked \? \[`LO-PLAN-RUN-\$\{gang\.id\}-\$\{banked\.srcBoard\.id\}`\] : \[\]\)/,
    'the sweep keeps exactly what this save re-banks');
});

test('the no-mix arm keeps the draft exemption that protects a withheld mix', () => {
  assert.match(planRoute,
    /\} else if \(runBanksLeftover\(gang\) && \(!draft \|\| Array\.isArray\(req\.body\.mix\)\)\)/,
    'a draft that said nothing about its mix must not sweep the bank mirroring it');
});

test('the MIX arm is gated on the rule, not on kind', () => {
  const arm = slice(planRoute, '// ── Run-level leftover banking', 3500);
  assert.match(arm, /if \(runBanksLeftover\(gang\)\) \{/,
    'a shared gang banks through a mix too');
  assert.doesNotMatch(arm, /if \(isMerge\) \{\s*\n\s*const bankWanted/,
    'the old merge-only gate is gone');
  assert.match(arm, /const rowUps = r\.ups \?\? childFit\(rowParent, loBasis\.child\)\.count/,
    'a gang row carries no chosen cuts — its cuts are the board’s natural fit');
  assert.match(arm, /chosenStrips\(rowParent, loBasis\.child, rowUps\)/);
});

test('an eligible run that cannot be measured refuses a bank rather than dropping it', () => {
  // Both arms: silently skipping would leave the planner's tick with no effect
  // and no message — the shape of bug that looks like a broken button.
  const hits = planRoute.match(/has no settled cut to measure an offcut on/g) || [];
  assert.equal(hits.length, 2, 'the mix arm and the no-mix arm each refuse');
});

test('a separate-layout gang still banks nothing anywhere', () => {
  // Its basis is null and the predicate is false, so neither arm can reach it.
  // Guarded in run-leftover-basis.test.js; asserted here as the route contract.
  // Every write of a run's bank — `un` excluded, since unbankRunLeftover
  // contains the name — must sit downstream of the predicate that decides
  // which runs may hold one at all.
  for (const m of planRoute.matchAll(/(?<!un)bankRunLeftover\(/g)) {
    const before = planRoute.slice(Math.max(0, m.index - 4000), m.index);
    assert.match(before, /runBanksLeftover\(gang\)/,
      `a bank at offset ${m.index} is not under the predicate`);
  }
});

// ── The guard rails ─────────────────────────────────────────────────────────

test('re-deriving a member takes the run’s bank back', () => {
  const fn = slice(gangs, 'async function reDeriveMemberSheets', 6000);
  assert.match(fn, /SELECT kind, layout_mode FROM gang_runs/,
    'the layout is read, not just the kind');
  assert.match(fn, /if \(runBanksLeftover\(run\)\) \{[\s\S]{0,200}?unbankRunLeftover/);
});

test('all three geometry-changing routes funnel through it', () => {
  // Per-member board reassignment, the shared sheet lock, and a qty/ups edit.
  for (const anchor of [
    "r.post('/gang-runs/:id/board'",
    "r.post('/gang-runs/:id/shared'",
    "r.patch('/gang-runs/:id/lines/:lineId'",
  ]) {
    assert.match(slice(gangs, anchor, 5000), /reDeriveMemberSheets\(/,
      `${anchor} must re-derive, which is what unbanks`);
  }
});

test('flipping a gang to separate layout sweeps a strip it may no longer hold', () => {
  const route = slice(gangs, "r.patch('/gang-runs/:id/layout'", 2400);
  assert.match(route,
    /UPDATE gang_runs SET layout_mode[\s\S]{0,1200}?unbankRunLeftover\(gang\.id/,
    'the sweep runs inside the same changed-mode branch as the UPDATE');
});

// ── The record the client seeds from ────────────────────────────────────────

test('gangDetail returns the live batches for any banking run, with their strip', () => {
  const fn = slice(gangs, 'let leftoverBatches = []', 1400);
  assert.match(fn, /if \(runBanksLeftover\(gang\)\)/);
  assert.match(fn, /JOIN materials m ON m\.id = sb\.material_id/,
    'the minted master carries the strip that was banked');
  assert.match(fn, /strip: \{ l: Number\(b\.sheet_l\), w: Number\(b\.sheet_w\) \}/);
  assert.match(fn, /\(sb\.initial_qty > 0 OR sb\.qty > 0\)/,
    'a SWEPT row is dead record and must not seed a toggle back on');
});

test('gangDetail hands the client the geometry the lock will use', () => {
  assert.match(gangs, /leftover_basis: runLeftoverBasis\(gang, board, \{/);
  assert.match(gangs, /sharedChild: sharedLayoutState\(gang, members\)\.child\s*\n\s*\|\| agreedChildSize\(/,
    'the stamped override, else the size the members already agree on — the plan route’s own soft gate');
});

// ── The cutting confirm ─────────────────────────────────────────────────────

const confirm = slice(production, "// Bank the planned leftover offcut", 13000);

test('the confirm reads the same rule the lock wrote by', () => {
  assert.match(production, /import \{ runBanksLeftover \} from '\.\/gangs\.js'/);
  assert.match(confirm, /SELECT kind, layout_mode FROM gang_runs/);
  assert.match(confirm, /!jcForLeftover\?\.order_line_id && !runBanksLeftover\(leftoverRun\)/,
    'only a run that never banks is skipped');
});

test('a run with NO mix trues its bank to the card’s own parents cut', () => {
  assert.match(confirm, /let runMixByBoard = null;[\s\S]{0,900}?if \(!mixRows\) \{/,
    'the per-board read only runs where the merge aggregation does not reach');
  assert.match(confirm, /: Math\.round\(Number\(stQtyIn\) \|\| 0\)/,
    'no mix means one board, and stQtyIn is already the TRUE parents cut');
  // stQtyIn is assigned the actual figure by BOTH variance arms above — that is
  // what makes it safe to use here rather than the planned issue.
  assert.match(production, /stQtyIn = mixVariance\.actualParents;.*leftover booking below/);
  assert.match(production, /stQtyIn = cutVariance\.actualParents;.*leftover booking below/);
});

test('a mixed run absent from its own mix is a stale bank, not a windfall', () => {
  assert.match(confirm, /runMixByBoard\.has\(mid\) \? Math\.round\(runMixByBoard\.get\(mid\)\) : null/);
  assert.match(confirm, /if \(actualParents == null\) continue;/);
});

test('a swept bank is never resurrected at cutting', () => {
  assert.match(confirm, /if \(!\(Number\(pb\.initial_qty\) > 0 \|\| Number\(pb\.qty\) > 0\)\) continue;/);
});

// ── The screen ──────────────────────────────────────────────────────────────

test('the basis carries dimensions only — no board row on the wire', () => {
  assert.match(gangs,
    /parent: \{ sheet_l: \+parent\.sheet_l, sheet_w: \+parent\.sheet_w \}/,
    'effectiveParent spreads the whole material; the basis must not ship its rates');
});

test('the run’s card measures on the server’s basis, never planned_parent_*', () => {
  assert.match(planning, /const gangLoBasis = gangView\?\.mix\?\.leftover_basis \|\| null/);
  assert.match(planning,
    /clientStrips\(gangLoBasis\.parent\.sheet_l, gangLoBasis\.parent\.sheet_w,\s*\n\s*gangLoBasis\.child\.child_l, gangLoBasis\.child\.child_w\)/);
});

test('the card and the per-row chips never both own one batch key', () => {
  // The server routes a mixed save to the per-row bank and does not read
  // `leftover` at all, so the card has to stand down at exactly the same point.
  assert.match(planning,
    /gangLoStrips\.length > 0 && !gangMixRows\.some\(r => Number\(r\.sheets\) > 0\)/,
    'the card hides once the mix has rows');
  assert.match(planning,
    /\.\.\.\(gangLoBasis && !activeGangMix\.length \? \{\s*\n\s*leftover:/,
    'and the payload sends `leftover` only in that same no-mix case');
  assert.match(planning,
    /\.\.\.\(gangLoBasis && activeGangMix\.length \? \{\s*\n\s*mix_leftovers:/);
});

test('a stale pick is dropped before it can ride into a 409', () => {
  assert.match(planning, /if \(!still\) setGangLo\(\{ push: false, strip: null \}\)/);
});

test('a gang with no card at all is told why', () => {
  // The only reason left: a CO-PRINTED run whose members have not agreed one
  // child sheet. A separate layout now banks per member, so it always has rows.
  assert.match(planning,
    /const gangLoWhy = gangView\?\.kind !== 'gang' \|\| gangLoBasis \|\| gangLoMembers\.length\s*\n\s*\? null : 'pending'/,
    'keyed on there being neither a run basis NOR member rows');
  assert.match(planning, /one child sheet<\/b>/, 'and it names the missing size');
});

// ── The separate-layout gang: one decision per member ───────────────────────

test('a separate-layout gang banks through the LINE machinery, per member', () => {
  const arm = slice(planRoute, '// ── A SEPARATE-LAYOUT gang banks PER MEMBER', 6200);
  assert.match(arm, /gang\.kind === 'gang' && gang\.layout_mode !== 'shared'/);
  assert.match(arm, /\(!draft \|\| Array\.isArray\(req\.body\.mix\)\)/,
    'same draft exemption as the run-level arms');
  assert.match(arm, /req\.body\.leftovers/, 'payload is per member');
  assert.match(arm, /bankPlanningLeftover\(line, r\._mat, r\.strip, r\.strips_per_parent, r\._qty,[\s\S]{0,120}?`LO-PLAN-\$\{line\.id\}-\$\{r\._mat\.id\}`\)/,
    'the LINE\'s own v2 batch key — no new storage');
  assert.match(arm, /UPDATE order_lines SET leftover_plan=\$1 WHERE id=\$2/,
    'and the line\'s own v2 record, which the confirm reads');
});

test('a member measures on ITS OWN parent, and its planned board must match the pick', () => {
  const arm = slice(planRoute, '// ── A SEPARATE-LAYOUT gang banks PER MEMBER', 6200);
  assert.match(arm, /leftoverStrips\(rowParent, eff\)/, 'that member\'s own child');
  assert.match(arm, /d\.role === 'planned' && d\.material_id === \+eff\.board_material_id\s*\n\s*\? parent : \{ sheet_l: mat\.sheet_l, sheet_w: mat\.sheet_w \}/,
    'planned board cuts from its trimmed parent, a substitute from its own sheet');
  assert.match(arm, /Leftover strip does not match the cut plan for/,
    'a stale pick on the planned board is refused');
  assert.match(arm, /Nothing bankable on/,
    'and a member asked to bank that leaves nothing is refused, not silently dropped');
});

test('a member\'s quoted parents use the LOCK\'s wastage rule, not its own', () => {
  // The run prints once, so the allowance is the LEAD member's alone.
  // memberParentSheets reads each member's stored wastage and over-quotes a
  // non-lead member by ~100 parents — a strip count the lock contradicts.
  const block = slice(gangs, "if (gang?.kind === 'gang' && gang?.layout_mode !== 'shared')", 3000);
  assert.match(block, /const w = i === 0 \? \(Number\(e\.member\.wastage_sheets\) \|\| 0\) : 0/);
  assert.match(block, /est_parents: estParents/);
  assert.doesNotMatch(block, /est_parents: memberParentSheets/);
});

test('a member draws its boards from the STORED mix, not a re-derivation', () => {
  const arm = slice(planRoute, '// ── A SEPARATE-LAYOUT gang banks PER MEMBER', 6200);
  assert.match(arm, /const rows = wantsMix \? await mixFor\(line\.id, 'plan', qc\) : \[\]/,
    'the split share replaceMixPlan just wrote — so the bank cannot disagree with the cut');
});

test('re-deriving a member of a separate gang sweeps its own line bank', () => {
  const fn = slice(gangs, 'async function reDeriveMemberSheets', 6000);
  assert.match(fn, /\} else \{[\s\S]{0,600}?unbankPlanningLeftover\(line\.id[\s\S]{0,300}?leftover_plan=NULL/,
    'the run-level branch has an else for the member-level bank');
});

test('the confirm settles a separate gang per member, per board', () => {
  assert.match(confirm, /distributeActualAcrossMembers\(\s*\n?\s*stQtyIn, memberPlans\.map/,
    'the card\'s actual parents split across members by their planned share');
  assert.match(confirm, /distributeActualAcrossMembers\(\s*\n?\s*shares\[mi\] \|\| 0, rows\.map/,
    'and again across the boards that member drew from');
  assert.match(confirm, /`LO-\$\{jcForLeftover\.jc_number\}-\$\{m\.id\}-\$\{row\.material_id\}`/,
    'the confirmed key carries the LINE — two members can share one board');
  assert.match(confirm, /if \(already\) continue;/, 'idempotent on a retried complete');
  assert.match(confirm, /if \(!\(Number\(pb\.initial_qty\) > 0 \|\| Number\(pb\.qty\) > 0\)\) continue;/,
    'a swept bank is not resurrected');
});

test('the per-member card measures on each member\'s own geometry', () => {
  assert.match(planning, /const gangLoMembers = gangView\?\.mix\?\.leftover_members \|\| \[\]/);
  assert.match(planning,
    /clientStrips\(m\.parent_l, m\.parent_w, m\.child_l, m\.child_w\)/,
    'per member, never the lead\'s');
  assert.match(planning, /leftovers: gangLoMemberStrips\.map\(m => \{/,
    'and every member is named in the payload, including the ones turned off');
});
