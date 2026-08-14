# Choosing which rack plate a Plate PR spends — design

**Date:** 2026-08-13
**Branch:** `feat/plate-rack-picker` off `origin/main@e7102ef`
**Supersedes nothing.** Extends the rack-reuse feature shipped at `main@8955843`.

## The problem

`Use 4 from Rack` reserves four plates on one click and the planner never sees which
four. On a rack that now holds 1,358 used plates — many of them several plates of the
same colour for the same artwork — "which one" is a real question with a real answer:
condition, wear and how long a plate has sat idle all differ between two rows that look
identical on the button.

Today the answer is always `bestPlateCandidate`'s: best condition, then least worn, then
idle longest. That ordering is right as a default and wrong as a decree. The planner can
see the rack, knows which plate came back from the press with a mark on it, and has no
way to say so short of the full VerificationModal — whose other outcomes (not found,
damaged, scrap) are about condemning a plate, not about preferring a different one.

And once four plates are reserved there is no way back. `releaseDraftPlateAssets` already
knows how to return a plate to the rack, but only the edit and delete paths ever call it.

## What this adds

1. A **picker**: the green button opens the actual candidate plates per colour, best
   pre-ticked, and reserves nothing until confirmed.
2. **Change**: swap the plate on a line that already holds one, in one transaction.
3. **Undo**: give a reserved plate back to the rack, for as long as it is still on the rack.

Out of scope: choosing a plate the candidate query does not offer (wrong artwork
revision, `Damaged`/`Scrapped` condition). The older-artwork banner already names that
case and the VerificationModal already owns condemning a plate.

## 1. One query, two callers

`plate-lifecycle.js` grows `plateCandidates(oc, request, component, plateMasterId,
excludedAssetIds, limit = null)` — the body of today's `bestPlateCandidate` with the
`LIMIT 1` made a parameter. `bestPlateCandidate` is redefined on top of it:

```js
export async function bestPlateCandidate(oc, request, component, plateMasterId, excluded = []) {
  const [first] = await plateCandidates(oc, request, component, plateMasterId, excluded, 1);
  return first || null;
}
```

**This is the load-bearing decision.** The `On Rack` count, the picker's list and the
plate the button actually takes must resolve through one `WHERE` and one `ORDER BY`, or
the picker will eventually offer a plate the button refuses. It is the same law
`plateArtworkMatchSql` was written to enforce, applied to the candidate set instead of
the artwork comparison.

`plateCandidates` returns `pa.*` plus `pm.plate_size` — `asset_number`, `rack_location`,
`condition`, `use_count`, `last_used_at`, `plate_created_on` and `artwork_version` are
all already on the row. The endpoint derives `age_days` the way `GET /plates/warehouse`
does.

## 2. `GET /plates/requirements/:id/rack-candidates`

Gate: `canVerify` (planner, qc, admin) — the same gate that spends a plate.

Returns one entry per component whose status is in
`RACK_CLAIMABLE_COMPONENT_STATUSES`, plus — so the form can offer **Change** — every
component already sitting at `verified_existing`:

```json
{ "request_id": 105,
  "lines": [
    { "component_id": 412, "component_label": "Cyan", "component_type": "cyan",
      "pantone_code": null, "status": "pr_required",
      "matched_asset_id": null,
      "candidates": [
        { "id": 903, "asset_number": "CI-PL-A-0417", "rack_location": "Used Plates Rack",
          "condition": "Good", "use_count": 1, "last_used_at": null,
          "age_days": 1, "artwork_version": "PCS-W026/R1", "plate_size": "600 x 730" }
      ] } ] }
```

Candidates are **not** cross-filtered between lines. Two Cyan lines on one PR list the
same plates, because the planner may want plate X on the second line rather than the
first. Uniqueness is enforced at confirm time, where it can be enforced against the
database rather than against a stale list.

A line already holding a plate lists its current plate first, flagged `current: true`,
so **Change** opens with the truth selected rather than with a proposal.

## 3. `use-from-rack` learns explicit picks

Body gains `picks: [{ component_id, asset_id }]`. `component_ids` keeps its present
meaning and present behaviour.

- A component named in `picks` gets that asset — **after the server re-runs
  `plateCandidates` for that component and asserts the asset is in the result.** A pick is
  a choice among what is offered, never a client-supplied plate id taken on trust.
