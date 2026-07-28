# Live Floor redesign — section bands, three jobs a machine, control on the board

**Date:** 2026-07-28
**Status:** approved

## The problem

The Live Floor page renders the plant twice and lets you do almost nothing to it.

### It is two boards, not one

`Floor.jsx` paints a **Machine Control** grid of every machine
(`Floor.jsx:350-364`, up to four columns) and then a **Sections** grid of every
section (`Floor.jsx:372-430`, three columns). A press appears in the first grid
as a card and again in the second as the `2/3 machines up` caption of its
section. Nothing tells you which machine a section's queued chip will run on,
because the two grids are laid out independently and never reference each other.

On a quiet shift both grids are mostly empty cards. Ten machine cards reading
`Nothing lined up` at ~180px each, then eight section tiles reading
`Section clear` at ~200px each, is roughly 1,400px of vertical scroll carrying
no information. The page is at its longest precisely when it has least to say.

### The same job is listed under every machine of its type

`/floor/machines` splits a machine's work into `assigned` (pinned via
`js.machine_id`, or `jc.machine_id` for printing) and `shared`:

```js
// floor.js:351-354
const shared = entries
  .filter(e => e.machine_id == null && e.stage === m.type
    && (e.state === 'queued' || e.state === 'incoming'))
```

`shared` is computed per machine from the same unpinned pool, so a die-cutting
job that has not started is handed to all seven die-cutting machines. Seven
cards, one job, no indication it is one job. Because `jobs.slice(0, 3)` is
applied after `[...assigned, ...shared]`, those duplicates also evict real
pinned work from the top three.

### You cannot act on what you see

The board offers Start and Complete (`Floor.jsx:67-85`) and machine status
(`Floor.jsx:152-159`). Everything else is a page away. Hold
(`POST /job-stages/:id/hold`) exists and is not reachable here. Extra sheets
(`POST /extra-sheets`) exists and is not reachable here. Reordering a queue does
not exist at all outside Print Planning's press lanes.

## Design

### 1. One stack of section bands

The Machine Control grid is deleted. The page becomes a single vertical stack of
bands in `FLOOR_NAV` order — cutting, printing, coating, lamination, foiling,
embossing, die cutting, Sort & Paste. Every machine now lives inside the band
for its section, so a machine is named once on the page.

A band has two shapes:

**Clear** — one ~44px row. Icon, name, `clear · 0 in queue · 7 machines idle`,
chevron to the workspace. No machine sub-rows, no empty-state box. This is the
whole fix for the scroll: on the shift in the screenshot, seven of eight bands
render as single lines.

**Active** — the full band: header, a block per machine, then the section queue.

A band ignores its clear/active state and always expands when it matches the
search, so searching a board size still opens an idle section — which, as the
existing comment at `Floor.jsx:280-282` notes, is exactly when someone looks a
section up.

