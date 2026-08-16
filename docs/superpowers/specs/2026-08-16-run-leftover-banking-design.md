# Bank to Leftover RM for combined runs and shared-layout gangs

**Date:** 2026-08-16
**Base:** `origin/main@785474ee`
**Migration:** none

## The problem

"Bank to Leftover RM on lock" — the planner's decision to keep a cut plan's offcut strip as
warehouse stock — reaches only part of the plant.

| | plain planned board | with a board mix |
|---|---|---|
| Single order line | Leftover card → `bankPlanningLeftover` | per-row chips → `mix_leftovers` |
| **Combined (merge) run** | **nothing** — and `gangs.js`'s `else if` arm actively *sweeps* any bank | per-row chips → `bankRunLeftover` |
| **Gang run** | **nothing** | **nothing** |

Two consequences on the floor:

1. A combined run planned the ordinary way — one product, one board, no substitute — has no way
   to bank its offcut at all. The option appears only as a side effect of opening a Board Mix,
   and re-locking without a mix takes back a strip an earlier mixed lock had banked.
2. A gang run never banks. That was deliberate: `gangs.js`, `production.js` and `Planning.jsx`
   each carry the same note — *"its parent card can carry mixed child layouts, so its offcut has
   no product identity until the die-cut split."*

That reasoning is sound for `layout_mode='separate'`, where every member cuts its own imposition
off the shared pile and the parent therefore has N different offcuts. It does **not** hold for
`layout_mode='shared'`: `sharedLayoutState` already refuses members with different child sizes, so
the run has one child, one `childFit`, one strip — exactly as well defined as a merge run's.

Anik confirmed the plant reality: the guillotine trims the strip off each parent sheet as it is
cut, so a shared gang's offcut reaches the leftover rack at cutting, the same as any single job.
It does not wait for the die-cut split.

## Scope

**In:**

- Combined (merge) runs bank without a mix.
- Shared-layout gang runs bank, with or without a mix.
- Cutting-complete confirms both.
- Every path that invalidates a run's strip geometry takes the bank back.

- **Separate-layout gang runs, per member** (added on Anik's instruction after the first wave
  shipped — see "Wave 2" below).

**Out:**

- Any change to the single-line paths. They are the reference implementation, not the subject.

## Design

### 1. One predicate, one spelling

```js
// gangs.js, exported
export function runBanksLeftover(gang) {
  return gang?.kind === 'merge'
      || (gang?.kind === 'gang' && gang?.layout_mode === 'shared');
}
```

`production.js` imports it rather than re-spelling the condition. Five call sites read this one
function; a sixth inline copy is exactly how the gang anchor drifted before.

`kind === 'merge'` short-circuits on purpose. The plan route records that a merge converted before
`convert-to-merge` began stamping `layout_mode='separate'` still carries a stale `'shared'` —
**the kind is the truth, the layout_mode is a leftover.** Reading `layout_mode` first would change
nothing for a merge today and would be wrong the moment the stale value matters.

### 2. The strip basis: hoisted, and returned to the client

The lock and the screen must measure the same cut. The basis is decided once, inside the branch
that already computed the run's fit:

- **shared gang** — the shared board's **own mother sheet** paired with the **locked child**: the
  same `(board, child)` that `childFit(board, child)` used. Never `effectiveParent`. A member's
  solo parent trim describes how that product cuts when planned alone; the co-printed layout is
  its own geometry. CI-GANG-0010 paid for that lesson — a lead member's 23×36 solo trim priced the
  run at 1,200 parent sheets where the shared 25×36 board cuts 600.
- **merge run** — `effectiveParent(plan[0].eff, board)` with `plan[0].eff` as the child. This is
  today's `runParent`, unchanged; a merge is one product by construction.
- **separate gang** — none. Not eligible.

The run detail returns that exact parent and child. The client renders its strip list from them
with `clientStrips` (`client/src/lib/cutFit.js`, the twin pinned to `leftoverStrips` by the
parity assertion in `cut-sizing.test.js`). This is the fix the leftover-strip-parent wave paid
for: the card must never describe a cut different from the one the lock banks, or ticking the box
409s.

