# Carton Master Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wipe & re-import the Carton Master from the Excel "Carton Master Bible", add warehouse physical-size verification, a PO spec auto-fetcher, and a smart planning/match engine.

**Architecture:** Pure, unit-tested logic lives in `src/lib/carton/*` (parsers, variance, match scoring) so it is testable under vitest (`src/**/*.test.ts`). Destructive/IO scripts (`scripts/*.ts`, run via `npx tsx`) import that logic. New DB columns ship as one raw-SQL Prisma migration consistent with `prisma migrate deploy` in the build. API routes follow the existing `requireAuth()` + `db` pattern; UI uses `sonner` toasts and the `(dashboard)` route group so URLs resolve at `/carton-master/...`.

**Tech Stack:** Next.js 14 App Router, Prisma + Neon Postgres, `xlsx`, `tsx`, vitest, `sonner`, Tailwind.

---

## Decisions locked at brainstorming

- **Wipe FK strategy:** Cascade delete everything linked (PoLineItem, PlateStore + scrap events, PlateRequirement + plate hub events that reference cartons). Documented data-loss consequence: POs lose their line items.
- **Sheet Size / UPS:** Add new columns `sheet_size_l`, `sheet_size_w`, `ups` to `cartons`.
- **Pasting enum:** Set `pastingStyle` only on a clean map to `LOCK_BOTTOM|BSO|SPECIAL`; otherwise NULL and log the raw value.
- IDs are UUIDs → no sequences to reset (Task 1 step is a documented no-op).

## File Structure

| File | Responsibility |
|---|---|
| `prisma/migrations/20260516130000_carton_warehouse_po_planning/migration.sql` | Adds sheet_size_l/w, ups, physical_l/w/h, size_verified*, size_variance_notes to `cartons` + index |
| `prisma/schema.prisma` (Carton model) | Mirror new columns in Prisma schema |
| `src/lib/carton/parse.ts` | Pure parsers: `parseDims`, `parseSheetSize`, `parseColours`, `mapPastingStyle`, `parseRate`, `parseGsm` |
| `src/lib/carton/parse.test.ts` | Vitest unit tests for parsers |
| `src/lib/carton/variance.ts` | Pure `computeVariance(spec, physical, tolMm)` → per-axis variance + mismatch flag |
| `src/lib/carton/variance.test.ts` | Vitest unit tests for variance |
| `src/lib/carton/match.ts` | Pure `levenshtein`, `scoreCartonMatch`, `dimensionMatch` |
| `src/lib/carton/match.test.ts` | Vitest unit tests for match scoring |
| `scripts/wipe-cartons.ts` | Destructive cascade wipe, `--confirm` guarded, `--dry-run` default-safe |
| `scripts/migrate-cartons.ts` | Excel → DB importer, `--dry-run` + `--confirm`, writes `failed-rows.csv` |
| `src/app/api/cartons/[id]/warehouse-verify/route.ts` | PATCH physical size + variance |
| `src/app/api/cartons/[id]/po-specs/route.ts` | GET full PO spec bundle |
| `src/app/api/cartons/smart-search/route.ts` | GET ranked smart search |
| `src/app/api/cartons/dimension-match/route.ts` | POST dimension auto-match |
| `src/app/api/planning/suggest-carton/route.ts` | POST weighted carton suggestion |
| `src/hooks/useCartonPOSpecs.ts` | React hook wrapping `/po-specs` |
| `src/components/carton/WarehouseSizeVerifier.tsx` | Spec vs physical live-variance UI |
| `src/components/carton/PlanningSmartMatch.tsx` | Dashboard match widget |
| `src/app/(dashboard)/carton-master/[id]/warehouse/page.tsx` | Hosts WarehouseSizeVerifier |

---

## PHASE A — Schema migration (foundation for all tasks)

### Task A1: Add new columns via Prisma migration

**Files:**
- Create: `prisma/migrations/20260516130000_carton_warehouse_po_planning/migration.sql`
- Modify: `prisma/schema.prisma` (Carton model, after `source` line ~712)

- [ ] **Step 1: Write the migration SQL**

Create `prisma/migrations/20260516130000_carton_warehouse_po_planning/migration.sql`:

```sql
-- AlterTable: Excel-import + warehouse verification fields
ALTER TABLE "cartons" ADD COLUMN "sheet_size_l" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "sheet_size_w" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "ups" INTEGER;
ALTER TABLE "cartons" ADD COLUMN "physical_l" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "physical_w" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "physical_h" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "size_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cartons" ADD COLUMN "size_verified_at" TIMESTAMP(3);
ALTER TABLE "cartons" ADD COLUMN "size_verified_by" TEXT;
ALTER TABLE "cartons" ADD COLUMN "size_variance_notes" TEXT;

-- CreateIndex: smart-search / planning filters
CREATE INDEX "cartons_size_verified_idx" ON "cartons"("size_verified");
CREATE INDEX "cartons_customer_id_carton_name_idx" ON "cartons"("customer_id", "carton_name");
```

- [ ] **Step 2: Mirror columns in `prisma/schema.prisma`**

In the `Carton` model, immediately after the `source String? @map("source")` line (~712), insert:

```prisma
  // EXCEL IMPORT EXTRAS
  sheetSizeL          Decimal?      @map("sheet_size_l") @db.Decimal(8, 2)
  sheetSizeW          Decimal?      @map("sheet_size_w") @db.Decimal(8, 2)
  ups                 Int?          @map("ups")
  // WAREHOUSE PHYSICAL VERIFICATION
  physicalL           Decimal?      @map("physical_l") @db.Decimal(8, 2)
  physicalW           Decimal?      @map("physical_w") @db.Decimal(8, 2)
  physicalH           Decimal?      @map("physical_h") @db.Decimal(8, 2)
  sizeVerified        Boolean       @default(false) @map("size_verified")
  sizeVerifiedAt      DateTime?     @map("size_verified_at")
  sizeVerifiedBy      String?       @map("size_verified_by")
  sizeVarianceNotes   String?       @map("size_variance_notes") @db.Text
```

