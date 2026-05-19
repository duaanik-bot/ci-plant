# Carton Spec Pack Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snapshot the complete Carton Master spec as a locked, versioned "spec pack" onto each PO line at PO entry, then consume it in the planning smart engine (board recommendation + sheet/qty math + warehouse shortage + procurement suggestion) and surface it read-only to the Artworks and Job Card people.

**Architecture:** One pure builder (`buildCartonSpecPack`) maps a canonicalized Carton row → a `SpecPackV1` JSON object, written once into a new `PoLineItem.specPack` column inside the single PO-creation chokepoint (`createPurchaseOrderWithLines`). One pure reader (`readCartonSpecPack`) returns the pack (deep-merged with any `specOverrides.specPack`) and a `legacy` flag for old lines. Planning reads the pack instead of live Carton; Artworks/Job Cards render a shared read-only panel. Carton Master is fixed first so Sheet Size / UPS land in the dedicated `sheetSizeL/sheetSizeW/ups` columns the pack reads from.

**Tech Stack:** Next.js (App Router), Prisma/PostgreSQL, Zod, React, Vitest + Testing Library.

**Phasing:** Phase A (Tasks 1–7) → Phase B (Tasks 8–10) → Phase C (Tasks 11–12). Each phase ends green and shippable. Phase A is inert until B reads it; C is read-only.

**Pre-known facts (already verified in the codebase):**
- `Carton` already HAS columns `sheetSizeL`, `sheetSizeW`, `ups` (schema lines 714–716). Phase A is a **data backfill + form/serializer rewire**, NOT a Carton column migration.
- `CartonForm.tsx` currently writes Sheet Size → `blankLength/blankWidth` (payload keys `blankLength/blankWidth` from `sheetLengthMm/sheetWidthMm`) and UPS → `specialInstructions` JSON. The carton create/update API routes map those.
- Both PO-creation paths (`src/app/api/purchase-orders/route.ts:250`, `src/app/api/purchase-orders/import/commit/route.ts:249`) funnel through `createPurchaseOrderWithLines` in `src/lib/po-create.ts`. Wiring the snapshot there covers both with no caller changes.
- `cartonSchema` (`src/lib/validations.ts:83`) has NO sheetSize/ups; the carton API routes `.extend()` it with carton fields.
- Planning route `src/app/api/planning/po-lines/route.ts` already computes `boardWanted/gsmWanted/shortageSheets/suggestedBoardOptions` (~lines 185–280) using `li.materialQueue?.totalSheets` for required sheets and live `li.carton?.*` fallbacks. Phase B repoints required-sheets math and board source at the resolved pack.

---

## File Structure

**Created:**
- `src/lib/carton-spec-pack.ts` — `SpecPackV1` type, `buildCartonSpecPack`, `readCartonSpecPack`, `emptySpecPack`. Single source of the contract.
- `src/lib/carton-spec-pack.test.ts` — unit tests for builder + reader.
- `src/lib/__migrations__/backfill-carton-sheet-ups.ts` — idempotent Carton backfill script (blankLength/blankWidth + specialInstructions.ups → sheetSizeL/W/ups).
- `src/lib/__migrations__/backfill-poline-specpack.ts` — idempotent open-PO-line specPack backfill.
- `src/components/spec-pack/SpecPackPanel.tsx` — shared read-only panel.
- `src/components/spec-pack/SpecPackPanel.test.tsx` — panel render tests.

**Modified:**
- `prisma/schema.prisma` — add `specPack Json?` to `PoLineItem`.
- `src/components/masters/CartonForm.tsx` — Sheet Size → `sheetSizeL/sheetSizeW`, UPS → `ups`; free blank L/W inputs.
- `src/app/(dashboard)/masters/cartons/[id]/page.tsx` — load `sheetSizeL/sheetSizeW/ups` into the form.
- `src/lib/carton-serialize.ts` — serialize `sheetSizeL/sheetSizeW/ups` from columns (not JSON).
- `src/app/api/masters/cartons/route.ts` + `src/app/api/masters/cartons/[id]/route.ts` — accept/persist `sheetSizeL/sheetSizeW/ups`.
- `src/lib/po-create.ts` — build + store `specPack` in the existing batched carton fetch.
- `src/app/api/planning/po-lines/route.ts` — read pack; pack-derived required sheets + recommendation + procurement suggestion.
- `src/app/(dashboard)/orders/designing/[poLineId]/page.tsx` + its data route — mount panel; ensure `specPack`/`specOverrides` in payload.
- `src/app/(dashboard)/production/job-cards/[id]/page.tsx` + its data route — mount panel; ensure `specPack`/`specOverrides` in payload.

---

# PHASE A — Canonicalization + PO-entry snapshot

## Task 1: `SpecPackV1` contract + `buildCartonSpecPack`

