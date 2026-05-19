# Carton Spec Pack — PO → Planning → Artworks → Job Cards

**Date:** 2026-05-19
**Status:** Approved design, pending spec review

## Problem

Carton Master holds the complete product specification, but it does not flow
cleanly through the order lifecycle:

- **PO entry** (`src/lib/po-create.ts`) snapshots only the fields the caller
  passes plus a targeted HSN backfill. There is no complete spec-pack snapshot.
- **Carton Master storage is inconsistent**: the schema has dedicated
  `sheetSizeL` / `sheetSizeW` / `ups` columns, but `CartonForm` writes Sheet
  Size into `blankLength` / `blankWidth` and UPS into a `specialInstructions`
  JSON blob. Downstream readers expecting `carton.sheetSizeL` / `carton.ups`
  get nulls even though the operator entered the data.
- **Planning** reads carton spec via ad-hoc fallback chains
  (`specOverrides → po line → carton`) off the live Carton, so a master edit
  mid-production silently changes a running order.
- **Artworks & Job Cards** read spec ad hoc with no single locked reference.

## Goal

One canonical, versioned **Spec Pack** built from Carton Master, **frozen onto
the PO line at PO entry** (same durability guarantee as HSN today), consumed by
the planning smart engine (board recommendation + sheet/qty math + warehouse
shortage + procurement suggestion) and surfaced read-only to the Artworks and
Job Card people.

## Approved decisions

- **Scope:** whole chain in one spec, delivered as phases A → B → C.
- **Spec lock:** locked snapshot at PO entry. Carton Master edits never
  retroactively change in-flight orders.
- **Engine output:** (1) board grade/GSM + sheet & qty math, (2) warehouse
  stock match + shortage qty, (3) procurement action / PO suggestion.
  Tooling/plate/shade readiness gating is **out of scope**.
- **Master storage:** canonicalize Sheet Size → `sheetSizeL/W`, UPS → `ups`,
  and migrate existing rows. `blankLength/blankWidth` freed for true carton
  blank/flat size.
- **Artworks/Job Cards:** read-only reference panel. No prefill, no gating.
- **Carrier:** single versioned JSON `specPack` column on `PoLineItem`
  (Approach 1). Additive, extensible by version bump, matches the existing
  `specOverrides` JSON pattern.

## The Spec Pack contract (`v1`)

Built by `buildCartonSpecPack(carton)` from the canonicalized Carton Master.

```
specPack = {
  v: 1,
  source:     { cartonId, cartonName, snapshotAt },
  board:      { boardGrade, gsm, paperType, caliperMicrons, plyCount },
  dimensions: { finishedL, finishedW, finishedH, blankL, blankW, dimensionTol },
  sheet:      { sheetSizeL, sheetSizeW, ups },
  print:      { printingType, numberOfColours, backPrint, artworkCode },
  finishing:  { coatingType, laminateType, foilType,
                embossingLeafing, spotUv, braille },
  tooling:    { dieMasterId, pastingStyle },
  linkage:    { shadeCardId },
  pharma:     { drugSchedule, scheduleMRequired },   // read-only carry-through
}
```

Rules:

- Built **once** at PO entry; never re-derived from Carton afterward.
- `specOverrides` (existing column) wins per-field at read time — the pack is
  the frozen baseline; overrides are the deliberate per-line exception.
- Stored as new nullable column `PoLineItem.specPack Json?`. Existing discrete
  snapshot columns (`coatingType`, `gsm`, `dimLengthMm`, …) remain for
  backward compat; the pack is additive and becomes the canonical read source.
- Single shared accessor `readCartonSpecPack(poLine)` returns the pack merged
  with `specOverrides`, with safe defaults for legacy lines that have no pack.

## Phase A — Carton Master canonicalization + PO-entry snapshot

### A1. Carton Master form/storage fix

- `CartonForm.tsx` + edit-page mapping + `serializeCarton`: Sheet Size inputs
  write/read `sheetSizeL` / `sheetSizeW`; UPS input writes/reads the `ups`
  column. `blankLength` / `blankWidth` become their own true carton-blank
  inputs, no longer aliased to sheet size.
- `cartonSchema` and the carton API routes gain explicit `sheetSizeL`,
  `sheetSizeW`, `ups` fields.

### A2. Data migration + backfill (idempotent, logged, reversible)

- Carton rows where `sheetSizeL/W` is null but `blankLength/blankWidth` is set
  → copy `blankLength→sheetSizeL`, `blankWidth→sheetSizeW`.
- Carton rows where `ups` is null but `specialInstructions` JSON has a numeric
  `ups` → copy to `ups` column; strip `ups` from the JSON, preserving notes.
