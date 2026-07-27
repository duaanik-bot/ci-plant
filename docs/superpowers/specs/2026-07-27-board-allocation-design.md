# Board allocation — hold, move, and re-point board from the PR row

Date: 2026-07-27
Status: approved design, not yet implemented

## The problem

A purchase requisition tells you a board is short. It does not tell you whether
that board is already sitting in the warehouse, who is waiting for it, or
whether the job in front of you deserves it more than the job that currently
has it.

Today "committed" is not a record — it is a live SUM. `committed_other` in the
planning engine adds up `parent_sheets_required` across every *other* order line
in `planned`/`ready` whose effective board resolves to the same material
(`server/src/routes/orders.js:1037`). Nobody holds anything. Whichever job
reaches cutting first consumes the pile, and the planner discovers the loss when
a later job comes up short.

So there is no object to edit. "Uncommit this board from NICOSTAR and give it to
ACEBROBID" has nothing to act on. That missing object is what this design adds.

A second gap blocks the same feature: `requisitions.order_line_id` exists in the
schema (`server/src/db.js:774`) but the planning engine never populates it —
`raisePrInline` posts only `material_id`, `qty`, `needed_by`, `reason`
(`client/src/pages/Planning.jsx:655`). A PR's link to its job is a free-text
reason string. Nothing can be re-pointed until that wire is connected.

## Decisions

Settled with the plant owner before design:

| Question | Decision |
|---|---|
| What happens to the job that loses the board? | A new PR is auto-raised for it |
| How much can move? | Defaults to the whole job, editable to any quantity |
| Does the original PR shrink? | Yes — by exactly what stock now covers. Net board purchased is unchanged |
| Does a hold stop the floor? | Warn with an audited override, never hard-block |
| Where does "re-point this PR" live? | Same panel as the stock moves |
| Does the Planning Engine get this? | Yes — full move capability, same panel |

The governing promise, shown on screen for every move: **nothing extra is
bought.** A move is a reshuffle of who waits, not an increase in spend.

## Data model

One new table. Idempotent, created after `materials`, `order_lines` and
`requisitions` exist.

```sql
CREATE TABLE IF NOT EXISTS board_allocations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  qty             DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  source          TEXT NOT NULL CHECK (source IN ('stock','requisition')),
  requisition_id  INTEGER REFERENCES requisitions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','released','consumed')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by     TEXT,
  released_at     TIMESTAMPTZ,
  release_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_alloc_material ON board_allocations (material_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_alloc_line     ON board_allocations (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_alloc_requisition ON board_allocations (requisition_id);
```

Quantities are in **parent (mother) sheets** — the unit the warehouse stocks and
every Available column already reports. This matches
`COALESCE(ol.parent_sheets_required, ol.sheets_required)` used throughout.

Two kinds of row:

- `source='stock'` — N sheets of on-hand board held for one job.
- `source='requisition'` — N sheets of an *incoming* PR earmarked for one job.
  `requisition_id` is required for this kind.

`requisitions.order_line_id` stays as the PR's primary owner. A
`source='requisition'` allocation is what lets one PR be split across several
jobs later; for now the common case is one PR, one job, one allocation.

Allocations are for boards only — every write asserts
`materials.category = 'board'`. Consumables and inks have no order-line demand
to compete over.

No table is dropped and no existing column changes type. The feature is purely
additive.

### PRs and allocations mirror each other

An open PR carrying an `order_line_id` always has a matching
`source='requisition'` allocation of the same quantity. The two move together:

- raising a PR with an `order_line_id` creates the allocation
- changing a PR's quantity changes the allocation
- closing, rejecting or deleting a PR releases it
- converting a PR to a PO leaves it in place (the material is still incoming)
- **QC-accepting a GRN shrinks it by the quantity received**, because that board
  is now counted in `available`

This is what makes the job stop showing short the moment its PR exists. Without
it, the auto-raised PR for NICOSTAR would be invisible to the engine and
NICOSTAR would still read `short 20,000` right after the move — the single
most confusing outcome this feature could produce.

The GRN rule was missing from the first draft of this design and was found by
adversarial review of the math module. Without it a job is credited twice for
the same board — once as stock on hand, once as still incoming — a permanent
under-buy that compounds with every received board PR. Reducing rather than
releasing is deliberate: on a partial delivery the undelivered balance is
genuinely still incoming.

