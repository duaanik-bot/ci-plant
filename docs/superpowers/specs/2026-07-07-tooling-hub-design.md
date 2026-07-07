# Tooling Hub — Design Spec

**Date:** 2026-07-07
**Status:** Approved by Anik (design conversation, 2026-07-06/07)
**Module:** `/tooling` — unified lifecycle manager for the plant's four physical tool families.

## 1. Purpose & positioning

CI-Production ran four bespoke, visually dense tooling hubs (Die Hub, Emboss Block Hub, Plate Hub, Shade Card Hub), each with its own zones and workflows. ci-erp gets **one** Tooling Hub: a single custody lifecycle shared by **dies, printing plates, emboss/foil blocks, and shade cards**, rendered in the app's macOS Tahoe / Liquid Glass design language, learnable in minutes.

It is a **shared pre-press pipeline with Artwork**: artwork lock surfaces a line's required tooling; tooling reaching the rack auto-satisfies the existing job-card readiness gate (`artwork + tooling + material` in `server/src/helpers.js → readiness()`). Artwork and Tooling read as two stations on one river.

**Nav placement:** own group, last in the sidebar:

```
Tooling
  └─ Tooling Hub   /tooling   icon: Wrench   roles: admin, planner, production, qc
```

## 2. Data model (server/src/db.js)

### 2.1 `tools`

One row per physical tool, all families. Flat columns, no JSON.

| column | type | notes |
|---|---|---|
| id | identity PK | |
| family | TEXT CHECK `die\|plate\|block\|shade_card` | |
| code | TEXT UNIQUE | auto-prefixed `DIE-` / `PLT-` / `BLK-` / `SHD-` via `nextNumber` pattern |
| title | TEXT NOT NULL | human name |
| product_id | INT FK products, nullable | links tool → jobs |
| zone | TEXT CHECK `incoming\|making\|in_rack\|on_floor` DEFAULT `incoming` | unified lifecycle |
| zone_since | TIMESTAMPTZ DEFAULT now() | powers time-in-zone |
| maker | TEXT | vendor name or `In-house` (covers old At-Vendor / In-House-Engraving split) |
| condition | TEXT CHECK `Good\|Fair\|Poor\|Scrapped` DEFAULT `Good` | Poor/Scrapped = unhealthy |
| location | TEXT | rack slot |
| notes | TEXT | |
| ups | INT | die |
| sheet_size | TEXT | die |
| carton_size | TEXT | die |
| colors | INT | plate (a plate row = a plate **set**) |
| emboss_type | TEXT | block (e.g. emboss / deboss / foil / combo) |
| shade_ref | TEXT | shade card reference |
| impression_count | INT DEFAULT 0 | carried from dies |
| max_impressions | INT DEFAULT 500000 | carried from dies |
| last_used_date | TEXT | carried from dies |
| active | INT DEFAULT 1 | |

### 2.2 `tool_events`

Append-only audit; every zone move / condition change writes one.

| column | notes |
|---|---|
| id | identity PK |
| tool_id | FK tools |
| action | e.g. `moved`, `condition`, `created`, `undo` |
| from_zone / to_zone | TEXT nullable |
| note | TEXT |
| user_name | TEXT |
| at | TIMESTAMPTZ DEFAULT now() |

### 2.3 Migration (idempotent, data-preserving)

The local DB holds **real plant data** (dies migrated from Supabase) — seed does not create dies, so migration must run against live rows and be re-runnable:

