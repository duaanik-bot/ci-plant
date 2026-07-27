# Partial runs on every station

**Date:** 2026-07-26
**Status:** Approved, implementing

## Problem

The partial-run engine shipped earlier today (`762afa4`, `8a921e0`, `39d4edc`): day-wise
`stage_runs`, the `partially_completed` status, cumulative counters, PARTIALLY DONE chips.
The engine is sound. The way in is not.

Today an operator reaches a partial run in exactly one of two ways, depending on which board
they are standing at:

- **Sort & Paste** — an explicit **Day count** button on every running row. Always visible,
  one click, job stays open. This is the good version.
- **Every other station** — nothing on the row. The operator must open **Complete**, then type
  a counter figure *below* the expected output, at which point an amber panel appears offering
  Partial or Final. The counter field is pre-filled with the full expected figure, so an
  operator who does not overwrite it never discovers that partials exist at all.

The result is that the plant's most common daily gesture — "I did 12,000 of 50,000 today" — is
a first-class button at one station and an undocumented side effect of typing a short number
everywhere else.

Worse: `/floor/qc` redirects to `/finished-goods`, so QC's real board is `FinishedGoods.jsx`,
which posts straight to `/complete` and has **no partial support whatsoever**. An inspector
working 50,000 cartons over three days must either sit on the batch or close it early. This is
the station that credits Finished Goods stock.

## Goal

Every station offers the partial-run option explicitly, through the same two doors, with the
same words.

## Scope

| Board | Stations | Row "Day count" button | Up-front toggle in Complete |
|---|---|---|---|
| `client/src/pages/Section.jsx` | cutting, printing, coating, lamination, foiling, embossing, die cutting | add | add |
| `client/src/pages/SortPaste.jsx` | sorting + pasting | already present | add |
| `client/src/pages/FinishedGoods.jsx` | QC | add — nothing today | add |

Out of scope: Print Planning (a planning board, not a counting station — it already renders
partial state and routes to `/floor/printing` to process).

## Design

### Two doors, one engine

The user asked for both entry points. To avoid two code paths drifting apart, the day-count
body that currently lives inline in `Section.jsx` is extracted into a shared module,
`client/src/components/DayCount.jsx`:

- `useStageRuns(stageId)` — fetch/refresh the run log, delete a run
- `postRun(stageId, { good, scrap, reason })` — **the single save path**
- `<RunLogPanel>` — the "Recorded so far" day table
- `<ModeChoice>` — the Partial / Final two-card selector
- `<DayCountDialog>` — self-contained modal behind the row button

Both doors call `postRun`. Net effect on `Section.jsx` is a refactor that removes duplication
rather than adding it.

### Behaviour

- **Available any time a stage is started.** Row button shows on running and partially-done
  rows. Not on pending rows — the server rejects those (`production.js:736`). The one exception
  is QC on Finished Goods, where the stage is often still `pending`; there the partial path
  starts the stage first, mirroring what `submitInspection` already does.
- **Counters stay cumulative** for non-QC stations (type what the machine reads; today's delta
  is computed and shown). **QC enters today's accepted/rejected.** Rework, inspector and the FG
  credit remain final-only. These semantics are unchanged — they are simply reachable now.
- **The shortfall guard stays.** If an operator picks Final and types a short figure, they still
  get the amber "partial or final?" challenge. The new toggle makes partials *discoverable*; the
  guard catches the *accidental* case. They serve different failures.
- **Capacity is surfaced.** The dialog shows remaining upstream headroom so a started-ahead
  station understands why a run would be capped, rather than eating a raw 409.

### Server

No changes. `POST /job-stages/:id/runs` (`production.js:729`) already accepts a run on any
started, not-completed stage, flips `in_progress` → `partially_completed`, caps against
upstream available, and audits. This is a client-only change, so live plant data is untouched.

## Wording

"Day count" everywhere, matching what Sort & Paste operators already say. Not "Partial",
which describes the record rather than the act.

## Row layout

Printing rows will carry `Sheets · Hold · Day count · Complete`. Four buttons is a lot, but
floor operators should not hunt through a menu for a daily action, so all four stay visible.

## Verification

In the real running app, logged in, at desktop breakpoint — not a mock:

1. Record a partial from the row button on a Section station → PARTIALLY DONE, run log correct
2. Record a partial via the toggle inside Complete → same result, same log
3. Record a QC partial on Finished Goods → stage partial, **FG not yet credited**
4. Final QC pass → FG credited with the full accepted total
5. Confirm the shortfall guard still fires when Final is chosen with a short counter
