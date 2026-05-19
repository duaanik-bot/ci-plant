# PO Line Drawer — Spec-Pack Autopopulation Design

Date: 2026-05-19
Status: Approved (Approach A)

## Problem

When creating a Purchase Order, the line-item side drawer
(`src/components/po/PoNewLineItemDrawer.tsx`) autopopulates from the thin
`/api/cartons` catalog projection (`PoCartonCatalogItem`). That projection is a
legacy, partial view of the carton, so values shown in the drawer (e.g. Paper =
"White") can be stale or wrong relative to the carton's true spec.

The authoritative `SpecPackV1` (built by `buildCartonSpecPack` from the full
carton row — caliper, ply, dimensions, sheet/UPS, colours, pharma, etc.) is only
assembled server-side at submit time in `src/lib/po-create.ts:145`. During entry
the drawer never sees it. The per-field merge logic (`readCartonSpecPack` in
`src/lib/carton-spec-pack.ts`) already exists and is used by `SpecPackPanel`; it
is simply not wired into the entry drawer.

## Goal

During PO creation, the drawer autopopulates editable line fields from a
per-field merge of the carton's canonical spec pack (wins where present) over
carton-master fallback, surfaces the remaining spec as a read-only block, and
shows provenance per field. User edits become per-line spec overrides.

## Approach (A): New spec-pack endpoint + client-side merge

Reuses the existing canonical builder and merge code; keeps the catalog
endpoint lean; server stays authoritative at submit.

### 1. New endpoint

`GET /api/cartons/[id]/spec-pack`

- `requireAuth()`.
- Load the full carton row (same shape `buildCartonSpecPack` consumes).
- Return `{ pack: buildCartonSpecPack(cartonRow) }` (canonical `SpecPackV1`).
- 404 when carton not found.
- `export const dynamic = 'force-dynamic'`.

No merge logic in the endpoint — it returns the frozen base pack only.

### 2. Client data flow (`src/app/(dashboard)/orders/purchase-orders/new/page.tsx`)

1. `applyCartonToLine` continues to run unchanged (carton-master fallback
   values + tooling), for both search-pick and sales-order-seeded lines.
2. A new effect fetches the spec pack for `line.cartonId`, cached by carton id
   (re-opening the drawer / re-selecting the same carton triggers no refetch).
   Cleared appropriately on customer switch (existing line-reset path).
3. On resolve, compute the effective pack:
   `readCartonSpecPack({ specPack: fetchedPack, specOverrides: line.specOverrides })`.
4. Seed editable line fields **per field**:
   - Only where the effective-pack leaf is non-null.
   - Never overwrite a value the user has already typed for that line.
   - Otherwise leave the carton-master fallback that `applyCartonToLine` set.
5. Each editable field records a provenance tag on the `Line`.

### 3. Provenance model

Per editable field, a tag stored on the `Line`:

- `spec` — value came from a non-null spec-pack leaf (base pack).
- `master` — spec-pack leaf null; carton-master fallback supplied the value.
- `override` — value resolved from `specOverrides.specPack` overlay.
- `user` — user edited the field this session.

Editing an autopopulated field writes the new value into
`line.specOverrides.specPack.<group>.<field>` (the existing override mechanism
that `po-create.ts:140` already persists) and sets the tag to `user`; on
re-derivation that overlay resolves as `override`.

`po-create.ts` is unchanged: it still snapshots `buildCartonSpecPack(cartonRow)`
into `specPack` and persists `specOverrides` at submit.

### 4. Drawer redesign (`PoNewLineItemDrawer.tsx`)

- Existing editable Material / Printing / Costing / Additional fields remain.
  Each spec-backed field gets a small provenance badge:
  "Spec pack" / "Master" / "Overridden".
- New **read-only spec block** below the editable sections, reusing
  `SpecPackPanel`'s presentation, for non-editable groups: dimensions,
  sheet/UPS, caliper, ply, number of colours, pharma (drug schedule /
  schedule-M).
- Legacy carton (no locked spec pack — `readCartonSpecPack` returns
  `legacy: true`): badges read "Master"; read-only block shows the existing
  "No locked spec pack" notice.

### Editable vs read-only field split

- Editable (autopopulated, override-able): boardGrade, gsm, paperType,
  coatingType, embossingLeafing, foilType, pastingStyle, backPrint,
  artworkCode. (Quantity, Rate, Wastage %, GST % keep current behavior.)
- Read-only spec block: finished/blank dimensions + tolerance, sheet size,
  UPS, caliper microns, ply count, printing type, number of colours,
  laminate type, spot UV, braille, drug schedule, schedule-M.

## Out of scope (scope guard)

- Dimensions / sheet / UPS / colours / pharma are NOT made editable.
- No change to submit-time snapshot logic in `po-create.ts`.
- No change to the `/api/cartons` list/search projection.
- No change to the `[id]` edit-PO page beyond what is required for shared
  drawer props (drawer stays presentational; logic lives in the new-PO page).

## Testing

Unit:
- `GET /api/cartons/[id]/spec-pack`: auth required; returns canonical pack;
  404 on missing carton.
- Seeding/merge precedence: spec leaf wins; master fallback when leaf null;
  user-typed value not clobbered by a later fetch; `specOverrides` overlay
  resolves as `override`.
- Provenance tagging maps to the correct source in each case.

Component:
- Provenance badges render the correct label per source.
- Read-only spec block renders populated groups and hides on legacy lines.
- Legacy carton path shows the "no locked spec pack" notice and "Master"
  badges.

## Key files

- New: `src/app/api/cartons/[id]/spec-pack/route.ts`
- Edit: `src/app/(dashboard)/orders/purchase-orders/new/page.tsx`
  (fetch + cache + per-field seeding + provenance + override write-back)
- Edit: `src/components/po/PoNewLineItemDrawer.tsx`
  (provenance badges + read-only spec block)
- Reuse: `src/lib/carton-spec-pack.ts` (`buildCartonSpecPack`,
  `readCartonSpecPack`), `src/components/spec-pack/SpecPackPanel.tsx`
  (read-only presentation)