**Files:**
- Create: `src/lib/carton-spec-pack.ts`
- Test: `src/lib/carton-spec-pack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/carton-spec-pack.test.ts
import { describe, it, expect } from 'vitest'
import { buildCartonSpecPack, type CartonForPack } from './carton-spec-pack'

const fullCarton: CartonForPack = {
  id: 'c1',
  cartonName: 'APEG ORAL SOLUTION 200ML',
  boardGrade: 'SBS (Solid Bleached Sulphate)',
  gsm: 350,
  paperType: 'White',
  caliperMicrons: 450,
  plyCount: 1,
  finishedLength: 59,
  finishedWidth: 59,
  finishedHeight: 175,
  blankLength: 210,
  blankWidth: 297,
  dimensionTol: 0.5,
  sheetSizeL: 720,
  sheetSizeW: 510,
  ups: 6,
  printingType: 'Offset',
  numberOfColours: 4,
  backPrint: 'No',
  artworkCode: 'AGSSLLCA001/01',
  coatingType: 'Full UV Coating',
  laminateType: null,
  foilType: null,
  embossingLeafing: 'Embossing',
  drugSchedule: 'H',
  scheduleMRequired: true,
  dieMasterId: 'd1',
  pastingStyle: 'STRAIGHT_TUCK_END',
  shadeCardId: 's1',
  specialInstructions: JSON.stringify({ notes: 'x', spotUvEnabled: true, brailleEnabled: false }),
}

describe('buildCartonSpecPack', () => {
  it('maps a full carton into a v1 pack', () => {
    const p = buildCartonSpecPack(fullCarton)
    expect(p.v).toBe(1)
    expect(p.source.cartonId).toBe('c1')
    expect(p.board).toEqual({
      boardGrade: 'SBS (Solid Bleached Sulphate)', gsm: 350,
      paperType: 'White', caliperMicrons: 450, plyCount: 1,
    })
    expect(p.sheet).toEqual({ sheetSizeL: 720, sheetSizeW: 510, ups: 6 })
    expect(p.finishing.spotUv).toBe(true)
    expect(p.finishing.braille).toBe(false)
    expect(p.pharma).toEqual({ drugSchedule: 'H', scheduleMRequired: true })
    expect(typeof p.source.snapshotAt).toBe('string')
  })

  it('produces nulls (never throws) for a sparse carton', () => {
    const p = buildCartonSpecPack({ id: 'c2', cartonName: 'X' } as CartonForPack)
    expect(p.sheet).toEqual({ sheetSizeL: null, sheetSizeW: null, ups: null })
    expect(p.finishing.spotUv).toBe(false)
    expect(p.board.gsm).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/carton-spec-pack.test.ts`
Expected: FAIL — `Cannot find module './carton-spec-pack'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/carton-spec-pack.ts

/** Versioned, locked product spec snapshot carried on a PO line. */
export interface SpecPackV1 {
  v: 1
  source: { cartonId: string | null; cartonName: string; snapshotAt: string }
  board: {
    boardGrade: string | null; gsm: number | null; paperType: string | null
    caliperMicrons: number | null; plyCount: number | null
  }
  dimensions: {
    finishedL: number | null; finishedW: number | null; finishedH: number | null
    blankL: number | null; blankW: number | null; dimensionTol: number | null
  }
  sheet: { sheetSizeL: number | null; sheetSizeW: number | null; ups: number | null }
  print: {
    printingType: string | null; numberOfColours: number | null
    backPrint: string | null; artworkCode: string | null
  }
  finishing: {
    coatingType: string | null; laminateType: string | null; foilType: string | null
    embossingLeafing: string | null; spotUv: boolean; braille: boolean
  }
  tooling: { dieMasterId: string | null; pastingStyle: string | null }
  linkage: { shadeCardId: string | null }
  pharma: { drugSchedule: string | null; scheduleMRequired: boolean }
}

type Decimalish = { toString(): string }

/** Structural input — accepts a Prisma Carton row (Decimal columns included). */
export interface CartonForPack {
  id: string | null
  cartonName: string
  boardGrade?: string | null
  gsm?: number | null
  paperType?: string | null
  caliperMicrons?: number | null
  plyCount?: number | null
  finishedLength?: Decimalish | number | null
  finishedWidth?: Decimalish | number | null
  finishedHeight?: Decimalish | number | null
  blankLength?: Decimalish | number | null
  blankWidth?: Decimalish | number | null
  dimensionTol?: Decimalish | number | null
  sheetSizeL?: Decimalish | number | null
  sheetSizeW?: Decimalish | number | null
  ups?: number | null
  printingType?: string | null
  numberOfColours?: number | null
  backPrint?: string | null
  artworkCode?: string | null
  coatingType?: string | null
  laminateType?: string | null
  foilType?: string | null
  embossingLeafing?: string | null
  drugSchedule?: string | null
  scheduleMRequired?: boolean | null
  dieMasterId?: string | null
  pastingStyle?: string | null
  shadeCardId?: string | null
  specialInstructions?: string | null
}

function num(v: Decimalish | number | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v.toString())
  return Number.isFinite(n) ? n : null
}

function str(v: string | null | undefined): string | null {
  if (v == null) return null
  const t = String(v).trim()
  return t ? t : null
}

function parseFinishingFlags(raw: string | null | undefined): {
  spotUv: boolean; braille: boolean
} {
  if (!raw) return { spotUv: false, braille: false }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return { spotUv: !!o.spotUvEnabled, braille: !!o.brailleEnabled }
  } catch {
    return { spotUv: false, braille: false }
  }
}

/** Pure: Carton row → frozen v1 spec pack. Never throws. */
export function buildCartonSpecPack(c: CartonForPack): SpecPackV1 {
  const flags = parseFinishingFlags(c.specialInstructions)
  return {
    v: 1,
    source: {
      cartonId: c.id ?? null,
      cartonName: c.cartonName,
      snapshotAt: new Date().toISOString(),
    },
    board: {
      boardGrade: str(c.boardGrade),
      gsm: c.gsm ?? null,
      paperType: str(c.paperType),
      caliperMicrons: c.caliperMicrons ?? null,
      plyCount: c.plyCount ?? null,
    },
    dimensions: {
      finishedL: num(c.finishedLength),
      finishedW: num(c.finishedWidth),
      finishedH: num(c.finishedHeight),
      blankL: num(c.blankLength),
      blankW: num(c.blankWidth),
      dimensionTol: num(c.dimensionTol),
    },
    sheet: {
      sheetSizeL: num(c.sheetSizeL),
      sheetSizeW: num(c.sheetSizeW),
      ups: c.ups ?? null,
    },
    print: {
      printingType: str(c.printingType),
      numberOfColours: c.numberOfColours ?? null,
      backPrint: str(c.backPrint),
      artworkCode: str(c.artworkCode),
    },
    finishing: {
      coatingType: str(c.coatingType),
      laminateType: str(c.laminateType),
      foilType: str(c.foilType),
      embossingLeafing: str(c.embossingLeafing),
      spotUv: flags.spotUv,
      braille: flags.braille,
    },
    tooling: {
      dieMasterId: c.dieMasterId ?? null,
      pastingStyle: str(c.pastingStyle),
    },
    linkage: { shadeCardId: c.shadeCardId ?? null },
    pharma: {
      drugSchedule: str(c.drugSchedule),
      scheduleMRequired: !!c.scheduleMRequired,
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/carton-spec-pack.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/carton-spec-pack.ts src/lib/carton-spec-pack.test.ts
git commit -m "feat(spec-pack): SpecPackV1 contract + buildCartonSpecPack builder"
```

