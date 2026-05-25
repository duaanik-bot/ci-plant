# Centralized Master Data (MiniMasters Registry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every controlled dropdown (Unit/UOM, Board Type, Board Colour, Coating, Foil, Emboss, Pasting) read from one cached, code+label master registry referenced by a typed key, so values created/deleted in the MiniMasters admin screen propagate everywhere with no wiring issues.

**Architecture:** Approach A — extend the existing `effect_categories` / `effect_values` tables with a stable `code` column; add one `/api/masters/registry` endpoint, one `MastersProvider` cached context, one `<MasterSelect>` consumer component, and a typed `MASTER` registry. Cut consumers over from ad-hoc `fetchMiniMasterOptions` to `useMaster`. Delete the Duplex/SBS filter hack and retire the interim `useUnitOptions` hook.

**Tech Stack:** Next.js App Router, Prisma + PostgreSQL (raw SQL migrations, `prisma migrate deploy`), React context + @tanstack/react-query (already in `providers.tsx`), Zod, Vitest (colocated `*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-05-18-centralized-master-data-design.md`

---

## File Structure

**Create:**
- `prisma/migrations/20260518120000_master_data_codes/migration.sql` — add + backfill `code` columns, repoint label-storing record fields
- `src/lib/masters/registry.ts` — typed `MASTER` keys + `MasterKey` type
- `src/lib/masters/registry.test.ts` — registry invariants test
- `src/lib/masters/code-map.ts` — legacy-value → code maps + `normalizeCode()` (pure, shared by migration test + seed + UI)
- `src/lib/masters/code-map.test.ts` — code-map / normalizeCode unit test
- `src/lib/masters/fallback-snapshot.ts` — embedded static seed lists used when the registry API fails
- `src/app/api/masters/registry/route.ts` — `GET` returns all active categories+values in one payload
- `src/components/masters/MastersProvider.tsx` — cached context + `useMaster` / `useMasterLabel` / `useMastersRefresh`
- `src/components/ui/MasterSelect.tsx` — drop-in `<select>` bound to a `MASTER` key
- `src/components/ui/MasterSelect.test.tsx` — renders label / stores code / preserves unknown code
- `prisma/seed-masters.ts` — idempotent seeder for the 7 categories + day-one values (run via `tsx`)

**Modify:**
- `prisma/schema.prisma:2114-2144` — add `code` to `EffectCategory` + `EffectValue`
- `src/app/api/masters/effects/values/route.ts` — accept/validate `code` on create
- `src/app/api/masters/effects/values/[id]/route.ts` — accept `code` on update, block code change once referenced, return `409` (not `400`) when delete is blocked by links
- `src/app/api/masters/effects/categories/route.ts` — accept/validate `code` on create
- `src/app/api/masters/effects/categories/[id]/route.ts` — accept `code` on update, `409` on blocked delete
- `src/app/(dashboard)/masters/effects/page.tsx` — add Code field to category + value drawers; call `useMastersRefresh()` after successful mutations
- `src/components/providers.tsx:20-28` — mount `MastersProvider`
- `src/components/masters/MaterialForm.tsx` — replace `useUnitOptions` usage with `<MasterSelect masterKey={MASTER.UNIT}>`
- `src/app/(dashboard)/billing/new/page.tsx` — replace `useUnitOptions` UOM select with `<MasterSelect masterKey={MASTER.UNIT}>`
- `src/app/(dashboard)/rfq/new/page.tsx` — replace `useUnitOptions` volume-unit select with `<MasterSelect masterKey={MASTER.UNIT}>`
- `src/components/po/PoNewLineItemDrawer.tsx:139-145` — replace `fetchMiniMasterOptions` calls with `useMaster`
- `src/components/po/PoQuickCreateCartonForm.tsx:57-64` — replace `fetchMiniMasterOptions` calls with `useMaster`
- `src/components/planning/PlanningJobDetailDrawer.tsx:417` — replace `fetchMiniMasterOptions('Coating')` with `useMaster(MASTER.COATING)`
- `src/components/ui/EffectSelect.tsx` — re-implement on top of `useMaster` (keep its public props)

**Delete:**
- `src/lib/minimasters-options.ts` (Duplex/SBS hack + ad-hoc fetch) — after all consumers are cut over
- `src/hooks/useUnitOptions.ts` (interim stopgap) — after Material/Billing/RFQ cut over

---

## Conventions for every task

- Tests are colocated `*.test.ts(x)` (matches `src/lib/reports/registry.test.ts`).
- Run a single test: `npx vitest run <path> -t "<name>"`. Run all: `npm test`.
- Typecheck: `npm run typecheck`.
- Commit after each task with the message shown.
- Category codes are SCREAMING_SNAKE; value codes are short uppercase tokens, unique within their category.

---

## Phase 1 — Schema, code maps, migration, seed

### Task 1: Pure code-map module

**Files:**
- Create: `src/lib/masters/code-map.ts`
- Test: `src/lib/masters/code-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/masters/code-map.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeCode, LEGACY_UNIT_CODE, legacyToCode } from './code-map'

describe('normalizeCode', () => {
  it('uppercases and snake-cases', () => {
    expect(normalizeCode('Board Type')).toBe('BOARD_TYPE')
    expect(normalizeCode('  duplex-gb ')).toBe('DUPLEX_GB')
    expect(normalizeCode('NOS')).toBe('NOS')
  })
  it('strips unsafe chars', () => {
    expect(normalizeCode('Kraft (brown)!')).toBe('KRAFT_BROWN')
  })
})

describe('legacy unit mapping', () => {
  it('maps known legacy stored unit labels to codes', () => {
    expect(LEGACY_UNIT_CODE['sheets']).toBe('SHT')
    expect(LEGACY_UNIT_CODE['kg']).toBe('KG')
    expect(LEGACY_UNIT_CODE['Pcs']).toBe('NOS')
    expect(LEGACY_UNIT_CODE['cartons']).toBe('CTN')
  })
  it('legacyToCode falls back to normalizeCode for unknowns', () => {
    expect(legacyToCode('sheets')).toBe('SHT')
    expect(legacyToCode('weird-unit')).toBe('WEIRD_UNIT')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/masters/code-map.test.ts`
Expected: FAIL — `Cannot find module './code-map'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/masters/code-map.ts

// Stable machine code from any human label. Uppercase, snake-cased,
// punctuation stripped. Used by the migration backfill, the seeder,
// and the admin UI's auto-suggest.
export function normalizeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// Legacy free-text values currently stored in record fields
// (material.unit, billing line uom, rfq annualVolumeUnit) → unit codes.
export const LEGACY_UNIT_CODE: Record<string, string> = {
  sheets: 'SHT',
  sheet: 'SHT',
  Sheets: 'SHT',
  packets: 'PKT',
  pkt: 'PKT',
  kg: 'KG',
  Kg: 'KG',
  grs: 'GRS',
  gross: 'GRS',
  tonnes: 'TON',
  tonne: 'TON',
  metres: 'MTR',
  meter: 'MTR',
  litres: 'LTR',
  litre: 'LTR',
  pieces: 'NOS',
  piece: 'NOS',
  nos: 'NOS',
  Pcs: 'NOS',
  pcs: 'NOS',
  Box: 'BOX',
  box: 'BOX',
  Set: 'SET',
  set: 'SET',
  cartons: 'CTN',
  carton: 'CTN',
  labels: 'LBL',
  label: 'LBL',
}

export function legacyToCode(value: string): string {
  return LEGACY_UNIT_CODE[value] ?? LEGACY_UNIT_CODE[value.toLowerCase()] ?? normalizeCode(value)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/masters/code-map.test.ts`
Expected: PASS (6 assertions)

- [ ] **Step 5: Commit**

```bash
git add src/lib/masters/code-map.ts src/lib/masters/code-map.test.ts
git commit -m "feat(masters): pure code-map + normalizeCode utilities"
```

---

### Task 2: Typed MASTER registry

**Files:**
- Create: `src/lib/masters/registry.ts`
- Test: `src/lib/masters/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/masters/registry.test.ts
import { describe, it, expect } from 'vitest'
import { MASTER, MASTER_KEYS } from './registry'

describe('MASTER registry', () => {
  it('exposes the 7 day-one category codes', () => {
    expect(MASTER).toEqual({
      UNIT: 'UNIT',
      BOARD_TYPE: 'BOARD_TYPE',
      BOARD_COLOUR: 'BOARD_COLOUR',
      COATING: 'COATING',
      FOIL: 'FOIL',
      EMBOSS: 'EMBOSS',
      PASTING: 'PASTING',
    })
  })
  it('each key maps to itself (stable category code)', () => {
    for (const k of MASTER_KEYS) expect(MASTER[k]).toBe(k)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/masters/registry.test.ts`
Expected: FAIL — `Cannot find module './registry'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/masters/registry.ts

// The single source of truth for which controlled lists exist.
// Consumers reference MASTER.* — never a string literal.
// Adding a category = add one line here + a seed row in prisma/seed-masters.ts.
export const MASTER = {
  UNIT: 'UNIT',
  BOARD_TYPE: 'BOARD_TYPE',
  BOARD_COLOUR: 'BOARD_COLOUR',
  COATING: 'COATING',
  FOIL: 'FOIL',
  EMBOSS: 'EMBOSS',
  PASTING: 'PASTING',
} as const

export type MasterKey = (typeof MASTER)[keyof typeof MASTER]

export const MASTER_KEYS = Object.values(MASTER) as MasterKey[]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/masters/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/masters/registry.ts src/lib/masters/registry.test.ts
git commit -m "feat(masters): typed MASTER category registry"
```

---

### Task 3: Add `code` columns to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma:2114-2144`

- [ ] **Step 1: Edit `EffectCategory`** — add the `code` field after `id`:

```prisma
model EffectCategory {
  id        String   @id @default(uuid())
  code      String   @unique @db.VarChar(48)
  name      String   @unique @db.VarChar(80)
  sortOrder Int      @default(100) @map("sort_order")
  active    Boolean  @default(true)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  values EffectValue[]

  @@map("effect_categories")
}
```

- [ ] **Step 2: Edit `EffectValue`** — add `code` after `categoryId`, add the composite unique:

```prisma
model EffectValue {
  id           String   @id @default(uuid())
  categoryId   String   @map("category_id")
  code         String   @db.VarChar(48)
  value        String   @db.VarChar(120)
  abbreviation String?  @db.VarChar(24)
  impactOn     String?  @map("impact_on") @db.VarChar(80)
  description  String?
  sortOrder    Int      @default(100) @map("sort_order")
  active       Boolean  @default(true)
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  category EffectCategory @relation(fields: [categoryId], references: [id], onDelete: Restrict)

  @@unique([categoryId, value])
  @@unique([categoryId, code])
  @@index([categoryId, active, sortOrder])
  @@map("effect_values")
}
```

- [ ] **Step 3: Validate schema**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(masters): add stable code columns to effect_* models"
```

---

### Task 4: Migration — add, backfill, constrain `code`; repoint record fields

**Files:**
- Create: `prisma/migrations/20260518120000_master_data_codes/migration.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- prisma/migrations/20260518120000_master_data_codes/migration.sql

-- 1. Add nullable code columns
ALTER TABLE "effect_categories" ADD COLUMN "code" VARCHAR(48);
ALTER TABLE "effect_values"     ADD COLUMN "code" VARCHAR(48);

-- 2. Backfill category codes from name (SCREAMING_SNAKE), curated overrides
UPDATE "effect_categories"
SET "code" = upper(regexp_replace(btrim("name"), '[^A-Za-z0-9]+', '_', 'g'));

UPDATE "effect_categories" SET "code" = 'BOARD_TYPE'   WHERE lower("name") = 'board type';
UPDATE "effect_categories" SET "code" = 'BOARD_COLOUR' WHERE lower("name") IN ('board colour','board color');
UPDATE "effect_categories" SET "code" = 'COATING'      WHERE lower("name") = 'coating';
UPDATE "effect_categories" SET "code" = 'FOIL'         WHERE lower("name") = 'foil';
UPDATE "effect_categories" SET "code" = 'EMBOSS'       WHERE lower("name") IN ('emboss','embossing');
UPDATE "effect_categories" SET "code" = 'PASTING'      WHERE lower("name") = 'pasting';
UPDATE "effect_categories" SET "code" = 'UNIT'         WHERE lower("name") IN ('unit','uom','units','unit of measure');

-- 3. Backfill value codes from value text (SCREAMING_SNAKE)
UPDATE "effect_values"
SET "code" = upper(regexp_replace(btrim("value"), '[^A-Za-z0-9]+', '_', 'g'));

-- Curated unit value codes (only rows under the UNIT category)
UPDATE "effect_values" v SET "code" = m.code
FROM (VALUES
  ('numbers','NOS'), ('number','NOS'), ('nos','NOS'), ('pcs','NOS'), ('pieces','NOS'),
  ('kilogram','KG'), ('kg','KG'),
  ('sheets','SHT'), ('sheet','SHT'),
  ('box','BOX'),
  ('gross','GRS'), ('grs','GRS'),
  ('tonnes','TON'), ('tonne','TON'),
  ('metres','MTR'), ('meter','MTR'),
  ('litres','LTR'), ('litre','LTR'),
  ('packets','PKT'), ('packet','PKT'),
  ('cartons','CTN'), ('labels','LBL'), ('set','SET')
) AS m(label, code)
WHERE v."category_id" IN (SELECT id FROM "effect_categories" WHERE "code" = 'UNIT')
  AND lower(btrim(v."value")) = m.label;

-- 4. De-duplicate any colliding (category_id, code) before adding unique index:
--    suffix dupes with _2, _3 ... keeping the lowest sort_order as canonical
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY category_id, code ORDER BY sort_order, value) AS rn
  FROM "effect_values"
)
UPDATE "effect_values" e
SET "code" = e."code" || '_' || ranked.rn
FROM ranked
WHERE e.id = ranked.id AND ranked.rn > 1;

