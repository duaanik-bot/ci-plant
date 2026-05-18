# Reporting Module — Design Spec

**Date:** 2026-05-18
**Status:** Approved (pending written-spec review)
**Scope:** A registry-driven reporting module delivering 9 KPI reports for a pharma folding-carton printing ERP, with interactive viewing plus Excel and PDF export.

## 1. Goals & Decisions

- Deliver **all 9 KPI reports** under a shared reporting framework.
- Each report is **interactive** (filterable table + KPI cards + chart) with **Excel and PDF export**.
- **Live Prisma aggregation queries** — no precompute, no new snapshot tables, no cron.
- Access: **any authenticated user** (`requireAuth()` only — no per-report role gating).
- **PPV baseline = `Inventory.weightedAvgCost`** (moving-average cost; no schema change).
- Architecture: **Approach A — Report Registry + shared engine** (one module file per report; generic API route and page; shared shell + exporters).

### Non-goals (YAGNI)
- No precomputed/warehouse layer.
- No per-report RBAC (open to all logged-in users by decision).
- No chart-in-PDF in v1 (table + KPI cards only; chart image is a later enhancement).
- No new schema/migrations.

## 2. Directory Layout

```
src/lib/reports/
  types.ts                 # ReportModule, ReportResult, FilterValues, ColumnDef
  registry.ts              # REPORTS: Record<reportId, ReportModule>; getReport(id)
  filters.ts               # shared Zod filter primitives (dateRange, machineId, …)
  format.ts                # number/₹/%/date formatters used by table + exports
  modules/
    oee.ts
    yield.ts
    otif.ts
    short-excess.ts
    downtime-pareto.ts
    vendor-quality-ppm.ts
    pm-compliance.ts
    ppv.ts
    wastage.ts
src/lib/reports/export/
  to-xlsx.ts               # ReportResult -> Excel (xlsx)
  to-pdf.tsx               # ReportResult -> PDF (@react-pdf/renderer)
src/app/api/reports/[reportId]/route.ts        # generic dispatcher (GET)
src/app/api/reports/[reportId]/export/route.ts # generic export (GET ?format=xlsx|pdf)
src/app/(dashboard)/reports/page.tsx           # report index (cards grouped by KPI area)
src/app/(dashboard)/reports/[reportId]/page.tsx# generic report viewer
src/app/(dashboard)/reports/_components/       # ReportShell, FilterBar, ReportTable,
                                               # KpiCards, ReportChart, ExportButtons
```

Existing stub pages (`reports/wastage`, `reports/production`, `reports/dashboard`,
`reports/schedule-m`) are removed and replaced by the single `[reportId]` viewer so
there is one code path. `schedule-m` (pharma regulatory register) is out of the
9-KPI scope and not built in this cycle.

## 3. Contracts

```ts
interface ReportModule<F> {
  id: string
  title: string
  group: 'production'|'quality'|'delivery'|'material'|'procurement'|'maintenance'
  kpi: string
  filterSchema: z.ZodType<F>
  query(filters: F): Promise<ReportResult>
}

type ColumnType = 'text'|'num'|'inr'|'pct'|'date'
interface ColumnDef { key: string; label: string; type: ColumnType; align?: 'left'|'right'; total?: boolean }

interface ReportResult {
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
  summary: { label: string; value: string; tone?: 'good'|'bad'|'neutral' }[]
  chart?: { kind: 'bar'|'line'|'stacked'|'pareto'; x: string; series: string[]; data: any[] }
  views?: { id: string; label: string }[]   // multi-view reports (Wastage); when present,
                                             // query receives the active view id in filters
  meta: { generatedAt: string; filtersApplied: Record<string,string> }
}
```

Every report returns this single shape, so table, KPI cards, chart, Excel and PDF
are written once and work for all reports.

## 4. Data Flow

1. Page `/reports/[reportId]` (server) resolves module from registry; unknown id → `notFound()`. Renders `<ReportShell module={meta}>`.
2. FilterBar state lives in URL query params (shareable, back-safe).
3. TanStack Query fetches `GET /api/reports/[reportId]?<filters>`.
4. API route: `requireAuth()` → `getReport(id)` (404 if unknown) → `filterSchema.parse(searchParams)` (400 on bad input) → `module.query(filters)` → `NextResponse.json(result)`. `export const dynamic = 'force-dynamic'`.
5. Export route `GET /api/reports/[reportId]/export?format=xlsx|pdf&<filters>` runs the **same** auth→getReport→parse→query path, then pipes through `to-xlsx`/`to-pdf` and returns a file download. Report and export can never diverge.
6. Errors → sonner toast + inline error/empty state in the shell.

