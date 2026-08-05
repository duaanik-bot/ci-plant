# Board shortage panel — confirm, status, cancel, undo

2026-08-05 · planning engine · `client/src/pages/Planning.jsx`

## The problem

When a planned board is short, the engine shows a red block with three buttons —
`Take board from another job`, `Raise PR for N`, `Cover with another board`. In the
narrow right-hand column those wrap onto three stacked rows in three different
colours, none of them obviously first. It reads as cluttered.

The clutter is not spacing. It is that three unequal actions are dressed as peers:

| Button | What it actually does today |
|---|---|
| Raise PR | Creates a real requisition immediately, no confirmation, unless a PR already exists for this product or gang |
| Take board from another job | Opens a picker panel |
| Cover with another board | Silently seeds draft rows into Board Mix on the left; commits nothing |

Two further gaps: raising a PR reports itself only as a toast that vanishes, and
once raised there is no way to withdraw it without leaving the engine for
Procurement.

## Scope

The row exists twice, and both are in scope:

- `Planning.jsx:2604` — single order line. The screen in the report.
- `Planning.jsx:3741` — gang/run view. Different wording, two buttons.

Both are replaced by one shared component. The differences between them become
props. This follows the rule the codebase has already paid for: a real difference
in one term argues for a parameter, not a second reader.

## The card

Layout, top to bottom:

1. Headline row — `Short 28,700 sheets` left, `cutting waits` right. For a
   `fresh_pr` plan this stays the calmer indigo `Buying fresh — N to order`.
2. One full-width primary button — `Raise PR for 28,700`.
3. A hairline.
4. Two quiet text buttons — `Take from another job` · `Cover with a board`.

A shortage has one normal answer, which is to buy the board. That becomes the only
thing competing for attention; the two situational routes stay reachable without
shouting. The result is roughly half the height of the current block.

`Cover with a board` hides on a gang, as it does today — a gang shares one board
across every member and the server 409s a mix sent for it. Each of the two quiet
buttons renders only when its handler is supplied, which is how the run view keeps
its smaller set without a second component.

## Confirmation

All three actions confirm first, each on the existing `Modal` from
`components/ui.jsx` so they match the rest of the app. Each modal states what its
own action does, rather than a generic "are you sure".

- **Raise PR** — board name, quantity, needed-by date, the job and PO it is for,
  and the reason string that will be written onto the requisition. Confirm:
  `Raise PR`.
- **Take board from another job** — states that this pulls stock off another job's
  hold and that a PR may be auto-raised for that job to replace it. Confirm:
  `Choose a job`, which opens the existing picker. The modal is the
  acknowledgement; the picker remains where the real choice is made.
- **Cover with another board** — names the candidate and says plainly that this
  drafts a mix in Board Mix on the left and commits nothing until the plan is
  saved. Confirm: `Draft the mix`.

The existing duplicate-PR modal keeps priority. If an active PR already exists for
this product or this line's gang, that modal opens instead — with its quantity and
re-raise reason — not two modals in sequence.

## When the panel renders

Today the red block renders only while `position.short > 0`, so the moment an
action resolves the shortage the whole thing disappears — which is why there is
currently nowhere for a result, or a way back, to live. The component therefore
renders in three modes, and is mounted whenever any of them applies:

| Mode | Condition |
|---|---|
| Action card | `short > 0` |
| PR status strip | this job has an active requisition |
| Move result | a board move completed in this session |

## Status after raising

Once this job's own PR exists, the red block is replaced by a calm strip:

```
PR-0412 raised · awaiting approval
28,700 sheets · needed by 12 Aug
Track requisition          Undo    Cancel
```

`Track requisition` opens the tracker that already exists (`openPrTracker`).

The strip is derived from `ctx.incoming.prs`, filtered to this product or gang the
same way the duplicate guard filters it. It is not local state. It therefore
survives a reload and reflects what the server holds rather than remembering that
a button was clicked. The toast stays for the immediate beat.

`Cover with another board` does not produce a status strip, because nothing was
committed. The card keeps showing the shortage with a quiet line —
`Mix drafted — review it on the left` — until the plan is saved.

## Cancel and undo

Two different intentions, two different endpoints, both already on the server.

