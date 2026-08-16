# Setting a rack plate aside, bringing it back, and undoing either — design

**Date:** 2026-08-16
**Branch:** `feat/plate-rack-picker` (continues from `main@785474ee`)
**Extends:** `2026-08-13-plate-rack-picker-design.md`

## The problem

The picker now shows a planner every plate the rack can offer — asset number, rack, condition,
runs, age. Which means it is now the moment a planner most often *knows something the rack does
not*: that `CI-PL-A-0154` came back marked, or is not on the shelf at all, or needs a look before
anyone prints from it. Today there is nothing they can do about it from there. Retire exists but
means *scrapped, gone, `active=0`* — far too final for "don't offer me this one for now", and it
is only reachable from the warehouse.

So a plate that should not be offered stays offered, and the only recorded alternative is to
destroy it.

## What this adds

1. **Set aside** — take a plate out of circulation with a reason, reversibly.
2. **Make available** — put it back, including un-retiring a scrapped plate.
3. **Undo** — reverse a Set aside in one click. Retire and Make available get explicit
   inverses instead, because the record cannot restore a grade it never stored (§4).

## Two findings that decide the shape

**The picker cannot host this on its own.** `plateCandidates` filters `pa.status='available'`, so
the instant a plate is set aside it disappears from the picker. The picker can take plates *out*
of circulation and never bring one back.

**And today a set-aside plate would vanish from the app entirely.** `PlatesLifecycle.jsx` offers
only Fresh and Used, both filtered `row.status === 'available'`. Nothing renders a plate in any
other state. A feature that can only hide plates, with no screen that lists what is hidden, is a
way to lose 1,358 plates one at a time.

So the warehouse gains a third tab, and that tab — not the picker — is where a plate comes back.

## 1. The state model — no migration

| Meaning | `status` | `condition` | `rack_location` | `active` |
|---|---|---|---|---|
| On the rack, offerable | `available` | Good / Fair | Fresh or Used rack | 1 |
| Set aside — damaged | `damaged` | **unchanged** | unchanged | 1 |
| Set aside — can't find it | `lost` | **unchanged** | unchanged | 1 |
| Set aside — needs checking | `awaiting_verification` | **unchanged** | unchanged | 1 |
| Retired | `scrapped` | `Scrapped` | `Scrap` | 0 |

**Set aside changes `status` and nothing else.** Two reasons. First, `condition` is a physical
grade produced by *inspecting* the plate — that is what the return-verification flow does. A
planner setting a plate aside from the picker has not inspected it; they are flagging it, and the
status `damaged` already says so. Writing `condition='Damaged'` there would be the system
asserting a grade nobody checked. Second, it is what makes Undo exact — see §4.

Every value is already permitted by the live CHECK constraints on `plate_assets.status`,
`plate_assets.condition` and `plate_asset_movements.action` — verified against production. **No
migration.** A set-aside plate keeps `active=1` and **keeps its rack location**, because it is
still physically on that shelf and somebody has to go and find it.

Verified on production before designing this: 1,354 `available`, 4 `reserved`, 4 `reversed`, and
**nothing** `damaged` / `lost` / `scrapped`. There is no existing data to reconcile.

Reason → state, mirroring the one-tap shape `PLATE_RETIRE_REASONS` already uses:

| Reason offered | `key` | status | movement `action` |
|---|---|---|---|
| Damaged | `damaged` | `damaged` | `damaged` |
| Can't find it | `missing` | `lost` | `not_found` |
| Needs checking | `check` | `awaiting_verification` | `verification_requested` |
| Other | `other` | `awaiting_verification` | `verification_requested` |

These are **not** `PLATE_RETIRE_REASONS` and must not reuse it: that list asks why a plate is
*dead* ("Worn out — dot loss", "Artwork changed"), which is a different question from why it is
off the rack today. A new `PLATE_SET_ASIDE_REASONS` carries the mapping, and it lives in
`client/src/lib/plateRack.js` with the server importing it — `server/src/helpers.js` already
imports `client/src/lib/productCode.js`, so this is the established direction and gives the
mapping ONE home rather than a client twin to keep in step.

## 2. The rule that protects the floor

**A plate a job owns can never be set aside or retired** — `reserved`, `issued_to_printing`,
`returned_pending_verification`. Setting aside a plate that a job card is relying on strands the
job silently.

`pickAvailableRackPlates` (`plates.js`) already enforces exactly this for Retire: it throws 409
naming the plate and the state it is in. Set aside reuses it rather than re-spelling the rule, so
the two doors cannot drift apart — the same reason `plateArtworkMatchSql` has one spelling.

Make available is the mirror: it accepts only `damaged`, `lost`, `awaiting_verification` and
`scrapped`, and refuses anything in flight.

## 3. Un-retire — allowed, and deliberately loud

Anik asked for this after being told the risk: a scrapped plate re-entering circulation can be
printed from. It is in, built so it cannot happen quietly.

- It is its own action, **Return to rack**, and exists only on the Set aside tab — never in the
  picker, never as a side effect of a bulk toggle.
- A reason is required.
- **The condition must be stated: Good or Fair.** The plate's condition is `Scrapped`; it does not
  come back as Good by default, and the UI has no default selected.
- Restores `active=1` and `rack_location` to the Used Plates Rack — a plate that has been scrapped
  and recovered is not fresh stock.
- Writes a `plate_asset_movements` row (`action='adjustment'`, `from_status='scrapped'`) and an
  `audit_log` row naming who brought it back and why.

## 4. Undo — exact where it can be, explicit where it cannot

`plate_asset_movements` already records `from_status`, `to_status`, `from_location` and
`to_location` on every change. So undo is not new state: it is **apply the inverse of movement N**.