### 3. A no-mix bank arm on `POST /gang-runs/:id/plan`

New payload field, the single line's own shape:

```json
{ "leftover": { "push": true, "strip": { "l": 20, "w": 13.5 } } }
```

For an eligible run with no mix, the arm:

1. derives `leftoverStrips(basis.parent, basis.child)`;
2. refuses a strip that does not match with 409 — same sentence as `orders.js`:
   *"Leftover strip does not match this board's cut plan"*;
3. banks `strips_per_parent × issuedTotal` on the run's planned board via `bankRunLeftover`.

`issuedTotal` — the run's total parent sheets after any issue override — is the same figure the
mix arm balances against, so the bank is priced on what will actually be cut.

The existing sweep at the `else if` becomes bank-or-sweep. It keeps its draft exemption verbatim:
a draft that says nothing about the mix must not sweep a bank that mirrors the mix it deliberately
withheld.

**Absent-key rule.** `leftover` absent on a lock means no bank — sweep. Absent on a draft that also
withheld its mix preserves what is banked. This mirrors `!draft || Array.isArray(req.body.mix)`,
the rule both engines already use for what saying nothing means, rather than inventing a third.

### 4. The mix arm widens

`if (isMerge)` → `if (eligible)`. Nothing else changes. A gang's mix rows carry no chosen `ups`
(the differing-cuts 409 still stands for a gang), so a row's cuts are its natural fit and
`chosenStrips(parent, child, naturalCount)` collapses to `leftoverStrips(parent, child)`. The
planned row measures on the run basis; a substitute measures on its own mother sheet — the same
`runRowParentFor` asymmetry the chosen-cuts validation already uses, so cuts and strips can never
disagree about which sheet they are talking about.

Without this a shared gang could bank until the planner covered a shortage with a second board,
and then silently could not — the same hole being closed for merge.

### 5. Guard rails: taking the bank back

A banked strip is live warehouse stock from the moment of the lock. Anything that changes the
geometry it was measured on must take it back.

`/gang-runs/:id/board`, `/gang-runs/:id/shared` and `/gang-runs/:id/lines/:lineId` all funnel
through `reDeriveMemberSheets`, which already unbanks — gated `kind === 'merge'`. Widening that
single gate to the predicate covers board reassignment, shared child-size edits and per-member
qty/ups edits at one site.

`/gang-runs/:id/layout` is the gap: it changes `layout_mode` and does **not** call
`reDeriveMemberSheets`, so flipping a shared gang to separate would strand a live bank on a run
that is no longer allowed to hold one. It gains an unbank on an actual change. (separate→shared
has nothing banked, so the call is a no-op there.)

Reverse plan, plan discard, remove-line, add-lines and dissolve already call `unbankRunLeftover`
unconditionally by run id. They needed no change — they were written as no-ops for gangs and
simply start doing real work.

### 6. Cutting-complete confirms

`production.js` books the planned bank up to the **actual** parents cut and renames
`LO-PLAN-RUN-<run>-<mat>` → `LO-<jc>-<mat>`. Two changes:

- The gate `leftoverRunKind !== 'merge'` reads the predicate instead, off `kind, layout_mode`.
- **A no-mix fallback.** The merge arm finds `actualParents` from the per-board variance rows, else
  from the aggregated mix rows. With no mix there are neither, so `actualParents` is null and the
  loop `continue`s — the bank would sit unconfirmed forever. For the run's planned board with no
  mix, the card's own actual parents (`stQtyIn`, already computed from the true parents cut) is
  that figure.

The three-way contract is unchanged: already confirmed → idempotent no-op; live plan batch →
true-up by delta + rename; swept batch (`initial_qty` and `qty` both zero) → skip, because
confirming it would resurrect stock the planner sent to waste.

### 7. Client

The run engine gains the Leftover card the single-line engine has — same copy, same 3" waste rule,
same "Pick which strip to keep" nudge — rendered when the run is eligible and its live cut leaves a
usable strip. It sends `leftover` on both save and lock.

The per-row chips in `BoardMix` widen from `gangIsMerge` to the same eligibility.