| | Endpoint | Reason required | Result |
|---|---|---|---|
| **Undo** — "I raised that by mistake" | `DELETE /requisitions/:id` | No | Row removed entirely. Refuses if the PR is on a PO, with the server's own message: *"PR-0412 is on PO-0117 — send that PO back to requisition first"* |
| **Cancel** — "we are not buying this after all" | `POST /requisitions/:id/close` | Yes | Row kept as `closed` with `status_reason`. Allocation retired. Audited |

`close` is the right verb for a planner withdrawing their own PR. `reject` is
narrower — it only accepts a `pending` PR and reads as procurement refusing the
request rather than planning changing its mind.

### Gates

Both gates come from existing rules, not new ones.

**Role.** Cancel and undo require `canBuy` (`planner`, or `admin` which
`requireRole` passes through). Raising requires the wider `canRaisePr`
(`planner`, `production`, `qc`). So `production` and `qc` can raise a PR and
cannot retire one — a deliberate split at `procurement.js:66`. Those users see the
status strip with no controls. The buttons are hidden rather than shown-and-403'd.

**State.**

| PR status | Undo | Cancel |
|---|---|---|
| `pending`, no PO | yes | yes |
| `approved` | no — it would have to silently unapprove first | yes |
| `converted` / on a PO | no | no — strip explains why, in the server's words |

## Board moves are not undoable

`/board/move` does more than shuffle a hold. When it takes board off another job it
can auto-raise a PR for that job to replace what was taken
(`board.js:385`, `create_from_move`), and it writes holds on both order lines.
Releasing the allocation would leave the auto-raised PR standing and the donor's
hold gone — a third state that is neither before nor after.

So this action gets no Undo. It gets:

- **Move it back** — reopens the picker with the transfer reversed.
- The result names any PR the move auto-raised, so that PR can be undone
  deliberately through the PR controls above.

### Why the move result is session-scoped

`board_allocations.source` is constrained to `'stock'` or `'requisition'` — there
is no `'move'` value (`db.js:1914`). A hold that arrived by a move is therefore
indistinguishable from an ordinary stock hold except by its free-text `reason`.
Detecting a past move on reload would mean parsing prose or replaying the audit
log, and both are fragile enough to produce a `Move it back` button pointing at
the wrong transfer.

So the move result is shown from the response we just received — `/board/move`
returns `{ ...plan, raised }`, which carries both the quantity moved and any PR it
auto-raised. The panel knows a move happened because it just performed one, not
because it inferred one. After a reload the result is gone and reversal lives
where it already lives: the board picker panel, which lists holds and can release
or move them.

Adding a `'move'` source to the schema would make this durable. That is a
migration, and it is deliberately not in this change.

## Component

`client/src/components/ShortagePanel.jsx`, one default export.

| Prop | Purpose |
|---|---|
| `short` | Shortfall in parent sheets |
| `fresh` | `fresh_pr` plan — buying, not short. Indigo wording |
| `prs` | This job's active requisitions, already filtered. Drives the status strip |
| `canBuy` | Whether to show Undo and Cancel |
| `onRaisePr` | Required |
| `onTakeBoard` | Optional. Omit to hide the button |
| `onCoverMix` | Optional. Omit to hide the button |
| `onUndoPr`, `onCancelPr`, `onTrackPr` | Status-strip actions |
| `lastMove` | The `/board/move` response, or null. Drives the move result and its `Move it back` |
| `onMoveBack` | Reopens the picker with the transfer reversed |
| `busy` | Disables the primary while a request is in flight |

The three confirmations live inside the component so both call sites inherit them
without repeating the copy.

## Testing

- Client: render tests for the five states — short, fresh, PR raised, PR on a PO,
  and move result — and for the two gates (role and status) hiding the right
  controls. The PR-on-a-PO case must show neither Undo nor Cancel; the
  `production` role must show neither while still seeing the status.
- Server: no new endpoints. Existing `DELETE`, `close` and `move` behaviour is
  unchanged. Confirm the existing procurement tests still pass.

## Verification limits

The live preview at `:5915` is read-only against the plant, so it can show the new
layout and open every modal, but confirming a PR will be refused by the guard.
Anything that actually writes — raise, undo, cancel — gets verified against a
local writable instance, not the live preview.

## Out of scope

- Changing who may raise or retire a requisition.
- A transactional server-side reversal of a board move.
- The Procurement module's own PR controls.