## 5. Report Specs

Common filters: `from`/`to` date range (default current month) + report-specific
dimensions. Money ₹, qty integer, % to 2 dp. Divide-by-zero guarded everywhere.

### 1. OEE — group: production
- Source: `ProductionOeeLedger` + `Machine` + attributed operator. Filters: date, machineId, operatorId.
- Columns: date, machine, operator, shiftMin, runMin, availability%, performance%, quality%, **OEE%**, goodPieces, totalPieces, yield%.
- KPI: avg OEE% (target ≥85), avg A/P/Q, # jobs below target.
- Chart: bar — OEE% by machine (target line 85).

### 2. Yield — group: production
- Source: `ProductionOeeLedger` (`yieldPercent`, `goodPieces`, `totalPieces`); cross-ref `SheetIssueRecord`.
- Columns: jobCard, machine, operator, totalPieces, goodPieces, **yield%**, incentiveEligible.
- KPI: avg yield% (target ≥96), # incentive-eligible, worst-yield job.
- Chart: line — yield% trend by day.

### 3. OTIF — group: delivery
- Source: `Dispatch` + `PoLineItem` (`poQtySnapshot`, `tolerancePctSnapshot`, `allowedQty`; due date via `po`/`job`). On-time = `dispatchedAt ≤ dueDate`; in-full = `qtyDispatched` within tolerance of PO qty.
- Columns: PO, customer, carton, poQty, dispatchedQty, dueDate, dispatchedAt, onTime?, inFull?, **OTIF?**.
- KPI: **OTIF%**, On-Time%, In-Full%, # late, # short.
- Chart: bar — OTIF% by customer.

### 4. Short & Excess — group: delivery
- Source: `ShortExcessRecord` + `Dispatch.excessQty` + `PoLineItem.tolerancePct`.
- Columns: PO, customer, carton, poQty, deliveredQty, short/excess qty, variance%, withinTolerance?.
- KPI: total short, total excess, # outside tolerance, S&E value ₹.
- Chart: bar — short vs excess by customer.

### 5. Downtime Pareto — group: production
- Source: `ProductionDowntimeLog` + `Machine`. Filters: date, machineId.
- Columns: reason, occurrences, totalDowntimeMin, % of total, cumulative %.
- KPI: total downtime, top reason, planned vs unplanned ratio.
- Chart: pareto (bar desc + cumulative line).

### 6. Vendor Quality PPM — group: procurement
- Source: `VendorMaterialReceipt` (received vs rejected) + `VendorQualityDebitNote` (value). Filters: date, vendor.
- Columns: vendor, receipts, qtyReceived, qtyRejected, **reject PPM**, debitNote ₹.
- KPI: overall PPM, worst vendor, total debit-note ₹.
- Chart: bar — PPM by vendor.

### 7. PM Compliance — group: maintenance
- Source: `MachinePmSchedule` vs `PreventiveMaintenanceLog`; `PmPlannedDowntime`. Filters: date, machineId.
- Columns: machine, scheduledPMs, completedPMs, onTimePMs, **compliance%**, overdue count.
- KPI: plant PM compliance% (target ≥95), # overdue, planned vs unplanned downtime ratio.
- Chart: bar — compliance% by machine.

### 8. Purchase Price Variance (PPV) — group: procurement
- Source: `VendorMaterialPurchaseOrderLine` (`ratePerKg`, `landedRatePerKg`, `freightTotalInr`, `unloadingChargesInr`, `insuranceMiscInr`, `totalWeightKg`) vs **`Inventory.weightedAvgCost`** matched by board grade + GSM. Filters: date, vendor, boardGrade.
- Columns: vendor, boardGrade, GSM, qtyKg, stdRate, basicRate, landedRate, **basic PPV ₹**, **landed PPV ₹**, priceVar, freightVar, unloadingVar, insuranceVar.
- KPI: total PPV ₹ (fav/adv), PPV % of spend, worst vendor, # lines outside tolerance band.
- Chart: stacked bar — PPV components by board grade.
- Edge: no matching `weightedAvgCost` → row flagged `no baseline`, excluded from variance totals (not silently zeroed).

