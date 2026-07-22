# Tooling Hub — Seamless Enhancement · Design

**Date:** 2026-07-10
**Module:** Tooling Hub (`client/src/pages/Tooling.jsx`, `server/src/routes/tooling.js`)
**Goal:** Remove cognitive fatigue by (A) enforcing a hard visual + structural split between scrapped and active tooling, and (B) giving shade cards a fast, automated logistics loop from Triage → Press → Vault.

---

## Current state (as-built, for grounding)

- **`tools` table:** `zone` ∈ {`incoming`, `making`, `in_rack`, `on_floor`} (locked by a CHECK constraint), `condition` ∈ {`Good`, `Fair`, `Poor`, `Scrapped`}, `active` (soft-delete). Append-only `tool_events` log. A tool reaching `in_rack` auto-flips waiting job lines to `ready`.
- **Scrapped is only a condition today** — a scrapped tool keeps its zone and looks identical to a live tool (only a gray status dot differs). This is the core confusion being fixed.
- **Shade cards** ride the same four zones; `on_floor` nominally means "issued to a machine" but **no machine/operator is recorded** on the tool.
- **Machines + operators exist:** `machines.type='printing'` with a `machine_operators` → `employees` crew join. The Floor's start-run modal already queries this shape (`floor.js` ~L379).
- **Migrations** are additive and safe (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` block in `db.js` ~L480). Adding a *new zone* is invasive (CHECK constraint), so new states are modelled as flags/condition, **not** new zones.
- **Stage completion** handler: `POST /job-stages/:id/complete` (`production.js:534`), runs inside a `tx` — the hook point for auto-return.

---

## Part A — Hard State Enforcement (Scrapped → Archive Hub)

### Decisions
- Scrapping **pulls the card off the live 4-zone board** and relocates it to a new **Archive Hub** tab. (Not muted-in-place.)
- Archive Hub holds **scrapped tools only** — deleted (`active=0`) tools stay hidden as today.

### Model
No schema change. `condition = 'Scrapped'` is the single source of truth. The tool stays `active = 1` (not deleted) but is filtered out of the live board and Ledger.

### Client (`Tooling.jsx`)
- Board and Ledger tool lists exclude `condition === 'Scrapped'`.
- New trailing **"Archive"** tab in the family tab strip (Plates · Dies · Blocks · Shade Cards · **Archive**). Cross-family; badge count = total scrapped; red-tinted when > 0. Selecting it swaps the content region to the Archive Hub and hides the zone board + Board/Ledger view toggle.
- **Archive Hub view:** scrapped tools grouped by family, each a **muted `ScrappedCard`**: `opacity-50`, `line-through` on code/title, a bold red **SCRAPPED** pill, and no zone/issue action affordances. Clicking opens the Spotlight in read-only mode.
- **Scrapped Spotlight:** zone "Move to" buttons and any shade-card Issue/Dock actions are **disabled**; a prominent red banner shows when it was scrapped and by whom (derived from the latest `condition` event); a single **Restore** action (planner role) sets condition back to `Fair`, returns it to the live board, and logs a `condition` event. Delete stays available.
- **"Needs Attention" KPI** no longer counts Scrapped (it now has its own home): becomes *Poor condition OR stuck-in-Making a week+*. The Archive tab badge carries the scrapped signal.

### Server
Essentially none. `/tooling/board` already returns scrapped tools (they are `active=1`); the client partitions them. Scrap and Restore both reuse the existing `PUT /tools/:id { condition }` endpoint, which already writes a `condition` event.

---

## Part B — Shade Card Control Dock & Vault

### Decisions
- Inline, in-column **Control Dock drawer** (no screen jump).
- Shade-card columns **relabel** onto existing zones (no literal new columns / zones).
- **Auto-return** when the card was issued against a tracked job stage; **one-tap fallback** otherwise ("Both").

### Model — additive migrations on `tools`
```sql
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_machine_id  INTEGER REFERENCES machines(id);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_operator    TEXT;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_job_card_id INTEGER REFERENCES job_cards(id);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_at          TIMESTAMPTZ;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS verified           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS verified_at        TIMESTAMPTZ;
```

Shade-card states map onto existing zones:

| Shade-card state | Zone | Flags |
|---|---|---|
| Triage | `incoming` | — |
| On Press | `on_floor` | `issued_machine_id` / `issued_operator` / `issued_at` set, optional `issued_job_card_id` |
| Vault (In-Storage / Verified) | `in_rack` | `verified = 1`, `verified_at` set |

`TOOL_VIEW` gains a LEFT JOIN to `machines` (expose `issued_machine_name`) and to `job_cards` (expose the linked `jc_number`) so cards render the press and run without extra calls.

### New endpoints (`routes/tooling.js`)
1. **`GET /tooling/print-stations`** — printing machines with their crew (reuses the Floor lateral `machine_operators` query, `WHERE m.type='printing' AND active`), plus each press's currently-running printing job cards (`jc_number`, product) for the optional attach-run picker.
2. **`POST /tools/:id/issue`** `{ machine_id, operator, job_card_id? }` (role `canMove`) — guards: family `shade_card`, zone ∈ {`incoming`, `in_rack`}. Sets `zone='on_floor'`, `issued_machine_id`, `issued_operator`, `issued_job_card_id`, `issued_at=now()`, `verified=0`, `zone_since=now()`. Logs a `tool_events` row (action `issued`, `to_zone='on_floor'`, note = machine · operator [· jc]). Returns the fresh view row.
3. **`POST /tools/:id/return-to-vault`** `{ verified?: true }` (role `canMove`) — guards: family `shade_card`, zone `on_floor`. Sets `zone='in_rack'`, `verified=1`, `verified_at=now()`, `zone_since=now()`, and clears `issued_machine_id` / `issued_operator` / `issued_job_card_id`. Logs a `returned` event.
4. **Auto-return hook** in `POST /job-stages/:id/complete` (`production.js`): after a stage whose `stage='printing'` is marked completed, in the same `tx`, return every shade card that is `on_floor` with `issued_job_card_id = st.job_card_id` → Vault (`in_rack`, `verified=1`, `verified_at=now()`, issued fields cleared) and insert a `returned` tool event for each. Unlinked on-press cards are untouched.

### Client (`Tooling.jsx`) — shade-card board only
When `tab === 'shade_card'` in Board view, columns relabel: Incoming → **Triage**, `making` stays **Making**, on_floor → **On Press**, in_rack → **Vault**.

- **Triage card:** a fast-track **"Direct Issue to Print"** button expands an inline **Control Dock drawer** *within the column* (no modal): Target Machine → Operator (filtered to the selected machine's crew) → optional **Attach running job** (job cards currently printing on that press — selecting one enables auto-return) → **Issue to Print** (`POST /tools/:id/issue`).
- **On Press card:** dense dock readout — machine · operator · time-on-press — plus a one-tap **"Run complete → Vault"** button (`POST /tools/:id/return-to-vault { verified:true }`). If job-linked, a small "auto-returns on print completion" hint.
- **Vault card:** green **Verified · In-Storage** badge + `verified_at` + the existing 1-year `ShadeAgeChip` expiry engine; a **Re-issue** action re-opens the Control Dock from `in_rack`.

New component: `ShadeDock` (inline, data-dense), plus a small `printStations` fetch in the page (loaded when the shade-card tab is active).

### Roles
Issue and return use `canMove` (planner + production) — consistent with existing zone moves. Restore/scrap use `canManage` (planner), consistent with the condition PUT.

---

## Data flow (Part B)

```
Triage (incoming)
   │  Direct Issue to Print → Control Dock: machine + operator (+ optional job)
   ▼
On Press (on_floor, issued_* set)
   │  ├─ job-linked → printing stage completes → auto-return (server hook)
   │  └─ not linked → one-tap "Run complete → Vault"
   ▼
Vault (in_rack, verified=1, verified_at) — Verified · In-Storage, 1-yr age chip, Re-issue
```

---

## Testing & verification

- **Vitest server tests** (style of `tooling-gate.test.js` / `order-lifecycle.test.js`):
  - `issue`: sets fields; rejects non-shade-card family and wrong zone.
  - `return-to-vault`: sets `verified` + clears issued fields; rejects wrong family/zone.
  - **auto-return:** completing a `printing` stage returns *linked* on-press shade cards to Vault verified and leaves *unlinked* on-press cards untouched.
- **Live visual verification** in the running app (login, desktop breakpoint) per project workflow — Archive tab muting/disabled actions, the inline Control Dock, and the Triage → Issue → Vault round-trip.
- Server routes exercised via a **temporary server on a spare port against live PG :5439** (running instance may not hot-reload); **self-seed a `UAT-` shade card** so no real plant data is touched, and clean up scoped to the `UAT-` marker.
- **No git commits** (project rule).

---

## Out of scope (YAGNI)

- No new zone in the DB CHECK constraint.
- No real webhook infrastructure — "auto-return" is the in-process stage-completion hook.
- Deleted (`active=0`) tools are **not** surfaced in the Archive Hub.
- No changes to die/plate/block issue flow beyond the shared scrapped/archive behaviour.
