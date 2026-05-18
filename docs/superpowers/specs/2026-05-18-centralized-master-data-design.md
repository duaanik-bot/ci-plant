# Centralized Master Data (MiniMasters Registry) — Design

**Date:** 2026-05-18
**Status:** Approved (design); pending implementation plan
**Approach:** A — extend the existing `effect_*` tables in place (no parallel system)

## Problem

Controlled dropdown lists (Unit/UOM, Board Type, Board Colour, Coating, Foil,
Emboss, Pasting) are the single source of truth in MiniMasters
(`EffectCategory` → `EffectValue`, surfaced as the "MiniMasters" admin screen
at `src/app/(dashboard)/masters/effects/page.tsx`). But consumers wire to it
ad hoc:

- Category names are loose strings (`fetchMiniMasterOptions('Board Type')`),
  easy to typo, no compile-time safety.
- Every form fetches independently with its own scattered hardcoded fallback
  list; the same list is refetched repeatedly.
- Consumer-side filtering logic exists (the "hide Duplex/SBS" hack in
  `src/lib/minimasters-options.ts`), so the master is not actually the single
  source of truth.
- No stable code vs. display label separation, so a value rename orphans data
  and "NOS means Numbers" cannot be expressed cleanly.

Goal: an ERP-grade master-data backbone — one central registry, referenced by
stable key everywhere, read through one cached store, with code/label
separation, so any controlled list can be fetched the same way from anywhere
with no wiring issues.

## Requirements (locked with user)

- **Scope:** value-lists only. Large entities (Customers, Materials,
  Suppliers, Machines) keep their own dedicated tables — out of scope.
- **Code + label:** each value has a stable machine `code` separate from its
  editable display `label`. One-time migration of existing label-storing rows.
- **Read model:** app-wide cached store, loaded once, with live invalidation
  when MiniMasters is edited.
- **Day-one categories:** Unit/UOM, Board Type, Board Colour, and the
  finishing lists (Coating, Foil, Emboss, Pasting).

## Design

### 1. Data model (extend `effect_*` tables)

`EffectCategory`
- Add `code String @unique` — stable machine key
  (`UNIT`, `BOARD_TYPE`, `BOARD_COLOUR`, `COATING`, `FOIL`, `EMBOSS`,
  `PASTING`). `name` remains the editable display label.

`EffectValue`
- Add `code String` with `@@unique([categoryId, code])` — stable per-value
  key (`NOS`, `KG`, `SHT`, `FBB`, `SBS`, …). `value` remains the editable
  display label. `abbreviation` / `impactOn` / `description` unchanged.

Migration (three-step, safe):
1. Add `code` columns nullable.
2. Backfill: categories `code = SCREAMING_SNAKE(name)` with curated
   overrides; values `code` from a curated legacy map (e.g. `sheets→SHT`,
   `kg→KG`, `cartons→CTN`). Repoint label-storing record fields —
   `material.unit`, billing line `uom`, rfq `annualVolumeUnit` — to codes
   using the same map. Any value that cannot be mapped is **kept as-is and
   surfaced** (never silently dropped).
3. Enforce `NOT NULL` + unique constraints.

### 2. Typed registry

`src/lib/masters/registry.ts` exports a frozen
`MASTER = { UNIT:'UNIT', BOARD_TYPE:'BOARD_TYPE', BOARD_COLOUR:'BOARD_COLOUR',
COATING:'COATING', FOIL:'FOIL', EMBOSS:'EMBOSS', PASTING:'PASTING' } as const`
plus a `MasterKey` union type. Every consumer references `MASTER.*`; no string
literals in forms. Adding a category is a one-line change here plus a seed
row.

### 3. Read path — app-wide cached store

- **API:** `GET /api/masters/registry` returns all active categories with
  their active values in one round trip:
  `{ [categoryCode]: { code, label, values: [{ code, label, abbreviation,
  sortOrder }] } }`, values sorted by `sortOrder` then label.
