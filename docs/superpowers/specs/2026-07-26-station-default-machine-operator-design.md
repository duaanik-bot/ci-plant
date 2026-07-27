# Station Default Machine + Operator — Design Spec

**Date:** 2026-07-26
**Module scope:** Floor stations (`Section.jsx`), Machines master, `/job-stages/:id/start`
**Type:** Prefill (never a lock) + one silent-misattribution bug fix

## Problem

Starting a job at a station opens the Start modal, where the operator picks a
machine and an operator before ticking line clearance. At **Cutting** and
**Printing** that pick carries no information:

- **Printing** — the press was already decided on the Print Planning board.
  Re-asking at the press is pure re-entry.
- **Cutting** — one man (Ankit) crews both cutting machines, and board cutting
  is the normal path.

The owner wants both fields **filled by default** at Cutting and Printing. Every
other station keeps manual selection.

### The silent bug this uncovers

The modal currently defaults the machine to `data.machines[0]` — the
**alphabetically first** machine of the section — and **posts it**:

```js
onClick={() => { setStarting(r); setOperator(''); setMachineId(data?.machines?.[0]?.id ? String(...) : ''); ... }}
```

Server-side, the planned-press fallback only fires when the client posts
*nothing*:

```js
if (!machineId && st.stage === 'printing' && jc.machine_id) machineId = jc.machine_id;
```

Because the client always posts something, the fallback is dead code in
practice. Consequences on live data:

| Station | Alphabetically first | Should be |
|---|---|---|
| Printing | Offset Printing Press No. 1 | the press Print Planning assigned |
| Cutting | Automatic Label Cutting Machine | Board Cutting Machine |

One cutting run in the database is already recorded against the Automatic Label
Cutting Machine, and a printing run is recorded against Press No. 1. Machine
utilisation, the logbook and the machine board all inherit the error.

## Live plant data this is designed against

| Station | Machines | Active assigned crew |
|---|---|---|
| **cutting** | Board Cutting Machine (11), Automatic Label Cutting Machine (12) | Ankit — on both |
| **printing** | Press No. 1 (8), No. 2 (9), No. 3 (13) | Modi / Dileep / Shiv Kumar — exactly one each |
| die_cutting | 7 machines | Birju, Lakhan, Rajesh, Sonu Pandit, Surjeet — all shared |

Every cutting and printing machine has **exactly one** dedicated operator, which
is what makes the operator auto-pick unambiguous. Die cutting shares five
operators across seven machines and is therefore **out of scope** — confirmed
with the owner.

## Resolution rules

`AUTO_ASSIGN_SECTIONS = ['cutting', 'printing']`. Outside this set nothing
prefills.

### Machine

First match wins:

1. **Stage's own machine** (`js.machine_id`) — already set, authoritative.
2. **Printing: the planned press** (`jc.machine_id`, exposed on the queue row as
   `press_machine_id`). The Print Planning board decided it; the modal honours it.
3. **The station's default machine** — new `machines.is_default` flag.
4. **The station's only active machine**, when there is exactly one.
5. Otherwise blank.

A resolved machine that is not in this station's active machine list (retired,
deactivated, out of the user's press scope) is discarded and resolution
continues at the next rule.

### Operator

First match wins:

1. The resolved machine's crew, **when it has exactly one active member**.
2. The queue row's `operator` — `COALESCE(js.operator, machine crew)` from
   `STAGE_VIEW`, i.e. an operator explicitly planned upstream — **but only if
   that name is in the resolved machine's crew**, so switching the machine never
   leaves a foreign operator behind.
3. Blank — the server then falls back to `st.operator || req.user.name`, as today.

### Why a `is_default` flag rather than an implicit rule

Lowest id happens to be right today (11 < 12) and needs no schema change, but it
is invisible and silently moves the day a machine is added or retired.
Last-used was considered and rejected by the owner. One boolean on a master the
owner already edits keeps the rule explicit and changeable without a release.