**Undo covers Set aside only, and that is a correctness limit, not a shortcut.** The movements
table has a *single* `condition` column holding the grade the movement resulted in — there is no
`from_condition`. So any change that alters the grade cannot be reversed from the record: undo a
Retire and nothing anywhere says whether the plate was Good or Fair before it read `Scrapped`.
Restoring a guess would put an invented grade on a plate the floor prints from.

Set aside touches `status` alone (§1), so its inverse is fully determined and Undo is exact. The
two actions that do change the grade get explicit inverses that *ask* for what the record cannot
supply:

| Action | Reversed by |
|---|---|
| Set aside | **Undo** — one click, exact |
| Retire | **Return to rack** — asks for the condition |
| Make available / Return to rack | **Set aside** — status only, no grade to restore |

`POST /plates/assets/undo-movement` with `{ movement_id }`:

- loads the movement and its plate `FOR UPDATE`;
- **refuses unless the plate is still where that movement left it** — `plate_assets.status` must
  still equal `movement.to_status`. If the plate has moved on since, undoing would overwrite
  whatever happened after, so it refuses by name: *"CI-PL-A-0154 has changed since — it is now
  reserved"*, `409`, code under `body`;
- restores `status` and `rack_location` from the movement's `from_*` columns. It does **not**
  touch `condition` — set aside never changed it, so there is nothing to put back;
- writes its own movement row (`action='adjustment'`, note naming the movement it reversed) — undo
  is itself an event in the ledger, never an erasure of one;
- **accepts only the three set-aside actions** — `damaged`, `not_found`,
  `verification_requested`. Notably it does **not** accept `adjustment`, which is what Retire's
  inverse and the picker's release both write.
- **and only a movement with no `tooling_request_id` and no `job_card_id`.** This is the
  discriminator, and it matters: `action='adjustment'` is *not* unique to this feature —
  `releaseDraftPlateAssets` writes it too, when the picker's Undo hands a plate back, and so do the
  PR edit and delete paths. Keying on the action alone would let this endpoint reverse a rack
  *release* and re-reserve a plate against a job that no longer wants it. Rack-state changes are
  not job-linked; every job-linked movement has one of those two ids. **It is not a general undo
  for reservations or issues** — those have their own reversal paths, and a generic inverse over
  every movement type would let someone un-issue a plate physically on the press.

Two places offer it:
- the success toast after a **Set aside** carries **Undo**;
- each row on the Set aside tab carries **Undo**, shown only when its last change was a set-aside.

## 5. Where the controls live

**Picker** (`RackPickerModal`) — each candidate row gains a small secondary affordance offering
**Set aside** and **Retire**. Not primary buttons: the row's job is still to be chosen. Both open
the reason step, so a mis-tap cannot change a plate's state — the reason is the confirmation.

**Except on the row flagged `current: true`,** where both are hidden. That row is the plate the
line already holds, and it is `reserved` — the picker fetches it separately precisely because
`plateCandidates` excludes it. Offering Set aside there would send the planner into the in-flight
guard for a 409 they could have been spared. To set that plate aside they Undo the line first,
which is the correct order anyway: give the plate back, then take it off the rack.
After either, the picker refetches its candidates; if the plate that vanished was the selected one
for its line, the selection falls to the next candidate, or to **Buy this one** if the line is now
empty.

**Plates Warehouse** — a third tab, **Set aside**, beside Fresh and Used, listing every plate that
is neither available nor in flight (`damaged`, `lost`, `awaiting_verification`, `scrapped`), with
its reason and when it was set aside. It carries **Make available**, **Return to rack** (for
scrapped) and **Undo**. Its count sits in the tab like the other two.

## 6. Endpoints

All `canVerify` (planner, qc, admin) — the same gate that spends and retires a plate today.

| Route | Body | Does |
|---|---|---|
| `POST /plates/assets/set-aside` | `{ asset_ids, reason }` | available → damaged / lost / awaiting_verification |
| `POST /plates/assets/make-available` | `{ asset_ids, condition, reason }` | set-aside or scrapped → available |
| `POST /plates/assets/undo-movement` | `{ movement_id }` | inverse of that movement |

`POST /plates/assets/retire` is **untouched** — it is reversed by Return to rack, not by Undo, so
it needs to hand back nothing new. Its two existing callers keep working unchanged.

`set-aside` returns the `movement_ids` it wrote, so its toast can offer Undo. Re-deriving "the last
movement for this plate" at undo time would race with anything else touching the plate in between,
so the id travels with the response.

Refusals carry their code under `body` — `app.js` writes `{ error, ...(err.body||{}) }`, so a code
on the error itself is dropped and the page keying on it becomes a dead button.

## 7. Tests

`npm test -w server`. No test in this repo touches a database, so every decision lives in a pure
function in `plates.js` and is unit-tested there; the routes get source-text wiring tests.

- `validateSetAside({ assets, assetIds, reason })` — refuses a plate any job owns, by name;
  refuses an empty reason; maps each reason to its status/condition/action.
- `validateMakeAvailable({ assets, assetIds, condition })` — accepts only the four set-aside
  states; refuses in-flight plates; requires `condition` to be Good or Fair, and **refuses an
  absent condition rather than defaulting it**.
- `invertMovement({ movement, asset })` — computes the restore; refuses when the plate's current
  status no longer matches `movement.to_status`; refuses an action outside the allowed set.
- Wiring: each route calls its validator rather than re-spelling the rules; the set-aside path and
  Retire both go through `pickAvailableRackPlates`.
- The warehouse's third tab counts what the other two exclude — no plate is in two tabs, and no
  plate is in none.

## 8. Delivery

Continues on `feat/plate-rack-picker`. **No migration.** Nothing is committed, pushed or deployed
without Anik sanctioning it in the session where it happens — the sanction given for the picker
does not carry to this work.