- A component with no pick falls back to `bestPlateCandidate`. This is what keeps the
  bulk dock, the form header button and every existing caller working unchanged.
- A pick whose plate is no longer free **fails the whole confirm with a 409, and nothing
  is reserved.** This is the one place the module's "skipped, never fatal" law does not
  apply, and the reason is that the two cases are indistinguishable at the point of
  decision: a plate another job took thirty seconds ago and a plate id that was never
  offered both present as *absent from the candidate list*. Silently skipping the second
  would let a buggy or hostile client spend plates it was never shown. Failing the batch
  is the non-destructive answer — the planner reopens the picker and sees the rack as it
  now stands, rather than half a reservation they have to reason about.

  `skipped` therefore carries only the refusals the server can name with certainty:
  `duplicate` (one plate picked for two lines) and `line_already_picked` (two plates
  picked for one line). Both are decided against the request's own components, not
  against a rack that may have moved.

### Swap

If a component is at `verified_existing` and a pick names a **different** asset,
`use-from-rack` releases the old plate and reserves the new one in the same transaction.
One endpoint owns "this line holds this plate", so a change cannot half-apply and leave a
line holding two plates or none.

To allow this without loosening the one-click path, the component filter becomes:
status in `RACK_CLAIMABLE_COMPONENT_STATUSES`, **or** status is `verified_existing` *and*
an explicit pick for that component names an asset other than its `matched_asset_id`.
Blind callers can therefore never re-pick a line that is already satisfied.

Response:

```json
{ "request_id": 105, "reused": 3, "swapped": 1, "short": 1,
  "skipped": [ { "component_id": 414, "component_label": "Black",
                 "asset_number": "CI-PL-A-0123", "reason": "taken" } ] }
```

The counts do not overlap: `reused` counts lines that went from holding no plate to
holding one, `swapped` counts lines that exchanged one plate for another, `short` counts
lines asked for and left without a plate. `reused + swapped + short` equals the number of
lines the call attempted, and `skipped` details the subset of `short` that failed for a
nameable reason rather than for want of stock.

## 4. `POST /plates/requirements/:id/release-rack` — undo

Gate: `canVerify`. Body: `component_ids`; omitted means every rack-claimed line on the PR.

Releasable means `matched_asset_id IS NOT NULL AND status = 'verified_existing'` — and
the plate itself still `reserved` against this job card, which is what
`releaseDraftPlateAssets` already tests. **Undo reaches exactly as far as the rack.** A
plate issued to printing has physically gone; bringing it back is a return, and the
existing return/verification flow owns that.

`releaseDraftPlateAssets` needs one change: today it `continue`s past a plate whose
`UPDATE` matched nothing, which is right for delete (the request is going anyway) and
wrong for an explicit undo. It returns `{ released: [], skipped: [] }`; existing callers
ignore the return, so nothing else changes.

Each released component is reset to `status='pr_required'`, `matched_asset_id=NULL`,
`proposed_asset_id=NULL`, all five `verified_*` flags and `verified_by`/`verified_at`
cleared. `pr_required` is the right landing: the line needs a plate and is approvable
onto a PO again, which is what rejecting a rack plate means.

If nothing could be released, respond `409` with a structured `code` **and** a message
naming the plate and the reason. A structured code no page handles is a dead button; the
client must render this one.

### The status machine has a hole undo is the first to find

`syncPlateRequest` (plate-lifecycle.js:171) computes:

```js
let nextStatus = current.status;
if (summary.is_ready) nextStatus = 'ready';
else if (rows.some(r => ['approved','po_created','ordered','grn_received'].includes(r.status))) nextStatus = 'procurement';
else if (rows.some(r => r.status === 'verified_existing')) nextStatus = 'rack_reserved';
else if (nextStatus === 'ready') nextStatus = 'pending';
```

Release the **last** `verified_existing` component of a `rack_reserved` request and no
branch fires: not ready, nothing in procurement, no `verified_existing` left, and the
current status is `rack_reserved` rather than `ready`. The request keeps saying
`rack_reserved` while holding no reserved plate.