## UI

The Run assignment panel currently shows two dropdowns. At Cutting and Printing
it becomes a resolved assignment line:

```
Run assignment                                    Cutting
┌──────────────────────────────────────────────────────┐
│  Board Cutting Machine · Ankit    [AUTO]     Change  │
└──────────────────────────────────────────────────────┘
```

- **Change** reveals the existing two dropdowns, unchanged in behaviour. Nothing
  is locked — a broken press or a relief operator is one click away.
- Once revealed, the pickers stay revealed for that modal.
- If resolution yields no machine (nothing planned, no default, several
  machines), the panel falls back to the plain dropdowns — no empty AUTO card.
- The **AUTO** chip is what distinguishes a prefilled decision from a silent
  guess; it disappears the moment the operator changes either field.

### Sections that stay manual

The blind `machines[0]` default is replaced by an explicit
`— Select machine —` blank option. "For the rest I choose" becomes literally
true, and no machine is recorded by silence. The server already treats a missing
`machine_id` as `null`, and only accepts a machine whose `type` matches the
stage.

## Server changes

`POST /job-stages/:id/start` keeps accepting a posted machine — a deliberate
press switch must stay possible. It gains one audit line:

> when `st.stage === 'printing'` and a posted `machine_id` differs from
> `jc.machine_id`, write an `audit('job_stage', id, 'press_override', …)` naming
> both presses.

The switch then shows on the universal timeline instead of vanishing. No new
block, no new 409.

## Data model

```sql
ALTER TABLE machines ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0;
```

Idempotent, placed after `CREATE TABLE machines` in `init()` per the repo rule,
with `supabase/migrations/0001_baseline_schema.sql` regenerated by
`npm run db:baseline`.

Seeding: the Board Cutting Machine is flagged by a guarded one-off statement
that only fires when the cutting category has **no** default yet, so it never
overrides a later choice by the owner.

**One default per category.** Enforced on write in `masters.js`: saving a machine
with `is_default = 1` clears the flag on every other machine of the same `type`,
inside the same transaction.

## Masters → Machines

New field `Default for this station` (select 1/0, same idiom as `active`), and
the column added to the machines list so the current default is visible at a
glance without opening a row.

## Files

| File | Change |
|---|---|
| `server/src/db.js` | `is_default` column + guarded seed |
| `supabase/migrations/0001_baseline_schema.sql` | regenerated |
| `server/src/routes/masters.js` | allow `is_default`; single-default-per-type on save |
| `server/src/routes/production.js` | `press_override` audit |
| `client/src/pages/Section.jsx` | resolution helpers, assignment card, blank option elsewhere |
| `client/src/pages/Masters.jsx` | default field + column |

`floor.js` needs no change — `/floor/:section` already returns `m.*` with the
crew attached, so `is_default` flows through.

## Testing

Server tests (`npm test -w server`):

- posting no `machine_id` at printing still inherits the planned press
- posting a different press is accepted **and** writes `press_override`
- a machine of the wrong `type` is still rejected to `null`
- saving `is_default = 1` clears the sibling default in the same category

Client resolution is pure and testable without a DOM:

- printing resolves to the planned press over the station default
- cutting with no plan resolves to the flagged default
- a resolved machine with two crew members fills the machine, leaves the operator blank
- an out-of-scope planned press falls through to the next rule
- a non-auto section resolves to nothing

Manual verification in the real running app (per project practice): Cutting and
Printing modals open filled; Change reveals working dropdowns; Coating opens
with `— Select machine —`; a started run records the right machine in the
logbook.

## Out of scope

- Die cutting and every other station — manual, unchanged.
- Sort & Paste (`SortPaste.jsx`) — has no machine picker in its start modal.
- Any change to how Print Planning assigns presses.
- Auto-starting a job without the line clearance checklist. Clearance is
  mandatory at every station except QC and stays mandatory; this spec removes
  the picking, not the checklist.