---

## Task 2: `readCartonSpecPack` reader (legacy-safe + override merge)

**Files:**
- Modify: `src/lib/carton-spec-pack.ts`
- Modify: `src/lib/carton-spec-pack.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/lib/carton-spec-pack.test.ts`:

```ts
import { readCartonSpecPack, emptySpecPack } from './carton-spec-pack'

describe('readCartonSpecPack', () => {
  it('flags a legacy line (null specPack) and returns an all-null pack', () => {
    const r = readCartonSpecPack({ specPack: null, specOverrides: null })
    expect(r.legacy).toBe(true)
    expect(r.pack.sheet.ups).toBeNull()
    expect(r.pack.v).toBe(1)
  })

  it('returns the stored pack and is not legacy', () => {
    const stored = emptySpecPack('c9', 'CARTON 9')
    stored.sheet.ups = 8
    const r = readCartonSpecPack({ specPack: stored, specOverrides: null })
    expect(r.legacy).toBe(false)
    expect(r.pack.sheet.ups).toBe(8)
  })

  it('deep-merges specOverrides.specPack over the stored pack', () => {
    const stored = emptySpecPack('c9', 'CARTON 9')
    stored.board.gsm = 300
    stored.sheet.ups = 6
    const r = readCartonSpecPack({
      specPack: stored,
      specOverrides: { specPack: { board: { gsm: 350 } } },
    })
    expect(r.pack.board.gsm).toBe(350) // override wins
    expect(r.pack.sheet.ups).toBe(6)   // untouched
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/carton-spec-pack.test.ts`
Expected: FAIL — `readCartonSpecPack`/`emptySpecPack` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/carton-spec-pack.ts`:

```ts
export interface ResolvedSpecPack { pack: SpecPackV1; legacy: boolean }

export function emptySpecPack(
  cartonId: string | null,
  cartonName: string,
): SpecPackV1 {
  return buildCartonSpecPack({ id: cartonId, cartonName } as CartonForPack)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Recursively overlay `patch` leaves onto `base` (non-mutating). */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(patch)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, pv] of Object.entries(patch)) {
    const bv = out[k]
    out[k] = isObj(bv) && isObj(pv) ? deepMerge(bv, pv) : pv
  }
  return out as T
}

/**
 * Resolve the effective pack for a PO line.
 * - `specPack` null/invalid → legacy line, all-null pack.
 * - `specOverrides.specPack` (Partial<SpecPackV1>) deep-merges over the pack
 *   so a deliberate per-line override wins per field.
 */