### 9. Wastage — Stage-wise & Overall — group: material
- Source: `WasteRecord` (`wasteType`, `stageId`→`JobStage`, `materialId`, `machineId`, qty) valued at `Inventory.weightedAvgCost`; reconciled vs `MaterialWeightReconciliation` and `ProductionOeeLedger.yieldPercent`. Filters: date, machineId, stage, customer.
- **View A (matrix):** rows = stage; columns = makeready / run_waste / substrate_trim; cells = qty, %, ₹.
- **View B (overall rollup):** total input → good output → waste%, three-way reconciliation (WasteRecord vs WeightRecon vs Yield) with discrepancy flag for hidden/unrecorded waste.
- KPI: overall waste%, worst stage, makeready:run ratio, total waste ₹.
- Chart: stacked bar — waste qty by stage × type.
- This is the only report using `views[]`; `<ReportShell>` renders a tab switch.

## 6. UI Shell

**Index `/reports`:** cards grouped by KPI area, driven by iterating `REPORTS`; new modules appear automatically. Card = title + KPI line + Open.

**Viewer `/reports/[reportId]`:** server resolves module (404 → `notFound()`), renders `<ReportShell>`. Client below, state in URL params.

- **FilterBar** — date-range picker always present (default current month) + dimension dropdowns only for filters the module declares. Apply → URL → refetch. Reset → defaults.
- **KpiCards** — `result.summary[]` with tone colour (`good`/`bad`/`neutral` → `--success`/`--danger`/muted).
- **ReportChart** — recharts; `bar`|`line`|`stacked`|`pareto`. Hidden if no chart.
- **ReportTable** — TanStack Table: sortable, sticky header, right-aligned numerics, totals row from `column.total`, type-aware formatting (`inr`→₹+thousands, `pct`→`xx.xx%`, `date`→`dd-MMM-yy`). Uses `enterprise-table-styles`.
- **ExportButtons** — Excel/PDF → export route with current filters; loading + sonner toast.
- **States** — loading skeleton, empty ("No data for selected filters"), error (message + Retry).
- **Views tab** — rendered only when module declares `views[]` (Wastage only).

## 7. Export

**Excel (`to-xlsx.ts`, `xlsx`):** Sheet "Report": title, applied-filters, generatedAt; header from `columns.label`; data rows type-formatted (numerics stay numeric for Excel math); bold totals row. Multi-view → one sheet per view. Filename `<reportId>_<from>_<to>.xlsx`.

**PDF (`to-pdf.tsx`, `@react-pdf/renderer`):** A4 landscape, company header (reuse `company-config`), title, filter summary, KPI strip, auto-paginated table with repeating header. No chart in v1. Filename matches Excel.

Both behind `GET /api/reports/[reportId]/export?format=xlsx|pdf` reusing the JSON route's auth→getReport→parse→query path.

## 8. Error Handling

- Unknown `reportId` → 404 (API) / `notFound()` (page).
- Invalid filters → Zod fails → 400 with field messages; FilterBar inline validation, no fetch fired.
- `query()` throws → 500 generic message to client, real error logged server-side; UI error state + Retry. No partial data rendered.
- Empty result → 200 `rows: []` → explicit empty state, export disabled.
- Money/divide-by-zero guards in every module (OTIF with 0 dispatches; PPV with no baseline → flagged & excluded, not zeroed).

## 9. Testing (Vitest)

- **Per-module unit tests** (9 files): `query()` vs seeded fixtures with known inputs → assert columns, row math, summary KPIs, edge cases (zero qty, missing baseline, out-of-tolerance). Correctness lives here.
- **Filter schema tests:** valid/invalid param coercion per module.
- **Export tests:** `to-xlsx`/`to-pdf` produce non-empty output for a sample `ReportResult` covering all column types + multi-view.
- **Registry test:** unique ids, valid group, parseable schema for every module.
- **API route:** one integration test — auth, 404, 400, happy path.

## 10. Build Phasing (internal; all 9 delivered)

1. **Framework:** types, registry, filters, format, API routes, ReportShell + components, exporters, index page.
2. **Batch 1:** PPV + Wastage (priority; proves framework end-to-end incl. multi-view).
3. **Batch 2:** OEE, Yield, OTIF, Short & Excess.
4. **Batch 3:** Downtime Pareto, Vendor Quality PPM, PM Compliance.
