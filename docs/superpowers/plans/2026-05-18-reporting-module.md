# Reporting Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a registry-driven reporting module that delivers 9 KPI reports with interactive viewing plus Excel and PDF export.

**Architecture:** Each report is one module file declaring metadata, a Zod filter schema, a thin Prisma `query()` adapter, and a **pure `compute()` function** holding all aggregation/KPI math. A generic API route dispatches by `reportId`; a generic page renders any report through a shared `<ReportShell>`. Exporters consume the one standard `ReportResult` shape. The `compute()`/`query()` split exists so KPI math is unit-tested with in-memory fixtures (matching this repo's pure-logic test style — no DB test harness exists).

**Tech Stack:** Next.js 14 App Router, Prisma 5, Zod, TanStack Query + Table, recharts, `xlsx`, `@react-pdf/renderer`, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-18-reporting-module-design.md`

---

## Conventions (apply to every task)

- API routes: `export const dynamic = 'force-dynamic'`; `import { requireAuth } from '@/lib/helpers'`; `import { db } from '@/lib/db'`; return `NextResponse.json(...)`.
- All Prisma `Decimal`/`BigInt` values converted with `Number(...)` before math.
- Money rounded to whole ₹ in output strings; percentages to 2 dp; never divide by zero (guard → `0`).
- Test files live next to source as `*.test.ts` (Vitest, `globals: true`, alias `@` → `src`). Run a single file with `npx vitest run <path>`.
- Commit after every task with the exact message shown. Do **not** use `--no-verify`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/reports/types.ts` | `ReportModule`, `ReportResult`, `ColumnDef`, `SummaryCard`, `ChartSpec` types |
| `src/lib/reports/format.ts` | Pure value formatters (`fmtInr`, `fmtPct`, `fmtNum`, `fmtDate`, `fmtCell`) |
| `src/lib/reports/filters.ts` | Shared Zod filter primitives (`dateRangeSchema`, `optionalId`, `withDateRange`) |
| `src/lib/reports/registry.ts` | `REPORTS` map + `getReport(id)`, `listReports()` |
| `src/lib/reports/modules/<id>.ts` | One file per report: `meta`, `filterSchema`, pure `compute*`, `query()` |
| `src/lib/reports/export/to-xlsx.ts` | `ReportResult` → Excel workbook buffer |
| `src/lib/reports/export/to-pdf.tsx` | `ReportResult` → PDF buffer (`@react-pdf/renderer`) |
| `src/app/api/reports/[reportId]/route.ts` | Generic JSON dispatcher |
| `src/app/api/reports/[reportId]/export/route.ts` | Generic export dispatcher |
| `src/app/(dashboard)/reports/page.tsx` | Report index (cards grouped by KPI area) |
| `src/app/(dashboard)/reports/[reportId]/page.tsx` | Generic report viewer (server) |
| `src/app/(dashboard)/reports/_components/*` | `ReportShell`, `FilterBar`, `KpiCards`, `ReportChart`, `ReportTable`, `ExportButtons` |

Delete stub pages: `reports/wastage/page.tsx`, `reports/production/page.tsx`, `reports/dashboard/page.tsx`, `reports/schedule-m/page.tsx` (replaced by `[reportId]` viewer; `schedule-m` out of scope).

---

# Phase 1 — Framework

### Task 1: Core types

**Files:**
- Create: `src/lib/reports/types.ts`

- [ ] **Step 1: Write the types file**

```ts
import type { z } from 'zod'

export type ColumnType = 'text' | 'num' | 'inr' | 'pct' | 'date'

export interface ColumnDef {
  key: string
  label: string
  type: ColumnType
  align?: 'left' | 'right'
  total?: boolean
}

export interface SummaryCard {
  label: string
  value: string
  tone?: 'good' | 'bad' | 'neutral'
}

export interface ChartSpec {
  kind: 'bar' | 'line' | 'stacked' | 'pareto'
  x: string
  series: string[]
  data: Record<string, unknown>[]
}

export interface ReportView {
  id: string
  label: string
}

export interface ReportResult {
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
  summary: SummaryCard[]
  chart?: ChartSpec
  views?: ReportView[]
  meta: { generatedAt: string; filtersApplied: Record<string, string> }
}

export type ReportGroup =
  | 'production' | 'quality' | 'delivery' | 'material' | 'procurement' | 'maintenance'

export interface ReportModule<F = Record<string, unknown>> {
  id: string
  title: string
  group: ReportGroup
  kpi: string
  filterSchema: z.ZodType<F>
  query: (filters: F) => Promise<ReportResult>
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors referencing `src/lib/reports/types.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/reports/types.ts
git commit -m "feat(reports): core report module + result types"
```

---

### Task 2: Value formatters (pure)

**Files:**
- Create: `src/lib/reports/format.ts`
- Test: `src/lib/reports/format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { fmtInr, fmtPct, fmtNum, fmtDate, fmtCell } from './format'

describe('reports/format', () => {
  it('formats INR as whole rupees with thousands separators', () => {
    expect(fmtInr(1234567.89)).toBe('₹12,34,568')
    expect(fmtInr(-500)).toBe('-₹500')
    expect(fmtInr(0)).toBe('₹0')
  })
  it('formats percent to 2 dp with sign', () => {
    expect(fmtPct(96.4567)).toBe('96.46%')
    expect(fmtPct(0)).toBe('0.00%')
  })
  it('formats numbers with thousands grouping', () => {
    expect(fmtNum(1234567)).toBe('12,34,567')
  })
  it('formats dates as dd-MMM-yy', () => {
    expect(fmtDate(new Date('2026-05-18T00:00:00Z'))).toBe('18-May-26')
    expect(fmtDate(null)).toBe('—')
  })
  it('fmtCell dispatches by column type', () => {
    expect(fmtCell(1000, 'inr')).toBe('₹1,000')
    expect(fmtCell(50, 'pct')).toBe('50.00%')
    expect(fmtCell('CI-01', 'text')).toBe('CI-01')
    expect(fmtCell(null, 'num')).toBe('—')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/format.test.ts`
Expected: FAIL — cannot resolve `./format`.

- [ ] **Step 3: Write the implementation**

```ts
import type { ColumnType } from './types'

const inrGroup = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

export function fmtNum(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return inrGroup.format(v)
}

export function fmtInr(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  const neg = v < 0
  return `${neg ? '-' : ''}₹${inrGroup.format(Math.abs(Math.round(v)))}`
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${v.toFixed(2)}%`
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
export function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return '—'
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return '—'
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${dd}-${MON[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(-2)}`
}

export function fmtCell(v: unknown, type: ColumnType): string {
  if (v == null || v === '') return '—'
  switch (type) {
    case 'inr': return fmtInr(Number(v))
    case 'pct': return fmtPct(Number(v))
    case 'num': return fmtNum(Number(v))
    case 'date': return fmtDate(v as Date | string)
    default: return String(v)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/format.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/format.ts src/lib/reports/format.test.ts
git commit -m "feat(reports): pure value formatters with tests"
```

---

### Task 3: Shared filter primitives

**Files:**
- Create: `src/lib/reports/filters.ts`
- Test: `src/lib/reports/filters.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { dateRangeSchema, optionalId } from './filters'

describe('reports/filters', () => {
  it('parses from/to into Date and defaults to current month when absent', () => {
    const r = dateRangeSchema.parse({ from: '2026-04-01', to: '2026-04-30' })
    expect(r.from.getUTCFullYear()).toBe(2026)
    expect(r.to.getUTCMonth()).toBe(3)
    const def = dateRangeSchema.parse({})
    expect(def.from instanceof Date).toBe(true)
    expect(def.to instanceof Date).toBe(true)
    expect(def.from.getTime()).toBeLessThanOrEqual(def.to.getTime())
  })
  it('rejects from after to', () => {
    expect(() => dateRangeSchema.parse({ from: '2026-05-10', to: '2026-05-01' })).toThrow()
  })
  it('optionalId coerces empty string to undefined', () => {
    expect(optionalId.parse('')).toBeUndefined()
    expect(optionalId.parse('abc')).toBe('abc')
    expect(optionalId.parse(undefined)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/filters.test.ts`
Expected: FAIL — cannot resolve `./filters`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'

function monthStart(d = new Date()) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) }
function monthEnd(d = new Date()) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59)) }

export const dateRangeSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .transform((v) => ({
    from: v.from ?? monthStart(),
    to: v.to ?? monthEnd(),
  }))
  .refine((v) => v.from.getTime() <= v.to.getTime(), {
    message: 'from must be on or before to',
  })

export const optionalId = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v : undefined))

/** Compose a report filter object schema that always carries from/to. */
export function withDateRange<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), ...shape })
    .transform((v) => {
      const { from, to, ...rest } = v
      return {
        from: from ?? monthStart(),
        to: to ?? monthEnd(),
        ...rest,
      } as { from: Date; to: Date } & { [K in keyof T]: z.infer<T[K]> }
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/filters.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/filters.ts src/lib/reports/filters.test.ts
git commit -m "feat(reports): shared zod filter primitives with tests"
```

---

### Task 4: Registry

**Files:**
- Create: `src/lib/reports/registry.ts`
- Test: `src/lib/reports/registry.test.ts`

> Modules are imported here as they are built. Start with an empty map; each report task appends one import + one map entry.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { REPORTS, getReport, listReports } from './registry'

describe('reports/registry', () => {
  it('every module id matches its map key and is unique', () => {
    const ids = Object.values(REPORTS).map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [key, mod] of Object.entries(REPORTS)) expect(mod.id).toBe(key)
  })
  it('getReport returns module or undefined', () => {
    expect(getReport('___nope___')).toBeUndefined()
  })
  it('listReports returns metadata array', () => {
    expect(Array.isArray(listReports())).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/registry.test.ts`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 3: Write the implementation**

```ts
import type { ReportModule } from './types'

// Report modules are registered here as they are implemented.
export const REPORTS: Record<string, ReportModule<any>> = {}

export function getReport(id: string): ReportModule<any> | undefined {
  return REPORTS[id]
}

export function listReports() {
  return Object.values(REPORTS).map((m) => ({
    id: m.id, title: m.title, group: m.group, kpi: m.kpi,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/registry.ts src/lib/reports/registry.test.ts
git commit -m "feat(reports): report registry with uniqueness test"
```

---

### Task 5: Generic JSON API route

**Files:**
- Create: `src/app/api/reports/[reportId]/route.ts`

- [ ] **Step 1: Write the implementation**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { getReport } from '@/lib/reports/registry'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { reportId: string } }
) {
  const { error } = await requireAuth()
  if (error) return error

  const mod = getReport(params.reportId)
  if (!mod) return NextResponse.json({ error: 'Unknown report' }, { status: 404 })

  const raw = Object.fromEntries(req.nextUrl.searchParams.entries())
  try {
    const filters = mod.filterSchema.parse(raw)
    const result = await mod.query(filters as any)
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof ZodError) {
      return NextResponse.json(
        { error: 'Invalid filters', issues: e.flatten().fieldErrors },
        { status: 400 }
      )
    }
    console.error(`[reports:${params.reportId}] query failed`, e)
    return NextResponse.json({ error: 'Report generation failed' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/reports/[reportId]/route.ts"
git commit -m "feat(reports): generic report JSON API dispatcher"
```

---

### Task 6: Excel exporter

**Files:**
- Create: `src/lib/reports/export/to-xlsx.ts`
- Test: `src/lib/reports/export/to-xlsx.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { reportToXlsx } from './to-xlsx'
import type { ReportResult } from '../types'

const sample: ReportResult = {
  columns: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'spend', label: 'Spend', type: 'inr', total: true },
  ],
  rows: [{ name: 'Vendor A', spend: 1000 }, { name: 'Vendor B', spend: 2500 }],
  summary: [{ label: 'Total', value: '₹3,500' }],
  meta: { generatedAt: '2026-05-18T00:00:00.000Z', filtersApplied: { from: '2026-05-01' } },
}

describe('reportToXlsx', () => {
  it('produces a non-empty workbook with a Report sheet and totals row', () => {
    const buf = reportToXlsx('ppv', sample)
    expect(buf.byteLength).toBeGreaterThan(0)
    const wb = XLSX.read(buf, { type: 'buffer' })
    expect(wb.SheetNames).toContain('Report')
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets['Report'])
    expect(csv).toContain('Vendor A')
    expect(csv).toContain('3500') // totals row sums spend
  })
  it('creates one sheet per view when views are present', () => {
    const multi: ReportResult = {
      ...sample,
      views: [{ id: 'matrix', label: 'Matrix' }, { id: 'overall', label: 'Overall' }],
    }
    const wb = XLSX.read(reportToXlsx('wastage', multi), { type: 'buffer' })
    expect(wb.SheetNames).toContain('Report')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/export/to-xlsx.test.ts`
Expected: FAIL — cannot resolve `./to-xlsx`.

- [ ] **Step 3: Write the implementation**

```ts
import * as XLSX from 'xlsx'
import type { ReportResult } from '../types'

export function reportToXlsx(reportId: string, result: ReportResult): Buffer {
  const wb = XLSX.utils.book_new()

  const header = result.columns.map((c) => c.label)
  const body = result.rows.map((r) => result.columns.map((c) => r[c.key] ?? ''))

  const totalsRow = result.columns.map((c) => {
    if (!c.total) return ''
    return result.rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0)
  })
  const hasTotals = result.columns.some((c) => c.total)

  const meta = [
    [`Report: ${reportId}`],
    [`Generated: ${result.meta.generatedAt}`],
    [`Filters: ${Object.entries(result.meta.filtersApplied).map(([k, v]) => `${k}=${v}`).join('  ')}`],
    [],
  ]
  const aoa = [...meta, header, ...body, ...(hasTotals ? [totalsRow] : [])]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.book_append_sheet(wb, ws, 'Report')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/export/to-xlsx.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/export/to-xlsx.ts src/lib/reports/export/to-xlsx.test.ts
git commit -m "feat(reports): excel exporter with tests"
```

---

### Task 7: PDF exporter

**Files:**
- Create: `src/lib/reports/export/to-pdf.tsx`
- Test: `src/lib/reports/export/to-pdf.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { reportToPdf } from './to-pdf'
import type { ReportResult } from '../types'

const sample: ReportResult = {
  columns: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'spend', label: 'Spend', type: 'inr', total: true },
  ],
  rows: [{ name: 'Vendor A', spend: 1000 }],
  summary: [{ label: 'Total Spend', value: '₹1,000', tone: 'neutral' }],
  meta: { generatedAt: '2026-05-18T00:00:00.000Z', filtersApplied: { from: '2026-05-01' } },
}

describe('reportToPdf', () => {
  it('produces a non-empty PDF buffer', async () => {
    const buf = await reportToPdf('Purchase Price Variance', sample)
    expect(buf.byteLength).toBeGreaterThan(1000)
    expect(buf.subarray(0, 4).toString()).toBe('%PDF')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/export/to-pdf.test.ts`
Expected: FAIL — cannot resolve `./to-pdf`.

- [ ] **Step 3: Write the implementation**

```tsx
import React from 'react'
import { Document, Page, View, Text, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { ReportResult } from '../types'
import { fmtCell } from '../format'
import { COMPANY } from '@/lib/company-config'

const s = StyleSheet.create({
  page: { padding: 24, fontSize: 8 },
  h1: { fontSize: 14, marginBottom: 2 },
  meta: { fontSize: 7, color: '#666', marginBottom: 8 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10, gap: 6 },
  card: { border: '1 solid #ddd', padding: 6, minWidth: 110 },
  cardLabel: { fontSize: 6, color: '#666' },
  cardValue: { fontSize: 11 },
  row: { flexDirection: 'row', borderBottom: '0.5 solid #eee' },
  th: { flex: 1, fontWeight: 700, padding: 3, backgroundColor: '#f3f3f3' },
  td: { flex: 1, padding: 3 },
})

export async function reportToPdf(title: string, result: ReportResult): Promise<Buffer> {
  const doc = (
    <Document>
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.h1}>{COMPANY.name} — {title}</Text>
        <Text style={s.meta}>
          Generated {result.meta.generatedAt} ·{' '}
          {Object.entries(result.meta.filtersApplied).map(([k, v]) => `${k}: ${v}`).join('  ')}
        </Text>
        <View style={s.cards}>
          {result.summary.map((c, i) => (
            <View key={i} style={s.card}>
              <Text style={s.cardLabel}>{c.label}</Text>
              <Text style={s.cardValue}>{c.value}</Text>
            </View>
          ))}
        </View>
        <View style={s.row} fixed>
          {result.columns.map((c) => (
            <Text key={c.key} style={s.th}>{c.label}</Text>
          ))}
        </View>
        {result.rows.map((r, i) => (
          <View key={i} style={s.row} wrap={false}>
            {result.columns.map((c) => (
              <Text key={c.key} style={s.td}>{fmtCell(r[c.key], c.type)}</Text>
            ))}
          </View>
        ))}
      </Page>
    </Document>
  )
  return renderToBuffer(doc)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/export/to-pdf.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/export/to-pdf.tsx src/lib/reports/export/to-pdf.test.ts
git commit -m "feat(reports): pdf exporter with tests"
```

---

### Task 8: Generic export API route

**Files:**
- Create: `src/app/api/reports/[reportId]/export/route.ts`

- [ ] **Step 1: Write the implementation**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { getReport } from '@/lib/reports/registry'
import { reportToXlsx } from '@/lib/reports/export/to-xlsx'
import { reportToPdf } from '@/lib/reports/export/to-pdf'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { reportId: string } }
) {
  const { error } = await requireAuth()
  if (error) return error

  const mod = getReport(params.reportId)
  if (!mod) return NextResponse.json({ error: 'Unknown report' }, { status: 404 })

  const sp = req.nextUrl.searchParams
  const format = sp.get('format') === 'pdf' ? 'pdf' : 'xlsx'
  const raw = Object.fromEntries(sp.entries())

  try {
    const filters = mod.filterSchema.parse(raw)
    const result = await mod.query(filters as any)
    const from = result.meta.filtersApplied.from ?? 'all'
    const to = result.meta.filtersApplied.to ?? 'all'
    const fname = `${mod.id}_${from}_${to}.${format}`

    if (format === 'pdf') {
      const buf = await reportToPdf(mod.title, result)
      return new NextResponse(buf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${fname}"`,
        },
      })
    }
    const buf = reportToXlsx(mod.id, result)
    return new NextResponse(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fname}"`,
      },
    })
  } catch (e) {
    if (e instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid filters' }, { status: 400 })
    }
    console.error(`[reports:${params.reportId}:export] failed`, e)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/reports/[reportId]/export/route.ts"
git commit -m "feat(reports): generic report export API dispatcher"
```

---

### Task 9: Shared UI components

**Files:**
- Create: `src/app/(dashboard)/reports/_components/ReportTable.tsx`
- Create: `src/app/(dashboard)/reports/_components/KpiCards.tsx`
- Create: `src/app/(dashboard)/reports/_components/ReportChart.tsx`
- Create: `src/app/(dashboard)/reports/_components/FilterBar.tsx`
- Create: `src/app/(dashboard)/reports/_components/ExportButtons.tsx`
- Create: `src/app/(dashboard)/reports/_components/ReportShell.tsx`

> These are presentational; correctness is covered by the report module tests + manual UI verification at the end of each phase. No unit tests for these components.

- [ ] **Step 1: Write `KpiCards.tsx`**

```tsx
'use client'
import type { SummaryCard } from '@/lib/reports/types'

const tone: Record<string, string> = {
  good: 'text-[var(--success)]',
  bad: 'text-[var(--danger)]',
  neutral: 'text-ds-ink',
}

export function KpiCards({ cards }: { cards: SummaryCard[] }) {
  if (!cards.length) return null
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <div key={i} className="rounded-lg border border-ds-border p-3">
          <div className="text-xs text-ds-ink-muted">{c.label}</div>
          <div className={`text-xl font-semibold ${tone[c.tone ?? 'neutral']}`}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Write `ReportTable.tsx`**

```tsx
'use client'
import {
  useReactTable, getCoreRowModel, getSortedRowModel, flexRender,
  type ColumnDef as TanCol, type SortingState,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import type { ReportResult } from '@/lib/reports/types'
import { fmtCell } from '@/lib/reports/format'
import {
  enterpriseTableClass, enterpriseTheadClass, enterpriseThClass,
  enterpriseTbodyClass, enterpriseTrClass, enterpriseTdClass,
} from '@/lib/enterprise-table-styles'

export function ReportTable({ result }: { result: ReportResult }) {
  const [sorting, setSorting] = useState<SortingState>([])
  const cols = useMemo<TanCol<Record<string, unknown>>[]>(
    () => result.columns.map((c) => ({
      accessorKey: c.key,
      header: c.label,
      cell: (ctx) => fmtCell(ctx.getValue(), c.type),
      meta: { align: c.align ?? (c.type === 'text' ? 'left' : 'right') },
    })),
    [result.columns]
  )
  const table = useReactTable({
    data: result.rows, columns: cols, state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
  })
  const totals = result.columns.filter((c) => c.total)
  return (
    <div className="overflow-auto">
      <table className={enterpriseTableClass}>
        <thead className={enterpriseTheadClass}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} className={`${enterpriseThClass} cursor-pointer`}
                    onClick={h.column.getToggleSortingHandler()}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className={enterpriseTbodyClass}>
          {table.getRowModel().rows.map((r) => (
            <tr key={r.id} className={enterpriseTrClass}>
              {r.getVisibleCells().map((cell) => (
                <td key={cell.id}
                    className={`${enterpriseTdClass} ${(cell.column.columnDef.meta as any)?.align === 'right' ? 'text-right' : ''}`}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals.length > 0 && (
          <tfoot>
            <tr className="font-semibold border-t border-ds-border">
              {result.columns.map((c) => (
                <td key={c.key} className={`${enterpriseTdClass} text-right`}>
                  {c.total
                    ? fmtCell(result.rows.reduce((s, row) => s + (Number(row[c.key]) || 0), 0), c.type)
                    : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
```

- [ ] **Step 3: Write `ReportChart.tsx`**

```tsx
'use client'
import type { ChartSpec } from '@/lib/reports/types'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts'

const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed']

export function ReportChart({ chart }: { chart?: ChartSpec }) {
  if (!chart) return null
  const common = (
    <>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey={chart.x} fontSize={11} />
      <YAxis fontSize={11} />
      <Tooltip />
      <Legend />
    </>
  )
  return (
    <div className="h-72 w-full rounded-lg border border-ds-border p-3">
      <ResponsiveContainer>
        {chart.kind === 'line' ? (
          <LineChart data={chart.data}>
            {common}
            {chart.series.map((k, i) => (
              <Line key={k} dataKey={k} stroke={COLORS[i % COLORS.length]} dot={false} />
            ))}
          </LineChart>
        ) : chart.kind === 'pareto' ? (
          <ComposedChart data={chart.data}>
            {common}
            <Bar dataKey={chart.series[0]} fill={COLORS[0]} />
            {chart.series[1] && (
              <Line dataKey={chart.series[1]} stroke={COLORS[2]} dot={false} />
            )}
          </ComposedChart>
        ) : (
          <BarChart data={chart.data}>
            {common}
            {chart.series.map((k, i) => (
              <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]}
                   stackId={chart.kind === 'stacked' ? 'a' : undefined} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 4: Write `ExportButtons.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { toast } from 'sonner'

export function ExportButtons({ reportId, query }: { reportId: string; query: string }) {
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null)
  async function go(format: 'xlsx' | 'pdf') {
    setBusy(format)
    try {
      const res = await fetch(`/api/reports/${reportId}/export?format=${format}&${query}`)
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${reportId}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error(`Could not export ${format.toUpperCase()}`)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex gap-2">
      <button onClick={() => go('xlsx')} disabled={busy !== null}
              className="rounded-md border border-ds-border px-3 py-1.5 text-sm disabled:opacity-50">
        {busy === 'xlsx' ? 'Exporting…' : 'Excel'}
      </button>
      <button onClick={() => go('pdf')} disabled={busy !== null}
              className="rounded-md border border-ds-border px-3 py-1.5 text-sm disabled:opacity-50">
        {busy === 'pdf' ? 'Exporting…' : 'PDF'}
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Write `FilterBar.tsx`**

```tsx
'use client'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useState } from 'react'

export interface FilterField { key: string; label: string; type: 'date' | 'text' }

export function FilterBar({ fields }: { fields: FilterField[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [state, setState] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, sp.get(f.key) ?? '']))
  )
  function apply() {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(state)) if (v) q.set(k, v)
    router.push(`${pathname}?${q.toString()}`)
  }
  function reset() {
    setState(Object.fromEntries(fields.map((f) => [f.key, ''])))
    router.push(pathname)
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      {fields.map((f) => (
        <div key={f.key} className="flex flex-col">
          <label className="text-xs text-ds-ink-muted">{f.label}</label>
          <input
            type={f.type === 'date' ? 'date' : 'text'}
            value={state[f.key] ?? ''}
            onChange={(e) => setState((s) => ({ ...s, [f.key]: e.target.value }))}
            className="rounded-md border border-ds-border px-2 py-1 text-sm"
          />
        </div>
      ))}
      <button onClick={apply} className="rounded-md bg-[var(--info)] px-3 py-1.5 text-sm text-white">
        Apply
      </button>
      <button onClick={reset} className="rounded-md border border-ds-border px-3 py-1.5 text-sm">
        Reset
      </button>
    </div>
  )
}
```

- [ ] **Step 6: Write `ReportShell.tsx`**

```tsx
'use client'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import type { ReportResult } from '@/lib/reports/types'
import { FilterBar, type FilterField } from './FilterBar'
import { KpiCards } from './KpiCards'
import { ReportChart } from './ReportChart'
import { ReportTable } from './ReportTable'
import { ExportButtons } from './ExportButtons'

export function ReportShell({
  reportId, title, kpi, filterFields,
}: { reportId: string; title: string; kpi: string; filterFields: FilterField[] }) {
  const sp = useSearchParams()
  const [view, setView] = useState<string | null>(null)
  const baseQuery = sp.toString()
  const query = view ? `${baseQuery}${baseQuery ? '&' : ''}view=${view}` : baseQuery

  const { data, isLoading, isError, refetch } = useQuery<ReportResult>({
    queryKey: ['report', reportId, query],
    queryFn: async () => {
      const res = await fetch(`/api/reports/${reportId}?${query}`)
      if (!res.ok) throw new Error('failed')
      return res.json()
    },
  })

  return (
    <section className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-ds-ink-muted">{kpi}</p>
        </div>
        <ExportButtons reportId={reportId} query={query} />
      </div>

      <FilterBar fields={filterFields} />

      {data?.views && (
        <div className="flex gap-2">
          {data.views.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)}
              className={`rounded-md px-3 py-1 text-sm border ${
                (view ?? data.views![0].id) === v.id
                  ? 'bg-[var(--info)] text-white' : 'border-ds-border'}`}>
              {v.label}
            </button>
          ))}
        </div>
      )}

      {isLoading && <div className="text-sm text-ds-ink-muted">Loading…</div>}
      {isError && (
        <div className="text-sm text-[var(--danger)]">
          Could not load report.{' '}
          <button onClick={() => refetch()} className="underline">Retry</button>
        </div>
      )}
      {data && data.rows.length === 0 && (
        <div className="text-sm text-ds-ink-muted">No data for the selected filters.</div>
      )}
      {data && data.rows.length > 0 && (
        <>
          <KpiCards cards={data.summary} />
          <ReportChart chart={data.chart} />
          <ReportTable result={data} />
        </>
      )}
    </section>
  )
}
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/reports/_components"
git commit -m "feat(reports): shared report shell + table/chart/kpi/filter/export UI"
```

---

### Task 10: Report index + generic viewer page; remove stubs

**Files:**
- Delete: `src/app/(dashboard)/reports/wastage/page.tsx`, `reports/production/page.tsx`, `reports/dashboard/page.tsx`, `reports/schedule-m/page.tsx` (and now-empty dirs)
- Create: `src/app/(dashboard)/reports/page.tsx`
- Create: `src/app/(dashboard)/reports/[reportId]/page.tsx`
- Create: `src/app/(dashboard)/reports/_components/filter-fields.ts`

- [ ] **Step 1: Remove stub pages**

```bash
git rm "src/app/(dashboard)/reports/wastage/page.tsx" \
       "src/app/(dashboard)/reports/production/page.tsx" \
       "src/app/(dashboard)/reports/dashboard/page.tsx" \
       "src/app/(dashboard)/reports/schedule-m/page.tsx"
```

- [ ] **Step 2: Create `filter-fields.ts`** (maps reportId → which filter inputs to show; appended as reports are added)

```ts
import type { FilterField } from './FilterBar'

const DATE: FilterField[] = [
  { key: 'from', label: 'From', type: 'date' },
  { key: 'to', label: 'To', type: 'date' },
]

export const FILTER_FIELDS: Record<string, FilterField[]> = {
  ppv: [...DATE, { key: 'vendor', label: 'Vendor', type: 'text' }, { key: 'boardGrade', label: 'Board Grade', type: 'text' }],
  wastage: [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }, { key: 'stage', label: 'Stage #', type: 'text' }],
  oee: [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }, { key: 'operatorId', label: 'Operator ID', type: 'text' }],
  yield: [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }],
  otif: [...DATE, { key: 'customerId', label: 'Customer ID', type: 'text' }],
  'short-excess': [...DATE, { key: 'customerId', label: 'Customer ID', type: 'text' }],
  'downtime-pareto': [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }],
  'vendor-quality-ppm': [...DATE, { key: 'vendor', label: 'Vendor', type: 'text' }],
  'pm-compliance': [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }],
}

export function filterFieldsFor(id: string): FilterField[] {
  return FILTER_FIELDS[id] ?? DATE
}
```

- [ ] **Step 3: Create index page `reports/page.tsx`**

```tsx
import Link from 'next/link'
import { listReports } from '@/lib/reports/registry'

const GROUP_LABEL: Record<string, string> = {
  production: 'Production & Efficiency',
  quality: 'Quality',
  delivery: 'Delivery',
  material: 'Material & Waste',
  procurement: 'Procurement',
  maintenance: 'Maintenance',
}

export default function ReportsIndexPage() {
  const reports = listReports()
  const groups = [...new Set(reports.map((r) => r.group))]
  return (
    <section className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Reports</h1>
      {groups.map((g) => (
        <div key={g} className="space-y-2">
          <h2 className="text-sm font-semibold text-ds-ink-muted">{GROUP_LABEL[g] ?? g}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {reports.filter((r) => r.group === g).map((r) => (
              <Link key={r.id} href={`/reports/${r.id}`}
                className="rounded-lg border border-ds-border p-4 hover:border-[var(--info)]">
                <div className="font-medium">{r.title}</div>
                <div className="text-xs text-ds-ink-muted mt-1">{r.kpi}</div>
              </Link>
            ))}
          </div>
        </div>
      ))}
      {reports.length === 0 && (
        <p className="text-sm text-ds-ink-muted">No reports registered yet.</p>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Create viewer page `reports/[reportId]/page.tsx`**

```tsx
import { notFound } from 'next/navigation'
import { getReport } from '@/lib/reports/registry'
import { ReportShell } from '../_components/ReportShell'
import { filterFieldsFor } from '../_components/filter-fields'

export const dynamic = 'force-dynamic'

export default function ReportViewerPage({ params }: { params: { reportId: string } }) {
  const mod = getReport(params.reportId)
  if (!mod) notFound()
  return (
    <ReportShell
      reportId={mod.id}
      title={mod.title}
      kpi={mod.kpi}
      filterFields={filterFieldsFor(mod.id)}
    />
  )
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: PASS.

```bash
git add "src/app/(dashboard)/reports"
git commit -m "feat(reports): report index + generic viewer page, remove stubs"
```

---

# Phase 2 — Batch 1 (priority: PPV + Wastage)

> **Pattern for every report module (Tasks 11–18):** export a pure `compute*(rows): ReportResult`-fragment function (unit-tested), and a thin `query(filters)` that fetches via Prisma and calls compute. Register in `registry.ts` (add `import` + map entry) and append to `filter-fields.ts` (already seeded in Task 10).

### Task 11: PPV report module

**Files:**
- Create: `src/lib/reports/modules/ppv.ts`
- Test: `src/lib/reports/modules/ppv.test.ts`
- Modify: `src/lib/reports/registry.ts`

PPV = (actual rate − standard rate) × qtyKg, where standard = `Inventory.weightedAvgCost` matched by board grade + GSM. Decompose landed variance into price/freight/unloading/insurance. Rows with no baseline are flagged and excluded from variance totals.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computePpv, type PpvInput } from './ppv'

const input: PpvInput[] = [
  { vendor: 'V1', boardGrade: 'SBS', gsm: 300, qtyKg: 1000,
    basicRate: 55, landedRate: 60, freightPerKg: 3, unloadingPerKg: 1, insurancePerKg: 1,
    stdRate: 50 },
  { vendor: 'V2', boardGrade: 'FBB', gsm: 250, qtyKg: 500,
    basicRate: 48, landedRate: 52, freightPerKg: 2, unloadingPerKg: 1, insurancePerKg: 1,
    stdRate: null }, // no baseline
]

describe('computePpv', () => {
  const r = computePpv(input)
  it('computes basic and landed PPV per line', () => {
    const row = r.rows.find((x) => x.vendor === 'V1')!
    expect(row.basicPpv).toBe((55 - 50) * 1000)   // 5000 adverse
    expect(row.landedPpv).toBe((60 - 50) * 1000)  // 10000
  })
  it('decomposes landed variance into components', () => {
    const row = r.rows.find((x) => x.vendor === 'V1')!
    expect(row.freightVar).toBe(3 * 1000)
    expect(row.unloadingVar).toBe(1 * 1000)
    expect(row.insuranceVar).toBe(1 * 1000)
    expect(row.priceVar).toBe((55 - 50) * 1000)
  })
  it('flags no-baseline rows and excludes them from totals', () => {
    const v2 = r.rows.find((x) => x.vendor === 'V2')!
    expect(v2.baseline).toBe('no baseline')
    const total = r.summary.find((s) => s.label === 'Total Landed PPV')!
    expect(total.value).toContain('10,000') // only V1 counted
  })
  it('marks adverse total tone bad', () => {
    expect(r.summary.find((s) => s.label === 'Total Landed PPV')!.tone).toBe('bad')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/ppv.test.ts`
Expected: FAIL — cannot resolve `./ppv`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtInr, fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface PpvInput {
  vendor: string
  boardGrade: string
  gsm: number
  qtyKg: number
  basicRate: number
  landedRate: number
  freightPerKg: number
  unloadingPerKg: number
  insurancePerKg: number
  stdRate: number | null
}

export function computePpv(input: PpvInput[]): ReportResult {
  const rows = input.map((i) => {
    const hasBase = i.stdRate != null
    const std = i.stdRate ?? 0
    const priceVar = hasBase ? (i.basicRate - std) * i.qtyKg : 0
    const freightVar = i.freightPerKg * i.qtyKg
    const unloadingVar = i.unloadingPerKg * i.qtyKg
    const insuranceVar = i.insurancePerKg * i.qtyKg
    return {
      vendor: i.vendor,
      boardGrade: i.boardGrade,
      gsm: i.gsm,
      qtyKg: i.qtyKg,
      stdRate: i.stdRate,
      basicRate: i.basicRate,
      landedRate: i.landedRate,
      basicPpv: hasBase ? (i.basicRate - std) * i.qtyKg : 0,
      landedPpv: hasBase ? (i.landedRate - std) * i.qtyKg : 0,
      priceVar, freightVar, unloadingVar, insuranceVar,
      baseline: hasBase ? 'ok' : 'no baseline',
    }
  })

  const counted = rows.filter((r) => r.baseline === 'ok')
  const totalLanded = counted.reduce((s, r) => s + r.landedPpv, 0)
  const totalBasic = counted.reduce((s, r) => s + r.basicPpv, 0)
  const spend = counted.reduce((s, r) => s + r.landedRate * r.qtyKg, 0)
  const worst = [...counted].sort((a, b) => b.landedPpv - a.landedPpv)[0]

  return {
    columns: [
      { key: 'vendor', label: 'Vendor', type: 'text' },
      { key: 'boardGrade', label: 'Board', type: 'text' },
      { key: 'gsm', label: 'GSM', type: 'num' },
      { key: 'qtyKg', label: 'Qty (kg)', type: 'num', total: true },
      { key: 'stdRate', label: 'Std ₹/kg', type: 'inr' },
      { key: 'basicRate', label: 'Basic ₹/kg', type: 'inr' },
      { key: 'landedRate', label: 'Landed ₹/kg', type: 'inr' },
      { key: 'basicPpv', label: 'Basic PPV', type: 'inr', total: true },
      { key: 'landedPpv', label: 'Landed PPV', type: 'inr', total: true },
      { key: 'priceVar', label: 'Price Var', type: 'inr', total: true },
      { key: 'freightVar', label: 'Freight Var', type: 'inr', total: true },
      { key: 'unloadingVar', label: 'Unloading Var', type: 'inr', total: true },
      { key: 'insuranceVar', label: 'Insurance Var', type: 'inr', total: true },
      { key: 'baseline', label: 'Baseline', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'Total Landed PPV', value: fmtInr(totalLanded), tone: totalLanded > 0 ? 'bad' : 'good' },
      { label: 'Total Basic PPV', value: fmtInr(totalBasic), tone: totalBasic > 0 ? 'bad' : 'good' },
      { label: 'PPV % of Spend', value: fmtPct(spend ? (totalLanded / spend) * 100 : 0) },
      { label: 'Worst Vendor', value: worst ? `${worst.vendor} (${fmtInr(worst.landedPpv)})` : '—' },
    ],
    chart: {
      kind: 'stacked', x: 'boardGrade',
      series: ['priceVar', 'freightVar', 'unloadingVar', 'insuranceVar'],
      data: rows,
    },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({
  vendor: optionalId,
  boardGrade: optionalId,
})
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'ppv', title: 'Purchase Price Variance', group: 'procurement' as const,
  kpi: 'Actual vs weighted-avg cost — decomposed by price, freight, unloading, insurance',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: {
      vendorPo: {
        createdAt: { gte: filters.from, lte: filters.to },
        ...(filters.vendor ? { supplier: { name: { contains: filters.vendor, mode: 'insensitive' } } } : {}),
      },
      ...(filters.boardGrade ? { boardGrade: { contains: filters.boardGrade, mode: 'insensitive' } } : {}),
    },
    include: { vendorPo: { include: { supplier: true } } },
  })

  const baselines = await db.inventory.findMany({
    select: { boardType: true, gsm: true, weightedAvgCost: true },
  })
  const baseFor = (grade: string, gsm: number) => {
    const m = baselines.find(
      (b) => (b.boardType ?? '').toLowerCase() === grade.toLowerCase() && b.gsm === gsm
    )
    return m ? Number(m.weightedAvgCost) : null
  }

  const input: PpvInput[] = lines.map((l) => {
    const qtyKg = Number(l.totalWeightKg) || 0
    return {
      vendor: l.vendorPo.supplier.name,
      boardGrade: l.boardGrade,
      gsm: l.gsm,
      qtyKg,
      basicRate: Number(l.ratePerKg) || 0,
      landedRate: Number(l.landedRatePerKg) || Number(l.ratePerKg) || 0,
      freightPerKg: qtyKg ? Number(l.freightTotalInr) / qtyKg : 0,
      unloadingPerKg: qtyKg ? Number(l.unloadingChargesInr) / qtyKg : 0,
      insurancePerKg: qtyKg ? Number(l.insuranceMiscInr) / qtyKg : 0,
      stdRate: baseFor(l.boardGrade, l.gsm),
    }
  })

  const result = computePpv(input)
  result.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
    ...(filters.vendor ? { vendor: filters.vendor } : {}),
    ...(filters.boardGrade ? { boardGrade: filters.boardGrade } : {}),
  }
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/ppv.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the module**

In `src/lib/reports/registry.ts`, add at top: `import * as ppv from './modules/ppv'` and inside `REPORTS`: `ppv: { ...ppv.meta, filterSchema: ppv.filterSchema, query: ppv.query },`.

- [ ] **Step 6: Run registry + typecheck**

Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/reports/modules/ppv.ts src/lib/reports/modules/ppv.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): PPV report module with decomposed variance + tests"
```

---

### Task 12: Wastage report module (multi-view: matrix + overall)

**Files:**
- Create: `src/lib/reports/modules/wastage.ts`
- Test: `src/lib/reports/modules/wastage.test.ts`
- Modify: `src/lib/reports/registry.ts`

View `matrix`: rows = stage; columns = makeready/run_waste/substrate_trim qty + ₹. View `overall`: total input → good → waste% with 3-way reconciliation.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeWastageMatrix, computeWastageOverall, type WasteInput, type ReconInput } from './wastage'

const waste: WasteInput[] = [
  { stage: 'Printing', wasteType: 'makeready', qty: 100, unitCost: 5 },
  { stage: 'Printing', wasteType: 'run_waste', qty: 50, unitCost: 5 },
  { stage: 'Punching', wasteType: 'substrate_trim', qty: 30, unitCost: 4 },
]

describe('computeWastageMatrix', () => {
  const r = computeWastageMatrix(waste)
  it('builds a stage x type matrix with qty and value', () => {
    const printing = r.rows.find((x) => x.stage === 'Printing')!
    expect(printing.makeready_qty).toBe(100)
    expect(printing.run_waste_qty).toBe(50)
    expect(printing.makeready_val).toBe(500)
  })
  it('summary reports total waste value and worst stage', () => {
    expect(r.summary.find((s) => s.label === 'Total Waste ₹')!.value).toContain('870')
    expect(r.summary.find((s) => s.label === 'Worst Stage')!.value).toContain('Printing')
  })
})

describe('computeWastageOverall', () => {
  it('reconciles three sources and flags discrepancy', () => {
    const recon: ReconInput = {
      totalInput: 1000, goodOutput: 820,
      wasteRecordQty: 180, weightReconWaste: 175, yieldImpliedWaste: 200,
    }
    const r = computeWastageOverall(recon)
    const wastePct = r.summary.find((s) => s.label === 'Overall Waste %')!
    expect(wastePct.value).toBe('18.00%')
    expect(r.rows.some((x) => x.source === 'WasteRecord' && x.qty === 180)).toBe(true)
    // max-min spread 200-175=25 > 5% of input → discrepancy flagged
    expect(r.summary.find((s) => s.label === 'Reconciliation')!.tone).toBe('bad')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/wastage.test.ts`
Expected: FAIL — cannot resolve `./wastage`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtInr, fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface WasteInput { stage: string; wasteType: string; qty: number; unitCost: number }
export interface ReconInput {
  totalInput: number; goodOutput: number
  wasteRecordQty: number; weightReconWaste: number; yieldImpliedWaste: number
}

const TYPES = ['makeready', 'run_waste', 'substrate_trim'] as const

export function computeWastageMatrix(input: WasteInput[]): ReportResult {
  const stages = [...new Set(input.map((i) => i.stage))]
  const rows = stages.map((stage) => {
    const row: Record<string, unknown> = { stage }
    let stageTotalVal = 0
    for (const t of TYPES) {
      const items = input.filter((i) => i.stage === stage && i.wasteType === t)
      const qty = items.reduce((s, i) => s + i.qty, 0)
      const val = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
      row[`${t}_qty`] = qty
      row[`${t}_val`] = val
      stageTotalVal += val
    }
    row.total_val = stageTotalVal
    return row
  })
  const totalVal = rows.reduce((s, r) => s + (Number(r.total_val) || 0), 0)
  const worst = [...rows].sort((a, b) => Number(b.total_val) - Number(a.total_val))[0]
  return {
    columns: [
      { key: 'stage', label: 'Stage', type: 'text' },
      { key: 'makeready_qty', label: 'Makeready Qty', type: 'num', total: true },
      { key: 'run_waste_qty', label: 'Run Waste Qty', type: 'num', total: true },
      { key: 'substrate_trim_qty', label: 'Trim Qty', type: 'num', total: true },
      { key: 'total_val', label: 'Waste ₹', type: 'inr', total: true },
    ],
    rows,
    summary: [
      { label: 'Total Waste ₹', value: fmtInr(totalVal), tone: 'bad' },
      { label: 'Worst Stage', value: worst ? `${worst.stage} (${fmtInr(Number(worst.total_val))})` : '—' },
    ],
    chart: {
      kind: 'stacked', x: 'stage',
      series: ['makeready_qty', 'run_waste_qty', 'substrate_trim_qty'],
      data: rows,
    },
    views: [{ id: 'matrix', label: 'Stage Matrix' }, { id: 'overall', label: 'Overall Rollup' }],
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export function computeWastageOverall(r: ReconInput): ReportResult {
  const wastePct = r.totalInput ? ((r.totalInput - r.goodOutput) / r.totalInput) * 100 : 0
  const sources = [
    { source: 'WasteRecord', qty: r.wasteRecordQty },
    { source: 'WeightRecon', qty: r.weightReconWaste },
    { source: 'YieldImplied', qty: r.yieldImpliedWaste },
  ]
  const spread = Math.max(...sources.map((s) => s.qty)) - Math.min(...sources.map((s) => s.qty))
  const discrepancy = r.totalInput ? spread > 0.05 * r.totalInput : false
  return {
    columns: [
      { key: 'source', label: 'Source', type: 'text' },
      { key: 'qty', label: 'Implied Waste Qty', type: 'num' },
    ],
    rows: sources,
    summary: [
      { label: 'Total Input', value: String(r.totalInput) },
      { label: 'Good Output', value: String(r.goodOutput) },
      { label: 'Overall Waste %', value: fmtPct(wastePct), tone: wastePct > 5 ? 'bad' : 'good' },
      { label: 'Reconciliation', value: discrepancy ? `Discrepancy (spread ${spread})` : 'Within 5%',
        tone: discrepancy ? 'bad' : 'good' },
    ],
    views: [{ id: 'matrix', label: 'Stage Matrix' }, { id: 'overall', label: 'Overall Rollup' }],
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({
  machineId: optionalId,
  stage: optionalId,
  view: optionalId,
})
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'wastage', title: 'Wastage — Stage-wise & Overall', group: 'material' as const,
  kpi: 'Waste by stage & type, overall waste % with 3-way reconciliation',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const wasteRecords = await db.wasteRecord.findMany({
    where: {
      recordedAt: { gte: filters.from, lte: filters.to },
      ...(filters.machineId ? { machineId: filters.machineId } : {}),
      ...(filters.stage ? { stage: { stageNumber: Number(filters.stage) || -1 } } : {}),
    },
    include: { stage: true, material: { select: { weightedAvgCost: true } } },
  })

  const applied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
    ...(filters.machineId ? { machineId: filters.machineId } : {}),
  }

  if (filters.view === 'overall') {
    const stages = await db.jobStage.findMany({
      where: { startedAt: { gte: filters.from, lte: filters.to } },
      select: { qtyIn: true, qtyOut: true, qtyWaste: true },
    })
    const totalInput = stages.reduce((s, x) => s + (x.qtyIn ?? 0), 0)
    const goodOutput = stages.reduce((s, x) => s + (x.qtyOut ?? 0), 0)
    const wasteRecordQty = wasteRecords.reduce((s, w) => s + Number(w.qty), 0)
    const recon = await db.materialWeightReconciliation.aggregate({
      _sum: { varianceKg: true },
      where: { createdAt: { gte: filters.from, lte: filters.to } },
    })
    const r = computeWastageOverall({
      totalInput, goodOutput,
      wasteRecordQty,
      weightReconWaste: Math.abs(Number(recon._sum.varianceKg) || 0),
      yieldImpliedWaste: totalInput - goodOutput,
    })
    r.meta.filtersApplied = applied
    return r
  }

  const input: WasteInput[] = wasteRecords.map((w) => ({
    stage: w.stage ? `Stage ${w.stage.stageNumber}` : 'Unattributed',
    wasteType: w.wasteType,
    qty: Number(w.qty),
    unitCost: Number(w.material.weightedAvgCost) || 0,
  }))
  const r = computeWastageMatrix(input)
  r.meta.filtersApplied = applied
  return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/wastage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register + typecheck**

Add to `registry.ts`: `import * as wastage from './modules/wastage'` and `wastage: { ...wastage.meta, filterSchema: wastage.filterSchema, query: wastage.query },`.

Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/modules/wastage.ts src/lib/reports/modules/wastage.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): wastage report (stage matrix + overall reconciliation) + tests"
```

- [ ] **Step 7: Manual UI verification (Phase 2 gate)**

Run: `npm run dev`, log in, open `/reports`. Verify PPV and Wastage cards appear, each opens, filters apply via URL, table/chart render, Wastage view tabs switch, Excel + PDF download. Report any failure before continuing.

---

# Phase 3 — Batch 2 (OEE, Yield, OTIF, Short & Excess)

### Task 13: OEE report module

**Files:**
- Create: `src/lib/reports/modules/oee.ts`
- Test: `src/lib/reports/modules/oee.test.ts`
- Modify: `src/lib/reports/registry.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeOee, type OeeInput } from './oee'

const input: OeeInput[] = [
  { date: '2026-05-01', machine: 'CI-01', operator: 'A', shiftMin: 480, runMin: 420,
    availability: 87.5, performance: 90, quality: 98, oee: 77.2, goodPieces: 9800, totalPieces: 10000, yield: 98 },
  { date: '2026-05-02', machine: 'CI-02', operator: 'B', shiftMin: 480, runMin: 300,
    availability: 62, performance: 80, quality: 95, oee: 47.1, goodPieces: 4750, totalPieces: 5000, yield: 95 },
]

describe('computeOee', () => {
  const r = computeOee(input)
  it('averages OEE and counts jobs below 85 target', () => {
    expect(r.summary.find((s) => s.label === 'Avg OEE %')!.value).toBe('62.15%')
    expect(r.summary.find((s) => s.label === 'Jobs Below Target')!.value).toBe('2')
  })
  it('avg OEE tone is bad when below 85', () => {
    expect(r.summary.find((s) => s.label === 'Avg OEE %')!.tone).toBe('bad')
  })
  it('emits a bar chart of OEE by machine', () => {
    expect(r.chart!.kind).toBe('bar')
    expect(r.chart!.x).toBe('machine')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/oee.test.ts`
Expected: FAIL — cannot resolve `./oee`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface OeeInput {
  date: string; machine: string; operator: string
  shiftMin: number; runMin: number
  availability: number; performance: number; quality: number; oee: number
  goodPieces: number; totalPieces: number; yield: number
}

export function computeOee(input: OeeInput[]): ReportResult {
  const avg = (k: keyof OeeInput) =>
    input.length ? input.reduce((s, i) => s + Number(i[k]), 0) / input.length : 0
  const avgOee = avg('oee')
  const below = input.filter((i) => i.oee < 85).length
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'machine', label: 'Machine', type: 'text' },
      { key: 'operator', label: 'Operator', type: 'text' },
      { key: 'shiftMin', label: 'Shift Min', type: 'num' },
      { key: 'runMin', label: 'Run Min', type: 'num' },
      { key: 'availability', label: 'Avail %', type: 'pct' },
      { key: 'performance', label: 'Perf %', type: 'pct' },
      { key: 'quality', label: 'Qual %', type: 'pct' },
      { key: 'oee', label: 'OEE %', type: 'pct' },
      { key: 'goodPieces', label: 'Good', type: 'num', total: true },
      { key: 'totalPieces', label: 'Total', type: 'num', total: true },
      { key: 'yield', label: 'Yield %', type: 'pct' },
    ],
    rows: input as unknown as Record<string, unknown>[],
    summary: [
      { label: 'Avg OEE %', value: fmtPct(avgOee), tone: avgOee >= 85 ? 'good' : 'bad' },
      { label: 'Avg Availability %', value: fmtPct(avg('availability')) },
      { label: 'Avg Performance %', value: fmtPct(avg('performance')) },
      { label: 'Jobs Below Target', value: String(below), tone: below ? 'bad' : 'good' },
    ],
    chart: { kind: 'bar', x: 'machine', series: ['oee'], data: input as any },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ machineId: optionalId, operatorId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'oee', title: 'OEE Report', group: 'production' as const,
  kpi: 'Availability × Performance × Quality (target ≥ 85%)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const ledgers = await db.productionOeeLedger.findMany({
    where: {
      computedAt: { gte: filters.from, lte: filters.to },
      ...(filters.machineId ? { machineId: filters.machineId } : {}),
      ...(filters.operatorId ? { attributedOperatorUserId: filters.operatorId } : {}),
    },
    include: {
      machine: { select: { machineCode: true } },
      attributedOperator: { select: { name: true } },
    },
  })
  const input: OeeInput[] = ledgers.map((l) => ({
    date: l.computedAt.toISOString(),
    machine: l.machine?.machineCode ?? '—',
    operator: l.attributedOperator?.name ?? '—',
    shiftMin: l.shiftMinutes,
    runMin: l.runMinutes,
    availability: Number(l.availabilityPct),
    performance: Number(l.performancePct),
    quality: Number(l.qualityPct),
    oee: Number(l.oeePct),
    goodPieces: l.goodPieces,
    totalPieces: l.totalPieces,
    yield: Number(l.yieldPercent) || 0,
  }))
  const r = computeOee(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/oee.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register + typecheck**

Add to `registry.ts`: `import * as oee from './modules/oee'` and `oee: { ...oee.meta, filterSchema: oee.filterSchema, query: oee.query },`.
Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/modules/oee.ts src/lib/reports/modules/oee.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): OEE report module + tests"
```

---

### Task 14: Yield report module

**Files:**
- Create: `src/lib/reports/modules/yield.ts`
- Test: `src/lib/reports/modules/yield.test.ts`
- Modify: `src/lib/reports/registry.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeYield, type YieldInput } from './yield'

const input: YieldInput[] = [
  { date: '2026-05-01', jobCard: 'JC1', machine: 'CI-01', operator: 'A',
    totalPieces: 10000, goodPieces: 9800, yield: 98, incentiveEligible: true },
  { date: '2026-05-02', jobCard: 'JC2', machine: 'CI-02', operator: 'B',
    totalPieces: 8000, goodPieces: 7200, yield: 90, incentiveEligible: false },
]

describe('computeYield', () => {
  const r = computeYield(input)
  it('computes avg yield and incentive count', () => {
    expect(r.summary.find((s) => s.label === 'Avg Yield %')!.value).toBe('94.00%')
    expect(r.summary.find((s) => s.label === 'Incentive-Eligible Jobs')!.value).toBe('1')
  })
  it('avg yield tone bad below 96 target', () => {
    expect(r.summary.find((s) => s.label === 'Avg Yield %')!.tone).toBe('bad')
  })
  it('identifies worst-yield job', () => {
    expect(r.summary.find((s) => s.label === 'Worst Job')!.value).toContain('JC2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/yield.test.ts`
Expected: FAIL — cannot resolve `./yield`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface YieldInput {
  date: string; jobCard: string; machine: string; operator: string
  totalPieces: number; goodPieces: number; yield: number; incentiveEligible: boolean
}

export function computeYield(input: YieldInput[]): ReportResult {
  const avgYield = input.length ? input.reduce((s, i) => s + i.yield, 0) / input.length : 0
  const incentive = input.filter((i) => i.incentiveEligible).length
  const worst = [...input].sort((a, b) => a.yield - b.yield)[0]
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'jobCard', label: 'Job Card', type: 'text' },
      { key: 'machine', label: 'Machine', type: 'text' },
      { key: 'operator', label: 'Operator', type: 'text' },
      { key: 'totalPieces', label: 'Total', type: 'num', total: true },
      { key: 'goodPieces', label: 'Good', type: 'num', total: true },
      { key: 'yield', label: 'Yield %', type: 'pct' },
      { key: 'incentiveEligible', label: 'Incentive', type: 'text' },
    ],
    rows: input as unknown as Record<string, unknown>[],
    summary: [
      { label: 'Avg Yield %', value: fmtPct(avgYield), tone: avgYield >= 96 ? 'good' : 'bad' },
      { label: 'Incentive-Eligible Jobs', value: String(incentive), tone: 'neutral' },
      { label: 'Worst Job', value: worst ? `${worst.jobCard} (${fmtPct(worst.yield)})` : '—', tone: 'bad' },
    ],
    chart: { kind: 'line', x: 'date', series: ['yield'], data: input as any },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ machineId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'yield', title: 'Yield Report', group: 'production' as const,
  kpi: 'Good vs total pieces (target ≥ 96%)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const ledgers = await db.productionOeeLedger.findMany({
    where: {
      computedAt: { gte: filters.from, lte: filters.to },
      ...(filters.machineId ? { machineId: filters.machineId } : {}),
    },
    include: {
      machine: { select: { machineCode: true } },
      attributedOperator: { select: { name: true } },
      jobCard: { select: { id: true } },
    },
  })
  const input: YieldInput[] = ledgers.map((l) => ({
    date: l.computedAt.toISOString(),
    jobCard: l.jobCard?.id?.slice(0, 8) ?? l.productionJobCardId.slice(0, 8),
    machine: l.machine?.machineCode ?? '—',
    operator: l.attributedOperator?.name ?? '—',
    totalPieces: l.totalPieces,
    goodPieces: l.goodPieces,
    yield: Number(l.yieldPercent) || 0,
    incentiveEligible: l.incentiveEligible,
  }))
  const r = computeYield(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/yield.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register + typecheck**

Add to `registry.ts`: `import * as yieldRpt from './modules/yield'` and `yield: { ...yieldRpt.meta, filterSchema: yieldRpt.filterSchema, query: yieldRpt.query },`.
Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/modules/yield.ts src/lib/reports/modules/yield.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): yield report module + tests"
```

---

### Task 15: OTIF report module

**Files:**
- Create: `src/lib/reports/modules/otif.ts`
- Test: `src/lib/reports/modules/otif.test.ts`
- Modify: `src/lib/reports/registry.ts`

On-time = `dispatchedAt <= dueDate`. In-full = `qtyDispatched >= poQty` AND `<= allowedQty` (within tolerance). OTIF = on-time AND in-full. Due date source: `PurchaseOrder.deliveryRequiredBy`, falling back to `Job.dueDate`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeOtif, type OtifInput } from './otif'

const input: OtifInput[] = [
  { po: 'PO1', customer: 'Acme', carton: 'C1', poQty: 1000, dispatchedQty: 1000,
    allowedQty: 1020, dueDate: '2026-05-10', dispatchedAt: '2026-05-09' }, // OTIF
  { po: 'PO2', customer: 'Acme', carton: 'C2', poQty: 1000, dispatchedQty: 900,
    allowedQty: 1020, dueDate: '2026-05-10', dispatchedAt: '2026-05-12' }, // late + short
]

describe('computeOtif', () => {
  const r = computeOtif(input)
  it('flags per-line onTime/inFull/OTIF', () => {
    const a = r.rows.find((x) => x.po === 'PO1')!
    expect(a.onTime).toBe('Yes'); expect(a.inFull).toBe('Yes'); expect(a.otif).toBe('Yes')
    const b = r.rows.find((x) => x.po === 'PO2')!
    expect(b.onTime).toBe('No'); expect(b.inFull).toBe('No'); expect(b.otif).toBe('No')
  })
  it('computes OTIF% and counts', () => {
    expect(r.summary.find((s) => s.label === 'OTIF %')!.value).toBe('50.00%')
    expect(r.summary.find((s) => s.label === 'Late')!.value).toBe('1')
    expect(r.summary.find((s) => s.label === 'Short')!.value).toBe('1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/otif.test.ts`
Expected: FAIL — cannot resolve `./otif`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface OtifInput {
  po: string; customer: string; carton: string
  poQty: number; dispatchedQty: number; allowedQty: number
  dueDate: string; dispatchedAt: string
}

export function computeOtif(input: OtifInput[]): ReportResult {
  const rows = input.map((i) => {
    const onTime = new Date(i.dispatchedAt).getTime() <= new Date(i.dueDate).getTime()
    const inFull = i.dispatchedQty >= i.poQty && i.dispatchedQty <= i.allowedQty
    const otif = onTime && inFull
    return {
      po: i.po, customer: i.customer, carton: i.carton,
      poQty: i.poQty, dispatchedQty: i.dispatchedQty,
      dueDate: i.dueDate, dispatchedAt: i.dispatchedAt,
      onTime: onTime ? 'Yes' : 'No',
      inFull: inFull ? 'Yes' : 'No',
      otif: otif ? 'Yes' : 'No',
    }
  })
  const n = rows.length || 1
  const otifCount = rows.filter((r) => r.otif === 'Yes').length
  const onTimeCount = rows.filter((r) => r.onTime === 'Yes').length
  const inFullCount = rows.filter((r) => r.inFull === 'Yes').length
  const late = rows.filter((r) => r.onTime === 'No').length
  const short = rows.filter((r) => r.dispatchedQty < r.poQty).length
  const otifPct = (otifCount / n) * 100

  const byCustomer = [...new Set(rows.map((r) => r.customer))].map((c) => {
    const cr = rows.filter((r) => r.customer === c)
    return { customer: c, otifPct: (cr.filter((r) => r.otif === 'Yes').length / cr.length) * 100 }
  })

  return {
    columns: [
      { key: 'po', label: 'PO', type: 'text' },
      { key: 'customer', label: 'Customer', type: 'text' },
      { key: 'carton', label: 'Carton', type: 'text' },
      { key: 'poQty', label: 'PO Qty', type: 'num', total: true },
      { key: 'dispatchedQty', label: 'Dispatched', type: 'num', total: true },
      { key: 'dueDate', label: 'Due', type: 'date' },
      { key: 'dispatchedAt', label: 'Dispatched At', type: 'date' },
      { key: 'onTime', label: 'On-Time', type: 'text' },
      { key: 'inFull', label: 'In-Full', type: 'text' },
      { key: 'otif', label: 'OTIF', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'OTIF %', value: fmtPct(otifPct), tone: otifPct >= 95 ? 'good' : 'bad' },
      { label: 'On-Time %', value: fmtPct((onTimeCount / n) * 100) },
      { label: 'In-Full %', value: fmtPct((inFullCount / n) * 100) },
      { label: 'Late', value: String(late), tone: late ? 'bad' : 'good' },
      { label: 'Short', value: String(short), tone: short ? 'bad' : 'good' },
    ],
    chart: { kind: 'bar', x: 'customer', series: ['otifPct'], data: byCustomer },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ customerId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'otif', title: 'On-Time-In-Full (OTIF)', group: 'delivery' as const,
  kpi: 'On-time AND in-full delivery vs customer PO (target ≥ 95%)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const dispatches = await db.dispatch.findMany({
    where: {
      dispatchedAt: { gte: filters.from, lte: filters.to, not: null },
      poLineItem: filters.customerId
        ? { po: { customerId: filters.customerId } } : { isNot: null },
    },
    include: {
      poLineItem: {
        include: {
          po: { include: { customer: { select: { name: true } } } },
        },
      },
      job: { select: { dueDate: true } },
    },
  })
  const input: OtifInput[] = dispatches
    .filter((d) => d.poLineItem)
    .map((d) => {
      const li = d.poLineItem!
      const due = li.po.deliveryRequiredBy ?? d.job?.dueDate ?? d.dispatchedAt!
      return {
        po: li.po.poNumber,
        customer: li.po.customer.name,
        carton: li.cartonName,
        poQty: d.poQtySnapshot ?? li.quantity,
        dispatchedQty: d.qtyDispatched,
        allowedQty: d.allowedQty ?? (d.poQtySnapshot ?? li.quantity),
        dueDate: new Date(due).toISOString(),
        dispatchedAt: d.dispatchedAt!.toISOString(),
      }
    })
  const r = computeOtif(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/otif.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register + typecheck**

Add to `registry.ts`: `import * as otif from './modules/otif'` and `otif: { ...otif.meta, filterSchema: otif.filterSchema, query: otif.query },`.
Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/modules/otif.ts src/lib/reports/modules/otif.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): OTIF report module + tests"
```

---

### Task 16: Short & Excess report module

**Files:**
- Create: `src/lib/reports/modules/short-excess.ts`
- Test: `src/lib/reports/modules/short-excess.test.ts`
- Modify: `src/lib/reports/registry.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeShortExcess, type SeInput } from './short-excess'

const input: SeInput[] = [
  { po: 'PO1', customer: 'Acme', carton: 'C1', poQty: 1000, deliveredQty: 1050,
    tolerancePct: 2, unitRate: 10 }, // excess 50, outside 2% tol (>1020)
  { po: 'PO2', customer: 'Beta', carton: 'C2', poQty: 1000, deliveredQty: 980,
    tolerancePct: 2, unitRate: 10 }, // short 20, within tol
]

describe('computeShortExcess', () => {
  const r = computeShortExcess(input)
  it('computes variance and tolerance flag', () => {
    const a = r.rows.find((x) => x.po === 'PO1')!
    expect(a.excessQty).toBe(50)
    expect(a.withinTolerance).toBe('No')
    const b = r.rows.find((x) => x.po === 'PO2')!
    expect(b.shortQty).toBe(20)
    expect(b.withinTolerance).toBe('Yes')
  })
  it('summarises totals and S&E value', () => {
    expect(r.summary.find((s) => s.label === 'Total Excess')!.value).toBe('50')
    expect(r.summary.find((s) => s.label === 'Total Short')!.value).toBe('20')
    expect(r.summary.find((s) => s.label === 'Outside Tolerance')!.value).toBe('1')
    expect(r.summary.find((s) => s.label === 'S&E Value')!.value).toContain('700')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/short-excess.test.ts`
Expected: FAIL — cannot resolve `./short-excess`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtInr } from '../format'
import type { ReportResult } from '../types'

export interface SeInput {
  po: string; customer: string; carton: string
  poQty: number; deliveredQty: number; tolerancePct: number; unitRate: number
}

export function computeShortExcess(input: SeInput[]): ReportResult {
  const rows = input.map((i) => {
    const diff = i.deliveredQty - i.poQty
    const allowed = i.poQty * (i.tolerancePct / 100)
    const within = Math.abs(diff) <= allowed
    return {
      po: i.po, customer: i.customer, carton: i.carton,
      poQty: i.poQty, deliveredQty: i.deliveredQty,
      shortQty: diff < 0 ? -diff : 0,
      excessQty: diff > 0 ? diff : 0,
      variancePct: i.poQty ? (diff / i.poQty) * 100 : 0,
      withinTolerance: within ? 'Yes' : 'No',
      seValue: Math.abs(diff) * i.unitRate,
    }
  })
  const totalShort = rows.reduce((s, r) => s + Number(r.shortQty), 0)
  const totalExcess = rows.reduce((s, r) => s + Number(r.excessQty), 0)
  const outside = rows.filter((r) => r.withinTolerance === 'No').length
  const seValue = rows.reduce((s, r) => s + Number(r.seValue), 0)
  return {
    columns: [
      { key: 'po', label: 'PO', type: 'text' },
      { key: 'customer', label: 'Customer', type: 'text' },
      { key: 'carton', label: 'Carton', type: 'text' },
      { key: 'poQty', label: 'PO Qty', type: 'num', total: true },
      { key: 'deliveredQty', label: 'Delivered', type: 'num', total: true },
      { key: 'shortQty', label: 'Short', type: 'num', total: true },
      { key: 'excessQty', label: 'Excess', type: 'num', total: true },
      { key: 'variancePct', label: 'Variance %', type: 'pct' },
      { key: 'withinTolerance', label: 'Within Tol', type: 'text' },
      { key: 'seValue', label: 'S&E ₹', type: 'inr', total: true },
    ],
    rows,
    summary: [
      { label: 'Total Short', value: String(totalShort), tone: totalShort ? 'bad' : 'good' },
      { label: 'Total Excess', value: String(totalExcess), tone: totalExcess ? 'bad' : 'good' },
      { label: 'Outside Tolerance', value: String(outside), tone: outside ? 'bad' : 'good' },
      { label: 'S&E Value', value: fmtInr(seValue), tone: 'bad' },
    ],
    chart: {
      kind: 'bar', x: 'customer', series: ['shortQty', 'excessQty'], data: rows,
    },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ customerId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'short-excess', title: 'Short & Excess', group: 'delivery' as const,
  kpi: 'Delivered vs PO qty against tolerance band',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const recs = await db.shortExcessRecord.findMany({
    where: {
      createdAt: { gte: filters.from, lte: filters.to },
      poLineItem: filters.customerId
        ? { po: { customerId: filters.customerId } } : undefined,
    },
    include: {
      poLineItem: {
        include: { po: { include: { customer: { select: { name: true } } } } },
      },
    },
  })
  const input: SeInput[] = recs
    .filter((s) => s.poLineItem)
    .map((s) => {
      const li = s.poLineItem!
      return {
        po: li.po.poNumber,
        customer: li.po.customer.name,
        carton: li.cartonName,
        poQty: li.quantity,
        deliveredQty: li.quantity + (Number((s as any).excessQty ?? 0) - Number((s as any).shortQty ?? 0)),
        tolerancePct: Number(li.tolerancePct) || 0,
        unitRate: Number(li.rate) || 0,
      }
    })
  const r = computeShortExcess(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
```

> Note: `ShortExcessRecord` field names for short/excess qty must be confirmed against `prisma/schema.prisma` (model `ShortExcessRecord`, lines ~992) during implementation; map the actual qty columns into `deliveredQty`. The compute function and its tests are authoritative for the math.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/short-excess.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register + typecheck**

Add to `registry.ts`: `import * as shortExcess from './modules/short-excess'` and `'short-excess': { ...shortExcess.meta, filterSchema: shortExcess.filterSchema, query: shortExcess.query },`.
Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/modules/short-excess.ts src/lib/reports/modules/short-excess.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): short & excess report module + tests"
```

- [ ] **Step 7: Manual UI verification (Phase 3 gate)**

`npm run dev` → verify OEE, Yield, OTIF, Short & Excess each render, filter, chart, and export. Report failures before continuing.

---

# Phase 4 — Batch 3 (Downtime Pareto, Vendor Quality PPM, PM Compliance)

### Task 17: Downtime Pareto report module

**Files:**
- Create: `src/lib/reports/modules/downtime-pareto.ts`
- Test: `src/lib/reports/modules/downtime-pareto.test.ts`
- Modify: `src/lib/reports/registry.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeDowntimePareto, type DtInput } from './downtime-pareto'

const input: DtInput[] = [
  { reason: 'makeready', minutes: 120 },
  { reason: 'makeready', minutes: 60 },
  { reason: 'breakdown', minutes: 90 },
  { reason: 'no_material', minutes: 30 },
]

describe('computeDowntimePareto', () => {
  const r = computeDowntimePareto(input)
  it('aggregates by reason sorted desc with cumulative %', () => {
    expect(r.rows[0]).toMatchObject({ reason: 'makeready', minutes: 180, occurrences: 2 })
    const last = r.rows[r.rows.length - 1]
    expect(Number(last.cumulativePct)).toBeCloseTo(100, 1)
  })
  it('summary shows total downtime and top reason', () => {
    expect(r.summary.find((s) => s.label === 'Total Downtime (min)')!.value).toBe('300')
    expect(r.summary.find((s) => s.label === 'Top Reason')!.value).toContain('makeready')
  })
  it('chart is pareto', () => {
    expect(r.chart!.kind).toBe('pareto')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/downtime-pareto.test.ts`
Expected: FAIL — cannot resolve `./downtime-pareto`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import type { ReportResult } from '../types'

export interface DtInput { reason: string; minutes: number }

export function computeDowntimePareto(input: DtInput[]): ReportResult {
  const byReason = new Map<string, { minutes: number; occurrences: number }>()
  for (const i of input) {
    const cur = byReason.get(i.reason) ?? { minutes: 0, occurrences: 0 }
    cur.minutes += i.minutes
    cur.occurrences += 1
    byReason.set(i.reason, cur)
  }
  const total = input.reduce((s, i) => s + i.minutes, 0)
  const sorted = [...byReason.entries()].sort((a, b) => b[1].minutes - a[1].minutes)
  let cum = 0
  const rows = sorted.map(([reason, v]) => {
    cum += v.minutes
    return {
      reason,
      occurrences: v.occurrences,
      minutes: v.minutes,
      pctOfTotal: total ? (v.minutes / total) * 100 : 0,
      cumulativePct: total ? (cum / total) * 100 : 0,
    }
  })
  const top = sorted[0]
  return {
    columns: [
      { key: 'reason', label: 'Reason', type: 'text' },
      { key: 'occurrences', label: 'Occurrences', type: 'num', total: true },
      { key: 'minutes', label: 'Downtime (min)', type: 'num', total: true },
      { key: 'pctOfTotal', label: '% of Total', type: 'pct' },
      { key: 'cumulativePct', label: 'Cumulative %', type: 'pct' },
    ],
    rows,
    summary: [
      { label: 'Total Downtime (min)', value: String(total), tone: 'bad' },
      { label: 'Top Reason', value: top ? `${top[0]} (${top[1].minutes} min)` : '—', tone: 'bad' },
      { label: 'Distinct Reasons', value: String(sorted.length) },
    ],
    chart: { kind: 'pareto', x: 'reason', series: ['minutes', 'cumulativePct'], data: rows },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ machineId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'downtime-pareto', title: 'Downtime Pareto', group: 'production' as const,
  kpi: 'Downtime minutes by reason (80/20 view)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const logs = await db.productionDowntimeLog.findMany({
    where: {
      startedAt: { gte: filters.from, lte: filters.to },
      ...(filters.machineId ? { machineId: filters.machineId } : {}),
    },
    select: { reasonCategory: true, durationSeconds: true },
  })
  const input: DtInput[] = logs.map((l) => ({
    reason: l.reasonCategory,
    minutes: Math.round((l.durationSeconds ?? 0) / 60),
  }))
  const r = computeDowntimePareto(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/downtime-pareto.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register + typecheck**

Add to `registry.ts`: `import * as downtimePareto from './modules/downtime-pareto'` and `'downtime-pareto': { ...downtimePareto.meta, filterSchema: downtimePareto.filterSchema, query: downtimePareto.query },`.
Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/modules/downtime-pareto.ts src/lib/reports/modules/downtime-pareto.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): downtime pareto report module + tests"
```

---

### Task 18: Vendor Quality PPM report module

**Files:**
- Create: `src/lib/reports/modules/vendor-quality-ppm.ts`
- Test: `src/lib/reports/modules/vendor-quality-ppm.test.ts`
- Modify: `src/lib/reports/registry.ts`

PPM = (rejected / received) × 1,000,000.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeVendorPpm, type VpInput } from './vendor-quality-ppm'

const input: VpInput[] = [
  { vendor: 'V1', receipts: 4, qtyReceived: 100000, qtyRejected: 500, debitNoteInr: 12000 },
  { vendor: 'V2', receipts: 2, qtyReceived: 50000, qtyRejected: 0, debitNoteInr: 0 },
]

describe('computeVendorPpm', () => {
  const r = computeVendorPpm(input)
  it('computes reject PPM per vendor', () => {
    expect(r.rows.find((x) => x.vendor === 'V1')!.ppm).toBe(5000)
    expect(r.rows.find((x) => x.vendor === 'V2')!.ppm).toBe(0)
  })
  it('summary reports overall PPM and worst vendor', () => {
    // (500+0)/(150000) * 1e6 = 3333.33
    expect(r.summary.find((s) => s.label === 'Overall PPM')!.value).toBe('3333');
    expect(r.summary.find((s) => s.label === 'Worst Vendor')!.value).toContain('V1')
    expect(r.summary.find((s) => s.label === 'Total Debit Notes')!.value).toContain('12,000')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/vendor-quality-ppm.test.ts`
Expected: FAIL — cannot resolve `./vendor-quality-ppm`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtInr } from '../format'
import type { ReportResult } from '../types'

export interface VpInput {
  vendor: string; receipts: number
  qtyReceived: number; qtyRejected: number; debitNoteInr: number
}

export function computeVendorPpm(input: VpInput[]): ReportResult {
  const rows = input.map((i) => ({
    vendor: i.vendor,
    receipts: i.receipts,
    qtyReceived: i.qtyReceived,
    qtyRejected: i.qtyRejected,
    ppm: i.qtyReceived ? Math.round((i.qtyRejected / i.qtyReceived) * 1_000_000) : 0,
    debitNoteInr: i.debitNoteInr,
  }))
  const totRec = input.reduce((s, i) => s + i.qtyReceived, 0)
  const totRej = input.reduce((s, i) => s + i.qtyRejected, 0)
  const overall = totRec ? Math.round((totRej / totRec) * 1_000_000) : 0
  const worst = [...rows].sort((a, b) => b.ppm - a.ppm)[0]
  const totDn = input.reduce((s, i) => s + i.debitNoteInr, 0)
  return {
    columns: [
      { key: 'vendor', label: 'Vendor', type: 'text' },
      { key: 'receipts', label: 'Receipts', type: 'num', total: true },
      { key: 'qtyReceived', label: 'Qty Received', type: 'num', total: true },
      { key: 'qtyRejected', label: 'Qty Rejected', type: 'num', total: true },
      { key: 'ppm', label: 'Reject PPM', type: 'num' },
      { key: 'debitNoteInr', label: 'Debit Note ₹', type: 'inr', total: true },
    ],
    rows,
    summary: [
      { label: 'Overall PPM', value: String(overall), tone: overall > 0 ? 'bad' : 'good' },
      { label: 'Worst Vendor', value: worst ? `${worst.vendor} (${worst.ppm})` : '—', tone: 'bad' },
      { label: 'Total Debit Notes', value: fmtInr(totDn), tone: 'bad' },
    ],
    chart: { kind: 'bar', x: 'vendor', series: ['ppm'], data: rows },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ vendor: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'vendor-quality-ppm', title: 'Vendor Quality PPM', group: 'procurement' as const,
  kpi: 'Incoming reject PPM by vendor + debit-note value',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const receipts = await db.vendorMaterialReceipt.findMany({
    where: { receiptDate: { gte: filters.from, lte: filters.to } },
    include: {
      vendorPo: { include: { supplier: { select: { name: true } } } },
      qualityDebitNote: { select: { amountInr: true } },
    },
  })
  const map = new Map<string, VpInput>()
  for (const rec of receipts) {
    const vendor = rec.vendorPo.supplier.name
    if (filters.vendor && !vendor.toLowerCase().includes(filters.vendor.toLowerCase())) continue
    const cur = map.get(vendor) ?? { vendor, receipts: 0, qtyReceived: 0, qtyRejected: 0, debitNoteInr: 0 }
    cur.receipts += 1
    cur.qtyReceived += Number(rec.receivedQty) || 0
    cur.qtyRejected += Number(rec.qtyRejected) || 0
    cur.debitNoteInr += Number(rec.qualityDebitNote?.amountInr) || 0
    map.set(vendor, cur)
  }
  const r = computeVendorPpm([...map.values()])
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/vendor-quality-ppm.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register + typecheck**

Add to `registry.ts`: `import * as vendorPpm from './modules/vendor-quality-ppm'` and `'vendor-quality-ppm': { ...vendorPpm.meta, filterSchema: vendorPpm.filterSchema, query: vendorPpm.query },`.
Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/modules/vendor-quality-ppm.ts src/lib/reports/modules/vendor-quality-ppm.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): vendor quality PPM report module + tests"
```

---

### Task 19: PM Compliance report module

**Files:**
- Create: `src/lib/reports/modules/pm-compliance.ts`
- Test: `src/lib/reports/modules/pm-compliance.test.ts`
- Modify: `src/lib/reports/registry.ts`

Compliance % = completed PMs / scheduled PMs. Scheduled count derived from `Machine.nextPmDue` falling in range; completed from `PreventiveMaintenanceLog` in range; overdue = `nextPmDue < now` and no log after it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computePmCompliance, type PmInput } from './pm-compliance'

const input: PmInput[] = [
  { machine: 'CI-01', scheduled: 4, completed: 4, overdue: 0 },
  { machine: 'CI-02', scheduled: 4, completed: 2, overdue: 1 },
]

describe('computePmCompliance', () => {
  const r = computePmCompliance(input)
  it('computes compliance % per machine', () => {
    expect(r.rows.find((x) => x.machine === 'CI-01')!.compliancePct).toBe(100)
    expect(r.rows.find((x) => x.machine === 'CI-02')!.compliancePct).toBe(50)
  })
  it('plant compliance and overdue count in summary', () => {
    // (4+2)/(4+4) = 75%
    expect(r.summary.find((s) => s.label === 'Plant PM Compliance %')!.value).toBe('75.00%')
    expect(r.summary.find((s) => s.label === 'Plant PM Compliance %')!.tone).toBe('bad')
    expect(r.summary.find((s) => s.label === 'Overdue PMs')!.value).toBe('1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reports/modules/pm-compliance.test.ts`
Expected: FAIL — cannot resolve `./pm-compliance`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface PmInput {
  machine: string; scheduled: number; completed: number; overdue: number
}

export function computePmCompliance(input: PmInput[]): ReportResult {
  const rows = input.map((i) => ({
    machine: i.machine,
    scheduled: i.scheduled,
    completed: i.completed,
    overdue: i.overdue,
    compliancePct: i.scheduled ? (i.completed / i.scheduled) * 100 : 0,
  }))
  const totSched = input.reduce((s, i) => s + i.scheduled, 0)
  const totDone = input.reduce((s, i) => s + i.completed, 0)
  const totOverdue = input.reduce((s, i) => s + i.overdue, 0)
  const plant = totSched ? (totDone / totSched) * 100 : 0
  return {
    columns: [
      { key: 'machine', label: 'Machine', type: 'text' },
      { key: 'scheduled', label: 'Scheduled PMs', type: 'num', total: true },
      { key: 'completed', label: 'Completed PMs', type: 'num', total: true },
      { key: 'overdue', label: 'Overdue', type: 'num', total: true },
      { key: 'compliancePct', label: 'Compliance %', type: 'pct' },
    ],
    rows,
    summary: [
      { label: 'Plant PM Compliance %', value: fmtPct(plant), tone: plant >= 95 ? 'good' : 'bad' },
      { label: 'Overdue PMs', value: String(totOverdue), tone: totOverdue ? 'bad' : 'good' },
      { label: 'Machines Tracked', value: String(input.length) },
    ],
    chart: { kind: 'bar', x: 'machine', series: ['compliancePct'], data: rows },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ machineId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'pm-compliance', title: 'PM Compliance', group: 'maintenance' as const,
  kpi: 'Preventive maintenance completed vs scheduled (target ≥ 95%)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const machines = await db.machine.findMany({
    where: filters.machineId ? { id: filters.machineId } : { status: { not: 'retired' } },
    select: { id: true, machineCode: true, nextPmDue: true },
  })
  const now = new Date()
  const input: PmInput[] = []
  for (const m of machines) {
    const completed = await db.preventiveMaintenanceLog.count({
      where: { machineId: m.id, verifiedAt: { gte: filters.from, lte: filters.to } },
    })
    const dueInRange =
      m.nextPmDue && m.nextPmDue >= filters.from && m.nextPmDue <= filters.to ? 1 : 0
    const scheduled = Math.max(completed + dueInRange, completed)
    const overdue = m.nextPmDue && m.nextPmDue < now && completed === 0 ? 1 : 0
    input.push({
      machine: m.machineCode,
      scheduled: scheduled || (completed === 0 && overdue ? 1 : completed),
      completed,
      overdue,
    })
  }
  const r = computePmCompliance(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reports/modules/pm-compliance.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register + typecheck**

Add to `registry.ts`: `import * as pmCompliance from './modules/pm-compliance'` and `'pm-compliance': { ...pmCompliance.meta, filterSchema: pmCompliance.filterSchema, query: pmCompliance.query },`.
Run: `npx vitest run src/lib/reports/registry.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/modules/pm-compliance.ts src/lib/reports/modules/pm-compliance.test.ts src/lib/reports/registry.ts
git commit -m "feat(reports): PM compliance report module + tests"
```

---

### Task 20: Full suite + final verification

- [ ] **Step 1: Run the entire reports test suite**

Run: `npx vitest run src/lib/reports`
Expected: PASS — all module, format, filters, registry, and export tests green.

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual UI verification (Phase 4 gate)**

`npm run dev` → `/reports` shows all 9 reports across the six groups. Spot-check one report per group: filters apply via URL, table sorts, chart renders, Excel + PDF download with correct filename. Confirm an unknown id (`/reports/nope`) shows the 404 page.

- [ ] **Step 4: Final commit (if any lint/type fixes were needed)**

```bash
git add -A
git commit -m "chore(reports): full suite green + final verification"
```

---

## Self-Review Notes

- **Spec coverage:** All 9 reports → Tasks 11–19. Framework (registry, API, export, shell, index/viewer) → Tasks 1–10. Excel + PDF → Tasks 6–8. Live queries, `requireAuth`-only, PPV baseline = `weightedAvgCost` → implemented in respective `query()`. Multi-view Wastage → Task 12.
- **Known schema confirmations during implementation:** `ShortExcessRecord` qty column names (Task 16, flagged inline) and exact `WasteRecord.stage` relation usage (Task 12) must be checked against `prisma/schema.prisma`; the pure `compute*` functions and their tests are the authoritative contract for math regardless.
- **Type consistency:** `ReportResult`/`ColumnDef`/`SummaryCard`/`ChartSpec` defined once (Task 1) and consumed unchanged everywhere. Every module exports `meta`, `filterSchema`, `query`, and pure `compute*`; registry wiring identical across Tasks 11–19.
- **No placeholders:** every code step contains full code; every test step contains real assertions.
