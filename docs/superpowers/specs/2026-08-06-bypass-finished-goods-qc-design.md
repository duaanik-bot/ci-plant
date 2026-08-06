# Bypass Finished Goods & QC — Sort & Paste releases straight to Dispatch

**Date:** 2026-08-06
**Status:** Design approved, not implemented

## Problem

Every job card carries a trailing `qc` stage. Passing it is what credits `fg_stock`,
sets the order line to `produced` and closes the job card — the three facts Dispatch
gates on. In practice nobody runs the gate:

| Fact (live, 2026-08-06) | Count |
| --- | --- |
| `qc` job stages pending | 70 |
| `qc` job stages ever completed | 1 |
| …of the 70, pasting already completed | **8** |
| Order lines at `produced` | 1 |
| Closed job cards | 1 |
| COAs ever issued | 0 |

Eight job cards — roughly 64,110 cartons — are finished on the floor and frozen
behind a gate that one job in seventy-one has ever passed.

## Decision

Cut the `qc` stage out of the journey. Sort & Paste becomes the release point:
completing it closes the job card and the goods appear in **Dispatch & Invoice →
Ready to Dispatch**. The "Finished Goods & QC" left-nav module is deleted.

**Out of scope — explicitly untouched:** Warehouse keeps its own FG Stock, Leftover
and Movement Ledger tabs (`/inventory/fg`, `/inventory/leftovers`,
`/fg-lots/bulk-to-fg`). The `fg_stock`, `fg_lots` and `fg_movements` tables, and all
their helpers, are unchanged. The dispatch-side rules are unchanged: Dispatch still
decides what ships and invoices versus what banks as leftover.

## Mechanism

The job-card closer at `server/src/routes/production.js:1459` already fires on
`st.seq === last.mx` — the *last* stage, not on `stage === 'qc'`:

```js
} else if (st.seq === last.mx) {
  await qc(`UPDATE job_cards SET status='closed', qty_produced=$1, ... `);
  await fgReceipt(jc.product_id, qty_out, 'job_card', jc.id, qc);
  await setLineStatus(jc.order_line_id, 'produced', qc, oc, req.user.name);
}
```

Remove `qc` from `routingFor()` and pasting inherits the close. No new state machine
and no change to Dispatch's gating (`ol.status='produced' AND fg_stock.qty > 0`).

`qty_produced` changes meaning from *QC-accepted* to *pasted good*. Downstream
consumers (`excess_available`, leftover banking) read `qty_produced` and are
unaffected in form.

**The one gap.** The unified Sort & Paste endpoint (`production.js:1667`) completes
both the `sorting` and `pasting` stages directly and only sets the job card to
`in_progress` — it never reaches the closer. Pasting can also close through the
generic `/job-stages/:id/complete`, which *does* have the closer. So the closer must
be added to the Sort & Paste path, guarded on pasting being the last stage, so both
routes behave identically.

## Changes

### Server

| File | Change |
| --- | --- |
| `helpers.js:511` | Drop `stages.push({ stage: 'qc', unit: 'cartons' })` from `routingFor()` |
| `helpers.js:1010` | Gang-child stage filter `['sorting','pasting','qc']` → `['sorting','pasting']` |
| `production.js` `/sort-paste` | Run the closer when pasting is the last stage: `fgReceipt`, `setLineStatus('produced')`, close the job card, audit |
| `production.js:1960` | Delete `GET /qc/pending` |
| `production.js:1987`, `:2013` | Delete `GET /finished-goods` and `GET /finished-goods/:jobCardId` |
| `routes/coa.js` | Source sampling from the pasting stage; store the quality declaration (below) |

No DDL. No migration file.

### Deliberately kept

- `'qc'` in the `job_stages` / `stage_runs` CHECK constraints — one completed QC
  stage exists in history and must still render.
- The `sections` master row `('qc','QC',100)` and `SECTION_META.qc` — timelines,
  Logbook `FLOW_ORDER` and Dashboard `stageOrder` render historical stages.
- `role='qc'` — orthogonal auth used by Artwork, COA, Procurement, Shade Cards and
  FG lot verification. Not a station.

Defensive `stage !== 'qc'` guards (`stage-runs.js:105`, `helpers.js:1754`,
`floor.js:271`) become harmless no-ops and stay.

### Client

| File | Change |
| --- | --- |
| `modules.js:19` | Remove the `finished_goods` module entry |
| `modules.js:43` | Remove `qc` from `FLOOR_SECTIONS` |
| `components/AppLayout.jsx:52` | Remove the nav item |
| `App.jsx:29,91,95` | Remove the lazy import and route; redirect `/finished-goods` **and** `/floor/qc` → `/dispatch-invoice` so old bookmarks and pinned logins land somewhere real |
| `pages/FinishedGoods.jsx` | Delete (646 lines) |
| `pages/Section.jsx` | **Not done — see Deviations.** QC branch left inert |
| `components/DayCount.jsx` | **Not done — see Deviations.** `variant='qc'` left inert |
| `server/src/record-entities.js` | `fg_lot` pointed at `inventory`, not the dead `finished_goods` module |
| `server/src/routes/timeline.js` | `fg_lot` moved from the `finished_goods` group to `inventory` |
| `sections.js:39-42` | Update the stale comment — QC is no longer "consolidated into Finished Goods & QC", it is gone |

## COA

`draftParams()` already defaults every row to `observed: 'Complies'`, `result: 'Pass'`,
and `CoaSheet` already renders a fallback declaration. Make it explicit and stored.