### 2. Inside an active band

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⎙ Printing        2 of 3 machines up      [3 running] [12 in queue] › │
├──────────────────────────────────────────────────────────────────────┤
│ ● CI-1 Komori   running · 4,200 out today                          ⋯ │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │ JC-1042 · Nicostar 10                                          │ │
│   │ running 2h 14m · 27,000 sheets · Shiv        ⏸    ⊞    ✓        │ │
│   └────────────────────────────────────────────────────────────────┘ │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │ JC-1051 · Zerodol SP                                           │ │
│   │ queued · 18,000 sheets                       ▲    ▼    ▶        │ │
│   └────────────────────────────────────────────────────────────────┘ │
│   +4 more in this queue                                              │
│ ○ CI-2 Komori   idle · nothing lined up                            ⋯ │
├──────────────────────────────────────────────────────────────────────┤
│ Section queue — not yet on a machine                                 │
│   JC-1088 · Telmisartan 40        queued · 9,000 sheets  ▲  ▼  ▶     │
└──────────────────────────────────────────────────────────────────────┘
```

**Machine block.** Name, live dot, `running · N out today`, and the `⋯` menu
carried over unchanged from `MachineCard` — view machine log, back in service,
mark idle, under maintenance. Under it, at most three jobs **pinned to that
machine**, running first, with its own `+N more` when it holds more. An idle
machine with no pinned work collapses to the single line shown above rather than
an empty-state box.

**Section queue.** The unpinned pool — today's `shared` — listed **once per
section** instead of once per machine, top three, `+N more`. Bench sections
(foiling, embossing) have no machines and are just this block.

Machine `jobs` therefore stop carrying `shared` entries. `slice(0, 3)` now
applies to genuinely pinned work, so a running job can no longer be pushed off
a machine card by three copies of the same unpinned queue.

### 3. Job row controls

The row reads: JC number, gang chip, product · customer, state and elapsed,
quantity and unit, operator, and the `BOARD PENDING` flag — the same facts
`JobChip` and `MachineJobRow` show today, merged into one row so the board has
one job component instead of two.

| State | Controls |
|---|---|
| queued / incoming | ▲ ▼ move · ▶ start (keeps the line-clearance gate) |
| running | ⏸ hold · ⊞ extra sheets · ✓ complete |
| hold | ▶ resume |
| any | ↗ open in the section workspace, filtered to this JC |

Gating reuses the rules already enforced server-side; this introduces no new
role:

- **start / complete / move** — admin + production (the existing `canOperate()`)
- **hold / resume** — also allows planner (`canHold`, `production.js:997`)
- **extra sheets** — production + planner (`canRequest`, `extrasheets.js`)

Start keeps routing through `LineClearancePanel` on the stations that require it
(`needsClearance`), and the merged Sort & Paste band keeps sending its chips to
`/floor/sort-paste` rather than opening the quick modals, because that station
enforces the waste gate.

### 4. Extra sheets raises a request; it does not issue board

The ⊞ control posts to the existing `POST /extra-sheets` and creates a CI-XS
**request**. Approval and physical issue stay where they are — that chain is the
entire point of the control, and a floor button that issued board would defeat
it.

The button renders only when the server would actually accept the request, so
the floor never offers an action that 409s:

- stage is in `SHEET_STAGES` (cutting → die cutting) and `unit = 'sheets'`
- stage status is `in_progress` or `hold`
- no `pending`/`approved` request already open on that job card — the server
  enforces one at a time

Otherwise the control is hidden rather than shown-and-rejected.

**Dependency on the in-flight approvals wave.** The working tree carries an
uncommitted notifications/approvals change to `extrasheets.js` that moves
approval from the planner role to a `users.xs_approver` flag (the plant head)
and rings that user's bell via `notify()` on request creation. Because the floor
posts to the same endpoint, it inherits both for free — no floor-side work. The
success toast should say the request has gone to the plant head for approval and
link to `/extra-sheets`, not claim sheets were issued.

### 5. Reordering — a floor order that leaves the planner alone

`queue_pos` cannot carry this. It lives on `job_cards`, so it is one number per
job shared by every section, and it is the same field Print Planning writes when
a press lane is dragged (`production.js:665`). A floor move through `queue_pos`
would silently reshuffle a planner's press lane from an unrelated station.

Queued work also cannot be reordered "within a machine", because queued work is
not on a machine: `job_stages.machine_id` is written when a stage **starts**
(`production.js:563`), and ahead of time only for printing
(`production.js:660`). Every other section's queue is unpinned, so a
machine-scoped move would appear on the printing band alone.

So: a new nullable `floor_pos` on `job_stages`, written only by the floor.

- **Migration** `supabase/migrations/0008_floor_queue_order.sql`, with its twin
  in `db.js` init: `ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS floor_pos
  INTEGER`. Lands after the in-flight `0007_notifications_approvals.sql`.
- **`POST /floor/queue/move`** `{ job_stage_id, dir: 'up' | 'down' }`, gated
  `canRun`. In one transaction: build the lane (same `stage`, not completed,
  same pinning group — pinned to machine M, or unpinned), normalise `floor_pos`
  to 1..N in the lane's current board order, swap with the neighbour, and audit
  as `floor_reorder`. Normalising first means the first move on a lane of all-
  NULL positions behaves, which is every lane on day one.
- **Sorting.** `floor_pos` becomes the first key in `laneSort` (`floor.js:220`)
  and `jobSort` (`floor.js:324`), ahead of `queue_pos`, and in the queue sorts
  at `floor.js:479` and `floor.js:600`. The floor's order therefore still holds
  when you click through to the section workspace.
- `queue_pos` is never written by the floor. Print Planning is untouched.

### 6. Endpoints

Both existing endpoints keep their shape — `/floor/machines` has a second
consumer in `Production.jsx:52` (which reads only `id` and `name`) and `/floor`
is polled by `AppLayout.jsx:269` for the nav counts (which reads only lane
lengths). Neither breaks:

- `/floor` gains, per section, its machines with their pinned `jobs`/`more`/
  `live`/`today`, plus the section-level unpinned lane. `Floor.jsx` drops to one
  request.
- `/floor/machines` keeps its flat array for `Production.jsx`.
- The machine-jobs computation moves into one helper in `floor.js` used by both,
  so the two boards cannot drift — the failure mode that produced the duplicate
  `shared` lists in the first place.

### 7. Files

`Floor.jsx` is 574 lines and this adds a control cluster, a move action and an
extra-sheets modal. Rendering splits out so each file holds one thing:

- `client/src/components/floor/SectionBand.jsx` — clear vs active, header, search
- `client/src/components/floor/MachineBlock.jsx` — machine row, `⋯` menu, its jobs
- `client/src/components/floor/JobRow.jsx` — one job, one control cluster
- `client/src/pages/Floor.jsx` — page shell, data loading, modals

`JobChip` and `MachineJobRow` are both replaced by `JobRow`; `MachineCard` is
replaced by `MachineBlock`.

## Trade-off accepted

Three jobs a machine plus three in the section queue hides queued work that
today's four-lane tile lists in full. The band header still reports true totals
(`12 in queue`), `+N more` is explicit about what is hidden, and the full list is
one click into the workspace. Anik accepted this; the cap is a single constant if
it wants raising.

## Out of scope

- Drag-and-drop reordering. Arrows only — the board is used on plant terminals.
- Approving or issuing extra sheets from the floor (see §4).
- QC, which `FLOOR_NAV` already excludes in favour of the Finished Goods module.
- Any change to Print Planning, `queue_pos`, or press lane assignment.