Nothing reaches this today, and the reason is worth recording: the only two callers of
`releaseDraftPlateAssets` are delete (routes/plates.js:139), which removes the request
outright, and edit (:502), whose very next statement hard-sets `status='pending'` on the
request rather than letting `syncPlateRequest` work it out. The fallback branch has
therefore never had to fire. Undo is the first caller that empties the set and *relies* on
it. The last branch becomes:

```js
else if (['ready', 'rack_reserved'].includes(nextStatus)) nextStatus = 'pending';
```

Checked: nothing depends on `rack_reserved` being sticky. The only other readers are
display (`PlatesLifecycle.jsx:39`, `Tooling.jsx:44`), sort order
(routes/plates.js:275) and the `rack` filter alias (tooling-requirements.js:49) — all
readers of the status, none assuming it persists once the last plate is gone.

## 5. Client

All four existing call sites are in `client/src/components/PlatesLifecycle.jsx`:
the row button (:1142), the bulk dock (:1394), the form header (:1621) and the
per-colour line (:1637).

**`RackPickerModal`** — new, `client/src/components/`. One block per colour line: the
label, `1 of 5 on rack`, and the candidates as a single-select list showing asset number ·
rack · condition · runs · age. Best pre-ticked; a **none** option leaves that colour to be
bought. The footer counts what is actually ticked — untick two of four and it reads
*Reserve 2 plates*.

Routing of the four call sites:

| Call site | After |
|---|---|
| Row button `Use N from Rack` | Opens the picker |
| Form header `Use N from Rack` | Opens the picker |
| Form per-colour `Use` | Opens the picker scoped to that line |
| Bulk dock | **Unchanged — takes defaults** |

The bulk dock stays blind deliberately: picking plates across twelve selected PRs is a
lot of clicking for the case where the default is right, and the default *is* right most
of the time. Bulk is the "I trust the ordering" door.

In the form, a line at `verified_existing` shows its asset number with **Change** (picker,
scoped, current plate preselected) and **Undo** (`release-rack`, that component). A line
still needing a plate shows `1 of 5 on rack` and **Choose**.

Pure logic — mapping candidates to a default selection, and detecting the same asset
picked twice — goes in `client/src/lib/plateRack.js` beside `plateRackSummary`. A `.jsx`
file cannot be imported by `node --test`, so anything that needs a test cannot live in the
modal.

### Undo re-offers the plate it just released

A released line returns to `pr_required`, and if the plate is still on the shelf the row
immediately offers it again — defaulting to the plate just rejected. This is accepted, not
overlooked: the offer is a live read of a plate that really is available, and **Change** is
the correct tool for wanting a *different* plate. Remembering "this planner said no to
this plate" needs a column and is not worth one.

## 6. Tests

`npm test -w server` — never `node --test src/`. Extending
`server/src/plate-rack-reuse.test.js`; new client-side pure logic in
`client/src/lib/plateRack.js` gets its own file.

**Parity (load-bearing).** `plateCandidates(...)[0]` is the row `bestPlateCandidate`
returned before this change, over a fixture with mixed condition, wear and idle time. If
this fails, the count and the button have drifted.

Then:

- an explicit pick reserves the *named* plate, not the default;
- a pick outside the candidate set is rejected, and nothing is reserved;
- the same asset picked for two lines is taken once; the second line is skipped and named;
- a pick whose plate was reserved by someone else mid-flight is skipped and named,
  while its sibling lines still succeed;
- release returns the plate to `available`, clears the component, and the `On Rack` count
  rises by one;
- release of a plate already `issued_to_printing` releases nothing and names it;
- swap releases the old plate and reserves the new one, and a failure mid-swap leaves the
  line holding its original plate;
- releasing the last `verified_existing` line drops the request out of `rack_reserved`
  (the `syncPlateRequest` hole above);
- the bulk dock path, sending no `picks`, behaves exactly as it does today.

## 7. Delivery

Built in a clean worktree at `feat/plate-rack-picker` off `origin/main@e7102ef`. The
canonical checkout is on `shade-card-simplification` with another session's uncommitted
work across twelve files including `routes/tooling.js` and `pages/Tooling.jsx`; it is not
touched.

No migration. `plate_assets.status='reserved'`, `verified_existing` and the movement
action `reserved` all already exist on prod — that was verified when `main@8955843`
shipped. Nothing is committed, pushed or deployed.
