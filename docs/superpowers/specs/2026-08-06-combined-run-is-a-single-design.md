# A Combined Run is a Single — set-type zones stop calling a merge a gang

**Date:** 2026-08-06
**Status:** design approved, not implemented
**Touches:** Planning queue, Print Planning board, `set-type` refusals
**Migration:** none. No new column, no new table, no payload change.

## The problem

`rowSetType` classifies any line carrying `gang_run_id` as **Gang**:

```js
export const rowSetType = r => ((r._gang || [r]).some(m => m.set_type === 'hold') ? 'hold'
  : r.gang_run_id ? 'gang' : (r.set_type || 'single'));
```

That test was written before Combined Runs existed. Since `main@007384f`, `gang_runs`
carries a `kind` column and a same-product merge **reuses `gang_run_id`** — deliberately, so
that all seven "which card is this line riding?" laterals keep working. The side effect is
that the zone classifier can no longer tell the two apart, and files every combined run under
a chip whose whole meaning is *"this splits after die cutting."* A merge is the one run that
never splits.

`PrintPlanning.jsx:32` carries a hand-rolled copy of the same broken test:

```js
const cardSetType = c => (c.printing_status === 'hold' ? 'hold' : c.gang_run_id ? 'gang' : 'single');
```

### What the live queue actually holds (prod, 2026-08-06)

The **Gang 16** chip in To Plan reconciles like this:

| Rows | What they are |
|---:|---|
| 15 | lines tagged `set_type='gang'` — **intent only**, no run built, nothing sharing a sheet |
| 1 | a real run — and its `kind` is **`merge`**, not `gang` |

**There are zero physical gangs in To Plan.** The only run in that chip is a combined run
being shown as something it isn't. A second combined run is also in To Plan but has a held
member, so it correctly sits under Hold.

The whole-database picture: **12 merge runs (25 member lines) against 4 gang runs (10
member lines)**. The misclassification is the common case, not the edge case.

## The rule

Narrow the gang fact by one word. The merge case is **deleted**, not special-cased:

```
hold (any member)          →  hold          unchanged — still outranks everything
run_kind === 'gang'        →  gang          was: gang_run_id
otherwise                  →  stored set_type   (DEFAULT 'single')
```

A combined run stops being a fact that *forces* a zone and falls through to its tag. That
yields the two rules asked for:

- **Rule 1 — Single.** One product, one order, tag `single`.
- **Rule 2 — Single, combined orders.** One product, N orders on a CI-MRG run, tag `single`.

Both are Single because both describe the same physical truth: one product, one plate set,
one pile, one sort, one paste, one QC.

### The rule earns something beyond the ask

Falling through to the stored tag — rather than hard-coding merges to `'single'` — means a
combined run tagged **New Output** now lands in New Output, where a job needing a fresh plate
set belongs. Today that tag is *refused* on a merge, and the refusal reads "A ganged job
cannot print on its own." For a same-product merge that sentence is false.

### Effect on the live chip counts

| Chip | Now | After |
|---|---:|---:|
| All | 41 | 41 |
| Single | 10 | **11** |
| Gang | 16 | **15** |
| New Output | 5 | 5 |
| Hold | 10 | 10 |

Hold is unchanged because hold still outranks the merge fact — the held combined run stays
parked, as a run must.

## The Combined chip

A **second axis**, not a sixth zone — the pattern `Plan saved` already established. It rides
the same strip behind the hairline divider, narrows whichever zone is open, and is **hidden
at zero**, so on a day with no combined runs in view the strip is exactly as wide as it is
today.

```
[ All 41 ] [ Single 11 ] [ Gang 15 ] [ New Output 5 ] [ Hold 10 ]  │  [ ⧉ Combined 1 ]  [ 🔖 Plan saved 1 ]
```

- **Predicate:** `run_kind === 'merge'` on the row (a pure fact, orthogonal to zone), so it
  composes with `Plan saved` instead of competing with it.