A separate-layout gang renders one line in place of the card: its parent carries mixed child
layouts, so the offcut has no single size until die cutting splits it.

### 8. No migration

`gang_runs` gains no `leftover_plan` column. The `LO-PLAN-RUN-…` batches are the record, which is
why `unbankRunLeftover` zeroes `initial_qty` as well as `qty` — a swept row must read as dead to
both consumers of that record (the toggle seed and the cutting confirm).

## Testing

**Pure units** — `runBanksLeftover` across the four kind/layout combinations including the stale
`merge` + `'shared'` pair; the strip basis for a shared gang resolving to the board's own sheet and
not the lead member's trim.

**Route tests** — merge no-mix bank and its round trip; shared gang bank with and without a mix;
separate gang refused when `leftover.push` arrives; a strip that does not match the cut 409s;
re-lock with the box cleared sweeps; `/layout` flip sweeps; `/board` change sweeps through
`reDeriveMemberSheets`.

**Cutting-complete** — a no-mix run card trues its planned bank to the actual parents cut and
renames it; a second complete is idempotent; a swept bank is not resurrected.

**Regression** — the existing merge-with-mix path stays byte-identical in behaviour, and a
separate-layout gang still banks nothing anywhere.

## What the build changed about this design

Five things the design did not anticipate, found while implementing and verifying:

1. **The mix chip only ever offered a REDUCED cut.** `BoardMix`'s `stripInfoFor` returns null
   unless the planner has turned a row's cuts *below* the board's ceiling — deliberate for a single
   line, whose natural-cut strip belongs to its own Leftover card. A gang's cuts are derived and so
   are never reduced, so widening the server's mix arm alone would have banked nothing. `BoardMix`
   gained a `runLeftover` prop that lifts that rule and supplies the run's basis; a line passes
   neither and behaves identically.

2. **The card stands down once the mix has rows.** Both would otherwise write the same batch key.
   The server already routes a mixed save to the per-row bank and never reads `leftover`, so the
   screen matches it — the same split `orders.js` makes with `storedLeftover = wantsMix ? null : …`.

3. **The cutting confirm could not reach a gang.** The aggregated `mixRows` it reads is built only
   for merge cards; a gang's cutting variance is deliberately legacy. Rather than widen that (which
   would rewrite the completion contract for every gang), the confirm sums the members' own rows for
   this booking alone, landing on the same fallback rung a merge already uses.

4. **The Warehouse named a run bank wrong.** The From column hard-coded
   ``` `line ${batch_no.replace('LO-PLAN-','')}` ```, printing `line RUN-8-1`. Run banks were rare
   enough to hide it; they are now the common row. Replaced by `leftoverSourceLabel` in
   `client/src/lib/leftoverSource.js` (pure, tested), with the API resolving the run's real number.
   The column also had no `export:`, so it exported blank — added.

5. **The basis shipped the whole board row.** `effectiveParent` spreads the material, so a merge's
   basis carried the board's rates and reorder levels to the browser. Narrowed to the two dimensions
   every consumer actually reads.

## Wave 2 — the separate-layout gang, per member

The first wave left a separate-layout gang refused, on the grounds that one parent card stands for
N impositions and therefore no single strip. That is true of the RUN, and false of its members:
each member's offcut is exactly the strip it would leave planned alone. So the decision moves down
a level — one per member — and the run level is simply not where it lives.

**No new storage.** A separate gang's member IS a line being cut on its own terms, so it banks
through the line's own v2 machinery: batch `LO-PLAN-<lineId>-<materialId>`, record `leftover_plan`
on the member's row. That means `unbankPlanningLeftover`, the reverse-plan path (which already
sweeps each member's line bank) and the warehouse's own reading of a line bank all work unchanged.
`runBanksLeftover` keeps its meaning — *banks at RUN level* — and the per-member path sits beside
it rather than widening it.

**Payload** `leftovers: [{ line_id, push, strip }]`, one entry per member, including the ones turned
off: silence would leave the previous lock's strip on the shelf.

