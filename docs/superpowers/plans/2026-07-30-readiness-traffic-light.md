# Readiness Traffic Light — Implementation Plan (Deploy 1)

> **For agentic workers:** own ONLY the files listed under your task. Never touch a file another
> task owns; the orchestrator wires shared files. Spec:
> `docs/superpowers/specs/2026-07-30-collaboration-system-design.md` (Part B).

**Goal:** An operator looking at a job knows without asking anyone whether they can start it:
RED = the ERP will refuse, AMBER = runnable but something is outstanding, GREEN = go. Plus a
checklist saying exactly what is missing, a manual "Ready to Run" override for supervisors, and
Print Planning cards slim enough to see a whole press day at once.

**Architecture:** The light is DERIVED, never a new source of truth. `readiness()` in helpers.js
already computes every fact; `tooling_detail` already carries a per-item three-state checklist the
client currently discards. One new pure module turns those facts into a light + checklist. The only
genuinely new computation is "board cut". The only new writes are four `job_cards` override columns.

**Tech stack:** ESM Node + pg (`q/one/tx` from `../db.js`), node:test, React 18 + Tailwind +
lucide-react + `client/src/components/ui.jsx` primitives.

**House rules:** comments say WHY in the repo's voice, never changelog. `tx` errors:
`throw Object.assign(new Error(msg), { status: 409 })`. Route errors: `res.status(400).json({error})`.
Audit via `audit(entity, id, action, detail, qc, req.user.name)`; notify via
`notify(userIds, {kind,title,body,link,refTable,refId}, qc)`.

---

## The contract (both agents build to this, verbatim)

`readinessLight(input)` returns:

```json
{ "light": "red|amber|green",
  "pct": 78,
  "overridden": false,
  "override": null,
  "blockers": ["Artwork not locked"],
  "items": [
    { "key": "artwork",  "label": "Artwork approved", "state": "ok|pending|blocked|na",
      "note": null, "hard": true, "tracked": true }
  ] }
```

`state`: `ok` satisfied · `pending` outstanding · `blocked` a hard stop · `na` not applicable to
this job (dropped from `pct`). `pct` = ok ÷ tracked, rounded. `light`: any `blocked` ⇒ red; else any
`pending` ⇒ amber; else green. An active override forces green and sets `overridden`.

Nine items, in this order and with these keys:
`artwork, board_available, board_cut, plate, die, shade, ink, machine, released`.

---

### Task 1: `server/src/readiness-light.js` + `readiness-light.test.js` (server agent)

Style-match `server/src/approvals.js` / `chat-rules.js` (pure, no DB imports) and their tests.

Input shape the module takes (the caller assembles it; the module never queries):

```js
readinessLight({
  gates,            // the object readiness() returns: { artwork, tooling, tooling_detail, material, material_pending, ... }
  cuttingStatus,    // 'completed' | 'in_progress' | 'partially_completed' | 'pending' | null (null = no cutting stage on this route)
  machineId,        // job_cards.machine_id — null when unassigned
  finalisedAt,      // job_cards.finalised_at — null when not released
  shade,            // { eligible, hard, reason } from productionEligibility, or null when no card
  toolingOk,        // order_lines.tooling_ok — the absolute manual override of the tooling gate
  override,         // { on, by, at, reason } | null
})
```

Rules — each gets a test:

- **artwork** — `gates.artwork` ⇒ ok, else **blocked** (`hard: true`). The only tooling-independent
  hard stop at job-card creation.
- **board_available** — `gates.material` ⇒ ok; `gates.material_pending` ⇒ pending (note: "on order");
  neither ⇒ **blocked** with the shortfall in the note.
- **board_cut** — `cuttingStatus === 'completed'` ⇒ ok; `null` ⇒ **na** (route has no cutting stage);
  anything else ⇒ pending.
- **plate / die** — read the matching family from `gates.tooling_detail`: `ready` ⇒ ok,
  `not_ready` ⇒ pending, `missing` ⇒ pending with note "not registered", absent family ⇒ na.
  **A bad die is PENDING, never blocked** — `createJobCardForLine` puts tooling in `pending[]`, not
  `blocked[]`, so the plant runs these jobs and RED would be a lie. Test this explicitly.
  When `toolingOk` is set, an otherwise-failing family still reports its real state but gains
  `note: 'accepted by planning'` — never a green tick, or an operator walks to a press with no die.
- **shade** — `shade === null` ⇒ na; `eligible` ⇒ ok; `!eligible && hard` ⇒ **blocked**;
  `!eligible && !hard` ⇒ pending. Note carries `shade.reason`.
- **ink** — always `state: 'na'`, `tracked: false`, note "not tracked in the ERP yet". Ink stock is
  not modelled anywhere; showing it green would be a fiction, and counting it would cap the plant
  below 100% forever.
- **machine** — `machineId` ⇒ ok, else pending.
- **released** — `finalisedAt` ⇒ ok, else pending.
- **override** — when `override.on`: `light='green'`, `overridden: true`, `override` echoed. Items
  and `pct` still report the truth underneath. Test that an overridden job with a hard blocker still
  lists that blocker.
- `blockers` = labels of `blocked` items, for the tooltip.

Also export `LIGHT_LABEL = { red: 'Blocked', amber: 'Partly ready', green: 'Ready to run' }`.

VERIFY: `cd server && node --test src/readiness-light.test.js` green, and `node --check` both files.

### Task 2: server wiring (server agent, same agent as Task 1)

**Files:** `server/src/routes/production.js`, `server/src/routes/floor.js`, `server/src/routes/orders.js`.