-- 5. Enforce NOT NULL + uniqueness
ALTER TABLE "effect_categories" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "effect_values"     ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "effect_categories_code_key" ON "effect_categories"("code");
CREATE UNIQUE INDEX "effect_values_category_id_code_key" ON "effect_values"("category_id","code");

-- 6. Repoint label-storing record fields → unit codes (UNIT only).
--    Unmapped values are left untouched (MasterSelect keeps them visible).
UPDATE "materials"      SET "unit" = 'SHT' WHERE lower(btrim("unit")) IN ('sheets','sheet');
UPDATE "materials"      SET "unit" = 'KG'  WHERE lower(btrim("unit")) = 'kg';
UPDATE "materials"      SET "unit" = 'GRS' WHERE lower(btrim("unit")) IN ('grs','gross');
UPDATE "materials"      SET "unit" = 'TON' WHERE lower(btrim("unit")) IN ('tonnes','tonne');
UPDATE "materials"      SET "unit" = 'PKT' WHERE lower(btrim("unit")) IN ('packets','packet');
UPDATE "materials"      SET "unit" = 'MTR' WHERE lower(btrim("unit")) IN ('metres','meter');
UPDATE "materials"      SET "unit" = 'LTR' WHERE lower(btrim("unit")) IN ('litres','litre');
UPDATE "materials"      SET "unit" = 'NOS' WHERE lower(btrim("unit")) IN ('pieces','piece','nos');
```

> Note: billing line `uom` and rfq `annualVolumeUnit` are stored on JSON/derived rows or created fresh each time; they are NOT bulk-repointed here. New records written through `<MasterSelect>` will store codes; pre-existing free-text values remain visible because `MasterSelect` preserves unknown codes (Task 9). If a future audit shows a dedicated column for either, add an analogous `UPDATE` in a follow-up migration.

- [ ] **Step 2: Apply the migration to the dev database**

Run: `npx prisma migrate deploy`
Expected: `Applying migration 20260518120000_master_data_codes` then `All migrations have been applied`

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `Generated Prisma Client`

- [ ] **Step 4: Verify no NULL / no dupes**

Run:
```bash
npx prisma db execute --stdin <<'SQL'
SELECT
  (SELECT count(*) FROM effect_categories WHERE code IS NULL) AS cat_null,
  (SELECT count(*) FROM effect_values WHERE code IS NULL)     AS val_null;