And add inside the `@@index` block area (before `@@map("cartons")`):

```prisma
  @@index([sizeVerified])
  @@index([customerId, cartonName])
```

- [ ] **Step 3: Apply migration & regenerate client**

Run: `npx prisma migrate deploy && npx prisma generate`
Expected: `migration 20260516130000_carton_warehouse_po_planning applied`; client regenerated with no error.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors from schema change).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260516130000_carton_warehouse_po_planning
git commit -m "feat(carton): add sheet size, ups, and warehouse verification columns"
```

---

## PHASE B — Pure parser library (TDD, feeds Task 2)

### Task B1: Excel value parsers

**Files:**
- Create: `src/lib/carton/parse.ts`
- Test: `src/lib/carton/parse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/carton/parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  parseDims,
  parseSheetSize,
  parseColours,
  mapPastingStyle,
  parseRate,
  parseGsm,
} from './parse'

describe('parseDims', () => {
  it('splits LxWxH', () => {
    expect(parseDims('138X50X108')).toEqual({ l: 138, w: 50, h: 108 })
  })
  it('lowercase x and spaces', () => {
    expect(parseDims(' 10 x 10 x 10 ')).toEqual({ l: 10, w: 10, h: 10 })
  })
  it('null/blank → all null', () => {
    expect(parseDims(null)).toEqual({ l: null, w: null, h: null })
    expect(parseDims('')).toEqual({ l: null, w: null, h: null })
  })
  it('two-part is treated as L x W only', () => {
    expect(parseDims('138X50')).toEqual({ l: 138, w: 50, h: null })
  })
})

describe('parseSheetSize', () => {
  it('parses LxW', () => {
    expect(parseSheetSize('138X50')).toEqual({ l: 138, w: 50 })
  })
  it('null → nulls', () => {
    expect(parseSheetSize(null)).toEqual({ l: null, w: null })
  })
})

describe('parseColours', () => {
  it('CMYK → 4', () => expect(parseColours('CMYK')).toBe(4))
  it('CMYKP → 5', () => expect(parseColours('CMYKP')).toBe(5))
  it('blank → null', () => {
    expect(parseColours(null)).toBeNull()
    expect(parseColours('')).toBeNull()
  })
  it('explicit number string', () => expect(parseColours('3')).toBe(3))
})

describe('mapPastingStyle', () => {
  it('maps known values case-insensitively', () => {
    expect(mapPastingStyle('lock bottom')).toBe('LOCK_BOTTOM')
    expect(mapPastingStyle('BSO')).toBe('BSO')
    expect(mapPastingStyle('special')).toBe('SPECIAL')
  })
  it('unknown/blank → null', () => {
    expect(mapPastingStyle(null)).toBeNull()
    expect(mapPastingStyle('straight tuck')).toBeNull()
  })
})