The mirror lives in route code against the database, and this repo's test runner
(`node --test src/*.test.js`) covers pure modules only — there is no integration
harness to assert it automatically. It is therefore verified by hand against the
local database at each transition, and the plan spells out the exact `psql`
checks. The user-visible consequence — a job reading `short 0` rather than
`short q` immediately after a move — is the acceptance test.

### The line being planned is not in the planned set

`order_lines.status` only becomes `planned` at the END of the plan-save
transaction (`orders.js:1005`). While the Planning Engine is open on a line for
the first time, that line is still `pending`, so a query filtering
`status IN ('planned','ready')` does not return it.

Every caller therefore passes the line being planned **explicitly**, separately
from the competing set — mirroring the `AND ol.id != $2` that the production
formula has always used. `linePosition` throws when that argument is missing
rather than defaulting the planner's own requirement to zero.

This too was found by review. The first draft looked the line up inside the
planned/ready set and silently returned `need: 0, short: 0` when it was absent,
which would have under-bought a job's entire board requirement on the first
plan of every order line.

## The math

Lives in a new pure module `server/src/board-allocation.js` — no database
handles, no `await`. Route code loads rows and hands them in. This is the piece
that decides real purchase quantities, so it must be testable without a plant.

For a board `M`:

```
available = SUM(stock_batches.qty WHERE material_id=M AND status='available')
held      = SUM(board_allocations.qty WHERE material_id=M AND source='stock' AND status='active')
free      = available − held
```

For an order line `L` on board `M`:

```
need            = COALESCE(L.parent_sheets_required, L.sheets_required)
held_for_me     = SUM(active stock allocations for L)
incoming_for_me = SUM(active requisition allocations for L)
my_open_need    = max(0, need − held_for_me − incoming_for_me)

others_open_need = Σ over other planned/ready lines K on M of
                     max(0, need(K) − held_for(K) − incoming_for(K))

net   = free − my_open_need − others_open_need
short = max(0, −net)
```

### Why this is safe to put in front of a live plant

With an empty `board_allocations` table:

- `held = 0`, so `free = available`
- `held_for_me = incoming_for_me = 0`, so `my_open_need = need`
- likewise `others_open_need = Σ need(K)` = today's `committed_other`

which gives `net = available − need − committed_other` — character for character
the formula running today at `orders.js:1037`. The new engine is a strict
generalisation that collapses onto the current one until somebody makes a move.

`server/src/board-allocation.test.js` asserts this as an explicit property test:
for a spread of board positions, the new function and a literal transcription of
the old formula must return identical `net` and `short` when no allocations
exist. If that test fails, nothing ships.

### Board identity

Every query resolving a line's board must use the existing effective-board
expression, so a warehouse pick made in the planning engine
(`spec_override.board_material_id`) wins over the product master:

```js
const EFF_BOARD_ID = `COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)`;
```

It is currently duplicated in `orders.js:22` and `gangs.js:20`. This wave adds a
third consumer, so it moves to `server/src/helpers.js` and all three import it.
That is the only refactor in scope.

## The move

The user story is "move 20,000 sheets from NICOSTAR to ACEBROBID". The
implementation is simpler than the story, and deliberately so:

1. **Create** a `source='stock'` allocation of 20,000 for ACEBROBID.
2. NICOSTAR gets **no allocation row at all**. It had none before — its claim was
   implicit. Holding stock for ACEBROBID raises NICOSTAR's `open_need` by
   exactly 20,000, which is what makes it short.
3. **Auto-raise** a PR for NICOSTAR for 20,000, with `order_line_id` set and a
   reason naming the move.
4. **Reduce** ACEBROBID's linked open PR by 20,000, and its mirrored allocation
   with it. If it reaches zero the PR is closed with a reason rather than
   deleted, so the register keeps the history.

If ACEBROBID has more than one open PR on this board — possible via the
duplicate-PR re-raise flow — they are reduced oldest first until the quantity is
absorbed.

**The receiving job cannot be held more board than it needs.** The move quantity
is capped at `need − held_for_me` for the target line. Note this deliberately
does *not* subtract `incoming_for_me`: cancelling the incoming PR is the whole
point of the move, so an already-ordered quantity must not block it.