1. A shared assembler in `helpers.js` is NOT wanted (that file is already 1300 lines and shared with
   other sessions). Instead add `server/src/readiness-light.js`'s companion
   `export async function lightForJobCards(cards, oc)` **inside `readiness-light.js`** — it takes job
   cards that already carry `readiness`-derived fields and batch-loads the two things they lack:
   the cutting stage status per job card (one query, `WHERE job_card_id = ANY($1) AND stage='cutting'`)
   and the shade eligibility (reuse the existing per-product shade lookup pattern in
   `readinessBatch`). Never N+1.
2. `GET /print-planning` (production.js ~689): attach `light` to every card.
3. `GET /planning` (orders.js ~765): attach `light` to every line, using the readiness it already
   computes. Cutting status is null for un-carded lines ⇒ `board_cut` is `na` there, which is right.
4. `GET /floor` (floor.js ~151): attach `light` to each job row.
5. `POST /job-cards/:id/ready-override` in production.js — body `{ on: bool, reason: string }`.
   Guard `requireRole('planner', 'production')` (admin implied). Reason mandatory when turning ON
   (400 otherwise). In one `tx`: write the four columns, `audit('job_card', id, 'ready_override',
   …)`, and when turning ON notify the assigned press operator(s) — resolve them via the existing
   `machine_operators` mapping used by print planning — with a link to `/print-planning`. Return the
   fresh card.

VERIFY: `node --check` each edited file; `cd server && node --test src/*.test.js` all green.

### Task 3: migration 0011 (ORCHESTRATOR — do not touch, agents)

`job_cards`: `ready_override INTEGER NOT NULL DEFAULT 0`, `ready_override_by TEXT`,
`ready_override_at TIMESTAMPTZ`, `ready_override_reason TEXT`. Mirrored in `db.js` init() and a
`supabase/migrations/0011_ready_override.sql`, baseline regenerated.

### Task 4: `client/src/components/Readiness.jsx` (client agent)

**Files:** CREATE `client/src/components/Readiness.jsx` only. Touch nothing else.

Exports three things, all driven by the `light` payload above:

- `<TrafficLight light={light} size="sm|md" />` — a single dot: red `#FF3B30`, amber `#FF9500`,
  green `#34C759`, each with a soft matching glow ring so it reads at a glance on a plant monitor.
  When `overridden`, the green dot gets a thin white ring and a tiny hand icon. `title` attribute
  carries `LIGHT_LABEL` plus the first blocker.
- `<ReadinessChecklist light={light} />` — the nine rows: state icon (Check / Clock / AlertTriangle /
  dash for na), label, note in muted text. Header shows `{pct}%` and "6 of 8 ready" using the same
  voice as the existing `LineClearance` panel ("{done}/{n} confirmed"), which the plant already
  knows. `na` rows render greyed with the note, never as failures. When `overridden`, a banner:
  "Marked ready to run by {by} · {reason}" in amber-on-white, above the list.
- `<ReadinessPopover light={light} children />` — wraps a trigger; click opens the checklist in a
  small glass panel (`glass rounded-[18px] shadow-modal animate-liquidPop`), closes on outside click
  and Escape. This is what a table cell and a kanban card both use, so the checklist looks identical
  everywhere.

Match the app's Liquid-Glass voice; study `ReadinessCell` in `client/src/pages/Planning.jsx:87` and
`LineClearance.jsx` first. No new dependencies.

VERIFY: `npx esbuild client/src/components/Readiness.jsx --loader:.jsx=jsx --jsx=automatic --outfile=/dev/null`.

### Task 5: Print Planning card slimming + light (client agent, second agent)

**Files:** `client/src/pages/PrintPlanning.jsx` only.

Current card is ~138px over seven stacked rows; target ~72–80px so a lane shows roughly double.
Keep every fact, spend fewer rows:

1. Header row: grip · status dot · `jc_number` · state word · **`<TrafficLight>`** · hover-revealed
   `DangerZone` menu. Replace the always-mounted 28px `ActionMenu` button with
   `opacity-0 group-hover:opacity-100` so the row collapses to its 20px text height.
2. Merge product + customer into ONE truncated line: `{product_name} · {customer_name}`.
3. Merge the metrics row and the footer into ONE line: `{sheets} sh · {colors} col` · operator ·
   delivery date. Collapse gracefully when there is no operator (today it renders an empty `<span/>`
   and still costs a row).
4. Replace `ReadyTicks`' two text-labelled pills with the traffic light in the header; wrap the card
   in `<ReadinessPopover>` so tapping the dot shows the checklist. **`ReadyTicks` is also used by the
   chooser modal at ~line 779 — update that call site too, or delete the component if unused after.**
5. Outer padding `px-3.5 py-2.5` → `px-3 py-2`.
6. KEEP: the progress bar for running/partial jobs, the hold reason, the gang stack wrapper, the
   left status edge, drag behaviour. These are load-bearing.

VERIFY: esbuild the file, and report the new estimated card height by counting rows/margins.

### Task 6: Planning + Live Floor light (ORCHESTRATOR)

- `Planning.jsx`: `ReadinessCell` gains the traffic light + popover, keeping the existing per-gate
  chips underneath (they are more informative for a planner than a single dot).
- `client/src/components/floor/JobRow.jsx`: add `<TrafficLight>` and the popover to the row.
- Both files are shared with other sessions' recent work — orchestrator only, exact-string edits.

### Task 7: Verify + ship (ORCHESTRATOR)

`npm run verify`; adversarial review wave; browser e2e against the real app with UAT-scoped data
proving red/amber/green on real jobs and the override notifying an operator; prod backup; migration
0011 to Supabase BEFORE the code; clean-worktree verify; push.