SQL
```
Expected: `cat_null = 0`, `val_null = 0`

- [ ] **Step 5: Commit**

```bash
git add prisma/migrations/20260518120000_master_data_codes/migration.sql
git commit -m "feat(masters): migration to add+backfill codes and repoint material units"
```

---

### Task 5: Idempotent master seeder

**Files:**
- Create: `prisma/seed-masters.ts`

- [ ] **Step 1: Write the seeder**

```ts
// prisma/seed-masters.ts
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

type Seed = {
  code: string
  name: string
  sortOrder: number
  values: { code: string; value: string; sortOrder: number }[]
}

const CATEGORIES: Seed[] = [
  {
    code: 'UNIT', name: 'Unit', sortOrder: 10,
    values: [
      { code: 'NOS', value: 'Numbers', sortOrder: 10 },
      { code: 'KG', value: 'Kilogram', sortOrder: 20 },
      { code: 'SHT', value: 'Sheets', sortOrder: 30 },
      { code: 'BOX', value: 'Box', sortOrder: 40 },
      { code: 'GRS', value: 'Gross', sortOrder: 50 },
      { code: 'TON', value: 'Tonnes', sortOrder: 60 },
      { code: 'MTR', value: 'Metres', sortOrder: 70 },
      { code: 'LTR', value: 'Litres', sortOrder: 80 },
      { code: 'PKT', value: 'Packets', sortOrder: 90 },
    ],
  },
  {
    code: 'BOARD_TYPE', name: 'Board Type', sortOrder: 20,
    values: [
      { code: 'FBB', value: 'FBB', sortOrder: 10 },
      { code: 'SBS', value: 'SBS', sortOrder: 20 },
      { code: 'DGB', value: 'Duplex GB', sortOrder: 30 },
      { code: 'DWB', value: 'Duplex WB', sortOrder: 40 },
      { code: 'KRFT', value: 'Kraft', sortOrder: 50 },
    ],
  },
  {
    code: 'BOARD_COLOUR', name: 'Board Colour', sortOrder: 30,
    values: [
      { code: 'WHT', value: 'White', sortOrder: 10 },
      { code: 'GRY', value: 'Grey-back', sortOrder: 20 },
      { code: 'KRF', value: 'Kraft brown', sortOrder: 30 },
    ],
  },
  { code: 'COATING', name: 'Coating', sortOrder: 40, values: [] },
  { code: 'FOIL', name: 'Foil', sortOrder: 50, values: [] },
  { code: 'EMBOSS', name: 'Emboss', sortOrder: 60, values: [] },
  { code: 'PASTING', name: 'Pasting', sortOrder: 70, values: [] },
]