**Which boards a member draws** comes from its stored mix rows (the waterfall share `replaceMixPlan`
just wrote), else its whole issue off its own planned board. Reading the stored split rather than
re-deriving it means the bank cannot disagree with what the floor will cut. The planner's tick is
per member, not per board: the planned board must yield the strip they picked (409 otherwise),
while a substitute banks whatever it actually leaves — geometry the planner never saw and cannot
sensibly be asked about. A board that leaves nothing usable is skipped; a member that leaves
nothing anywhere is refused rather than silently dropped.

**The confirm** splits the card's true parents cut across members by their planned share
(`distributeActualAcrossMembers`, the same helper the mixed true-up uses), then across each
member's boards by planned sheets. Confirmed keys carry the LINE as well as the board —
`LO-<jc>-<lineId>-<materialId>` — because two members of one run can sit on the same board and
would otherwise collide, silently confirming one and dropping the other.

**Known limitation, pre-existing and deliberately not touched.** A gang parent card derives its
"true parents cut" from children-out ÷ the LEAD member's cuts. On a separate-layout gang whose
members have different impositions that single figure is an approximation — and every member's
leftover share rides on it, exactly as board consumption already does. Making it exact means
reporting children per member at the cutting station, which is its own change to the completion
contract. The leftover confirm deliberately uses the same figure as everything else rather than
inventing a second, more precise one that would disagree with the board ledger.

## Verification

- **2,062 server tests green** (2,015 before the wave), including 13 pure basis/predicate tests and
  27 wiring tests.
- **70 E2E assertions** against the real routes on a private Postgres (own port 5461, never the
  shared 5439), in three suites:
  - *run-level* (29): bank / stale-strip 409 / sweep on clear / sweep on layout flip /
    combined-run bank / sweep on spec edit.
  - *cutting confirm* (11): a 3,400-sheet planned bank trued to the 3,300 parents actually cut,
    renamed `LO-CI-GANG-JC-0004-1`, idempotent on a repeated completion.
  - *per-member* (30): two members with genuinely different impositions (12×20 → 36×5", 14×22 →
    22×8") bank two DIFFERENT leftover masters at their own quantities; one member toggled off
    sweeps only its own; a member given another member's strip 409s by name; and at cutting both
    confirm to `LO-<jc>-<lineId>-<board>` with the two shares summing to exactly the parents the
    stage recorded.
- **Driven in the real UI**, both shapes:
  - *co-printed gang* — ticked the box, clicked Lock; the server wrote `LO-PLAN-RUN-8-1` (3,400
    sheets) with a `leftover_planned` audit line, the run reopened with the box seeded on, and the
    strip appears in Warehouse → Leftovers as `CI-GANG-0006`.
  - *separate-layout gang* — the card showed one block per job, job B offering two strips; picked
    B's SMALLER 22×8" rather than the default, ticked both, clicked Lock. The server wrote
    `LO-PLAN-56-1` (36×5", 3,400) and `LO-PLAN-57-1` (22×8", 5,000) — two masters, per-member
    quantities, the planner's non-default pick honoured — and both reopened seeded on.
  - Card states confirmed on screen: co-printed, combined run, per-member, and the one remaining
    explanation (co-printed with no agreed child sheet).
- **A card/lock disagreement found and fixed by driving it**: the per-member card quoted 5,100
  sheets where the lock banked 5,000, because `memberParentSheets` reads each member's own stored
  wastage while the lock books the allowance to the LEAD member alone. The card now runs the lock's
  own arithmetic.

## Risks

- **Stock written on a lock.** Banking creates real available stock before anything is cut. That is
  already true for lines and merges; this widens the surface to shared gangs. The guard rails in §5
  are what keep it honest, and `/layout` is the one genuinely new hole.
- **The stale-`shared` merge.** A merge carrying `layout_mode='shared'` must not be judged by
  layout. Handled by the short-circuit in §1 and asserted in the unit tests.
- **Card/lock disagreement.** The failure mode the leftover-strip-parent wave documented: a screen
  that measures on different geometry than the save produces a 409 the planner cannot explain.
  Handled by §2 returning the basis instead of letting the client re-derive it.