export function readCartonSpecPack(line: {
  specPack: unknown
  specOverrides: unknown
}): ResolvedSpecPack {
  let base: SpecPackV1
  let legacy: boolean
  if (isObj(line.specPack) && (line.specPack as { v?: unknown }).v === 1) {
    base = line.specPack as unknown as SpecPackV1
    legacy = false
  } else {
    base = emptySpecPack(null, '')
    legacy = true
  }
  const ov = isObj(line.specOverrides)
    ? (line.specOverrides as Record<string, unknown>).specPack
    : undefined
  return { pack: deepMerge(base, ov), legacy }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/carton-spec-pack.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/carton-spec-pack.ts src/lib/carton-spec-pack.test.ts
git commit -m "feat(spec-pack): readCartonSpecPack reader with legacy + override merge"
```

---

## Task 3: Add `PoLineItem.specPack` column

**Files:**
- Modify: `prisma/schema.prisma` (PoLineItem model, near `specOverrides Json? @map("spec_overrides")` ~line 958)

- [ ] **Step 1: Add the column**

In `prisma/schema.prisma`, immediately after the `specOverrides` line in `model PoLineItem`, add:

```prisma
  specPack                      Json?     @map("spec_pack")
```

- [ ] **Step 2: Create the migration (no data change)**

Run: `npx prisma migrate dev --name poline_spec_pack --create-only`
Expected: a new migration file under `prisma/migrations/*_poline_spec_pack/migration.sql` containing `ADD COLUMN "spec_pack" JSONB`.

- [ ] **Step 3: Apply + regenerate client**

Run: `npx prisma migrate dev && npx prisma generate`
Expected: migration applied; `PoLineItem` type now has `specPack`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add PoLineItem.specPack jsonb column"
```

---

## Task 4: Carton Master form + serializer → dedicated sheet/UPS columns

**Files:**
- Modify: `src/components/masters/CartonForm.tsx`
- Modify: `src/app/(dashboard)/masters/cartons/[id]/page.tsx`
- Modify: `src/lib/carton-serialize.ts`

- [ ] **Step 1: Form payload — write dedicated columns**

In `src/components/masters/CartonForm.tsx`, in `handleSubmit`'s `payload` object, replace the two blank-aliased keys:

```ts
      blankLength: f.sheetLengthMm ? Number(f.sheetLengthMm) : undefined,
      blankWidth: f.sheetWidthMm ? Number(f.sheetWidthMm) : undefined,
```

with:

```ts
      sheetSizeL: f.sheetLengthMm ? Number(f.sheetLengthMm) : undefined,
      sheetSizeW: f.sheetWidthMm ? Number(f.sheetWidthMm) : undefined,
      ups: toOptionalInt(f.ups),
```

Then in the `specialInstructions: JSON.stringify({ ... })` block in the same payload, **remove** the `ups: toOptionalInt(f.ups) ?? null,` line (UPS now lives in its own column; notes/flags stay).

- [ ] **Step 2: Form load — read dedicated columns**

In `src/app/(dashboard)/masters/cartons/[id]/page.tsx`, in the `initialData` object, replace:

```ts
        sheetLengthMm: data.blankLength != null ? String(data.blankLength) : '',
        sheetWidthMm: data.blankWidth != null ? String(data.blankWidth) : '',
        ups: data.ups != null ? String(data.ups) : '',
```

with:

```ts
        sheetLengthMm: data.sheetSizeL != null ? String(data.sheetSizeL) : '',
        sheetWidthMm: data.sheetSizeW != null ? String(data.sheetSizeW) : '',
        ups: data.ups != null ? String(data.ups) : '',
```

Also extend the `ApiCarton` type in that file: add `sheetSizeL?: number | string | null; sheetSizeW?: number | string | null; ups?: number | null` to its type literal.

- [ ] **Step 3: Serializer — emit dedicated columns**

In `src/lib/carton-serialize.ts`, in the returned object of `serializeCarton`, replace the `ups: specialUps,` line with:

```ts
    sheetSizeL: dec(row.sheetSizeL),
    sheetSizeW: dec(row.sheetSizeW),
    ups: row.ups ?? specialUps,
```

(Keep the existing `specialUps` parse as a read-time fallback for not-yet-migrated rows. Leave `blankLength/blankWidth` serialization untouched.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors in the 3 files.

- [ ] **Step 5: Commit**

```bash
git add src/components/masters/CartonForm.tsx "src/app/(dashboard)/masters/cartons/[id]/page.tsx" src/lib/carton-serialize.ts
git commit -m "fix(masters): persist Sheet Size + UPS to dedicated carton columns"
```

---

## Task 5: Carton API schemas accept `sheetSizeL/sheetSizeW/ups`

**Files:**
- Modify: `src/app/api/masters/cartons/route.ts`
- Modify: `src/app/api/masters/cartons/[id]/route.ts`

- [ ] **Step 1: Create route — schema + persist**

In `src/app/api/masters/cartons/route.ts`, in `createSchema = cartonSchema.extend({ ... })`, add:

```ts
  sheetSizeL: z.number().positive().optional(),
  sheetSizeW: z.number().positive().optional(),
  ups: z.number().int().positive().optional(),
```

In the same file's POST handler, add `sheetSizeL`/`sheetSizeW`/`ups` to the `toOptionalNumber` normalization block alongside `finishedLength` etc.:

```ts
    sheetSizeL: toOptionalNumber(body.sheetSizeL),
    sheetSizeW: toOptionalNumber(body.sheetSizeW),
    ups: toOptionalNumber(body.ups),
```

In `db.carton.create({ data: { ... } })`, add:

```ts
      sheetSizeL: data.sheetSizeL ?? null,
      sheetSizeW: data.sheetSizeW ?? null,
      ups: data.ups ?? null,
```

- [ ] **Step 2: Update route — schema + persist**

In `src/app/api/masters/cartons/[id]/route.ts`, in `updateSchema`, add:

```ts
  sheetSizeL: z.number().positive().optional().nullable(),
  sheetSizeW: z.number().positive().optional().nullable(),
  ups: z.number().int().positive().optional().nullable(),
```

In the PUT `safeParse({ ... })` normalization, add:

```ts
    sheetSizeL: toOptionalNumber(body.sheetSizeL),
    sheetSizeW: toOptionalNumber(body.sheetSizeW),
    ups: toOptionalNumber(body.ups),
```

After the existing `if (data.blankWidth !== undefined) update.blankWidth = data.blankWidth`, add:

```ts
  if (data.sheetSizeL !== undefined) update.sheetSizeL = data.sheetSizeL
  if (data.sheetSizeW !== undefined) update.sheetSizeW = data.sheetSizeW
  if (data.ups !== undefined) update.ups = data.ups
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Manual smoke (DB required)**

Run: `npm run dev`, open `/masters/cartons/<id>`, set Sheet size `720 × 510`, UPS `6`, Save, reopen.
Expected: values persist and reload from the dedicated columns.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/masters/cartons/route.ts" "src/app/api/masters/cartons/[id]/route.ts"
git commit -m "feat(api): carton create/update accept sheetSizeL/sheetSizeW/ups"
```

---

## Task 6: Reader audit + Carton backfill script

**Files:**
- Create: `src/lib/__migrations__/backfill-carton-sheet-ups.ts`

- [ ] **Step 1: Audit existing blankLength/blankWidth readers**

Run: `grep -rn "blankLength\|blankWidth\|blank_length\|blank_width" src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v carton-spec-pack`
For each hit, record in the commit message whether it means **press sheet size** (must repoint to `sheetSizeL/sheetSizeW`) or **true carton blank** (leave). Apply repoints in the same commit. If a hit is ambiguous, default to leaving it (blank size) and note it — Task 8 reads the pack, not blank columns, so planning is unaffected.

- [ ] **Step 2: Write the idempotent backfill script**

```ts
// src/lib/__migrations__/backfill-carton-sheet-ups.ts
import { db } from '@/lib/db'
import { writeFileSync } from 'node:fs'

/**
 * One-time, idempotent: move legacy Sheet Size (blankLength/blankWidth) and
 * UPS (specialInstructions JSON) into the dedicated sheetSizeL/W/ups columns.
 * Only fills columns that are currently null. Logs before-values.
 */
async function main() {
  const rows = await db.carton.findMany({
    select: {
      id: true, blankLength: true, blankWidth: true, ups: true,
      sheetSizeL: true, sheetSizeW: true, specialInstructions: true,
    },
  })
  const log: Array<Record<string, unknown>> = []
  for (const r of rows) {
    const data: Record<string, unknown> = {}
    if (r.sheetSizeL == null && r.blankLength != null) data.sheetSizeL = r.blankLength
    if (r.sheetSizeW == null && r.blankWidth != null) data.sheetSizeW = r.blankWidth
    if (r.ups == null && typeof r.specialInstructions === 'string') {
      try {
        const o = JSON.parse(r.specialInstructions) as Record<string, unknown>
        const n = Number(o.ups)
        if (Number.isFinite(n) && n > 0) {
          data.ups = Math.floor(n)
          delete o.ups
          data.specialInstructions = JSON.stringify(o)
        }
      } catch { /* leave as-is */ }
    }
    if (Object.keys(data).length > 0) {
      log.push({ id: r.id, before: {
        sheetSizeL: r.sheetSizeL, sheetSizeW: r.sheetSizeW, ups: r.ups,
      }, applied: data })
      await db.carton.update({ where: { id: r.id }, data })
    }
  }
  writeFileSync(
    'docs/carton-sheet-ups-backfill-log.json',
    JSON.stringify({ at: new Date().toISOString(), count: log.length, log }, null, 2),
  )
  console.log(`Backfilled ${log.length} carton(s). Log: docs/carton-sheet-ups-backfill-log.json`)
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3: Dry-run on a DB copy, then run**

Run (against a restored copy first, then prod DB):
`npx tsx src/lib/__migrations__/backfill-carton-sheet-ups.ts`
Expected: console reports a count; `docs/carton-sheet-ups-backfill-log.json` written with before-values; re-running reports `Backfilled 0` (idempotent).

- [ ] **Step 4: Verify**

Run: `npx tsx -e "import('@/lib/db').then(async ({db})=>{const c=await db.carton.count({where:{ups:{not:null}}});console.log('cartons with ups:',c);process.exit(0)})"`
Expected: count > 0 (assuming legacy data existed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/__migrations__/backfill-carton-sheet-ups.ts docs/carton-sheet-ups-backfill-log.json
git commit -m "chore(migration): backfill carton sheet size + UPS into dedicated columns

Reader audit: <list each blankLength/blankWidth reader and the repoint/leave decision>"
```

---

## Task 7: Snapshot the pack at PO entry + open-line backfill

**Files:**
- Modify: `src/lib/po-create.ts`
- Create: `src/lib/__migrations__/backfill-poline-specpack.ts`

- [ ] **Step 1: Build + store the pack in the existing batched fetch**

In `src/lib/po-create.ts`:

Add import at top:

```ts
import { buildCartonSpecPack } from '@/lib/carton-spec-pack'
```

Replace the HSN-only carton fetch block (the `cartonIdsNeedingHsn` / `cartonHsnById` section) with a fetch of the full carton row keyed by id, reused for both HSN and the pack:

```ts
  const lineCartonIds = Array.from(
    new Set(
      input.lineItems
        .filter((li) => li.cartonId)
        .map((li) => li.cartonId as string),
    ),
  )
  const cartonById = new Map<string, Awaited<ReturnType<typeof tx.carton.findMany>>[number]>()
  if (lineCartonIds.length > 0) {
    const rows = await tx.carton.findMany({ where: { id: { in: lineCartonIds } } })
    for (const r of rows) cartonById.set(r.id, r)
  }
```

In the `input.lineItems.map((li) => { ... tx.poLineItem.create({ data: { ... } }) })` body, change the HSN resolution to read from `cartonById`:

```ts
      const cartonRow = li.cartonId ? cartonById.get(li.cartonId) ?? null : null
      const resolvedHsn =
        li.hsnCode != null && li.hsnCode !== ''
          ? li.hsnCode
          : cartonRow?.hsnCode ?? null
```

And add to the `data: { ... }` object of `tx.poLineItem.create`:

```ts
          specPack: cartonRow ? (buildCartonSpecPack(cartonRow) as object) : undefined,
```

(`undefined` → column stays null for free-text lines, which `readCartonSpecPack` treats as legacy.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Open-PO-line backfill script**

```ts
// src/lib/__migrations__/backfill-poline-specpack.ts
import { db } from '@/lib/db'
import { buildCartonSpecPack } from '@/lib/carton-spec-pack'

/**
 * Best-effort baseline: populate specPack for OPEN po lines that have a
 * cartonId but no pack yet. Closed/dispatched lines are left untouched.
 * Idempotent (skips lines that already have a pack).
 */
async function main() {
  const lines = await db.poLineItem.findMany({
    where: {
      specPack: { equals: null },
      cartonId: { not: null },
      po: { status: { notIn: ['dispatched', 'closed', 'cancelled'] } },
    },
    select: { id: true, cartonId: true },
  })
  let n = 0
  for (const l of lines) {
    const c = await db.carton.findUnique({ where: { id: l.cartonId! } })
    if (!c) continue
    await db.poLineItem.update({
      where: { id: l.id },
      data: { specPack: buildCartonSpecPack(c) as object },
    })
    n++
  }
  console.log(`Backfilled specPack on ${n} open po line(s).`)
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
```

> If `po.status` values differ from `dispatched|closed|cancelled`, run `npx tsx -e "import('@/lib/db').then(async({db})=>{console.log(await db.purchaseOrder.findMany({distinct:['status'],select:{status:true}}));process.exit(0)})"` first and adjust the `notIn` list to the actual terminal statuses.

- [ ] **Step 4: Run the backfill**

Run: `npx tsx src/lib/__migrations__/backfill-poline-specpack.ts`
Expected: console reports a count; re-run reports `0` (idempotent).

- [ ] **Step 5: Commit**

```bash
git add src/lib/po-create.ts src/lib/__migrations__/backfill-poline-specpack.ts
git commit -m "feat(po): snapshot locked carton spec pack onto PO lines at entry"
```

**Phase A complete — green, shippable, inert until Phase B reads the pack.**

---

# PHASE B — Planning smart engine consumption

## Task 8: Pack-derived sheet/qty math helper

**Files:**
- Modify: `src/lib/carton-spec-pack.ts`
- Modify: `src/lib/carton-spec-pack.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/lib/carton-spec-pack.test.ts`:

```ts
import { computePackSheetMath } from './carton-spec-pack'

describe('computePackSheetMath', () => {
  it('computes ceil(qty/ups) * (1 + wastage) ceiled', () => {
    const r = computePackSheetMath({ ups: 6 }, 18000, 2)
    // ceil(18000/6)=3000; *1.02=3060
    expect(r.specComplete).toBe(true)
    expect(r.sheetsRequired).toBe(3060)
  })

  it('flags incomplete when ups missing', () => {
    const r = computePackSheetMath({ ups: null }, 18000, 2)
    expect(r.specComplete).toBe(false)
    expect(r.sheetsRequired).toBeNull()
    expect(r.reason).toMatch(/ups/i)
  })

  it('flags incomplete on non-positive quantity', () => {
    const r = computePackSheetMath({ ups: 6 }, 0, 2)
    expect(r.specComplete).toBe(false)
    expect(r.sheetsRequired).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/carton-spec-pack.test.ts`
Expected: FAIL — `computePackSheetMath` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/carton-spec-pack.ts`:

```ts
export interface PackSheetMath {
  specComplete: boolean
  sheetsRequired: number | null
  reason: string | null
}

/** ceil(quantity / ups) inflated by wastagePct, then ceiled. */
export function computePackSheetMath(
  sheet: { ups: number | null },
  quantity: number,
  wastagePct: number,
): PackSheetMath {
  if (sheet.ups == null || !(sheet.ups > 0)) {
    return { specComplete: false, sheetsRequired: null, reason: 'Missing UPS in spec pack' }
  }
  if (!(quantity > 0)) {
    return { specComplete: false, sheetsRequired: null, reason: 'Order quantity not positive' }
  }
  const w = Number.isFinite(wastagePct) && wastagePct > 0 ? wastagePct : 0
  const base = Math.ceil(quantity / sheet.ups)
  const sheetsRequired = Math.ceil(base * (1 + w / 100))
  return { specComplete: true, sheetsRequired, reason: null }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/carton-spec-pack.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/carton-spec-pack.ts src/lib/carton-spec-pack.test.ts
git commit -m "feat(spec-pack): computePackSheetMath (ups + wastage sheet math)"
```

---

## Task 9: Planning route reads the pack

**Files:**
- Modify: `src/app/api/planning/po-lines/route.ts`

- [ ] **Step 1: Read the route end-to-end**

Read `src/app/api/planning/po-lines/route.ts` fully (esp. the Prisma `findMany` `select/include` for `poLineItem`, and the enrich `.map` body lines ~150–290). Confirm `specOverrides`, `quantity`, and `tolerancePct` are selected on the line; if `specPack`/`specOverrides`/`tolerancePct` are NOT in an explicit `select`, add them to it. If the query uses `include` (no field `select`), they are already present.

- [ ] **Step 2: Import + resolve the pack per line**

Add import at top of the route:

```ts
import { readCartonSpecPack, computePackSheetMath } from '@/lib/carton-spec-pack'
```

Inside the enrich `.map(async (li) => { ... })`, directly after the existing
`const spec = li.specOverrides && typeof li.specOverrides === 'object' ? ... : {}`
line, add:

```ts
      const resolved = readCartonSpecPack({
        specPack: (li as { specPack?: unknown }).specPack ?? null,
        specOverrides: li.specOverrides ?? null,
      })
      const packBoard = resolved.pack.board
      const wastagePct = li.tolerancePct != null ? Number(li.tolerancePct.toString()) : 2
      const packMath = computePackSheetMath(
        resolved.pack.sheet, li.quantity, wastagePct,
      )
```

- [ ] **Step 3: Repoint board/gsm wanted at the pack (pack wins, legacy falls back)**

Replace the existing `boardFromCarton` / `boardWanted` / `gsmWanted` assignments with pack-first resolution:

```ts
      const boardFromPack = packBoard.boardGrade?.trim() || packBoard.paperType?.trim() || ''
      const boardFromPo = typeof li.paperType === 'string' && li.paperType.trim() ? li.paperType.trim() : ''
      const boardFromQueue =
        typeof li.materialQueue?.boardType === 'string' && li.materialQueue.boardType.trim()
          ? li.materialQueue.boardType.trim()
          : ''
      const boardWanted = boardFromQueue || boardFromPack || boardFromPo
      const gsmWanted =
        typeof li.materialQueue?.gsm === 'number'
          ? li.materialQueue.gsm
          : packBoard.gsm != null
            ? packBoard.gsm
            : typeof li.gsm === 'number'
              ? li.gsm
              : li.carton?.gsm ?? null
```

(Delete the now-unused `boardFromCarton` line.)

- [ ] **Step 4: Use pack-derived required sheets for shortage**

Replace:

```ts
      const requiredSheets = li.materialQueue?.totalSheets ?? null
```

with:

```ts
      const requiredSheets =
        packMath.sheetsRequired ?? li.materialQueue?.totalSheets ?? null
```

(`shortageSheets` / `stockSignal` below already derive from `requiredSheets` and need no further change.)

- [ ] **Step 5: Add recommendation + procurement suggestion to the response**

In the returned object's `boardStockInsight: { ... }`, add these fields alongside the existing ones:

```ts
            specComplete: packMath.specComplete,
            specIncompleteReason: packMath.reason,
            recommendedBoardGrade: packBoard.boardGrade,
            recommendedGsm: packBoard.gsm,
            recommendedPaperType: packBoard.paperType,
            packSheetsRequired: packMath.sheetsRequired,
            procurementSuggestion:
              shortageSheets > 0
                ? {
                    boardGrade: packBoard.boardGrade,
                    gsm: packBoard.gsm,
                    paperType: packBoard.paperType,
                    suggestedSheets: shortageSheets,
                  }
                : null,
```

- [ ] **Step 6: Typecheck + full test run**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: no new type errors; existing planning tests still pass.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/planning/po-lines/route.ts"
git commit -m "feat(planning): consume locked spec pack — board reco, sheet math, procurement suggestion"
```

---

## Task 10: Planning UI surfaces pack-derived numbers

**Files:**
- Modify: `src/components/planning/engine/SectionBoardAllocation.tsx`
- Modify: `src/components/planning/engine/SectionBoardAllocation.test.tsx`
- Modify: `src/components/planning/engine/types.ts`

- [ ] **Step 1: Extend the type**

In `src/components/planning/engine/types.ts`, find the `boardStockInsight` shape (within the planning ledger / `PlanningEngineLine` type) and add optional fields:

```ts
  specComplete?: boolean
  specIncompleteReason?: string | null
  recommendedBoardGrade?: string | null
  recommendedGsm?: number | null
  recommendedPaperType?: string | null
  packSheetsRequired?: number | null
  procurementSuggestion?: {
    boardGrade: string | null; gsm: number | null
    paperType: string | null; suggestedSheets: number
  } | null
```

- [ ] **Step 2: Add a failing render test**

In `src/components/planning/engine/SectionBoardAllocation.test.tsx`, add a test that passes a line whose `boardStockInsight` has `specComplete:false, specIncompleteReason:'Missing UPS in spec pack'` and asserts the warning text renders; and a second with `procurementSuggestion` asserting the suggested sheets render. Mirror the existing `baseLine` fixture in that file for shape. Example assertion bodies:

```ts
  it('shows the spec-incomplete warning', () => {
    render(<SectionBoardAllocation line={lineWithIncompletePack} ... />)
    expect(screen.getByText(/missing ups in spec pack/i)).toBeInTheDocument()
  })

  it('shows the procurement suggestion sheets', () => {
    render(<SectionBoardAllocation line={lineWithShortage} ... />)
    expect(screen.getByText(/1,200/)).toBeInTheDocument() // suggestedSheets
  })
```

Use the existing render signature/props already used by other tests in this file (copy from a passing test in the same file — do not invent prop names).

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/components/planning/engine/SectionBoardAllocation.test.tsx`
Expected: FAIL — new text not rendered.

- [ ] **Step 4: Render the new fields**

In `SectionBoardAllocation.tsx`, where `boardStockInsight` is rendered, add:
- when `specComplete === false`: a warning row showing `specIncompleteReason` ("Spec incomplete — cannot compute: {reason}").
- a "Recommended board" line: `{recommendedBoardGrade} · {recommendedGsm} GSM · {recommendedPaperType}` (omit nulls).
- when `procurementSuggestion` is non-null: a "Suggested procurement: {suggestedSheets.toLocaleString()} sheets of {boardGrade} {gsm} GSM" line.
Follow the existing JSX/class conventions in the file (reuse the same row/label classes already present).

- [ ] **Step 5: Run to verify pass + full suite**

Run: `npx vitest run`
Expected: PASS including the two new assertions; no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/components/planning/engine/SectionBoardAllocation.tsx src/components/planning/engine/SectionBoardAllocation.test.tsx src/components/planning/engine/types.ts
git commit -m "feat(planning-ui): show spec-pack board reco, incomplete flag, procurement suggestion"
```

**Phase B complete — planning runs off the locked pack.**

---

# PHASE C — Artworks + Job Cards read-only panel

## Task 11: Shared `SpecPackPanel` component

**Files:**
- Create: `src/components/spec-pack/SpecPackPanel.tsx`
- Create: `src/components/spec-pack/SpecPackPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/spec-pack/SpecPackPanel.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SpecPackPanel } from './SpecPackPanel'
import { emptySpecPack } from '@/lib/carton-spec-pack'

describe('SpecPackPanel', () => {
  it('renders legacy notice when no pack', () => {
    render(<SpecPackPanel specPack={null} specOverrides={null} />)
    expect(screen.getByText(/no locked spec pack/i)).toBeInTheDocument()
  })

  it('renders grouped values from the pack', () => {
    const p = emptySpecPack('c1', 'APEG ORAL')
    p.board.boardGrade = 'SBS'
    p.board.gsm = 350
    p.sheet.ups = 6
    render(<SpecPackPanel specPack={p} specOverrides={null} />)
    expect(screen.getByText('SBS')).toBeInTheDocument()
    expect(screen.getByText('350')).toBeInTheDocument()
    expect(screen.getByText('6')).toBeInTheDocument()
  })

  it('marks overridden fields', () => {
    const p = emptySpecPack('c1', 'X')
    p.board.gsm = 300
    render(
      <SpecPackPanel
        specPack={p}
        specOverrides={{ specPack: { board: { gsm: 350 } } }}
      />,
    )
    expect(screen.getByText('350')).toBeInTheDocument()
    expect(screen.getByText(/overridden/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/spec-pack/SpecPackPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/components/spec-pack/SpecPackPanel.tsx
'use client'

import { readCartonSpecPack } from '@/lib/carton-spec-pack'

type Props = { specPack: unknown; specOverrides: unknown }

function Row({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-ds-ink-muted">{label}</span>
      <span className="font-medium text-foreground">{text}</span>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-ds-md border border-ds-line/50 bg-ds-card p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ds-ink-faint">{title}</h4>
      {children}
    </div>
  )
}

export function SpecPackPanel({ specPack, specOverrides }: Props) {
  const { pack, legacy } = readCartonSpecPack({ specPack, specOverrides })
  const overridden = !!(
    specOverrides &&
    typeof specOverrides === 'object' &&
    (specOverrides as Record<string, unknown>).specPack
  )

  if (legacy) {
    return (
      <div className="rounded-ds-md border border-ds-line/50 bg-ds-card p-3 text-sm text-ds-ink-muted">
        No locked spec pack (legacy line — entered before spec-pack snapshotting).
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ds-ink">Locked Spec Pack</h3>
        {overridden && (
          <span className="rounded border border-ds-warning/40 bg-ds-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ds-warning">
            Overridden for this line
          </span>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Group title="Board">
          <Row label="Board grade" value={pack.board.boardGrade} />
          <Row label="GSM" value={pack.board.gsm} />
          <Row label="Paper type" value={pack.board.paperType} />
          <Row label="Caliper (µm)" value={pack.board.caliperMicrons} />
          <Row label="Ply" value={pack.board.plyCount} />
        </Group>
        <Group title="Dimensions">
          <Row label="Finished L" value={pack.dimensions.finishedL} />
          <Row label="Finished W" value={pack.dimensions.finishedW} />
          <Row label="Finished H" value={pack.dimensions.finishedH} />
          <Row label="Blank L" value={pack.dimensions.blankL} />
          <Row label="Blank W" value={pack.dimensions.blankW} />
          <Row label="Tolerance" value={pack.dimensions.dimensionTol} />
        </Group>
        <Group title="Sheet & UPS">
          <Row label="Sheet size L" value={pack.sheet.sheetSizeL} />
          <Row label="Sheet size W" value={pack.sheet.sheetSizeW} />
          <Row label="UPS" value={pack.sheet.ups} />
        </Group>
        <Group title="Print">
          <Row label="Printing type" value={pack.print.printingType} />
          <Row label="Colours" value={pack.print.numberOfColours} />
          <Row label="Back print" value={pack.print.backPrint} />
          <Row label="Artwork code" value={pack.print.artworkCode} />
        </Group>
        <Group title="Finishing">
          <Row label="Coating" value={pack.finishing.coatingType} />
          <Row label="Laminate" value={pack.finishing.laminateType} />
          <Row label="Foil" value={pack.finishing.foilType} />
          <Row label="Emboss/Leafing" value={pack.finishing.embossingLeafing} />
          <Row label="Spot UV" value={pack.finishing.spotUv} />
          <Row label="Braille" value={pack.finishing.braille} />
        </Group>
        <Group title="Tooling & Pharma">
          <Row label="Pasting style" value={pack.tooling.pastingStyle} />
          <Row label="Drug schedule" value={pack.pharma.drugSchedule} />
          <Row label="Schedule M" value={pack.pharma.scheduleMRequired} />
        </Group>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/spec-pack/SpecPackPanel.test.tsx`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/spec-pack/SpecPackPanel.tsx src/components/spec-pack/SpecPackPanel.test.tsx
git commit -m "feat(spec-pack): shared read-only SpecPackPanel component"
```

---

## Task 12: Mount the panel in Artworks + Job Card screens

**Files:**
- Modify: `src/app/(dashboard)/orders/designing/[poLineId]/page.tsx` (+ its data source)
- Modify: `src/app/(dashboard)/production/job-cards/[id]/page.tsx` (+ its data source)

- [ ] **Step 1: Read both screens and their data routes**

Read `src/app/(dashboard)/orders/designing/[poLineId]/page.tsx` and `src/app/(dashboard)/production/job-cards/[id]/page.tsx`. Trace where each fetches its PO line (the designing route is `src/app/api/designing/po-lines/[id]/route.ts`; the job-card route is `src/app/api/job-cards/[id]/route.ts` or the page's loader). For each data source, confirm `specPack` and `specOverrides` are returned for the PO line; if either is missing from a Prisma `select`, add `specPack: true, specOverrides: true` to that select (no change needed if the query uses `include`/returns the whole line).

- [ ] **Step 2: Render the panel — Artworks**

In the designing page, add the import:

```ts
import { SpecPackPanel } from '@/components/spec-pack/SpecPackPanel'
```

Place, directly above the existing artwork-lookup/resolve section JSX:

```tsx
<div className="mb-4">
  <SpecPackPanel
    specPack={poLine?.specPack ?? null}
    specOverrides={poLine?.specOverrides ?? null}
  />
</div>
```

(Use the page's actual PO-line variable name in place of `poLine` — confirmed in Step 1.)

- [ ] **Step 3: Render the panel — Job Cards**

In the job-card detail page, add the same import and place the panel in the spec/details area:

```tsx
<div className="mb-4">
  <SpecPackPanel
    specPack={jobCard?.poLineItem?.specPack ?? null}
    specOverrides={jobCard?.poLineItem?.specOverrides ?? null}
  />
</div>
```

(Use the page's actual job-card/PO-line variable path confirmed in Step 1. If the job-card payload exposes the PO line under a different relation name, use that.)

- [ ] **Step 4: Typecheck + manual verification (DB required)**

Run: `npx tsc --noEmit -p tsconfig.json`
Then `npm run dev`:
- Open an Artworks (designing) screen for a PO line created **after** Phase A → panel shows the locked pack.
- Open a Job Card whose PO line predates Phase A → panel shows the "legacy line" notice.
Expected: both render without console errors; values match the source carton at the time the PO was entered.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/orders/designing/[poLineId]/page.tsx" "src/app/(dashboard)/production/job-cards/[id]/page.tsx" "src/app/api/designing/po-lines/[id]/route.ts" "src/app/api/job-cards/[id]/route.ts"
git commit -m "feat(spec-pack): surface read-only spec pack in Artworks + Job Card screens"
```

**Phase C complete — Artworks and Job Card people work off the locked pack.**

---

## Final verification (run after all phases)

- [ ] `npx vitest run` — full suite green.
- [ ] `npx tsc --noEmit -p tsconfig.json` — no new errors.
- [ ] Create a fresh PO (manual + PDF import) for a carton with full specs → confirm `specPack` populated on its lines (DB check).
- [ ] Edit that carton's GSM in Carton Master → confirm the existing PO line's pack is **unchanged** (lock guarantee).
- [ ] Planning screen for that PO line → board recommendation + sheet math + shortage + procurement suggestion all reflect the **frozen** pack.

---

## Self-review notes (filled by plan author)

- **Spec coverage:** Spec §"Phase A" → Tasks 1–7; §"Phase B" → Tasks 8–10; §"Phase C" → Tasks 11–12; §"Cross-cutting/migrations" → Tasks 3,6,7 (+ Final verification); §"legacy/null safety" → Task 2 + panel legacy notice + planning fallback.
- **Carton column add NOT needed** (sheetSizeL/W/ups already exist) — Phase A is rewire + backfill only; recorded as a pre-known fact.
- **Override semantics:** implemented as `specOverrides.specPack` deep-merge (nested), the only faithful interpretation since `specOverrides` is otherwise a flat loose bag; documented in spec "Out of scope" boundary (no flat-key remapping invented).
- **Ambiguity flagged for executor:** wastage source is `tolerancePct` (Task 9 Step 2) per approved spec; blank/sheet reader audit is an explicit step (Task 6 Step 1), not an assumption.