async function main() {
  for (const c of CATEGORIES) {
    const cat = await db.effectCategory.upsert({
      where: { code: c.code },
      update: { name: c.name, sortOrder: c.sortOrder },
      create: { code: c.code, name: c.name, sortOrder: c.sortOrder, active: true },
    })
    for (const v of c.values) {
      await db.effectValue.upsert({
        where: { categoryId_code: { categoryId: cat.id, code: v.code } },
        update: { value: v.value, sortOrder: v.sortOrder },
        create: { categoryId: cat.id, code: v.code, value: v.value, sortOrder: v.sortOrder, active: true },
      })
    }
  }
  console.log('Masters seeded.')
}

main().finally(() => db.$disconnect())
```

- [ ] **Step 2: Run the seeder**

Run: `npx tsx prisma/seed-masters.ts`
Expected: `Masters seeded.` (no error; safe to re-run)

- [ ] **Step 3: Verify the 7 categories exist**

Run:
```bash
npx prisma db execute --stdin <<'SQL'
SELECT code, name FROM effect_categories ORDER BY sort_order;
SQL
```
Expected: rows for UNIT, BOARD_TYPE, BOARD_COLOUR, COATING, FOIL, EMBOSS, PASTING

- [ ] **Step 4: Commit**

```bash
git add prisma/seed-masters.ts
git commit -m "feat(masters): idempotent seeder for day-one categories+values"
```

---

## Phase 2 — Registry API + provider + fallback

### Task 6: Registry API endpoint

**Files:**
- Create: `src/app/api/masters/registry/route.ts`

- [ ] **Step 1: Write the route**

```ts
// src/app/api/masters/registry/route.ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export type RegistryValue = { code: string; label: string; abbreviation: string | null; sortOrder: number }
export type RegistryCategory = { code: string; label: string; values: RegistryValue[] }
export type RegistryPayload = Record<string, RegistryCategory>

export async function GET() {
  try {
    const categories = await db.effectCategory.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        values: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }],
          select: { code: true, value: true, abbreviation: true, sortOrder: true },
        },
      },
    })

    const payload: RegistryPayload = {}
    for (const c of categories) {
      payload[c.code] = {
        code: c.code,
        label: c.name,
        values: c.values.map((v) => ({
          code: v.code,
          label: v.value,
          abbreviation: v.abbreviation,
          sortOrder: v.sortOrder,
        })),
      }
    }
    return NextResponse.json(payload)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to load master registry'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

> Read endpoint is intentionally unauthenticated-by-role (it returns only non-sensitive controlled lists already exposed in dropdowns app-wide); write paths remain role-guarded in the effects routes.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no new errors mentioning `api/masters/registry`

- [ ] **Step 3: Manual smoke (dev server running)**

Run: `curl -s localhost:3000/api/masters/registry | head -c 300`
Expected: JSON containing `"UNIT"` and `"BOARD_TYPE"` keys

- [ ] **Step 4: Commit**

```bash
git add src/app/api/masters/registry/route.ts
git commit -m "feat(masters): single registry API returning all active lists"
```

---

### Task 7: Static fallback snapshot

**Files:**
- Create: `src/lib/masters/fallback-snapshot.ts`

- [ ] **Step 1: Write the snapshot** (mirrors the seeder day-one lists; used only when the API fails so dropdowns never break)

```ts
// src/lib/masters/fallback-snapshot.ts
import type { RegistryPayload } from '@/app/api/masters/registry/route'

export const FALLBACK_REGISTRY: RegistryPayload = {
  UNIT: {
    code: 'UNIT', label: 'Unit',
    values: [
      { code: 'NOS', label: 'Numbers', abbreviation: null, sortOrder: 10 },
      { code: 'KG', label: 'Kilogram', abbreviation: null, sortOrder: 20 },
      { code: 'SHT', label: 'Sheets', abbreviation: null, sortOrder: 30 },
      { code: 'BOX', label: 'Box', abbreviation: null, sortOrder: 40 },
      { code: 'GRS', label: 'Gross', abbreviation: null, sortOrder: 50 },
      { code: 'TON', label: 'Tonnes', abbreviation: null, sortOrder: 60 },
      { code: 'MTR', label: 'Metres', abbreviation: null, sortOrder: 70 },
      { code: 'LTR', label: 'Litres', abbreviation: null, sortOrder: 80 },
      { code: 'PKT', label: 'Packets', abbreviation: null, sortOrder: 90 },
    ],
  },
  BOARD_TYPE: {
    code: 'BOARD_TYPE', label: 'Board Type',
    values: [
      { code: 'FBB', label: 'FBB', abbreviation: null, sortOrder: 10 },
      { code: 'SBS', label: 'SBS', abbreviation: null, sortOrder: 20 },
      { code: 'DGB', label: 'Duplex GB', abbreviation: null, sortOrder: 30 },
      { code: 'DWB', label: 'Duplex WB', abbreviation: null, sortOrder: 40 },
      { code: 'KRFT', label: 'Kraft', abbreviation: null, sortOrder: 50 },
    ],
  },
  BOARD_COLOUR: {
    code: 'BOARD_COLOUR', label: 'Board Colour',
    values: [
      { code: 'WHT', label: 'White', abbreviation: null, sortOrder: 10 },
      { code: 'GRY', label: 'Grey-back', abbreviation: null, sortOrder: 20 },
      { code: 'KRF', label: 'Kraft brown', abbreviation: null, sortOrder: 30 },
    ],
  },
  COATING: { code: 'COATING', label: 'Coating', values: [] },
  FOIL: { code: 'FOIL', label: 'Foil', values: [] },
  EMBOSS: { code: 'EMBOSS', label: 'Emboss', values: [] },
  PASTING: { code: 'PASTING', label: 'Pasting', values: [] },
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no new errors mentioning `fallback-snapshot`

- [ ] **Step 3: Commit**

```bash
git add src/lib/masters/fallback-snapshot.ts
git commit -m "feat(masters): static fallback registry snapshot"
```

---

### Task 8: MastersProvider + hooks

**Files:**
- Create: `src/components/masters/MastersProvider.tsx`
- Modify: `src/components/providers.tsx:20-28`

- [ ] **Step 1: Write the provider**

```tsx
// src/components/masters/MastersProvider.tsx
'use client'