- **`remarks`** is set at draft time to the quality declaration, so it snapshots onto
  the issued certificate. It stays editable before issue. `remarks` is currently
  unused at draft, so no schema change is needed.

  > **Quality Approval** — Certified that the material covered by this certificate
  > has been inspected by Quality Control against the approved specification,
  > artwork and shade card, and that all parameters listed above conform to the
  > stated standards with no deviation observed. The batch is approved by Quality
  > and released for dispatch.

- **`sampling`** sources from the completed pasting stage instead of the dead QC
  stage: `lot_size` ← `qty_in` (fallback: dispatch line qty), `accepted` ← `qty_out`,
  `rejected` ← `qty_scrap`. `aql` is unchanged.
- **`inspected_by`** stays null at draft and renders as **"Quality Control"** — the
  function, not a person. The pasting operator's name is deliberately kept off a
  customer-facing certificate.

Zero COAs have ever been issued, so there is no legacy certificate to reconcile.

## Data migration

A script, run **after** the code deploys. Running it before would leave prod
inconsistent — jobs closed while the live app still mints a `qc` stage for every new
job card.

1. **The 8** (pasting completed, qc pending): close the job card
   (`status='closed'`, `qty_produced` = pasting `qty_out`, `qty_scrap` = sum across
   stages, `fg_location` default, `closed_at`), `fgReceipt` the pasted good qty, set
   the order line to `produced`, delete the pending `qc` stage row, audit each as a
   bypass migration.
2. **The 63** (pasting not completed): delete the pending `qc` stage row only where
   it has no `stage_runs`. They close naturally at pasting under the new routing.
3. **Guard:** one `qc` stage carries a `stage_run`. Do not blind-delete — report it
   and handle it explicitly.
4. **Preserve:** the 1 completed `qc` stage stays exactly as it is.
5. **Users:** strip `qc` from `sections` on the **Pasting** and **Dies** logins, and
   `finished_goods` from **Pasting**'s `modules`.

The script must run as a single transaction with a dry-run mode that prints the
intended changes and writes nothing.

## Testing

- `routing.test.js` asserts stage sequences and **will fail** on the routing change —
  that failure is the guard. Update it to assert `pasting` is last and no `qc` stage
  is ever produced.
- New: completing Sort & Paste closes the job card, credits `fg_stock`, and moves the
  order line to `produced`.
- New: parity — a job closed through `/job-stages/:id/complete` and one closed through
  `/sort-paste` reach the same state.
- New: COA draft carries the declaration and pasting-sourced sampling.
- `app-imports.test.js` must still pass — deleting a page and its routes is exactly
  the class of change that has taken the API down before.
- Gang: a gang child job card gets `sorting` + `pasting` only, and closes at pasting.

## Risks

- **Release becomes one click.** Completing Sort & Paste now closes the job and
  releases stock. `/sort-paste/:jobCardId/reverse` currently blocks once the *next*
  stage has started; with no next stage that guard goes silent and a reverse would
  unwind an FG receipt. **Decision:** it already refuses a `closed` job card
  (`if (jc.status === 'closed')`), which now covers every completed Sort & Paste run.
  Add a test pinning that behaviour so the guard cannot regress into a silent
  FG-unwind.
- **`Dies` and `Pasting` logins** have `qc` in `sections`. Left unstripped they keep a
  station that no longer exists; the landing-path lockout precedent applies.
- Deleting `FinishedGoods.jsx` removes the only UI for `POST /fg-lots/:id/verify`
  (lot verification). Warehouse exposes `to-fg` and `bulk-to-fg` but not `verify`.
  **Decision:** leave the route in place — it is server-side and harmless — and
  accept that lot verification has no screen for now. One lot sits at `verified` and
  106 at `consumed`, so nothing is stranded. If the plant still wants a verification
  step it belongs in Warehouse, as separate work.

## Deviations from this design, as built

1. **`Section.jsx` and `DayCount.jsx` keep their QC code.** The plan was to strip
   it. `isQC` runs through ~25 sites of a 2375-line page, inside the completion
   modal *every* station shares — excising it risks the counting flow for the whole
   floor, for no user-visible gain. `/floor/qc` redirects and `qc` is out of
   `FLOOR_SECTIONS`, so `section === 'qc'` is unreachable from the router and the
   branch is inert. Worth removing as its own change, with its own testing.

2. **Two module-key references had to move**, found by the `record-entities` and
   `landing-path` test guards rather than by reading: `fg_lot` pointed at the
   `finished_goods` module in both `record-entities.js` and `timeline.js`. Both now
   point at `inventory`, which is where FG lots actually live.

3. **Dashboard's "Produced (Month)" KPI** opened `/finished-goods`. It now opens
   `/production` (Job Cards) — the module that holds those rows. Not
   `/dispatch-invoice`, which the "Ready to Dispatch" card already owns.

4. **`qty_produced` changes meaning** from *QC-accepted* to *pasted good*. No
   consumer needed changing, but reports comparing across the cutover should know.

## Verification

- `npm test -w server` — **1372 pass, 0 fail** (was 1369 before; +3 routing tests,
  and `routing.test.js` / `landing-path.test.js` updated to the new contract).
- `npm run build -w client` — clean.
- `app-imports.test.js` — passes; the import guard that has caught a prod outage
  before.
- Migration dry-run against live: **71 qc stages cleared, 8 job cards released
  (64,110 cartons), 2 logins cleaned of the `qc` section, 1 of `finished_goods`,
  0 open qc stages left, 1 completed qc stage preserved, 0 skips.**

## Session constraint

The no-commit/no-deploy default was **lifted out loud in the session of 2026-08-06**,
so this work is committed, pushed and deployed, and the migration is applied to prod
after the deploy lands. That sanction covers this session only.

Built on a worktree off `origin/main` — the shared tree was 60 commits behind and
carried another session's uncommitted shade-card work, which is deliberately not in
this branch.
