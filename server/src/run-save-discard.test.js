import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Save and Discard on a MERGE / GANG run — the run-level twins of the single
// line's own pair, added 2026-08-06 on Anik's "the saving and discarding system
// i need in merge and gang products also, like we have in single. logics of
// arithmetic calculations should be same as per single".
//
// These are SOURCE assertions, deliberately. Every claim below is about two files
// agreeing with each other — orders.js's rule for a line and gangs.js's rule for
// a run — and that is a claim a unit test on either one alone cannot make. The
// arithmetic itself is already covered by board-mix / gang-mix / chosen-strips;
// what has no other guard is the PARITY, which is the whole point of the request
// and the thing a later edit to one file would silently break.

const SRC = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(SRC, p), 'utf8');
const gangs = read('routes/gangs.js');
const orders = read('routes/orders.js');
const planning = read('../../client/src/pages/Planning.jsx');

// ── The draft save ──────────────────────────────────────────────────────────

test('a run plan accepts draft: true, and the flag reaches the status flip', () => {
  assert.match(gangs, /const draft = !!req\.body\.draft;/,
    'gangs.js must read `draft` off the run plan payload');
  // The ONE line that makes a draft a draft. Written as the same expression
  // orders.js uses for a line, so the two cannot mean different things by it.
  assert.match(gangs,
    /if \(line\.status === 'pending' && !draft\) await setLineStatus\(line\.id, 'planned'/,
    'the member status flip must be gated on !draft');
  assert.match(orders,
    /if \(line\.status === 'pending' && !draft\) await setLineStatus\(line\.id, 'planned'/,
    'the single-line gate is the shape being mirrored — if this moved, move both');
});

test('a draft does NOT remember the die', () => {
  // rememberDie seeds every FUTURE gang of this product combination. A draft is
  // not the plant deciding a layout, and shared state that outlives the discard
  // which threw the layout away is the one thing a draft must not write.
  assert.match(gangs, /if \(!draft\) await rememberDie\(/,
    'rememberDie must be skipped on a draft');
  // The spec_override child stamp is a DIFFERENT thing and still runs: it is
  // local to these members and is what makes the saved figures re-derivable.
  // If this ever gets wrapped in the same !draft guard, a saved shared-layout
  // run reopens with no agreed sheet and cannot recompute what it just saved.
  const sharedBlock = gangs.slice(gangs.indexOf('const boards = [...new Set(effs.map'));
  const stamp = gangs.slice(0, gangs.indexOf('await rememberDie'));
  assert.match(stamp, /UPDATE order_lines SET spec_override=\$1 WHERE id=\$2/,
    'the adopted child size is still stamped');
  assert.ok(!/if \(!draft\)[^\n]*spec_override/.test(sharedBlock),
    'the spec_override stamp must NOT be gated on !draft');
});

test('the audit trail tells a saved run from a locked one', () => {
  assert.match(gangs, /draft \? 'plan_draft' : 'planned'/,
    "each member's audit must record plan_draft on a save");
  assert.match(gangs, /draft \? 'plan_draft' : 'plan'/,
    "the run's own audit must record plan_draft on a save");
});

// ── The discard ─────────────────────────────────────────────────────────────

test('the run discard route exists, behind the planning guard', () => {
  assert.match(gangs, /r\.post\('\/gang-runs\/:id\/plan\/discard', canPlan,/,
    'the run discard must be POST /gang-runs/:id/plan/discard behind canPlan');
});

test('the run discard guards on the SAME pair as LINE_VIEW.plan_draft', () => {
  const route = gangs.slice(gangs.indexOf("r.post('/gang-runs/:id/plan/discard'"));
  // Half one: nothing locked. `find(l => l.status !== 'pending')` and not
  // `every` — ONE locked member means the run's board is live, and a partial
  // release would strand the rest of it half-held.
  assert.match(route, /lines\.find\(l => l\.status !== 'pending'\)/,
    'a single non-pending member must block the discard');
  assert.match(route, /code: 'RUN_NOT_DRAFT'/);
  // Half two: something actually saved.
  assert.match(route, /lines\.every\(l => l\.parent_sheets_required == null\)/,
    'a run with no written requirement anywhere has nothing to discard');
  assert.match(route, /code: 'RUN_NEVER_SAVED'/);
  // The pair is the one LINE_VIEW computes. If that view's rule ever changes,
  // this assertion is what says the route has to follow it.
  assert.match(orders,
    /\(ol\.status = 'pending' AND ol\.parent_sheets_required IS NOT NULL\) AS plan_draft/,
    'LINE_VIEW.plan_draft is the rule both discards are written against');
});

test('the run discard locks the rows before it reads them', () => {
  const route = gangs.slice(gangs.indexOf("r.post('/gang-runs/:id/plan/discard'"));
  // The guard's whole claim is "every member is still an unlocked draft". A Lock
  // landing concurrently would otherwise be read here as pending and then commit
  // 'planned' underneath us — releasing board a live plan had just claimed.
  assert.match(route, /FROM gang_runs WHERE id=\$1 FOR UPDATE/);
  assert.match(route, /WHERE gang_run_id=\$1 ORDER BY id FOR UPDATE OF order_lines/);
  // FOR UPDATE has to come before the guard, not after it.
  assert.ok(route.indexOf('FOR UPDATE OF order_lines') < route.indexOf("RUN_NOT_DRAFT"),
    'the row lock must precede the draft guard');
});

test('the run discard releases board, sweeps both leftover shapes, and nulls the derived PAIR', () => {
  const route = gangs.slice(gangs.indexOf("r.post('/gang-runs/:id/plan/discard'"));
  assert.match(route, /await clearMixPlan\(line\.id, qc, req\.user\.name, why\)/,
    'the mirrored board_allocations holds must be released per member');
  // Two banks can exist: the RUN-level one a merge lock writes, and per-member
  // LO-PLAN batches a member can still carry from a solo save before it joined.
  assert.match(route, /await unbankRunLeftover\(gang\.id, qc, oc, req\.user\.name, why\)/,
    'the run-level leftover bank must be swept');
  assert.match(route, /await unbankPlanningLeftover\(line\.id, qc, oc, req\.user\.name, why\)/,
    "a member's own leftover bank must be swept too");
  // sheets_required goes with parent_sheets_required, never without it:
  // board-allocation.js reads a requirement as `parent ?? sheets`, so nulling
  // only the parent leaves every reader quoting the CHILD count as parent demand.
  assert.match(route,
    /SET sheets_required=NULL, parent_sheets_required=NULL, leftover_plan=NULL/,
    'both halves of the derived pair must be nulled together');
});

test('the run discard keeps the spec work, and keeps the run together', () => {
  const route = gangs.slice(gangs.indexOf("r.post('/gang-runs/:id/plan/discard'"),
    gangs.indexOf('async function reDeriveMemberSheets'));
  // "Unsave" reverses what the save COMMITTED (board). The spec the planner
  // decided and the remarks they typed are not commitments — a planner who
  // discards a cut plan to redo it wants the engine to reopen pre-filled.
  for (const kept of ['spec_override', 'wastage_sheets', 'notes', 'machine_id', 'planned_date']) {
    assert.ok(!new RegExp(`${kept}\\s*=\\s*NULL`).test(route),
      `${kept} must survive a discard`);
  }
  // gang_runs.issue_parent_sheets is the planner's manual "issue this many",
  // an intent they typed — not board being handed back.
  assert.ok(!/UPDATE gang_runs SET issue_parent_sheets/.test(route),
    "the run's manual issue figure must survive a discard");
  // And the run itself: discard is not Dissolve. Nothing may clear gang_run_id
  // or delete the run.
  assert.ok(!/gang_run_id\s*=\s*NULL/.test(route), 'discard must not un-gang the members');
  assert.ok(!/DELETE FROM gang_runs/.test(route), 'discard must not delete the run');
});

test('the discard names the board it released, per board and not per member', () => {
  const route = gangs.slice(gangs.indexOf("r.post('/gang-runs/:id/plan/discard'"));
  // "Released 2,400 sheets of Saffire 340" is checkable against the warehouse;
  // "plan discarded" is not. Summed across members because the planner typed ONE
  // run-level row per board — the split is an implementation detail they never
  // saw, so reporting it per member hands back a list they cannot reconcile.
  assert.match(route, /const byBoard = new Map\(\)/,
    'the released figures must be grouped by board');
  assert.match(route, /audit\('materials', m\.material_id, 'board_hold_released'/,
    "each board's own timeline must show the release");
  assert.match(route, /audit\('gang_run', gang\.id, 'plan_discarded'/);
});

test('a ganged line still cannot be discarded on its own — and is told where to go', () => {
  // Refusing here is right: releasing one member's share of a pile the others
  // are still counting on would strand the rest. What changed is the ADVICE —
  // it used to say "remove it from the gang first", which was never what the
  // planner wanted, only the one door that existed.
  assert.match(orders, /code: 'PLAN_DISCARD_GANGED'/,
    'the per-line refusal must stay');
  const at = orders.indexOf("code: 'PLAN_DISCARD_GANGED'");
  const msg = orders.slice(at - 700, at);
  assert.match(msg, /Open the run and discard its plan there/,
    'the refusal must point at the run-level discard, not at breaking the run up');
  assert.ok(!/Remove it from the gang first/.test(msg),
    'the old advice must be gone');
});

// ── Arithmetic parity: what a run is told is FREE ────────────────────────────

test('run mix candidates are costed — gross available is never labelled free', () => {
  // The bug this closes, reported on a single line and still live on every run:
  // BoardMix renders `c.free ?? c.available` and labels whichever it gets
  // "free", so a candidate with no `free` set advertises board other jobs have
  // already committed — and Smart Match sizes its proposal off the same figure.
  assert.match(planning, /c\.free \?\? c\.available/,
    'the client still falls back to available — so the server must set free');
  const ctx = gangs.slice(gangs.indexOf('async function gangMixContext'),
    gangs.indexOf('// A line can arrive carrying a board mix'));
  assert.match(ctx, /boardClaimLines\(candIds, members\.map\(m => m\.id\)\)/,
    "candidates must be costed against every OTHER job's claim");
  assert.match(ctx, /c\.free = Math\.max\(0, Math\.round\(Number\(c\.available \|\| 0\) - c\.committed\)\)/,
    'free = available − committed, the same expression orders.js uses');
  // The SAVED rows too: a reopened mix must not read its board as freer than
  // the "+ Add board" list says it is, or one board tells two stories on a screen.
  assert.match(ctx, /boardClaimLines\(rowIds, members\.map\(m => m\.id\)\)/,
    'the saved mix rows must be costed on the same rule');
  assert.match(ctx, /r\.free = Math\.max\(0, Math\.round\(Number\(r\.available \|\| 0\) - r\.committed\)\)/);
});

test("the run's own members are excluded from its free figure", () => {
  // Leave them in and the run's own saved mix reads as competing demand: free
  // collapses toward zero on every save, and the planner is told their own plan
  // has taken the board. Both call sites pass the member ids as the exclude list.
  const ctx = gangs.slice(gangs.indexOf('async function gangMixContext'),
    gangs.indexOf('// A line can arrive carrying a board mix'));
  // The capture stops at the first ')' — which lands inside `m.id)` — so the
  // arrow body, not the whole argument, is what gets compared. That is enough:
  // the claim being made is "the exclude list is the members", and any other
  // expression would not contain this text at all.
  const excludes = [...ctx.matchAll(/boardClaimLines\([^,]+, ([^)]+)/g)].map(m => m[1]);
  assert.equal(excludes.length, 2, 'both the candidates and the saved rows are costed');
  for (const e of excludes) {
    assert.match(e, /members\.map\(m => m\.id/,
      'every claim on a run must exclude the run’s own members');
  }
  // The exclusion works because claimsByBoard sums `committed` off the LINES
  // alone — the allocation list is only ever read per line, by heldFor and
  // incomingFor, which filter it by order_line_id. Filtering the allocations
  // array here would be a no-op; the assertion records WHY none is attempted.
  const alloc = read('board-allocation.js');
  assert.match(alloc, /a\.order_line_id === orderLineId/,
    'heldFor/incomingFor must keep filtering allocations by line');
});

// ── Client parity ───────────────────────────────────────────────────────────

test('Save and Lock send ONE payload, differing only by the draft flag', () => {
  // Two copies of this object is exactly the drift that made the job-card
  // traveler its own component. If a figure is added to Lock and not to Save, a
  // saved plan locks as something other than what was saved.
  assert.match(planning, /const gangPlanPayload = \(\{ draft = false \} = \{\}\) =>/,
    'the run payload must be built in ONE place');
  assert.match(planning, /api\.post\(`\/gang-runs\/\$\{gangView\.id\}\/plan`, gangPlanPayload\(\)\)/,
    'Lock must use the shared builder');
  assert.match(planning,
    /api\.post\(`\/gang-runs\/\$\{gangView\.id\}\/plan`, \{ \.\.\.gangPlanPayload\(\{ draft: true \}\), draft: true \}\)/,
    'Save must use the shared builder and send draft: true');
});

test('a draft with a half-built mix withholds the mix instead of 409ing', () => {
  // The run's plan route enforces runBal.sufficient, so sending an unbalanced
  // mix on a save would refuse the save outright — costing the planner the very
  // mix they were in the middle of building. Same rule savePlan applies to a
  // single line, so a half-built mix behaves identically in both engines.
  assert.match(planning, /\.\.\.\(draft && !gangMixOk \? \{\} : \{/,
    'a draft must omit the mix keys when the mix does not balance');
  assert.match(planning, /\.\.\.\(draft && !mixOk \? \{\} : \{/,
    'the single-line rule is the shape being mirrored');
});

test('and the withheld mix actually SURVIVES — the run must not clear it', () => {
  // The other half of the rule above, and the half that was missing: withholding
  // only protects the stored mix if the route then leaves it alone.
  //
  // A single line is safe by construction — orders.js touches job_board_mix only
  // inside `if (rows.length) {...} else if (!draft || Array.isArray(req.body.mix))`.
  // The run's plan route clears per member in its PERSIST loop, which runs before
  // the payload's mix is read at all, so withholding deleted the very rows it was
  // meant to save. Measured on a live run: 417 sheets stored, Save with the mix
  // withheld, 0 rows left — "save my work" cost the planner their mix.
  const persist = gangs.slice(gangs.indexOf('// 3) Persist.'),
    gangs.indexOf("// 4) The run's board mix"));
  assert.match(persist, /if \(!draft \|\| Array\.isArray\(req\.body\.mix\)\) \{\s*\n\s*await clearMixPlan\(line\.id/,
    "the persist loop must not clear a draft's mix when the payload withheld it");
  // Written as the SAME condition orders.js uses, so the two engines cannot come
  // to mean different things by "the caller said nothing about the mix".
  assert.match(orders, /\} else if \(!draft \|\| Array\.isArray\(req\.body\.mix\)\) \{/,
    'the single-line condition is the shape being mirrored — if it moves, move both');
  // An EMPTIED mix is a real instruction to clear, and still is: `[]` is an
  // array, so it passes the guard on both sides.

  // The run-level leftover bank mirrors those same rows, so it takes the same
  // exemption — sweeping it would hand back the planned offcut of a mix that is
  // deliberately still standing.
  assert.match(gangs,
    /\} else if \(gang\.kind === 'merge' && \(!draft \|\| Array\.isArray\(req\.body\.mix\)\)\) \{/,
    "the no-mix leftover sweep must skip a draft that withheld its mix");
});

test('Save is offered only on a wholly-pending run; Discard only on a saved one', () => {
  // One locked member means the run's board is already live: a draft there would
  // write figures without un-locking anything, a click with no visible effect.
  // Reverse Plan is that run's door, and it is already in the footer.
  assert.match(planning,
    /const gangEveryPending = !!gangView\?\.members\?\.length\s*\n\s*&& gangView\.members\.every\(m => m\.status === 'pending'\)/,
    'gangEveryPending must require EVERY member pending');
  assert.match(planning,
    /const gangDraft = gangEveryPending\s*\n\s*&& gangView\.members\.some\(m => m\.parent_sheets_required != null\)/,
    'gangDraft is gangEveryPending AND some member carrying a requirement');
  assert.match(planning, /gangView && gangEveryPending && \(\s*\n\s*<Button variant="secondary" onClick=\{saveGangPlan\}/,
    'Save is gated on gangEveryPending');
  assert.match(planning, /gangView && gangDraft && \(\s*\n\s*<Button variant="danger"/,
    'Discard is gated on gangDraft');
  // Save must NOT be gated on the mix balancing — an unbalanced mix is the state
  // a planner most wants to come back to (the payload withholds it instead).
  const saveBtn = planning.slice(planning.indexOf('onClick={saveGangPlan}'));
  const disabled = saveBtn.slice(saveBtn.indexOf('disabled='), saveBtn.indexOf('title='));
  assert.ok(!/gangMixOk/.test(disabled),
    'Save must not be disabled on an unbalanced mix — parity with the single engine');
});

test('the run row wears the saved badge only when the WHOLE run is saved', () => {
  // No route can save half a run, so a mixed row must not claim run-level saved.
  // But the filter chip counts any member (rowDraft), so a row matching "Saved"
  // with nothing on it to say why reads as a bug in the filter — hence the count.
  assert.match(planning,
    /if \(sts\.length === 1 && sts\[0\] === 'pending' && savedN\) return \(/,
    'the run badge needs one status, pending, and something saved');
  assert.match(planning, /\{savedN\} of \{l\._gang\.length\} saved/,
    'a partly-saved run must say so rather than showing nothing');
  // The stale claim this replaced said gangs.js "never reads `draft`". It does now.
  assert.ok(!/the run has no draft save of its\s*\n?\s*\/\/ own/.test(planning),
    'the comment denying a run-level draft must be gone');
});