import { createContext, useContext, useCallback, ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RegistryPayload } from '@/app/api/masters/registry/route'
import { FALLBACK_REGISTRY } from '@/lib/masters/fallback-snapshot'
import type { MasterKey } from '@/lib/masters/registry'

const QUERY_KEY = ['masters-registry'] as const

async function fetchRegistry(): Promise<RegistryPayload> {
  const res = await fetch('/api/masters/registry', { cache: 'no-store' })
  if (!res.ok) throw new Error(`registry ${res.status}`)
  return (await res.json()) as RegistryPayload
}

type Ctx = { registry: RegistryPayload; loading: boolean }
const MastersContext = createContext<Ctx | null>(null)

export function MastersProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchRegistry,
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const registry = data ?? FALLBACK_REGISTRY
  return (
    <MastersContext.Provider value={{ registry, loading: isLoading }}>
      {children}
    </MastersContext.Provider>
  )
}

function useRegistry(): Ctx {
  const ctx = useContext(MastersContext)
  if (!ctx) throw new Error('useMaster must be used within <MastersProvider>')
  return ctx
}

export type MasterOption = { code: string; label: string }

export function useMaster(key: MasterKey): { options: MasterOption[]; loading: boolean } {
  const { registry, loading } = useRegistry()
  const cat = registry[key]
  const options = cat ? cat.values.map((v) => ({ code: v.code, label: v.label })) : []
  return { options, loading }
}

export function useMasterLabel(key: MasterKey, code: string | null | undefined): string {
  const { registry } = useRegistry()
  if (!code) return ''
  const hit = registry[key]?.values.find((v) => v.code === code)
  return hit?.label ?? code
}

export function useMastersRefresh(): () => void {
  const qc = useQueryClient()
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: QUERY_KEY })
  }, [qc])
}
```

- [ ] **Step 2: Mount it in `providers.tsx`** — replace lines 20-28 with:

```tsx
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <SessionProvider refetchOnWindowFocus={false} refetchWhenOffline={false}>
        <QueryClientProvider client={queryClient}>
          <MastersProvider>{children}</MastersProvider>
        </QueryClientProvider>
      </SessionProvider>
    </ThemeProvider>
  )
}
```

And add the import near the top of `src/components/providers.tsx` (after line 6):

```tsx
import { MastersProvider } from '@/components/masters/MastersProvider'
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no new errors mentioning `MastersProvider` or `providers.tsx`

- [ ] **Step 4: Commit**

```bash
git add src/components/masters/MastersProvider.tsx src/components/providers.tsx
git commit -m "feat(masters): app-wide cached MastersProvider + hooks"
```

---

### Task 9: MasterSelect component

**Files:**
- Create: `src/components/ui/MasterSelect.tsx`
- Test: `src/components/ui/MasterSelect.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/ui/MasterSelect.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MasterSelect } from './MasterSelect'
import { MASTER } from '@/lib/masters/registry'

vi.mock('@/components/masters/MastersProvider', () => ({
  useMaster: () => ({
    options: [
      { code: 'NOS', label: 'Numbers' },
      { code: 'KG', label: 'Kilogram' },
    ],
    loading: false,
  }),
}))

describe('MasterSelect', () => {
  it('renders labels but keeps codes as option values', () => {
    render(<MasterSelect masterKey={MASTER.UNIT} value="KG" onChange={() => {}} />)
    const opt = screen.getByRole('option', { name: 'Kilogram' }) as HTMLOptionElement
    expect(opt.value).toBe('KG')
  })
  it('preserves an unknown stored code so old records do not lose data', () => {
    render(<MasterSelect masterKey={MASTER.UNIT} value="LEGACY_X" onChange={() => {}} />)
    expect(screen.getByRole('option', { name: 'LEGACY_X' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ui/MasterSelect.test.tsx`
Expected: FAIL — `Cannot find module './MasterSelect'`

- [ ] **Step 3: Write the component**

```tsx
// src/components/ui/MasterSelect.tsx
'use client'

import { SelectDropdown } from '@/components/design-system/SelectDropdown'
import { useMaster } from '@/components/masters/MastersProvider'
import type { MasterKey } from '@/lib/masters/registry'

type Props = {
  masterKey: MasterKey
  value: string
  onChange: (code: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
  allowEmpty?: boolean
}

export function MasterSelect({
  masterKey,
  value,
  onChange,
  disabled,
  placeholder = 'Select…',
  className,
  allowEmpty = true,
}: Props) {
  const { options, loading } = useMaster(masterKey)
  const known = options.some((o) => o.code === value)
  const merged = !value || known ? options : [{ code: value, label: value }, ...options]

  return (
    <SelectDropdown
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading}
      className={className}
    >
      {allowEmpty && <option value="">{loading ? 'Loading…' : placeholder}</option>}
      {merged.map((o) => (
        <option key={o.code} value={o.code}>
          {o.label}
        </option>
      ))}
    </SelectDropdown>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ui/MasterSelect.test.tsx`
