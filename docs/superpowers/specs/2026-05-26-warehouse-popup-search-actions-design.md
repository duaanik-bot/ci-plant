# Warehouse Popup — Search + Inline Row Actions + Reliable Close

**Date:** 2026-05-26
**Branch:** `fix/warehouse-popup-actions` (off `origin/staging-supabase` @ 47fe2a0)
**Component:** `src/components/planning/engine/WarehousePopup.tsx`, opened from `src/components/planning/PlanningJobDetailDrawer.tsx`

## Problem

The Paper Warehouse popup in the planning engine is read-only and, on the
production build, unclosable:

1. **No reliable close.** In the deployed (older) build the modal header with
   the `X` scrolls off the top of the viewport, leaving no way to dismiss it.
2. **No actions.** Each stock row is display-only — a planner cannot reserve,
   unreserve, or select (link) a material to the planning line from here.
3. **No search.** With ~260 materials, there is no way to find a specific stock
   row within the popup; only the 5 tab filters exist.

The popup is always opened from a single planning line (`PlanningJobDetailDrawer`),
so all actions are scoped to **that line**.

## Goals

- The popup is always closable (header `X`, `Esc`, backdrop click).
- A localized search bar filters the loaded rows instantly.
- Every row exposes inline **Select**, **Reserve**, and **Release** actions that
  operate against the current planning line, with live refresh after each action.

## Non-goals

- No changes to the warehouse list endpoint (`/api/inventory/paper-warehouse`).
- No bulk/multi-select actions. Actions are per-row.
- Not using the server `stock-search` endpoint here (that is line-scoped
  match-ranking for Board Allocation, a different purpose).

## Design

### 1. Close (verify-first, minimal change)

On this base branch the popup already renders through the current
`GlobalPopoutModal`, which has a sticky `shrink-0` header with an `X`
(`aria-label="Close"`), closes on `Esc`, locks body scroll, caps the panel at
`sm:max-h-[88vh]` with the body as the only scroll region, and covers the app
nav with a `z-[1100]` full-screen backdrop. The production symptom predates this
modal.

Action: **verify in browser preview** that the `X` is reachable with 260 rows
loaded and the nav does not overlap the header. Only if preview shows a problem
(e.g. a higher-z nav bleeding through) do we bump `zIndexClass` or adjust layout.
No redesign of the modal.

### 2. Localized search bar

- A controlled text `input` rendered above the table, on the same row as / just
  under the tab pills, with a clear (`✕`) button when non-empty.
- Pure **client-side** filter over the already-loaded `rows` (no network).
- Matches case-insensitively against `material_code`, `board_type_id`,
  `gsm` (stringified), and `size_display`.
- Composes with the active tab via **AND**: the tab filter runs first, then the
  search predicate. The metadata count (`N materials in warehouse`) continues to
  reflect the total loaded set; the table shows the filtered subset, with the
  existing empty state ("No rows to display.") when the combination is empty.

### 3. Inline row actions

A new right-aligned **Actions** column. Each row, scoped to the current line:

- **Select** — links the row's material to the line. Calls a new
  `onSelect(materialId)` prop wired to the drawer's existing
  `handleEngineSelectBoard` (`lockSelectionOnly`). The currently linked material
  (`readiness.materialId`) renders with a selected highlight/ring and a
  "Selected" affordance.
- **Reserve** — clicking reveals an **inline** qty editor in the row (numeric
  input + ✓ confirm / ✕ cancel), pre-filled with
  `min(lineRequiredSheets, rowFree)` where `rowFree = available - reserved`.
  Editable; clamped to `[1, rowFree]`. Confirm calls `onReserve(materialId, qty)`.
- **Release** — calls `onUnreserve(materialId)`. Disabled (greyed) when this line
  has reserved 0 sheets of that material. Releases the full amount this line
  reserved against that material.