- **Count:** rows in the *open zone* that are merge-fact — 1 in Single, 1 in Hold, 2 in All.
  Counted on `zoneRows`, before `draftOnly` narrows, exactly as `draftCount` is.
- **Colour: teal.** Across this ERP violet means *"splits after die cutting"*; teal is the
  established merge colour (`Merge.jsx`, the Combine Orders button, the `GangCellParts` tone).
- **Icon: `Layers`** — the same icon as the **Combine Orders** button that creates these runs.
- **Live-filter guard:** `mergeOnly && mergeCount` mirrors `draftOnly && draftCount`, so a
  filter left on cannot outlive the rows it filtered.

## The tagging refusals

The existing doctrine in `set-type.js` is *"a tag the fact would mask is a lie, not a
preference."* Applied symmetrically once merges classify as Single:

| Run | `single` | `new_output` | `gang` |
|---|---|---|---|
| `kind='gang'` | refused *(today)* | refused *(today)* | ok |
| `kind='merge'` | **ok** — was refused | **ok** — was refused | **refused** — new |

Tagging a combined run "Gang" would be masked by its own `kind`, so it is refused the way
`single` on a gang always has been, with its own sentence naming the right remedy: remove the
line from the combined run first.

`setTypeError` gains `run_kind` on its `line` argument. The route must supply it — the
current `SELECT` does not read it:

```sql
-- server/src/routes/orders.js, PATCH /planning/:id/set-type
SELECT ol.id, ol.status, ol.gang_run_id, gr.kind AS run_kind
  FROM order_lines ol
  LEFT JOIN gang_runs gr ON gr.id = ol.gang_run_id
 WHERE ol.id = $1
```

This is the only server query that changes anywhere in the spec.

The row dropdown must offer the same set the server will accept, or the planner meets a
refusal the UI could have prevented. `setTypeMenuItems` switches from asking *"is there a
run?"* to asking *"what kind of run?"*:

| Row | Options offered |
|---|---|
| no run | `single` · `gang` · `new_output` · `hold` *(unchanged)* |
| `kind='gang'` | `gang` · `hold` *(unchanged)* |
| `kind='merge'` | `single` · `new_output` · `hold` |

The current option is filtered out of its own menu, as it is today. The bulk bar inherits
this for free — it shares `saveSetTypes`, and its own zone buttons already hide `single` and
`new_output` when the selection holds a ganged job; that guard narrows to gang runs by the
same rule.

## Print Planning gets the same fix

Leaving `cardSetType` alone would put one run in **Single** on the planning queue and
**Gang** on the press board — precisely the drift the shared `SetType.jsx` exists to prevent
(the gang-anchor rule: hand-rolled copies of a shared verdict drift).

- `cardSetType`: `c.run_kind === 'gang' ? 'gang' : 'single'`.
- `zoneOf`: same substitution; `heldRuns` is untouched — a held member still parks the whole
  stack, merge or gang.
- Same teal `Combined` chip, same hides-at-zero rule, counted on the unfiltered board like
  the other zone counts so it never restates the filter.

One legitimate difference stays, and it is already documented in the `SetType.jsx` header:
Print Planning maps the vocabulary onto **card-level facts** and has no stored `set_type` to
fall through to, so there a merge resolves to `'single'` directly.

> **CORRECTED AT IMPLEMENTATION.** This section originally claimed `run_kind` was already on the
> card payload and that no server change was needed here. **That was wrong**, and it would have
> shipped a regression: `GET /print-planning` (`server/src/routes/production.js`) joins
> `gang_runs gg` and even reads `gg.kind` inside two CASE expressions, but never *selected* it. So
> every card arrived with `run_kind` undefined, and the narrowed `cardSetType` filed all nine
> run-carrying cards — including **two genuine gangs** — as Single. Verified on live data: the
> board read `Single 40 · Gang 0` before the fix and `Single 38 · Gang 2 · Combined 7` after.
>
> Fixed by selecting `gg.kind AS run_kind` in that query. The lesson generalises: `floor.js`
> having the column proved nothing about `production.js`, and only reading the actual JSON payload
> caught it — the chip being correctly hidden at zero looked exactly like success.