That cap is what keeps the zero-net-purchase promise exact. Because the target's
open PRs always total at least `need − held_for_me` (the mirror rule guarantees
it), the reduction can always absorb the full moved quantity, so the PR raised
for the losing job and the PR reduction on the receiving job are equal by
construction. There is no rounding case and no leftover to explain.

The "from" side needs no row unless it already had one, in which case that row is
reduced (and released at zero) before step 1. Net board on order is unchanged by
construction: one PR falls by *q*, another rises by *q*.

### Preview

`POST /board/move/preview` runs the same pure function as the commit and returns
the plain-English consequences. The confirm dialog renders exactly what the
server returns — the "what will happen" box cannot drift from what happens.

```json
{
  "ok": true,
  "effects": [
    { "kind": "hold",     "text": "ACEBROBID takes 20,000 sheets from the warehouse" },
    { "kind": "pr_down",  "text": "CI-PR-0006 drops 41,742 → 21,742", "requisition_id": 6 },
    { "kind": "pr_new",   "text": "NICOSTAR gets a new PR for 20,000 sheets" }
  ],
  "net_purchase_delta": 0,
  "blockers": []
}
```

`net_purchase_delta` is asserted to be `0` in tests and rendered as the closing
line of the dialog.

### Commit

`POST /board/move` takes `{ material_id, from_order_line_id, to_order_line_id,
qty, reason }`. A reason is mandatory. The whole thing runs in one `tx()`,
re-reading and locking both lines and any linked PRs with `FOR UPDATE`, and
re-running the preview server-side — a stale client preview must not be trusted.

Audit rows (`audit(entity, entityId, action, detail, qc, req.user.name)`) are
written against: `materials`, both `order_lines`, and both `requisitions`, so the
move surfaces in the universal timeline drawer and in Masters 360 for the board
without any extra wiring.

### Re-pointing a PR