describe('parseRate / parseGsm', () => {
  it('parseRate strips currency', () => expect(parseRate('23.20')).toBe(23.2))
  it('parseRate null', () => expect(parseRate(null)).toBeNull())
  it('parseGsm int', () => expect(parseGsm('350')).toBe(350))
  it('parseGsm bad → null', () => expect(parseGsm('abc')).toBeNull())
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/carton/parse.test.ts`
Expected: FAIL — cannot resolve `./parse`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/carton/parse.ts`:

```ts
export type Dims3 = { l: number | null; w: number | null; h: number | null }
export type Dims2 = { l: number | null; w: number | null }

function num(s: string): number | null {
  const n = Number(s.trim())
  return Number.isFinite(n) ? n : null
}

export function parseDims(raw: string | null | undefined): Dims3 {
  if (!raw || !String(raw).trim()) return { l: null, w: null, h: null }
  const parts = String(raw)
    .trim()
    .split(/\s*[xX]\s*/)
    .filter((p) => p.length > 0)
  return {
    l: parts[0] != null ? num(parts[0]) : null,
    w: parts[1] != null ? num(parts[1]) : null,
    h: parts[2] != null ? num(parts[2]) : null,
  }
}

export function parseSheetSize(raw: string | null | undefined): Dims2 {
  const d = parseDims(raw)
  return { l: d.l, w: d.w }
}

export function parseColours(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const v = String(raw).trim().toUpperCase()
  if (!v) return null
  if (v === 'CMYK') return 4
  if (v === 'CMYKP') return 5
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

const PASTING_MAP: Record<string, 'LOCK_BOTTOM' | 'BSO' | 'SPECIAL'> = {
  'LOCK BOTTOM': 'LOCK_BOTTOM',
  LOCKBOTTOM: 'LOCK_BOTTOM',
  LOCK_BOTTOM: 'LOCK_BOTTOM',
  BSO: 'BSO',
  SPECIAL: 'SPECIAL',
}

export function mapPastingStyle(
  raw: string | null | undefined,
): 'LOCK_BOTTOM' | 'BSO' | 'SPECIAL' | null {
  if (raw == null) return null
  const v = String(raw).trim().toUpperCase()
  return PASTING_MAP[v] ?? null
}

export function parseRate(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const cleaned = String(raw).replace(/[^0-9.]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export function parseGsm(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const n = parseInt(String(raw).trim(), 10)
  return Number.isInteger(n) ? n : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/carton/parse.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/carton/parse.ts src/lib/carton/parse.test.ts
git commit -m "feat(carton): add tested Excel value parsers"
```

---

## PHASE C — Task 1: Wipe script

### Task C1: Cascade wipe with --confirm guard

**Files:**
- Create: `scripts/wipe-cartons.ts`

- [ ] **Step 1: Write the script**

Create `scripts/wipe-cartons.ts`:

```ts
/**
 * wipe-cartons.ts — DESTRUCTIVE. Cascade-deletes all cartons and every
 * record that FK-references a carton (PO line items, plate stores + their
 * scrap events, plate requirements + their hub events). Does NOT touch
 * customers, dyes, shade cards, users, or purchase order headers.
 *
 * IDs are UUIDs — there are NO auto-increment sequences to reset (no-op).
 *
 * USAGE:
 *   npx tsx scripts/wipe-cartons.ts            # dry-run, counts only
 *   npx tsx scripts/wipe-cartons.ts --confirm  # REAL destructive wipe
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')

async function main() {
  const cartonIds = (await prisma.carton.findMany({ select: { id: true } })).map(
    (c) => c.id,
  )

  const counts = {
    cartons: cartonIds.length,
    poLineItems: await prisma.poLineItem.count({
      where: { cartonId: { in: cartonIds } },
    }),
    plateStores: await prisma.plateStore.count({
      where: { cartonId: { in: cartonIds } },
    }),
    plateRequirements: await prisma.plateRequirement.count({
      where: { cartonId: { in: cartonIds } },
    }),
  }

  console.log('── Carton wipe — records that will be deleted ──')
  console.table(counts)
  console.log(
    'NOTE: deleting PO line items leaves their PurchaseOrder headers empty.',
  )

  if (!CONFIRM) {
    console.log('\nDRY-RUN. Re-run with --confirm to execute the wipe.')
    return
  }

  await prisma.$transaction(async (tx) => {
    const plateStoreIds = (
      await tx.plateStore.findMany({
        where: { cartonId: { in: cartonIds } },
        select: { id: true },
      })
    ).map((p) => p.id)
    const plateReqIds = (
      await tx.plateRequirement.findMany({
        where: { cartonId: { in: cartonIds } },
        select: { id: true },
      })
    ).map((p) => p.id)

    await tx.plateStoreScrapEvent.deleteMany({
      where: { plateStoreId: { in: plateStoreIds } },
    })
    await tx.plateHubEvent.deleteMany({
      where: { plateRequirementId: { in: plateReqIds } },
    })
    await tx.plateStore.deleteMany({ where: { cartonId: { in: cartonIds } } })
    await tx.plateRequirement.deleteMany({
      where: { cartonId: { in: cartonIds } },
    })
    await tx.poLineItem.deleteMany({ where: { cartonId: { in: cartonIds } } })
    // ShadeCard.productId is onDelete:SetNull — Prisma nulls it automatically.
    await tx.carton.deleteMany({})
  })

  console.log('✅ Wipe complete. Auto-increment sequence reset: N/A (UUID PKs).')
}

main()
  .catch((e) => {
    console.error('Wipe failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Verify FK model names against schema**

Run: `npx prisma validate && grep -n "plateStoreId\|plateRequirementId" prisma/schema.prisma | head`
Expected: confirms `PlateStoreScrapEvent.plateStoreId` and `PlateHubEvent.plateRequirementId` exist. If field names differ, correct the script before continuing.

- [ ] **Step 3: Dry-run**

Run: `npx tsx scripts/wipe-cartons.ts`
Expected: prints count table, ends with "DRY-RUN. Re-run with --confirm". No rows deleted.

- [ ] **Step 4: Commit (do NOT run --confirm yet — Task D1 step controls that)**

```bash
git add scripts/wipe-cartons.ts
git commit -m "feat(scripts): add --confirm-guarded cascade carton wipe"
```

---

## PHASE D — Task 2: Excel migration script

### Task D1: Importer with dry-run, failed-rows.csv

**Files:**
- Create: `scripts/migrate-cartons.ts`

- [ ] **Step 1: Write the script**

Create `scripts/migrate-cartons.ts`:

```ts
/**
 * migrate-cartons.ts — imports the "Carton Master Bible" Excel into `cartons`.
 *
 * USAGE:
 *   npx tsx scripts/migrate-cartons.ts "<path-to.xlsx>"            # dry-run
 *   npx tsx scripts/migrate-cartons.ts "<path-to.xlsx>" --confirm  # real insert
 *
 * Sheet: "Carton Master Bible" (else first sheet). Header at row index 2,
 * data from row index 3. Yellow-highlighted (missing colour) rows import
 * with numberOfColours = null. Failures written to failed-rows.csv.
 */
import { PrismaClient } from '@prisma/client'
import * as XLSX from 'xlsx'
import * as fs from 'fs'
import {
  parseDims,
  parseSheetSize,
  parseColours,
  mapPastingStyle,
  parseRate,
  parseGsm,
} from '../src/lib/carton/parse'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')
const filePath = process.argv.slice(2).find((a) => !a.startsWith('--'))

type Row = (string | null)[]

async function main() {
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('Excel path required and must exist. Got:', filePath)
    process.exit(1)
  }
  const wb = XLSX.readFile(filePath)
  const sheetName =
    wb.SheetNames.find((n) => n === 'Carton Master Bible') ?? wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: false })
  const dataRows = rows.slice(3) // skip title(0), subtitle(1), header(2)

  const customerCache = new Map<string, string>()
  const failed: { row: number; name: string; reason: string }[] = []
  let success = 0,
    skipped = 0

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const excelRowNo = i + 4 // 1-based, +3 offset, +1 header line
    const cartonName = (r[0] ?? '').toString().trim()
    const customerName = (r[1] ?? '').toString().trim()

    if (!cartonName) {
      skipped++
      continue
    }
    if (!customerName) {
      failed.push({ row: excelRowNo, name: cartonName, reason: 'missing Customer' })
      continue
    }

    try {
      const dims = parseDims(r[9] as string) // Panel Size (LxWxH)
      const sheet = parseSheetSize(r[3] as string) // Sheet Size
      const rec = {
        cartonName,
        numberOfColours: parseColours(r[2] as string),
        sheetSizeL: sheet.l,
        sheetSizeW: sheet.w,
        ups: r[4] != null && String(r[4]).trim() ? parseInt(String(r[4]), 10) : null,
        boardGrade: (r[5] ?? null) as string | null, // Board Type
        category: (r[6] ?? null) as string | null,
        printingType: (r[6] ?? null) as string | null, // Category → printingType
        coatingType: (r[7] ?? null) as string | null, // Coating
        pastingStyle: mapPastingStyle(r[8] as string),
        finishedLength: dims.l,
        finishedWidth: dims.w,
        finishedHeight: dims.h,
        rate: parseRate(r[10] as string),
        gsm: parseGsm(r[11] as string),
      }
      const rawPasting = (r[8] ?? '').toString().trim()
      if (rawPasting && rec.pastingStyle == null) {
        console.warn(
          `row ${excelRowNo}: unmapped Pasting Type "${rawPasting}" → null`,
        )
      }

      if (!CONFIRM) {
        success++
        continue
      }

      let customerId = customerCache.get(customerName.toLowerCase())
      if (!customerId) {
        const existing = await prisma.customer.findFirst({
          where: { name: { equals: customerName, mode: 'insensitive' } },
          select: { id: true },
        })
        customerId =
          existing?.id ??
          (
            await prisma.customer.create({
              data: { name: customerName, source: 'carton_bible_import' },
              select: { id: true },
            })
          ).id
        customerCache.set(customerName.toLowerCase(), customerId)
      }

      await prisma.carton.create({
        data: {
          ...rec,
          customerId,
          source: 'carton_bible_import',
        },
      })
      success++
    } catch (e) {
      failed.push({
        row: excelRowNo,
        name: cartonName,
        reason: (e as Error).message,
      })
    }
  }

  console.log('── Import summary ──')
  console.table({
    total: dataRows.length,
    success,
    failed: failed.length,
    skipped,
    mode: CONFIRM ? 'WRITE' : 'DRY-RUN',
  })

  if (failed.length) {
    const csv =
      'excel_row,carton_name,reason\n' +
      failed
        .map(
          (f) =>
            `${f.row},"${f.name.replace(/"/g, '""')}","${f.reason.replace(/"/g, '""')}"`,
        )
        .join('\n')
    fs.writeFileSync('failed-rows.csv', csv)
    console.log(`Wrote failed-rows.csv (${failed.length} rows).`)
  }
  if (!CONFIRM) console.log('\nDRY-RUN — no rows written. Add --confirm to insert.')
}

