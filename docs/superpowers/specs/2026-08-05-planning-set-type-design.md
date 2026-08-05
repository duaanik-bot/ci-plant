# Planning set-type zones — Single / Gang / Hold

**Date:** 2026-08-05 · **Branch:** `planning-set-type` (worktree off origin/main @ 4b81715) · **Status:** approved by Anik in chat, not committed, not deployed.

## What

The Planning queue (To Plan tab especially) is one long list. The planner wants to triage it:
tag each job **Single** (prints alone), **Gang** (will share a sheet), or **Hold** (parked, with a
reason), and have the list split into zones so the working view stays clean. Chip label is **Gang**,
not Mix (Anik's correction).

- Sub-chip rail under the existing status tabs: **All · Single · Gang · Hold**, counts scoped to the
  active tab, opens on **Single**.
- New **Set Type** column (before Status): dropdown on pending lines, static chip otherwise.
- Picking Gang moves the row to the Gang zone; picking Hold prompts for a reason, then parks it.

## Data

Migration `supabase/migrations/0027_planning_set_type.sql` **and** the same DDL in `server/src/db.js`
init() (an init()-only edit never reaches prod — check-prod-schema memory):

```sql
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS set_type TEXT NOT NULL DEFAULT 'single';
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS set_type_by TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS set_type_at TIMESTAMPTZ;
-- CHECK set_type IN ('single','gang','hold') — drop/re-add by name, existing rows all 'single'.
```

`LINE_VIEW` selects `ol.*`, so the columns flow to every planning payload with zero plumbing.
No backticks anywhere in db.js SQL comments (template-literal trap).

## The effective-type rule (the one correctness rule)

Stored `set_type` is *intent*; a real gang membership is *fact*; a hold is a *parking brake* that
outranks both:

```
rowSetType(row) =
  any member set_type === 'hold'  → 'hold'     // hold wins — else a held gang could never leave the Gang zone
  row.gang_run_id                 → 'gang'     // physically shares a sheet; never shows Single
  else                            → stored set_type || 'single'
```

Evaluated on **grouped rows** (after gang collapse), same reasoning as board state: filtering
members would split a run that must move as one.

## Server

`PATCH /planning/:id/set-type` `{ set_type, hold_reason? }` in `server/src/routes/orders.js`
(requireRole admin/planner):

- `set_type` ∉ {single, gang, hold} → 400. `hold` with blank reason → 400.
- Line in a gang: `single` → 400 ("a ganged job cannot print alone — remove it from the gang first").
  `hold`/`gang` fan out to **every member** of the gang_run (the run moves as one).
- Any non-hold value clears `hold_reason`. Stamps `set_type_by = req.user.name`, `set_type_at = now()`.
- Errors via `Object.assign(new Error(msg), { status })` (file convention).
- `audit('order_line', id, 'set_type:<value>', reason, …)` so the timeline shows the parking.

## Client (Planning.jsx)

Pipeline rework (small): tab lines → gang-collapse → `rowSetType` zone filter → everything
downstream (KPI strip, board counts, suggestions, table) describes the **zone**, so no number on
the page disagrees with the list beside it. Tab badges keep whole-tab counts; sub-chips carry the
zone counts.

- **Sub-chips:** compact pill row directly under `<Tabs/>`, lighter weight than the tab rail.
  Default `single`. Switching clears selection. Counts = grouped rows per zone in the active tab.
- **Set Type column** (`key: 'set_type'`, before Status): `ActionMenu` with a chip trigger
  (grey Single / violet Gang / amber Hold + reason line under). Editable only when every line in
  the row is `pending` and role is admin/planner. Gang rows offer Gang/Hold only. Hold option opens
  a small Modal (Textarea reason, required); cancel reverts. Static chip on planned/completed rows.
- **Gang zone extras** (subTab === 'gang'):
  - `groupBy` switches to `board_name|gsm|coating` so candidates stack; group header shows
    "N jobs · board · GSM · coating" + a **Gang these** button (≥2 loose lines) pre-filling the
    existing create-gang modal (`setGangSel`). Existing gang runs keep their rail inside the stack.
  - Suggestions band uncapped and filtered to suggestions touching a gang-tagged line.
- **Hold zone:** reason visible under the chip; no other behaviour change. **No gate anywhere** —
  Plan/Job Card buttons, readiness, WorkflowControls untouched (physics hard, paperwork soft).

## Print Planning (added same session, Anik's follow-up)

The same four chips on the press board (`PrintPlanning.jsx`), mapped onto the board's FACTS — a
card there is already plated, so intent has become truth:

- `cardSetType(c)` = printing stage on **hold** → hold; `gang_run_id` → gang; else single.
  **Hold is the page's existing press hold** (stage hold + reason picklist) — never a second flag.
- Zone is **run-level** (`zoneOf` + `heldRuns`): one held member parks the whole stack; card-face
  chips stay card-level so the eye finds which member the press stopped on.
- Chips filter `lanes` view-only (same contract as Board Status/WIP); reorder buttons, queue
  numbering and expanded-table interactivity all gate on `zone === 'all'` so positions are never
  rewritten against a half-hidden queue. Zone chip clicks `clearSel()`.
- Card face + expanded row wear the shared `SetTypeChip` (inert); Completed table gains a Set Type
  column (a printed run is only ever Single/Gang). Both exports carry the column; board export
  meta names the active zone.
- Chip/vocabulary lifted to `client/src/components/SetType.jsx` — Planning imports it too (one
  spelling; the gang-anchor lesson). No server change; the payloads already carried
  `gang_run_id` + `printing_status`. Default zone is **All** here (a press board schedules gang
  runs as first-class work; Single-default would hide them).

## Bulk movement + queued holds (same session, Anik's follow-ups)

- **Bulk bar (Planning):** multi-select → **Move to Gang** / **Move to Hold** buttons beside the
  workflow bar — TAG-only (zone movement), deliberately separate from Combine/Gang Together which
  BUILD the physical run. Shown when every selected line is pending. Selected gang members dedupe
  to one anchor per run (`selectedRowAnchors`) so "2 jobs → Gang" means two. Bulk hold shares the
  single-row reason modal (`holdAsk.rows`), one reason for the whole selection; both paths write
  through `saveSetTypes` — one rule, N writes.
- **Queued cards hold (Print Planning):** `/job-stages/:id/hold` now accepts `pending` (message:
  "Only a queued or running stage can be put on hold"); resume restores **by evidence** —
  stage_runs → partially_completed, started_at → in_progress, else back to **pending** (a
  never-started run must not resume to "Printing now"). Chooser offers "Hold this Job" on queued
  cards and labels release "Release Hold" vs "Resume Printing" off the same evidence.

## Out of scope

Bulk retagging, Print Planning / floor visibility of set_type, auto-tagging gang on gang creation
(effective rule covers it), any hold enforcement.

## Verify

Full server suite (expect 949 + new route tests green), then real-app check on a scratch DB:
tag flows, zone moves, gang fan-out, hold reason, counts. Screenshots to Anik.