Expected: PASS (2 assertions)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/MasterSelect.tsx src/components/ui/MasterSelect.test.tsx
git commit -m "feat(masters): MasterSelect drop-in (renders label, stores code)"
```

---

## Phase 3 — Admin UI: code field + live refresh + 409

### Task 10: Accept `code` in effects value/category create + update; immutability; 409

**Files:**
- Modify: `src/app/api/masters/effects/values/route.ts`
- Modify: `src/app/api/masters/effects/values/[id]/route.ts`
- Modify: `src/app/api/masters/effects/categories/route.ts`
- Modify: `src/app/api/masters/effects/categories/[id]/route.ts`

- [ ] **Step 1: `values/route.ts`** — add `code` to `createSchema` (after the `value` line, line 10) and to the `create` data (after `categoryId:` line 77):

In `createSchema`:
```ts
  code: z.string().trim().min(1, 'Code is required').max(48).regex(/^[A-Z0-9_]+$/, 'Uppercase letters, digits, underscore only'),
```
Add a duplicate-code check next to the existing duplicate-value check (after line 73):
```ts
    const dupCode = await db.effectValue.findFirst({
      where: { categoryId: parsed.data.categoryId, code: parsed.data.code },
      select: { id: true },
    })
    if (dupCode) {
      return NextResponse.json(
        { error: 'Code already exists in this category', fields: { code: 'Code already exists' } },
        { status: 400 },
      )
    }
```
In `db.effectValue.create({ data: { ... } })` add:
```ts
        code: parsed.data.code,
```

- [ ] **Step 2: `values/[id]/route.ts`** — add optional `code` to `updateSchema` (line 9 area):
```ts
  code: z.string().trim().min(1).max(48).regex(/^[A-Z0-9_]+$/).optional(),
```
Before the `db.effectValue.update` call (line 53), guard immutability — a code may only change while the value is unreferenced. Add:
```ts
  if (parsed.data.code && parsed.data.code !== existing.code) {
    const refCount = await db.$queryRaw<{ c: number }[]>`
      SELECT (
        (SELECT count(*) FROM inventory       WHERE lower(coalesce(board_type,'')) = lower(${existing.value})) +
        (SELECT count(*) FROM po_line_items   WHERE lower(coalesce(paper_type,''))  = lower(${existing.value}))
      )::int AS c`
    if (Number(refCount[0]?.c || 0) > 0) {
      return NextResponse.json(
        { error: 'Code is locked: this value is already referenced by records.', fields: { code: 'Locked (referenced)' } },
        { status: 409 },
      )
    }
    const dupCode = await db.effectValue.findFirst({
      where: { id: { not: id }, categoryId: existing.categoryId, code: parsed.data.code },
      select: { id: true },
    })
    if (dupCode) {
      return NextResponse.json(
        { error: 'Code already exists in this category', fields: { code: 'Code already exists' } },
        { status: 400 },
      )
    }
  }
```
Add to the `update` data object:
```ts
      ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
```
Change the **blocked-delete** status from `400` to `409` (line ~117):
```ts
      { error: 'This value is used in active records. Please inactivate instead.' },
      { status: 409 },
```

- [ ] **Step 3: `categories/route.ts`** — add `code` to `createSchema`:
```ts
  code: z.string().trim().min(1, 'Code is required').max(48).regex(/^[A-Z0-9_]+$/, 'Uppercase letters, digits, underscore only'),
```
Add a duplicate-code check after the existing duplicate-name check (after line ~88) and add `code: parsed.data.code,` to the `db.effectCategory.create` data.

- [ ] **Step 4: `categories/[id]/route.ts`** — add optional `code` to `updateSchema`, add the same referenced-immutability guard pattern keyed on `existing.code` (block change with `409` if any `effect_values` exist under it AND those values are referenced — reuse the loop already present), add `code` to update data, and change the blocked-delete status from `400` to `409`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors in the four route files

- [ ] **Step 6: Commit**

```bash
git add src/app/api/masters/effects
git commit -m "feat(masters): code field on effect CRUD, immutability guard, 409 on blocked delete"
```

---

### Task 11: Code field in MiniMasters drawers + live refresh

**Files:**
- Modify: `src/app/(dashboard)/masters/effects/page.tsx`

- [ ] **Step 1: Add `code` to the local `EffectCategory` / `EffectValue` types** (lines 7-25) — add `code: string` to each type.

- [ ] **Step 2: Add a Code input** to the create/edit **category** drawer and the create/edit **value** drawer. Beside the existing name/value input add:

```tsx
<label className="block text-sm text-ds-ink-muted mb-1 mt-3">Code</label>
<input
  className={/* same input class used by the name field in this drawer */ ''}
  value={form.code ?? ''}
  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))}
  placeholder="e.g. NOS"
/>
{drawerMode === 'edit-value' || drawerMode === 'edit-category'
  ? <p className="text-xs text-ds-ink-muted mt-1">Code is locked once referenced by records.</p>
  : null}
```

(Use the exact `form`/`setForm` state names already in this file; if the drawer keeps separate `categoryForm`/`valueForm`, add `code` to whichever the drawer uses. Auto-suggest the code from the typed name/value on first blur using `normalizeCode` from `@/lib/masters/code-map` when the code field is still empty.)

- [ ] **Step 3: Include `code` in the create/update request bodies** sent to the effects endpoints in this page's submit handlers.

- [ ] **Step 4: Trigger live refresh** — import and call the registry refresh after a successful create/update/delete/inactivate so every open dropdown updates:

```tsx
import { useMastersRefresh } from '@/components/masters/MastersProvider'
// inside the component:
const refreshMasters = useMastersRefresh()
// in each success branch (after toast.success and list reload):
refreshMasters()
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors in `effects/page.tsx`