`POST /requisitions/:id/reassign` with `{ order_line_id, reason }` moves the
incoming material to a different job: updates `requisitions.order_line_id`, moves
any `source='requisition'` allocations to the new line, and audits both sides. It
refuses once the PR is `converted` — at that point the PO and its GRN own the
material, and re-pointing is a different problem.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/board/:materialId/panel` | Everything the panel renders: available, held, free, this PR's job, and the committed job list |
| POST | `/board/move/preview` | Consequences of a proposed move, no writes |
| POST | `/board/move` | Perform the move |
| POST | `/board/allocations/:id/release` | Give a hold back to the free pool, with reason |
| POST | `/requisitions/:id/reassign` | Re-point an unconverted PR to a different job |

All mutations require the existing `planner` role (`requireRole('planner')`,
matching `canBuy`/`canPlan`).

`GET /inventory/demand/:materialId` already returns the committed job list with
PO number, customer, product and planned date (`inventory.js:52`). It gains the
held/free split rather than being replaced, so the Masters 360 drawer that
consumes it today keeps working.

## UI

One shared component, `client/src/components/BoardCommitments.jsx`, used from
three places so they cannot disagree:

**Procurement → Requisitions.** A new line under the item name on the PR row:
`26,000 in warehouse · all of it committed to 2 jobs`, tinted amber when free
stock is zero. Clicking opens the panel. For a single-line PR the number is that
material's; for a multi-line PR the row keeps its `+N more` badge and the panel
lists each material separately.

**The panel.** Three metric tiles (In warehouse / Committed / Free), then "This
PR is buying for <job>" with a change link, then the committed job list with a
`Move to this PR` button per row.

**The dialog.** Quantity pre-filled with the whole job and editable, the
server-computed "what will happen" list, the "nothing extra is bought" line, and
a mandatory reason.

**Planning Engine.** The existing board position box gains Free alongside
Available and Committed, and the `Short N parent sheets` banner gets a second
button — `Take board from another job` — opening the same panel. Catching the
shortage here often avoids raising the PR at all.

`Planning.jsx` also starts sending `order_line_id: planLine.id` when raising a
PR. This is the first change in the build order because nothing downstream works
without it.

**Existing PRs.** PRs raised before this wave have no `order_line_id` and their
job is only recoverable from reason text. Rather than guess, the panel shows a
one-time `Which job is this PR for?` picker, filtered to open lines on that
board. CI-PR-0006 is in exactly this state.

## Floor behaviour

Board is issued at first-stage start —
`consumeFifo(eff.board_material_id, jc.sheets_issued, 'job_card', ...)` inside
`POST /job-stages/:id/start` (`production.js:511`).

Before that call: if active holds on this board belong to *other* lines and the
issue would eat into them, return a structured 409 the client turns into an
amber confirm — `these 20,000 are held for ACEBROBID — continue?`. Re-submitting
with `confirm_allocation: true` proceeds and writes an
`allocation_override_ack` audit row against the job card.

This follows the acknowledgement pattern already in the same handler for shade
cards (`production.js:460`) and for the strength-mixup alarm
(`production.js:612`). Cutting is never hard-blocked — consistent with
`adjustBoardStock`, which lets board go negative rather than stop the floor
(`helpers.js:252`).

When a held line's own job card consumes its board, its allocations move to
`status='consumed'` and stop counting against `free`.

## Gang runs

A gang shares one board across several jobs and raises a single combined PR
(`POST /gang-runs/:id/raise-pr`). In the panel, gang members appear as the one
violet row they are everywhere else in the app, and `Move to this PR` is disabled
with a plain reason: *prints in gang CI-G-0012 — move the gang's board from
Planning*. Unpicking a gang's shared board mid-move is a separate piece of work
and is out of scope here.

## Database change procedure

Per `CLAUDE.md` and `DEPLOYMENT.md` §3:

1. Add the table and indexes to `init()` in `server/src/db.js`, ordered after
   `materials`, `order_lines` and `requisitions`.
2. `npm run db:baseline` to regenerate `supabase/migrations/0001_baseline_schema.sql`.
3. Add `supabase/migrations/0005_board_allocations.sql` as the named production
   migration. (0002–0004 are already applied.)
4. `npm run db:check -- --baseline` to prove the baseline replays into an empty
   database.
5. `npm run db:check` against Supabase `colour-impressions-prod` **before**
   deploying — production holds real orders that local does not, and a prior
   wave shipped code for three columns production lacked.

## Build order

Steps 1–4 change what the plant can *see* and nothing about what it *does*. They
are independently shippable. Behaviour changes at step 5.

1. Wire `order_line_id` onto new PRs; add the one-time picker for old ones.
2. `board-allocation.js` + `board-allocation.test.js`, including the
   collapses-to-today property test. No callers yet.
3. `board_allocations` table, migration, baseline, `db:check`.
4. Read-only panel in all three screens: held/free shown, no moves possible.
5. Move preview + commit, wired to the dialog.
6. PR shrink and auto-raise.
7. Floor warning at `/job-stages/:id/start`.

## Tests

- **Property:** new math ≡ old math when `board_allocations` is empty. Non-negotiable.
- **Conservation:** every move preview returns `net_purchase_delta === 0`.
- **No-still-short:** immediately after a move, the losing job reads short 0,
  not short *q*. This is the mirror rule's user-visible consequence and the
  acceptance test for it.
- **Consumed holds:** once a job's own card consumes its board, its hold stops
  counting against `free`. Without this, `free` drifts permanently low and every
  later job on that board reads short.

Manual checks (no integration harness exists — see the mirror section):

- an open PR with an `order_line_id` has an equal `source='requisition'`
  allocation after raise, quantity change, close, reject, delete and PO
  conversion.
- **Partial move:** 20,000 of 41,742 leaves the receiving job part-held,
  part-bought, and both numbers reconcile to `need`.
- **Over-move:** moving more than the source job holds is rejected, not clamped.
- **Need cap:** moving more than `need − held_for_me` to the target is rejected.
- **Reassign guard:** re-pointing a `converted` PR returns 409.
- **Floor:** issuing into another job's hold returns the structured 409; the
  confirmed retry succeeds and writes the ack audit row.
- **Gang:** a gang member's move is refused with the gang's number in the message.

Existing suites that must stay green: `production.finalise`, `routing`,
`procurement-rate`, `print-planning`, `order-lifecycle`.

## Out of scope

- Moving a gang's shared board.
- Splitting one PR across several jobs from the UI (the schema supports it; no
  screen exposes it).
- Holding board against a PO rather than a PR.
- Auto-suggesting which job should lose its board. Every move is a human
  decision with a written reason.