- Pre-migration **reader audit**: grep every reader of
  `blankLength`/`blankWidth`; repoint sheet-size-meaning readers to
  `sheetSizeL/W`; leave genuine blank-size readers. This audit is part of the
  phase, not an assumption.
- Backfill logged with before-values to `docs/` (reuse the existing
  `reset-import-log.json` pattern); reversible from the log.

### A3. Spec Pack builder + storage + PO-entry wiring

- New `src/lib/carton-spec-pack.ts`:
  - `buildCartonSpecPack(carton): SpecPackV1` — pure, unit-tested.
  - `readCartonSpecPack(poLine): ResolvedSpecPack` — pack merged with
    `specOverrides` (override wins per field); null-safe for legacy lines.
- New nullable column `PoLineItem.specPack Json?` (additive migration).
- `src/lib/po-create.ts` (`createPurchaseOrderWithLines`): extend the existing
  batch carton fetch to pull the full carton row per line with a `cartonId`
  and set `specPack: buildCartonSpecPack(carton)` on each `poLineItem.create`.
  Lines with no `cartonId` → `specPack: null`. Single chokepoint covers both
  the manual create route and the PDF-import commit path.
- One-time backfill: populate `specPack` for existing **open** PO lines from
  their linked Carton (best-effort baseline). Closed/dispatched lines
  untouched.
- Lock guarantee: nothing rewrites `specPack` after entry.

## Phase B — Planning smart engine consumption

- `/api/planning/po-lines/route.ts`: resolve each line through
  `readCartonSpecPack(poLine)` instead of live `li.carton?.*`.
- **Board recommendation + sheet/qty math** from pack `board` + `sheet`:
  - `sheetsRequired = ceil(orderQty / ups) × (1 + wastagePct)`
  - recommended board grade + GSM + paper type surfaced on the line.
  - Missing `ups`/`sheetSize` → line flagged "spec incomplete — cannot
    compute" (no silent zero).
- **Warehouse stock match + shortage** (reuses existing paper-warehouse
  matching on board grade + GSM + paper type):
  - `shortageSheets = max(0, sheetsRequired − availableSheets)`; surface
    available / required / shortage on the line.
- **Procurement suggestion** when `shortageSheets > 0`: suggested procurement
  quantity (shortage rounded to buyable unit) + matched board spec, as an
  actionable payload for the existing material-procurement flow. Suggestion
  only — no auto-PO.
- Surfaced via existing `SectionBoardAllocation` / `SectionUpsAndSpec`
  components, fed pack-derived numbers.
- **Wastage % source:** existing per-line `tolerancePct` (default 2.0),
  unless the pre-implementation audit finds a dedicated planning wastage
  setting — confirmed during audit, not assumed.

## Phase C — Artworks + Job Cards read-only panel

- Shared `src/components/spec-pack/SpecPackPanel.tsx`: read-only, grouped per
  the `v1` contract. Marks fields a `specOverride` replaced ("overridden for
  this line"). Legacy/null lines show "No locked spec pack (legacy line)".
- Artworks: surfaced in `orders/designing/[poLineId]` beside the existing
  artwork-lookup/resolve flow. No change to `resolve-artwork`.
- Job Cards: surfaced in `production/job-cards/[id]`. No change to
  `generate-job-card` or job-card PDF logic.
- No write paths in Phase C.

## Cross-cutting

- **Migrations** (3, additive/safe, each reversible, backfills logged with
  before-values):
  1. `PoLineItem.specPack` nullable column.
  2. Carton sheet-size/UPS canonicalization + backfill.
  3. PO-line `specPack` backfill for open orders.
- **Legacy/null safety:** every consumer degrades gracefully when `specPack`
  is null (falls back to discrete columns / shows "legacy line"). No hard
  failures.
- **Testing:** unit tests for `buildCartonSpecPack` (full + sparse cartons)
  and `readCartonSpecPack` (override precedence, null line); engine math tests
  (ceil/wastage/shortage, missing-ups flag) extending existing
  `SectionBoardAllocation.test.tsx` / `SectionUpsAndSpec.test.tsx`; migration
  backfill verified on a DB copy before prod.
- **Rollout:** A → B → C, each independently shippable. A is inert until B
  reads it; C is read-only. No feature flag needed (additive + null-safe).

## Out of scope

- Tooling/plate/shade readiness gating in the planning engine.
- Job-card / artwork prefill or progression gating from the pack.
- Auto-creating material procurement POs (suggestion only).
- Live "refresh from master" on PO lines (lock is absolute for v1).