1. `CREATE TABLE IF NOT EXISTS tools / tool_events`.
2. `ALTER TABLE products ADD COLUMN IF NOT EXISTS tool_id INTEGER REFERENCES tools(id)`.
3. Guarded copy (only when `tools` has no `die` rows and `dies` is non-empty): insert every `dies` row into `tools` (`family='die'`, `code=die_number` — real die numbers are kept as-is, no re-prefixing, `title=die_type` or `Die <n>`, `zone='in_rack'` when active & healthy else `incoming`, condition/location/impressions carried over), then set `products.tool_id` from the old `products.die_id` mapping.
4. `dies` table and `products.die_id` stay in place, dormant (safety net; nothing writes to them).
5. Masters: `dies` removed from the CRUD `MASTERS` map and from `client/src/pages/Masters.jsx` (products' die picker now reads `/tools?family=die`; the products query joins `tools` for `die_number` display). Tooling Hub is the single home for tools.
6. Seed (`seedIfEmpty`) gains demo tools for all four families so a fresh install shows a working hub.

## 3. Requirements engine — the Artwork patch

A line's **required tooling** is derived, never manually declared:

| family | required when | matched by |
|---|---|---|
| die | always | `products.tool_id` (the linked die) |
| plate set | always | tool `family='plate'` with same `product_id` |
| block | `product.special ∈ {foil, emboss, foil_emboss}` | tool `family='block'` with same `product_id` |
| shade card | always | tool `family='shade_card'` with same `product_id` |

`readiness()` change: **die is a HARD requirement** (must exist, be healthy — `condition ∉ {Poor, Scrapped}`, `active=1` — and be `in_rack`/`on_floor`, exactly the old dies gate), while **plate/block/shade card are SOFT** — they block only when a registered tool is not ready; untracked soft tools inform (status `missing`) but never block. This keeps real plant data (dies only today) flowing unchanged while new tool records tighten the gate as they're adopted. The manual `tooling_ok` flag remains as the absolute admin override. The gate response gains `tooling_detail`: per-family status list used by chips everywhere.

**Auto-flip:** when a tool moves into `in_rack`, the move endpoint re-checks order lines waiting on that product (status `planned`, artwork locked) and flips `planned → ready` via the existing `setLineStatus` + gate pattern used by the artwork endpoint (`routes/orders.js`). No new machinery.

## 4. Tooling Hub page (`client/src/pages/Tooling.jsx`)

Liquid Glass, top to bottom:

1. **PageHeader** — "Tooling Hub" / "Dies, plates, blocks & shade cards — from maker to rack to machine" + **New Tool** (`btn-brand`) opening a create modal (family select drives which spec fields show; optional product link).
2. **KPI strip** — 4 compact `KpiCard`s: **In Making**, **In Rack**, **On Floor**, **Needs Attention** (Poor/Scrapped condition, or in `making` > 7 days).
3. **"Needed for jobs" rail** — horizontally scrollable glass chips (`scrollbar-none`), one per artwork-locked line whose tooling gate is not satisfied: "CI-PO-041 · Amul 1L — plate set missing · die at maker". Click → filters the board to that product's tools. Each chip offers **Create missing** which opens the create modal pre-filled (family + product).
4. **Family tabs** — existing `Tabs`: All · Dies · Plates · Blocks · Shade Cards, with counts.
5. **Kanban board** — 4 fixed zone columns (**Incoming → Making → In Rack → On Floor**), each a glass panel with zone label + count badge. **Uniform compact cards** (~72 px): family-tint icon chip (tint idiom from `sections.js` — die: rose `Square`, plate: sky `Printer`, block: amber `Stamp`, shade card: violet `Palette`), code + title, one spec line, time-in-zone, condition dot (emerald/amber/red). Tap card → spotlight. **No drag-and-drop** (tap-to-move; touch-friendly; DnD can come later).
6. **Ledger toggle** — board ⇄ table icon switch; table = existing `DataTable` (searchable, sortable): Code, Family, Title, Product, Zone, Condition, Location, Time in zone, Last action.
7. **Tool spotlight** — existing `Modal`: full spec (family-appropriate fields, editable), linked product + its open lines, **zone move buttons** (the four zones; current disabled), condition setter, maker field, and the event timeline (latest first). **Undo** reverses the latest move via its event.

Empty states and mobile behaviour follow existing pages (board columns stack on small screens).

## 5. Artwork page patch (light touch)

- One new column in `client/src/pages/Artwork.jsx`'s table: **Tooling** — compact chip from `readiness.tooling_detail`: `✓ Ready` (emerald) / `2 of 4 in rack` (amber) / `die missing` (red). Click → `/tooling` pre-filtered to that product.
- `/artwork` GET (`routes/orders.js`) enriches rows with the tooling detail (single batched query — no N+1).
- Tracking (`/track/:id`, `routes/floor.js`) gains a **Tooling ready** milestone beside the artwork milestone.
- Artwork behaviour otherwise unchanged (two approvals → auto-lock stays exactly as is).

## 6. API surface (`server/src/routes/tooling.js`)

| endpoint | role | behaviour |
|---|---|---|
| `GET /tooling/board` | all module roles | tools grouped by zone + KPI counts + needed-for-jobs rail, one call |
| `GET /tools?family=&product_id=` | all | flat list (ledger, pickers) |
| `POST /tools` | planner+ | create (auto code by family prefix); writes `created` event |
| `PUT /tools/:id` | planner+ | edit spec/condition/location; condition change writes event |
| `POST /tools/:id/move` | planner, production, admin | zone move; writes event; resets `zone_since`; on arrival `in_rack` re-checks waiting lines (auto-flip) |
| `POST /tools/:id/undo` | planner+ | reverses the latest `moved` event |
| `GET /tools/:id/events` | all | event timeline |

Errors follow the existing structured-409 pattern (`data.code`) where a decision is needed; plain errors use the central toast. Route mounted in `server/src/index.js` like the other routers. Auth via existing `requireRole`.

## 7. Testing & verification

- **Server:** unit-style checks for required-tooling derivation (special → block; colours → plate), gate pass/fail matrix (missing / unhealthy / at-maker / in-rack), auto-flip on rack arrival, undo restores prior zone, migration idempotency (run twice, no dupes).
- **Client:** live preview verification against seeded data — board renders all families, tap-move updates zone + event log, needed-rail click filters, create-missing prefills, artwork chip states (ready/partial/missing), ledger search/sort.

## 8. Out of scope (explicit)

- Plate CTP / reissue / rack-grid sub-workflows (unified lifecycle + `maker` + notes covers the need).
- Drag-and-drop board interaction (later enhancement).
- Impression-count auto-increment from production runs (columns carried, wiring later).
- Deleting the legacy `dies` table (kept dormant one release for safety).