- [ ] **Step 6: Manual check (dev server)** — open MiniMasters, add a value with code `TEST1`, confirm it saves; open a form using that category in another tab → value appears without reload.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/masters/effects/page.tsx"
git commit -m "feat(masters): code field in MiniMasters drawers + live registry refresh"
```

---

## Phase 4 — Consumer cutover

> Each task swaps one consumer to `useMaster` / `<MasterSelect>`. After each, run `npm run typecheck` and commit. The stored value becomes a **code**; display uses the label automatically.

### Task 12: EffectSelect re-implemented on the registry

**Files:**
- Modify: `src/components/ui/EffectSelect.tsx`

- [ ] **Step 1: Replace the whole file body** with a thin adapter that keeps the existing prop names (`category`, `value`, `onChange`, …) but maps the legacy `category` *name* string to a `MasterKey` via `normalizeCode`, then delegates to `useMaster`:

```tsx
'use client'

import { SelectDropdown } from '@/components/design-system/SelectDropdown'
import { useMaster } from '@/components/masters/MastersProvider'
import { normalizeCode } from '@/lib/masters/code-map'
import type { MasterKey } from '@/lib/masters/registry'

type Props = {
  category: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

export function EffectSelect({ category, value, onChange, disabled, placeholder = 'Select...', className }: Props) {
  const key = normalizeCode(
    category.toLowerCase() === 'board classification' ? 'Board Type'
    : category.toLowerCase() === 'embossing' ? 'Emboss'
    : category,
  ) as MasterKey
  const { options, loading } = useMaster(key)
  const known = options.some((o) => o.code === value)
  const merged = !value || known ? options : [{ code: value, label: value }, ...options]
  return (
    <SelectDropdown value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || loading} className={className}>
      <option value="">{loading ? 'Loading…' : placeholder}</option>
      {merged.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
    </SelectDropdown>
  )
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck`; Expected: no new errors in `EffectSelect.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/EffectSelect.tsx
git commit -m "refactor(masters): EffectSelect now reads the cached registry"
```

### Task 13: MaterialForm UOM → MasterSelect

**Files:**
- Modify: `src/components/masters/MaterialForm.tsx`

- [ ] **Step 1:** Remove `import { useUnitOptions } from '@/hooks/useUnitOptions'`, the `UNIT_FALLBACK` const, and the `const { options: unitOptions } = useUnitOptions(UNIT_FALLBACK)` line. Add `import { MasterSelect } from '@/components/ui/MasterSelect'` and `import { MASTER } from '@/lib/masters/registry'`.

- [ ] **Step 2:** Replace the `<select value={f.unit} …>…</select>` block (the "Unit of measure" field) with:

```tsx
<MasterSelect
  masterKey={MASTER.UNIT}
  value={f.unit}
  onChange={(code) => patch('unit', code)}
  allowEmpty={false}
  className={cls}
/>
```

- [ ] **Step 3:** `npm run typecheck` → no new errors in `MaterialForm.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/components/masters/MaterialForm.tsx
git commit -m "refactor(masters): MaterialForm UOM uses MasterSelect"
```

### Task 14: Billing line UOM → MasterSelect

**Files:**
- Modify: `src/app/(dashboard)/billing/new/page.tsx`

- [ ] **Step 1:** Remove the `useUnitOptions` import and the `const { options: uomOptions } = useUnitOptions([...])` line. Add `MasterSelect` + `MASTER` imports.

- [ ] **Step 2:** Replace the line-UOM `<select value={l.uom} …>{…}</select>` with:

```tsx
<MasterSelect
  masterKey={MASTER.UNIT}
  value={l.uom}
  onChange={(code) => updateLine(idx, { uom: code })}
  allowEmpty={false}
  className="ds-input w-20 cursor-pointer text-xs"
/>
```

- [ ] **Step 3:** Update `DEFAULT_UOM` (line 53) from `'Pcs'` to `'NOS'` so new lines default to the unit code.

- [ ] **Step 4:** `npm run typecheck` → no new errors in `billing/new/page.tsx`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/billing/new/page.tsx"
git commit -m "refactor(masters): billing line UOM uses MasterSelect"
```

### Task 15: RFQ annual-volume unit → MasterSelect

**Files:**
- Modify: `src/app/(dashboard)/rfq/new/page.tsx`

- [ ] **Step 1:** Remove the `useUnitOptions` import and `const { options: volumeUnitOptions } = useUnitOptions([...])`. Add `MasterSelect` + `MASTER` imports.

- [ ] **Step 2:** Replace the `<select value={core.annualVolumeUnit} …>{…}</select>` with:

```tsx
<MasterSelect
  masterKey={MASTER.UNIT}
  value={core.annualVolumeUnit}
  onChange={(code) => setCore((prev) => ({ ...prev, annualVolumeUnit: code }))}
  allowEmpty={false}
  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
/>
```

- [ ] **Step 3:** Change the initial state `annualVolumeUnit: 'cartons'` (line ~131) to `annualVolumeUnit: 'CTN'`.

- [ ] **Step 4:** `npm run typecheck` → no new errors in `rfq/new/page.tsx`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/rfq/new/page.tsx"
git commit -m "refactor(masters): RFQ volume unit uses MasterSelect"
```

### Task 16: PoNewLineItemDrawer → useMaster

**Files:**
- Modify: `src/components/po/PoNewLineItemDrawer.tsx:136-150`

- [ ] **Step 1:** Remove `import { fetchMiniMasterOptions } from '@/lib/minimasters-options'`. Add `import { useMaster } from '@/components/masters/MastersProvider'` and `import { MASTER } from '@/lib/masters/registry'`.

- [ ] **Step 2:** Delete the `useEffect` block (lines ~136-150) that calls `Promise.all([fetchMiniMasterOptions(...)])` and the related `setXOptions` state setters it feeds. Replace each options source with a hook call near the top of the component:

```tsx
const { options: paperOptions } = useMaster(MASTER.BOARD_TYPE)
const { options: boardGradeOptions } = useMaster(MASTER.BOARD_TYPE) // Board Classification folded into Board Type
const { options: coatingOptions } = useMaster(MASTER.COATING)
const { options: embossOptions } = useMaster(MASTER.EMBOSS)
const { options: foilOptions } = useMaster(MASTER.FOIL)
```

- [ ] **Step 3:** Update each consuming `<select>`/dropdown in this file to render `option.label` with `value={option.code}` (and store the selected `code`). Where the old code mapped `string[]`, it now maps `{code,label}[]`.

- [ ] **Step 4:** `npm run typecheck` → resolve any `.map`/type mismatches from `string[]` → `{code,label}[]` in this file only.

- [ ] **Step 5: Commit**

```bash
git add src/components/po/PoNewLineItemDrawer.tsx
git commit -m "refactor(masters): PoNewLineItemDrawer reads cached registry"
```

### Task 17: PoQuickCreateCartonForm → useMaster

**Files:**
- Modify: `src/components/po/PoQuickCreateCartonForm.tsx:55-66`

- [ ] **Step 1:** Same import swap as Task 16 Step 1.

- [ ] **Step 2:** Delete the `Promise.all([fetchMiniMasterOptions(...)])` effect (lines ~55-66) and replace with hook calls:

```tsx
const { options: paperOptions } = useMaster(MASTER.BOARD_TYPE)
const { options: boardGradeOptions } = useMaster(MASTER.BOARD_TYPE)
const { options: coatingOptions } = useMaster(MASTER.COATING)
const { options: embossOptions } = useMaster(MASTER.EMBOSS)
const { options: foilOptions } = useMaster(MASTER.FOIL)
const { options: pastingOptions } = useMaster(MASTER.PASTING)
```

- [ ] **Step 3:** Update the consuming dropdowns to `value={code}` / show `label` as in Task 16 Step 3.

- [ ] **Step 4:** `npm run typecheck` → no new errors in this file.

- [ ] **Step 5: Commit**

```bash
git add src/components/po/PoQuickCreateCartonForm.tsx
git commit -m "refactor(masters): PoQuickCreateCartonForm reads cached registry"
```

### Task 18: PlanningJobDetailDrawer Coating → useMaster

**Files:**
- Modify: `src/components/po/../planning/PlanningJobDetailDrawer.tsx:417`

- [ ] **Step 1:** Remove `import { fetchMiniMasterOptions } from '@/lib/minimasters-options'`; add `useMaster` + `MASTER` imports.

- [ ] **Step 2:** In the `useEffect` at line ~412, drop `fetchMiniMasterOptions('Coating')` from the `Promise.all` (keep the `fetch('/api/masters/materials')` call). Add near the top of the component:

```tsx
const { options: coatingOptions } = useMaster(MASTER.COATING)
```

Remove the now-unused `setCoatingOptions` state plumbing; point the coating dropdown at `coatingOptions` (render `label`, store `code`).

- [ ] **Step 3:** `npm run typecheck` → no new errors in this file.

- [ ] **Step 4: Commit**

```bash
git add src/components/planning/PlanningJobDetailDrawer.tsx
git commit -m "refactor(masters): PlanningJobDetailDrawer coating reads cached registry"
```

### Task 19: Delete legacy helper + interim hook

**Files:**
- Delete: `src/lib/minimasters-options.ts`
- Delete: `src/hooks/useUnitOptions.ts`

- [ ] **Step 1:** Confirm no remaining importers:

Run: `grep -rn "minimasters-options\|useUnitOptions" src --include=*.ts --include=*.tsx`
Expected: no matches (all consumers cut over in Tasks 12-18)

- [ ] **Step 2:** Delete both files:

```bash
git rm src/lib/minimasters-options.ts src/hooks/useUnitOptions.ts
```

- [ ] **Step 3:** `npm run typecheck` → no errors referencing the deleted modules.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(masters): remove Duplex/SBS filter hack + interim useUnitOptions"
```

---

## Phase 5 — Final verification

### Task 20: Full verification pass

- [ ] **Step 1: Typecheck whole project**

Run: `npm run typecheck`
Expected: error count == the 7 pre-existing baseline errors (`PlanningJobDetailDrawer.tsx` stages/specialInstructions, `production-yield.ts` Map iteration) and **no** errors in any file touched by this plan.

- [ ] **Step 2: Run the test suite**

Run: `npm test`
Expected: PASS including `code-map`, `registry`, `MasterSelect` suites.

- [ ] **Step 3: Manual end-to-end (dev server: `npm run dev`)**
  1. Open MiniMasters → Unit category → add value `Dozen` code `DOZ` → Save.
  2. Open Material master "Add" form in a second tab → "Unit of measure" shows **Dozen**, selecting it stores `DOZ`.
  3. Back in MiniMasters → inactivate `Dozen` → reopen Material form → `Dozen` no longer offered; an existing material saved with `DOZ` still displays "Dozen" (label resolves) and the code stays visible.
  4. Add a Board Type value `Duplex GB` if missing → confirm it now appears in PO line drawer (the old Duplex hack is gone).
  5. Try to delete a Board Type value referenced by a PO line → expect the 409 "inactivate instead" message.

- [ ] **Step 4: Commit any fixes** discovered during manual testing with message `fix(masters): <what>`; otherwise no commit.

---

## Self-Review Notes (author)

- **Spec coverage:** §1 data model → Tasks 3-4; §2 typed registry → Task 2; §3 read path/provider/fallback/live-invalidation → Tasks 6-8, 11; §4 consumer contract `MasterSelect` → Task 9 + Tasks 12-18; §5 admin code field + seeding + delete protection → Tasks 5, 10, 11; §6 integrity (immutable code, inactivation resolves) → Tasks 9, 10, 20; §7 testing → Tasks 1, 2, 9, 20.
- **Open risk flagged for executor:** billing `uom` / rfq `annualVolumeUnit` are not bulk-repointed in the migration (Task 4 note) by design — `MasterSelect` keeps legacy free-text visible; revisit if a dedicated column is found.
- **Type consistency:** `RegistryPayload`/`RegistryCategory`/`RegistryValue` defined in Task 6 and reused in Tasks 7-8; `MasterKey`/`MASTER` from Task 2 used Tasks 8-18; `useMaster` returns `{options:{code,label}[],loading}` consistently in Tasks 8, 9, 12, 16-18.