After any action, the popup refetches the warehouse rows and the drawer refreshes
line readiness + the per-material reservation map, so Available/Reserved/Free and
the Release enabled-state update live. Success/error surfaced via `toast`
(reusing the drawer's existing pattern). Per-row action buttons show a disabled
state while their request is in flight.

### 4. Data flow / wiring

`WarehousePopup` gains props:

```ts
type WarehousePopupProps = {
  open: boolean
  onClose: () => void
  lineBoardType?: string | null
  lineGsm?: number | null
  readiness: PlanningEngineReadiness | null
  gsmTolerance?: number
  // new:
  lineRequiredSheets: number
  lineReservedByMaterial: Record<string, number> // this line's reserved sheets per materialId
  onSelect: (materialId: string) => Promise<void>
  onReserve: (materialId: string, qty: number) => Promise<void>
  onUnreserve: (materialId: string) => Promise<void>
}
```

`PlanningJobDetailDrawer` supplies them:

- `lineRequiredSheets` ← `readiness.requiredSheets`.
- `lineReservedByMaterial` ← fetched per below; refreshed after each action.
- `onSelect` ← `handleEngineSelectBoard` (existing).
- `onReserve(materialId, qty)` ← new handler:
  POST `/api/planning/po-lines/{id}/reservation-control`
  `{ action: 'adjust', materialId, requiredSheets: lineRequiredSheets,
     targetReserveQty: (lineReservedByMaterial[materialId] ?? 0) + qty,
     prImpactAction: 'reduce' }`.
  (`adjustPlanningReservation` sets an **absolute** target, so we add to the
  current per-line reserved amount.)
- `onUnreserve(materialId)` ← new handler:
  POST `/api/planning/po-lines/{id}/reservation-control`
  `{ action: 'release', materialId, requiredSheets: lineRequiredSheets,
     releaseQty: lineReservedByMaterial[materialId], prImpactAction: 'reduce' }`.

### 5. Per-line reserved-by-material map (small backend addition)

The popup needs, per material, how many sheets **this line** has reserved (drives
Release enablement and the `adjust` target). The aggregation already exists as a
private `getPlanningReservedByMaterial(planningLineId, materialIds)` inside the
`reserve-material` route.

Plan:

- **Extract** `getPlanningReservedByMaterial` into `material-readiness-service.ts`
  as an exported helper (when `materialIds` is omitted/empty, return the full map
  for the line). Update the `reserve-material` route to import it (no behavior
  change there).
- **Extend** the `reservation-control` `GET` handler: when called **without**
  `materialId` (e.g. `?all=1`), return `{ reservedByMaterial: Record<string,
  number> }` for the line. The existing single-material snapshot branch is
  unchanged.
- The drawer calls this GET on popup open and after each action to populate /
  refresh `lineReservedByMaterial`.

## Components & responsibilities

- `WarehousePopup` — presentation + client-side tab/search filtering + inline
  qty-editor local state; delegates all mutations via callbacks. No direct
  network mutations.
- `PlanningJobDetailDrawer` — owns the reserve/unreserve/select handlers and the
  reserved-by-material fetch; passes data + callbacks down.
- `reservation-control` route + `material-readiness-service` — server-side
  reserve/release/adjust and the new per-line reserved-by-material read.

## Error handling

- Action handlers catch and `toast.error` with the API message; on failure no
  optimistic state is kept — the subsequent refetch reflects true state.
- Reserve qty clamped client-side to `[1, rowFree]`; server remains the source of
  truth (`adjust`/`release` already validate bounds and throw clear messages).
- A failed reserved-by-material fetch leaves Release buttons disabled (safe
  default) rather than blocking the popup.

## Testing

Extend `src/components/planning/engine/WarehousePopup.test.tsx`:

- Search filter matches code/board/gsm/size and composes with the active tab (AND).
- Clear button resets search.
- Reserve click reveals the inline editor pre-filled with
  `min(lineRequiredSheets, rowFree)`; confirm calls `onReserve` with the clamped qty.
- Release disabled when `lineReservedByMaterial[materialId]` is 0/absent; enabled
  and calls `onUnreserve` otherwise.
- Select calls `onSelect`; the linked material row shows the selected state.
- Close: `X` present and calls `onClose` (the modal already has a close test).

Server: a focused test that `reservation-control` `GET` without `materialId`
returns the per-line `reservedByMaterial` map.
