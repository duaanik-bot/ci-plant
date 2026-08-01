# Press operator picker — one device, three men, three queues

**Date:** 2026-08-01 · **Branch:** `press-operator` · **Status:** built, verified, shipped to
production (Anik sanctioned commit + deploy in session). Rebased onto `origin/main@95775cf`,
which had merged `cutting-row-density` — the other change to `Section.jsx`. No migration.

## The problem

All three press operators enter production against **one device and one login** at
`/floor/printing`. Two things break because of that:

1. **Every man sees all three presses.** Shiv Kumar has to read past Dileep's and
   Rahul's jobs to find his own next job, on a page that already carries ten rows
   and a seven-card KPI strip.
2. **Entries are attributed to the wrong person.** `/job-stages/:id/complete` and
   `/runs` fall back to `st.operator` — whoever *started* the stage — and then to
   `req.user.name`, the shared login. So a job Shiv starts and Dileep finishes is
   filed entirely under Shiv. Nothing on the floor screen can say otherwise.

## The decision

**A man's queue is his press.** The link is `machine_operators`, already the source
of truth for the Start modal's crew picker and for the Press Line-up report's
column headers.

That choice is forced by the data: `job_stages.operator` is only stamped when a run
*starts*, so filtering on the operator name would show a queued job to nobody. The
press is known from the moment Print Planning pins the card.

Today that resolves to:

| Press | Crew |
| --- | --- |
| Offset Printing Press No. 1 (5 Colour + Coater) | Shiv Kumar |
| Offset Printing Press No. 2 | Dileep |
| Offset Printing Press No. 3 | Rahul Kumar |

**Modi is on the printing crew with no press, so he gets no chip.** Under this
definition he has no queue. Giving him one is an assignment in Masters → Machines,
not a code change — which keeps that screen the one place that says who runs what.

## The control

A segmented rail on the toolbar row, immediately right of the tabs, printing only:

```
[ Production Queue 10 ][ Completed Runs 3 ][ Audit Trail ]   👤 [ All presses ][ Shiv Kumar · P1 ][ Dileep · P2 ][ Rahul Kumar · P3 ]
```

Chips are derived from `data.machines`, which `GET /floor/:section` already returns
with each press's `operators[]` attached (`floor.js:909`). Assign a second man to a
press in Masters and a fourth chip appears with no code change. One chip per
(machine, operator) pair, so a man on two presses gets two chips and each one means
one press — never a silent union.

The selected chip is filled and loud, carrying the full name, because the next man
at the keyboard has to notice whose name the screen is wearing.

Gated by `OPERATOR_PICKER_SECTIONS = ['printing']`. Widening it to cutting later is
one word, and it is a plant decision, not a code cleanup — the same reasoning
`runAssignment.js` already applies to `AUTO_ASSIGN_SECTIONS`.

## What a selection does

### Queue narrows to that press

Client-side, on `machine_id ?? press_machine_id` — both already on the row, and the
same `effectiveMachineId` rule the server uses to scope a press-scoped login
(`floor.js:26`).

### The serial renumbers itself

No new code. `S.No.` is `i + 1` over the visible rows, and the page already polls
every 5s. Drag a card up a lane in Print Planning and its serial here moves within
seconds. Order stays Planning's `queue_pos` via `orderBoard`; the floor's own
`floor_pos` override is untouched, and this page still never writes either.

### Completed Runs narrows to the same press

### The KPI strip recomputes over the filtered rows

Not optional. A strip reading "In Queue 10" above a three-row list is a lie, and it
breaks the standing rule that a KPI must count the same way as the list beside it.

All seven KPIs are derivable client-side from `data.queue` and `data.completed` —
the very arrays the server counted (`floor.js:882`). `kpisFor()` mirrors that block
line for line so the two can never drift.

**On "All presses" the server's own object passes through untouched.** No recompute,
no rounding difference, zero change to today's numbers.

### Entries carry the picked name

- **Start** already posts `operator`; it now comes from the pick rather than from
  `resolveOperator`'s crew fallback.
- **Complete** and **Day count** gain `operator` in the body. Both routes already
  read `req.body.operator` (`production.js:1586`, `:1355`) and `stage_runs.operator`
  already exists. **No server change, no migration.**
- **Hold** is the one gap: `/job-stages/:id/hold` takes no operator and audits under
  the shared login. One server line puts the picked name in the audit detail.

The pick is a default, not a lock — the Start modal's operator dropdown still opens
and still overrides.

## Shift carryover

The pick persists per device in `localStorage`, so it survives reload and the 5s
poll. The risk that creates is real: the night man's name still on screen at 7am,
silently filing the morning's output under him.

So the stored value carries the date it was chosen and **resets to "All presses" on
a new calendar day**. Alongside that, the Start and Complete modals show
`Recording as — Shiv Kumar · Change`, so the name is confirmed where the write
happens, not only in the header.

## Not doing

- **No login or permission change.** This is a device-level identity sitting on top
  of the shared login. `req.user.name` still records who is signed in, so the audit
  trail keeps both facts — who was at the keyboard and who ran the press.
- **No reordering from this page.** Queue order remains Print Planning's.
- **No server-side scoping.** The existing `floorScope` press-scoped *login* path is
  untouched and composes correctly: a scoped login already sees one press, and the
  rail then offers only that press's chips.

## Modules

`client/src/lib/operatorScope.js` — pure, no React:

| Export | Contract |
| --- | --- |
| `operatorChips(machines)` | `[{ key, name, machineId, machineName, short }]`, one per (machine, active crew member), machine order preserved. A machine with no crew contributes nothing. |
| `rowsForOperator(rows, chip)` | `rows` filtered to that chip's machine. A null chip returns `rows` unchanged (identity, not a copy-with-filter). |
| `kpisFor(queue, completed)` | The seven KPIs, mirroring `floor.js:882`. |
| `readPick(section, today)` / `writePick(section, key, today)` | localStorage with the calendar-day reset. |

Tested from `server/src/operator-scope.test.js` — the server runner is the only one
in the repo, the precedent being `run-assignment.test.js` over
`client/src/lib/runAssignment.js`.

## Test cases

1. Chips come out one per crewed press, in machine order; a crewless press is absent.
2. A press with two assigned men yields two chips, both pointing at that press.
3. `rowsForOperator` matches on `machine_id`, falls back to `press_machine_id`, and
   never matches a row pinned nowhere.
4. A null chip returns every row.
5. `kpisFor` over the full arrays reproduces the server's numbers exactly.
6. `kpisFor` over one press's rows counts only that press.
7. `yield_today` is null, not `NaN` or `0`, when nothing was received today.
8. A pick stored yesterday reads back as null; today's reads back intact.
9. A pick naming a man who no longer has that press reads back as null rather than
   filtering to a press that is no longer his.