`run_kind` reaches the queue payload already (`orders.js` LINE_VIEW). The press-board query needs
the one-column addition described above.

## Files

| File | Change |
|---|---|
| `client/src/components/SetType.jsx` | `rowSetType` — gang fact narrows to `run_kind === 'gang'`; header comment records why a merge is not a gang |
| `client/src/pages/Planning.jsx` | `mergeOnly` state + `mergeCount`; teal Combined chip on the zone strip; `setTypeMenuItems` offers by `run_kind`, not by `gang_run_id` |
| `client/src/pages/PrintPlanning.jsx` | `cardSetType` + `zoneOf` narrow to `run_kind`; Combined chip on its zone strip |
| `server/src/set-type.js` | `SOLO_ONLY` scoped to gang runs; new refusal of `gang` on a merge run |
| `server/src/routes/orders.js` | the `set-type` route's line `SELECT` joins `gang_runs` for `kind` |
| `server/src/routes/production.js` | `GET /print-planning` selects `gg.kind AS run_kind` (see the correction above) |
| `server/src/set-type.test.js` | cases below |
| `server/src/set-type-zone.test.js` | new — executes the client classifier from the node suite |
| `client/src/lib/setType.js` | new — the pure rules, so a node test can run them |

## Testing

`set-type.test.js` gains, against `setTypeError`:

1. `single` on a `kind='merge'` run — **allowed** (was refused)
2. `new_output` on a `kind='merge'` run — **allowed** (was refused)
3. `gang` on a `kind='merge'` run — **refused**, message names removing it from the combined run
4. `single` and `new_output` on a `kind='gang'` run — still **refused** (no regression)
5. `gang` on a `kind='gang'` run — still allowed
6. a line with no run — all four tags allowed, unchanged
7. every refusal that is not about `kind` survives: blank hold reason, unknown set type, and
   a member whose status has left `pending` all still refuse on a merge run

Client-side, `rowSetType` is asserted directly for five shapes: no run; `kind='gang'`;
`kind='merge'` tagged `single`; `kind='merge'` tagged `new_output`; and `kind='merge'` with a
held member. The fourth is the case that regresses silently if someone later "simplifies" the
fall-through back to a hard-coded `'single'`; the fifth pins hold's precedence over the merge
fact, which is what keeps the Hold count at 10.

## Verification

Against the real app, not a mock (per the standing rule):

1. To Plan opens on Single showing **11**, Gang showing **15**, All still **41**.
2. The combined run appears in Single wearing its teal chip and its `2 orders · one pile`
   cell — not in Gang.
3. The teal **Combined** chip is present with count 1; clicking it leaves that one row;
   clicking again restores 11.
4. Switch to Gang — the Combined chip **disappears** (zero merges there). Switch to Hold —
   it returns with count 1, the held combined run.
5. Open the combined run's set-type dropdown: **New Output** is offered and saves; **Gang**
   is not offered, and the API refuses it if called directly.
6. Print Planning shows the same run under Single, with the same chip and count.
7. Full suite green.

## Out of scope

- **No "Combine these N" stack grouping in the Single zone.** The teal suggestion band
  already surfaces same-product repeats; adding a second discovery path would be the clutter
  this change is meant to avoid.
- **No header or chrome tightening.** Confirmed with Anik: this change only, and it adds
  zero permanent width.
- **The 15 intent-tagged `gang` lines are left exactly as they are.** They are a planner's
  stated intention to gang later, which is what the tag is for. That the chip is currently
  almost entirely intent rather than fact is worth knowing, but it is not a defect and not
  this change's business.

## Related

[[ci-erp-combined-runs]] · [[ci-erp-planning-set-type]] · [[ci-erp-gang-printing]] ·
[[ci-erp-gang-anchor-one-spelling]] · `docs/superpowers/specs/2026-08-05-planning-set-type-design.md`