main()
  .catch((e) => {
    console.error('Import failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Dry-run against the real file**

Run: `npx tsx scripts/migrate-cartons.ts "/Users/anikdua/Documents/Projects/Data base /carton_master_bible.xlsx"`
Expected: summary table with `total: 1080`, `mode: DRY-RUN`, success≈1080. **STOP and show the user this output + any `failed-rows.csv` before proceeding.**

- [ ] **Step 3: CHECKPOINT — get user confirmation**

Do not run the wipe or the `--confirm` import without explicit user "yes". When confirmed:
- Run: `npx tsx scripts/wipe-cartons.ts --confirm`
- Then: `npx tsx scripts/migrate-cartons.ts "/Users/anikdua/Documents/Projects/Data base /carton_master_bible.xlsx" --confirm`
Expected: wipe completes; import summary `mode: WRITE`, success count reported.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-cartons.ts
git commit -m "feat(scripts): add Carton Bible Excel importer with dry-run"
```

---

## PHASE E — Task 3: Warehouse physical size verification

### Task E1: Variance logic (TDD)

**Files:**
- Create: `src/lib/carton/variance.ts`
- Test: `src/lib/carton/variance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/carton/variance.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeVariance } from './variance'

describe('computeVariance', () => {
  const spec = { l: 138, w: 50, h: 108 }
  it('exact match → no mismatch, zero variance', () => {
    const r = computeVariance(spec, { l: 138, w: 50, h: 108 }, 2)
    expect(r.variance).toEqual({ l: 0, w: 0, h: 0 })
    expect(r.sizeMismatch).toBe(false)
    expect(r.maxAbsVariance).toBe(0)
  })
  it('<=2mm on all axes → not a mismatch', () => {
    const r = computeVariance(spec, { l: 139, w: 48, h: 110 }, 2)
    expect(r.sizeMismatch).toBe(false)
  })
  it('>2mm on one axis → mismatch', () => {
    const r = computeVariance(spec, { l: 145, w: 50, h: 108 }, 2)
    expect(r.variance.l).toBe(7)
    expect(r.sizeMismatch).toBe(true)
    expect(r.maxAbsVariance).toBe(7)
  })
  it('missing physical value → that axis variance null, not a mismatch by itself', () => {
    const r = computeVariance(spec, { l: null, w: 50, h: 108 }, 2)
    expect(r.variance.l).toBeNull()
    expect(r.sizeMismatch).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/carton/variance.test.ts`
Expected: FAIL — cannot resolve `./variance`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/carton/variance.ts`:

```ts
export type Axis = number | null
export type Dims = { l: Axis; w: Axis; h: Axis }

export type VarianceResult = {
  variance: { l: Axis; w: Axis; h: Axis }
  maxAbsVariance: number
  sizeMismatch: boolean
}

export function computeVariance(
  spec: Dims,
  physical: Dims,
  tolMm = 2,
): VarianceResult {
  const axisVar = (s: Axis, p: Axis): Axis =>
    s == null || p == null ? null : Number((p - s).toFixed(2))

  const variance = {
    l: axisVar(spec.l, physical.l),
    w: axisVar(spec.w, physical.w),
    h: axisVar(spec.h, physical.h),
  }
  const abs = [variance.l, variance.w, variance.h]
    .filter((v): v is number => v != null)
    .map((v) => Math.abs(v))
  const maxAbsVariance = abs.length ? Math.max(...abs) : 0
  return { variance, maxAbsVariance, sizeMismatch: maxAbsVariance > tolMm }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/carton/variance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/carton/variance.ts src/lib/carton/variance.test.ts
git commit -m "feat(carton): add tested dimension variance logic"
```

### Task E2: PATCH warehouse-verify route

**Files:**
- Create: `src/app/api/cartons/[id]/warehouse-verify/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/cartons/[id]/warehouse-verify/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { computeVariance } from '@/lib/carton/variance'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const physical = {
    l: body.physical_l != null ? Number(body.physical_l) : null,
    w: body.physical_w != null ? Number(body.physical_w) : null,
    h: body.physical_h != null ? Number(body.physical_h) : null,
  }

  const carton = await db.carton.findUnique({ where: { id: params.id } })
  if (!carton)
    return NextResponse.json({ error: 'Carton not found' }, { status: 404 })

  const spec = {
    l: carton.finishedLength != null ? Number(carton.finishedLength) : null,
    w: carton.finishedWidth != null ? Number(carton.finishedWidth) : null,
    h: carton.finishedHeight != null ? Number(carton.finishedHeight) : null,
  }
  const v = computeVariance(spec, physical, 2)

  const updated = await db.carton.update({
    where: { id: params.id },
    data: {
      physicalL: physical.l,
      physicalW: physical.w,
      physicalH: physical.h,
      sizeVerified: true,
      sizeVerifiedAt: new Date(),
      sizeVerifiedBy:
        (body.verified_by as string) ?? user?.name ?? user?.email ?? 'unknown',
      sizeVarianceNotes: (body.notes as string) ?? null,
    },
  })

  return NextResponse.json({
    carton: updated,
    variance: v.variance,
    maxAbsVariance: v.maxAbsVariance,
    status: v.sizeMismatch ? 'size_mismatch' : 'ok',
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cartons/\[id\]/warehouse-verify/route.ts
git commit -m "feat(api): add warehouse-verify PATCH with variance report"
```

### Task E3: WarehouseSizeVerifier component + page

**Files:**
- Create: `src/components/carton/WarehouseSizeVerifier.tsx`
- Create: `src/app/(dashboard)/carton-master/[id]/warehouse/page.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/carton/WarehouseSizeVerifier.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { toast } from 'sonner'
import { computeVariance } from '@/lib/carton/variance'

type Spec = { l: number | null; w: number | null; h: number | null }

export function WarehouseSizeVerifier({
  cartonId,
  spec,
}: {
  cartonId: string
  spec: Spec
}) {
  const [phys, setPhys] = useState<{ l: string; w: string; h: string }>({
    l: '',
    w: '',
    h: '',
  })
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const physNum = {
    l: phys.l ? Number(phys.l) : null,
    w: phys.w ? Number(phys.w) : null,
    h: phys.h ? Number(phys.h) : null,
  }
  const v = computeVariance(spec, physNum, 2)

  const cellColor = (axisVar: number | null) => {
    if (axisVar == null) return 'bg-muted'
    const a = Math.abs(axisVar)
    if (a === 0) return 'bg-green-100 text-green-800'
    if (a <= 2) return 'bg-yellow-100 text-yellow-800'
    return 'bg-red-100 text-red-800'
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/cartons/${cartonId}/warehouse-verify`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          physical_l: physNum.l,
          physical_w: physNum.w,
          physical_h: physNum.h,
          notes,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Save failed')
      toast.success(
        data.status === 'size_mismatch'
          ? `Saved — SIZE MISMATCH (max ${data.maxAbsVariance}mm)`
          : 'Saved — size within tolerance',
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const axes: ('l' | 'w' | 'h')[] = ['l', 'w', 'h']
  return (
    <div className="space-y-4">
      <table className="w-full text-sm border">
        <thead>
          <tr className="bg-muted">
            <th className="p-2 text-left">Axis</th>
            <th className="p-2">Spec (mm)</th>
            <th className="p-2">Physical (mm)</th>
            <th className="p-2">Variance</th>
          </tr>
        </thead>
        <tbody>
          {axes.map((ax) => (
            <tr key={ax} className="border-t">
              <td className="p-2 font-medium uppercase">{ax}</td>
              <td className="p-2 text-center">{spec[ax] ?? '—'}</td>
              <td className="p-2 text-center">
                <input
                  type="number"
                  className="w-24 border rounded px-2 py-1"
                  value={phys[ax]}
                  onChange={(e) =>
                    setPhys((p) => ({ ...p, [ax]: e.target.value }))
                  }
                />
              </td>
              <td className={`p-2 text-center ${cellColor(v.variance[ax])}`}>
                {v.variance[ax] == null ? '—' : `${v.variance[ax]}mm`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <textarea
        className="w-full border rounded p-2 text-sm"
        placeholder="Variance notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button
        disabled={saving}
        onClick={save}
        className="px-4 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save verification'}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Write the page**

Create `src/app/(dashboard)/carton-master/[id]/warehouse/page.tsx`:

```tsx
import { db } from '@/lib/db'
import { notFound } from 'next/navigation'
import { WarehouseSizeVerifier } from '@/components/carton/WarehouseSizeVerifier'

export const dynamic = 'force-dynamic'

export default async function WarehousePage({
  params,
}: {
  params: { id: string }
}) {
  const c = await db.carton.findUnique({
    where: { id: params.id },
    include: { customer: { select: { name: true } } },
  })
  if (!c) notFound()

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold mb-1">Physical Size Verification</h1>
      <p className="text-sm text-muted-foreground mb-4">
        {c.cartonName} — {c.customer.name}
      </p>
      <WarehouseSizeVerifier
        cartonId={c.id}
        spec={{
          l: c.finishedLength != null ? Number(c.finishedLength) : null,
          w: c.finishedWidth != null ? Number(c.finishedWidth) : null,
          h: c.finishedHeight != null ? Number(c.finishedHeight) : null,
        }}
      />
    </div>
  )
}
```

- [ ] **Step 3: Typecheck + manual verify**

Run: `npm run typecheck`
Expected: PASS. Then `npm run dev`, open `/carton-master/<a-real-id>/warehouse`, type physical values, confirm green/yellow/red cells update live and Save shows a toast.

- [ ] **Step 4: Commit**

```bash
git add src/components/carton/WarehouseSizeVerifier.tsx "src/app/(dashboard)/carton-master/[id]/warehouse/page.tsx"
git commit -m "feat(carton): warehouse size verifier UI + page"
```

---

## PHASE F — Task 4: Smart PO spec fetcher

### Task F1: GET /api/cartons/[id]/po-specs

**Files:**
- Create: `src/app/api/cartons/[id]/po-specs/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/cartons/[id]/po-specs/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { computeVariance } from '@/lib/carton/variance'

export const dynamic = 'force-dynamic'

const n = (v: unknown) => (v != null ? Number(v as number) : null)

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { error } = await requireAuth()
  if (error) return error

  const c = await db.carton.findUnique({
    where: { id: params.id },
    include: {
      customer: { select: { id: true, name: true } },
      dieMaster: { select: { id: true, dyeNumber: true, dyeType: true } },
      shadeCard: { select: { id: true, shadeCardNumber: true } },
    },
  })
  if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const spec = { l: n(c.finishedLength), w: n(c.finishedWidth), h: n(c.finishedHeight) }
  const physical = { l: n(c.physicalL), w: n(c.physicalW), h: n(c.physicalH) }
  const v = computeVariance(spec, physical, 2)

  return NextResponse.json({
    carton_name: c.cartonName,
    client_name: c.customer.name,
    artwork_code: c.artworkCode,
    dimensions: { spec, physical, variance: v.variance },
    board_grade: c.boardGrade,
    gsm: c.gsm,
    printing_type: c.printingType,
    coating_spec: c.coatingType,
    colours: c.numberOfColours,
    sheet_size: { l: n(c.sheetSizeL), w: n(c.sheetSizeW) },
    ups: c.ups,
    pasting_style: c.pastingStyle,
    rate: n(c.rate),
    gst_percent: c.gstPct,
    hsn_code: c.hsnCode,
    tooling: c.dieMaster
      ? {
          die_master_id: c.dieMaster.id,
          die_master_name: c.dieMaster.dyeNumber,
          type: c.dieMaster.dyeType,
        }
      : { die_master_id: null, die_master_name: null, type: null },
    shade_card: c.shadeCard
      ? { id: c.shadeCard.id, name: c.shadeCard.shadeCardNumber, ink_kitchen_status: null }
      : { id: null, name: null, ink_kitchen_status: null },
    special_instructions: c.specialInstructions,
    remarks: c.remarks,
    size_verified: c.sizeVerified,
    last_verified_at: c.sizeVerifiedAt,
  })
}
```

- [ ] **Step 2: Verify relation field names**

Run: `grep -n "shadeCardNumber\|dyeNumber\|dyeType" prisma/schema.prisma | head`
Expected: confirms `Dye.dyeNumber`, `Dye.dyeType`, `ShadeCard.shadeCardNumber` exist. If a name differs, fix the `select` and JSON before continuing.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add src/app/api/cartons/\[id\]/po-specs/route.ts
git commit -m "feat(api): add carton po-specs bundle endpoint"
```

### Task F2: useCartonPOSpecs hook

**Files:**
- Create: `src/hooks/useCartonPOSpecs.ts`

- [ ] **Step 1: Write the hook**

Create `src/hooks/useCartonPOSpecs.ts`:

```ts
'use client'
import { useEffect, useState } from 'react'

export type CartonPOSpecs = Record<string, unknown> & {
  carton_name: string
  size_verified: boolean
}

export function useCartonPOSpecs(cartonId: string | null) {
  const [data, setData] = useState<CartonPOSpecs | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cartonId) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/cartons/${cartonId}/po-specs`)
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j?.error ?? 'Failed')
        return j as CartonPOSpecs
      })
      .then((j) => !cancelled && setData(j))
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [cartonId])

  return { data, loading, error }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add src/hooks/useCartonPOSpecs.ts
git commit -m "feat(hooks): add useCartonPOSpecs"
```

### Task F3: Wire auto-populate into PO new form

**Files:**
- Modify: `src/app/(dashboard)/orders/purchase-orders/new/page.tsx`

- [ ] **Step 1: Read the current form to find the carton-select handler**

Run: `grep -n "carton\|setForm\|onChange\|select" "src/app/(dashboard)/orders/purchase-orders/new/page.tsx" | head -40`
Expected: identify the carton dropdown `onChange` and the form-state setter. (Do not guess — read the file fully before editing.)

- [ ] **Step 2: Add the hook + auto-populate effect**

In `new/page.tsx`, import the hook and, when a carton id is selected into state, call `useCartonPOSpecs(selectedCartonId)`. On `data` arriving, populate the existing PO line fields (rate, gsm, hsnCode, coatingType, dims, artworkCode) using the form's existing setter. Render, next to the carton field:

```tsx
{specs.data && !specs.data.size_verified && (
  <p className="text-xs text-yellow-700">Size not warehouse-verified ⚠️</p>
)}
```

Track manual overrides: when a user edits an auto-filled field, set a `overridden[field] = true` flag in state so it is not re-overwritten on the next fetch.

- [ ] **Step 3: Typecheck + manual verify**

Run: `npm run typecheck` → PASS. Then `npm run dev`, open `/orders/purchase-orders/new`, select a carton, confirm fields populate and the unverified warning shows for an unverified carton.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/orders/purchase-orders/new/page.tsx"
git commit -m "feat(po): auto-populate specs from selected carton"
```

---

## PHASE G — Task 5: Smart planning & auto-match

### Task G1: Match logic (TDD)

**Files:**
- Create: `src/lib/carton/match.ts`
- Test: `src/lib/carton/match.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/carton/match.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { levenshtein, nameSimilarity, dimensionMatch, scoreSuggestion } from './match'

describe('levenshtein', () => {
  it('identical → 0', () => expect(levenshtein('antox', 'antox')).toBe(0))
  it('one edit', () => expect(levenshtein('antox', 'antux')).toBe(1))
})

describe('nameSimilarity', () => {
  it('identical → 1', () => expect(nameSimilarity('ANTOX', 'antox')).toBe(1))
  it('disjoint → low', () => expect(nameSimilarity('abc', 'xyz')).toBeLessThan(0.4))
})

describe('dimensionMatch', () => {
  const target = { l: 138, w: 50, h: 108 }
  it('within tolerance on all axes', () => {
    expect(dimensionMatch(target, { l: 139, w: 51, h: 107 }, 3)).toBe('exact')
  })
  it('rotated orientation', () => {
    expect(dimensionMatch(target, { l: 50, w: 138, h: 108 }, 3)).toBe('rotated')
  })
  it('far off → none', () => {
    expect(dimensionMatch(target, { l: 200, w: 90, h: 5 }, 3)).toBe('none')
  })
})

describe('scoreSuggestion', () => {
  it('full client+name+dim+spec match scores near 100', () => {
    const s = scoreSuggestion({
      clientMatch: true,
      nameSim: 1,
      dimWithinTol: true,
      specMatch: 1,
    })
    expect(s).toBeGreaterThanOrEqual(95)
  })
  it('no signals → 0', () => {
    expect(
      scoreSuggestion({ clientMatch: false, nameSim: 0, dimWithinTol: false, specMatch: 0 }),
    ).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/carton/match.test.ts`
Expected: FAIL — cannot resolve `./match`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/carton/match.ts`:

```ts
export function levenshtein(a: string, b: string): number {
  a = a.toLowerCase()
  b = b.toLowerCase()
  const m = a.length
  const k = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(k).fill(0)])
  for (let j = 0; j <= k; j++) d[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= k; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
  return d[m][k]
}

export function nameSimilarity(a: string, b: string): number {
  if (!a && !b) return 1
  const dist = levenshtein(a, b)
  const maxLen = Math.max(a.length, b.length) || 1
  return Math.max(0, 1 - dist / maxLen)
}

type Dims = { l: number | null; w: number | null; h: number | null }

export function dimensionMatch(
  target: Dims,
  candidate: Dims,
  tolMm: number,
): 'exact' | 'rotated' | 'none' {
  const within = (a: number | null, b: number | null) =>
    a != null && b != null && Math.abs(a - b) <= tolMm
  if (within(target.l, candidate.l) && within(target.w, candidate.w) && within(target.h, candidate.h))
    return 'exact'
  // rotated: swap L and W
  if (within(target.l, candidate.w) && within(target.w, candidate.l) && within(target.h, candidate.h))
    return 'rotated'
  return 'none'
}

export function scoreSuggestion(p: {
  clientMatch: boolean
  nameSim: number
  dimWithinTol: boolean
  specMatch: number
}): number {
  const score =
    (p.clientMatch ? 30 : 0) +
    p.nameSim * 25 +
    (p.dimWithinTol ? 25 : 0) +
    p.specMatch * 20
  return Math.round(Math.min(100, Math.max(0, score)))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/carton/match.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/carton/match.ts src/lib/carton/match.test.ts
git commit -m "feat(carton): add tested match scoring + dimension match"
```

### Task G2: smart-search route

**Files:**
- Create: `src/app/api/cartons/smart-search/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/cartons/smart-search/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { nameSimilarity } from '@/lib/carton/match'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim()
  const clientId = searchParams.get('client')

  const rows = await db.carton.findMany({
    where: {
      active: true,
      ...(clientId ? { customerId: clientId } : {}),
      ...(q
        ? {
            OR: [
              { cartonName: { contains: q, mode: 'insensitive' } },
              { artworkCode: { contains: q, mode: 'insensitive' } },
              { boardGrade: { contains: q, mode: 'insensitive' } },
              { coatingType: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: { customer: { select: { id: true, name: true } } },
    take: 200,
  })

  const ranked = rows
    .map((c) => {
      const nameSim = q ? nameSimilarity(q, c.cartonName) : 0
      let score = nameSim * 60
      let reason = q && nameSim > 0.8 ? 'name match' : 'partial match'
      if (clientId && c.customerId === clientId) {
        score += 25
        reason = 'client + ' + reason
      }
      if (q && c.artworkCode?.toLowerCase().includes(q.toLowerCase())) score += 15
      return {
        id: c.id,
        carton_name: c.cartonName,
        client_name: c.customer.name,
        artwork_code: c.artworkCode,
        match_score: Math.round(Math.min(100, score)),
        match_reason: reason,
      }
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 10)

  return NextResponse.json({ results: ranked })
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add src/app/api/cartons/smart-search/route.ts
git commit -m "feat(api): carton smart-search with ranked results"
```

### Task G3: dimension-match route

**Files:**
- Create: `src/app/api/cartons/dimension-match/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/cartons/dimension-match/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { dimensionMatch } from '@/lib/carton/match'

export const dynamic = 'force-dynamic'
const n = (v: unknown) => (v != null ? Number(v as number) : null)

export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const target = { l: Number(body.l), w: Number(body.w), h: Number(body.h) }
  const tol = body.tolerance_mm != null ? Number(body.tolerance_mm) : 3

  const rows = await db.carton.findMany({
    where: {
      active: true,
      ...(body.client_id ? { customerId: body.client_id } : {}),
      finishedLength: { not: null },
    },
    include: { customer: { select: { id: true, name: true } } },
    take: 2000,
  })

  const exact_matches: unknown[] = []
  const close_matches: unknown[] = []
  const different_orientation: unknown[] = []

  for (const c of rows) {
    const cand = {
      l: n(c.finishedLength),
      w: n(c.finishedWidth),
      h: n(c.finishedHeight),
    }
    const m = dimensionMatch(target, cand, tol)
    const item = {
      id: c.id,
      carton_name: c.cartonName,
      client_name: c.customer.name,
      dims: cand,
    }
    if (m === 'exact') exact_matches.push(item)
    else if (m === 'rotated') different_orientation.push(item)
    else if (
      dimensionMatch(target, cand, tol + 3) === 'exact'
    )
      close_matches.push(item)
  }

  return NextResponse.json({
    exact_matches,
    close_matches,
    different_orientation,
  })
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add src/app/api/cartons/dimension-match/route.ts
git commit -m "feat(api): dimension-match endpoint"
```

### Task G4: suggest-carton planning route (cached)

**Files:**
- Create: `src/app/api/planning/suggest-carton/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/planning/suggest-carton/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { unstable_cache } from 'next/cache'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { nameSimilarity, dimensionMatch, scoreSuggestion } from '@/lib/carton/match'

export const dynamic = 'force-dynamic'
const n = (v: unknown) => (v != null ? Number(v as number) : null)

const loadCartons = (clientId: string | null) =>
  unstable_cache(
    async () =>
      db.carton.findMany({
        where: { active: true, ...(clientId ? { customerId: clientId } : {}) },
        include: { customer: { select: { id: true, name: true } } },
        take: 3000,
      }),
    ['suggest-carton', clientId ?? 'all'],
    { revalidate: 300 },
  )()

export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const clientId = (body.client_id as string) ?? null
  const hint = (body.product_name_hint as string) ?? ''
  const dims = body.dimensions
    ? { l: n(body.dimensions.l), w: n(body.dimensions.w), h: n(body.dimensions.h) }
    : null

  const rows = await loadCartons(clientId)

  const scored = rows
    .map((c) => {
      const nameSim = hint ? nameSimilarity(hint, c.cartonName) : 0
      const cand = {
        l: n(c.finishedLength),
        w: n(c.finishedWidth),
        h: n(c.finishedHeight),
      }
      const dimWithinTol = dims
        ? dimensionMatch(dims, cand, 3) !== 'none'
        : false
      const specMatch =
        (body.gsm && c.gsm === Number(body.gsm) ? 0.5 : 0) +
        (body.board_grade && c.boardGrade === body.board_grade ? 0.5 : 0)
      const confidence_score = scoreSuggestion({
        clientMatch: !!clientId && c.customerId === clientId,
        nameSim,
        dimWithinTol,
        specMatch,
      })
      const basis: string[] = []
      if (clientId && c.customerId === clientId) basis.push('client')
      if (nameSim > 0.6) basis.push('name')
      if (dimWithinTol) basis.push('dimensions')
      if (specMatch > 0) basis.push('spec')
      return {
        carton: { id: c.id, carton_name: c.cartonName, client_name: c.customer.name },
        confidence_score,
        match_basis: basis.join('+') || 'weak',
      }
    })
    .sort((a, b) => b.confidence_score - a.confidence_score)

  const top = scored[0]
  return NextResponse.json({
    top_suggestion: top ?? null,
    alternatives: scored.slice(1, 4),
    new_carton_required: !top || top.confidence_score < 40,
    missing_fields: [
      !clientId && 'client_id',
      !hint && 'product_name_hint',
      !dims && 'dimensions',
    ].filter(Boolean),
  })
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add src/app/api/planning/suggest-carton/route.ts
git commit -m "feat(api): cached suggest-carton planning endpoint"
```

### Task G5: PlanningSmartMatch dashboard widget

**Files:**
- Create: `src/components/carton/PlanningSmartMatch.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/carton/PlanningSmartMatch.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Match = {
  id: string
  carton_name: string
  client_name: string
  match_score: number
}

export function PlanningSmartMatch() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(false)

  async function search() {
    if (!q.trim()) return
    setLoading(true)
    try {
      const r = await fetch(
        `/api/cartons/smart-search?q=${encodeURIComponent(q)}`,
      )
      const j = await r.json()
      setMatches((j.results ?? []).slice(0, 3))
    } finally {
      setLoading(false)
    }
  }

  const best = matches[0]?.match_score ?? 0
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h3 className="font-semibold text-sm">Planning Smart Match</h3>
      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-2 py-1 text-sm"
          placeholder="Type carton name / scan barcode"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button
          onClick={search}
          disabled={loading}
          className="px-3 py-1 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          {loading ? '…' : 'Match'}
        </button>
      </div>
      {matches.map((m) => (
        <div key={m.id} className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">{m.carton_name}</div>
            <div className="text-xs text-muted-foreground">{m.client_name}</div>
            <div className="h-2 bg-muted rounded mt-1">
              <div
                className="h-2 rounded bg-green-500"
                style={{ width: `${m.match_score}%` }}
              />
            </div>
          </div>
          <button
            onClick={() =>
              router.push(`/orders/purchase-orders/new?cartonId=${m.id}`)
            }
            className="text-xs px-2 py-1 rounded border"
          >
            Use this carton
          </button>
        </div>
      ))}
      {matches.length > 0 && best < 40 && (
        <button className="text-xs px-3 py-1 rounded border border-yellow-500 text-yellow-700">
          No match — create new
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + manual verify**

Run: `npm run typecheck` → PASS. Then `npm run dev`, render `<PlanningSmartMatch />` on a dashboard page, search a known carton name, confirm confidence bars + "Use this carton" navigation work.

- [ ] **Step 3: Commit**

```bash
git add src/components/carton/PlanningSmartMatch.tsx
git commit -m "feat(carton): planning smart-match dashboard widget"
```

---

## Final verification

- [ ] Run full test suite: `npm run test` → all PASS
- [ ] `npm run typecheck` → PASS
- [ ] `npm run build` → succeeds (migration deploy + next build)
- [ ] Manual smoke: warehouse verify, PO auto-populate, smart-search, dimension-match, suggest-carton

---

## Self-Review notes

- **Spec coverage:** Task 1 → Phase C; Task 2 → Phase D (+B parsers); Task 3 → Phase E; Task 4 → Phase F; Task 5 → Phase G (5a=G2, 5b=G3, 5c=G4, 5d=G5). Schema gaps (sheet_size, ups, physical_*) → Phase A.
- **Known assumptions to verify during execution (steps already include the grep checks):** `PlateStoreScrapEvent.plateStoreId`, `PlateHubEvent.plateRequirementId`, `Dye.dyeNumber/dyeType`, `ShadeCard.shadeCardNumber`, and the PO new-form field setter names. These are explicitly re-checked in C1-S2, F1-S2, F3-S1 rather than assumed blindly.
- **Destructive ordering:** wipe (`--confirm`) and import (`--confirm`) are gated behind the D1-S3 user checkpoint, matching the stated execution order.