- **Provider:** `MastersProvider`, mounted in the existing
  `src/components/providers.tsx`. Loads the registry once on mount, holds it
  in React context. Exposes:
  - `useMaster(key: MasterKey)` → `{ options: {code,label}[], loading }`
  - `useMasterLabel(key, code)` → resolves a stored code to its label
    (renders `NOS` → "Numbers")
  - `useMastersRefresh()` → force refetch
- **Live invalidation:** MiniMasters create/update/delete/inactivate calls
  trigger the refresh on success → every mounted dropdown updates without a
  page reload. Optional cheap cross-tab `storage` event ping.
- **Fallback:** an embedded static snapshot of the seed lists is served if the
  registry fetch fails, so dropdowns never break. This replaces all scattered
  per-form hardcoded fallbacks, **deletes the Duplex/SBS filter hack** in
  `src/lib/minimasters-options.ts`, and retires the interim `useUnitOptions`
  hook.

### 4. Consumer contract

Reusable `<MasterSelect masterKey={MASTER.X} value onChange />`:
- Renders the label, stores the code.
- Always keeps an unknown stored code visible (no orphan/data loss when a
  value is later inactivated/renamed).

Replace every ad-hoc `fetchMiniMasterOptions` / `EffectSelect` /
`useUnitOptions` usage with `useMaster` / `<MasterSelect>`:
Material UOM, Billing line UOM, RFQ annual-volume unit, PO forms (Board Type,
Coating, Foil, Emboss, Pasting), Planning Coating, Board Colour wherever
selected.

### 5. Admin UI & seeding (MiniMasters screen)

- Add a **Code** field to the Add/Edit Value and Add/Edit Category drawers in
  `src/app/(dashboard)/masters/effects/page.tsx`: uppercase, unique in scope,
  **immutable once referenced** (warn + block change if referenced).
- Seed script creates the 7 categories + day-one values with codes:
  - Unit: `NOS`→Numbers, `KG`→Kilogram, `SHT`→Sheets, `BOX`→Box,
    `GRS`→Gross, `TON`→Tonnes, `MTR`→Metres, `LTR`→Litres, `PKT`→Packets
  - Board Type: `FBB`, `SBS`, `DGB`→Duplex GB, `DWB`→Duplex WB, `KRFT`→Kraft
  - Board Colour: `WHT`→White, `GRY`→Grey-back, `KRF`→Kraft brown (extendable)
  - Coating / Foil / Emboss / Pasting: seeded from the existing values in
    `src/lib/constants.ts` and current `effect_values` rows.
- Delete protection: hard-deleting a value/category that is referenced by any
  record is **blocked** (409 with a clear message); the user inactivates it
  instead (schema already enforces `EffectValue.category onDelete: Restrict`).
  Unreferenced values may be hard-deleted. Inactive values remain resolvable
  for old records.

### 6. Error handling & integrity

- A `code` is immutable once any record references it (prevents
  rename-orphan).
- Inactivating a value hides it from new selections but label resolution for
  existing records still works.
- No consumer-side filtering anywhere — the master is the only source of
  truth.

### 7. Testing

- Migration backfill: legacy value → code map; assert no row dropped, every
  repointed field resolves.
- `GET /api/masters/registry` response shape and active-only filtering.
- Provider: cache hit, invalidation refetch, fallback-on-error path.
- `MasterSelect`: stores code, renders label, preserves an unknown stored
  code.

## Out of scope

- Entity masters (Customers/Materials/Suppliers/Machines) remaining as
  dedicated tables.
- Per-tenant / multi-company master overrides.
- Bulk import/export of master values (future enhancement).

## Migration / rollout notes

- Backfill map lives in the migration and is unit-tested before deploy.
- The static fallback snapshot guarantees no dropdown breaks during the window
  between deploy and seed.
- Consumers can be cut over incrementally (registry + `MasterSelect` ship
  first; each form switched and verified one at a time) because the provider
  and the legacy helpers can coexist until the last consumer is migrated, at
  which point the Duplex hack and `useUnitOptions` are deleted.
