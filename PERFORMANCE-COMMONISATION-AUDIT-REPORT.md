# Performance Commonisation Audit Report

Date: 2026-06-10

## Executive summary

This audit found the highest loading and commonisation risk in list-heavy operational modules: Purchase Orders, Planning, Inventory/Paper Warehouse, Production Job Cards, Production Stages, Procurement, Designing/AW Queue, Plate Hub, Tooling Hub, GRN, Billing, and Reports.

The dominant pattern is not one bad component. It is repeated broad first-render loading: full lists, nested relations, client-side search/sort/filter, and detail data being included before the user asks for it. Several pages also maintain their own raw table markup, local sort headers, checkbox selection, action cells, and modal/detail loading patterns even though shared table shells and some DataTable components already exist.

No code or business logic was changed by this audit. The safe path is incremental: first add pagination/limit contracts and compact endpoints, then move duplicate table/filter/detail patterns behind existing shared components, and only then consider larger commonisation.

## Slowest or most likely slow pages/modules

| Risk | Module/page | Why likely slow | Exact files |
|---|---|---|---|
| Critical | Inventory/Paper Warehouse | First render loads stock states, alerts, paper ledger, full paper warehouse, all job cards, activity log, and then tab components can load open PO/incoming data again. | `src/app/(dashboard)/inventory/page.tsx`, `src/app/api/inventory/paper-warehouse/route.ts`, `src/app/api/inventory/stock-states/route.ts`, `src/app/api/job-cards/route.ts` |
| Critical | Purchase Orders | `/api/purchase-orders` returns all matching POs with all line items and readiness/tooling calculations; page table filters locally and opens detail drawers. | `src/app/(dashboard)/orders/purchase-orders/page.tsx`, `src/app/api/purchase-orders/route.ts` |
| Critical | Job Cards and Cutting Queue | `/api/job-cards` returns all job cards with nested stages and PO-line enrichment; cutting queue fetches the full job-card list then filters to cutting rows in the browser. | `src/app/(dashboard)/production/job-cards/page.tsx`, `src/app/(dashboard)/production/cutting-queue/page.tsx`, `src/app/api/job-cards/route.ts` |
| Critical | Production Stage Boards | Stage route loads stage records with nested job cards/stages, then loads PO lines, PM health, OEE ledger, downtime, issued kg, and yield data. No page limit. | `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`, `src/app/api/production/stages/[stageKey]/route.ts` |
| High | Procurement workbench | High fetch count page and heavy material-requirements route aggregates suppliers, vitals, vendor POs, material queue rows, lead buffers, vendor scores, cash rows, policies, and physical stock. | `src/app/(dashboard)/orders/procurement/page.tsx`, `src/app/api/procurement/material-requirements/route.ts` |
| High | Designing/AW Queue | Large client page with grouped raw table, image preview cells, drawers, multiple actions, local grouping/filtering, and many fetch actions. | `src/app/(dashboard)/orders/designing/page.tsx`, `src/app/api/designing/po-lines/route.ts` |
| High | Plate Hub / Tooling Hub | Dashboard endpoints return multi-lane payloads in one request; large components render dashboards, ledgers, modals, exports, and searches together. | `src/components/hub/HubPlateDashboard.tsx`, `src/app/api/plate-hub/dashboard/route.ts`, `src/components/hub/HubToolingKanbanDashboard.tsx`, `src/app/api/tooling-hub/dashboard/route.ts` |
| High | GRN | First render preloads all inventory, suppliers, and all open POs before the user chooses a PO/material. | `src/app/(dashboard)/inventory/grn/page.tsx`, `src/app/api/inventory/route.ts`, `src/app/api/inventory/paper-warehouse/open-pos/route.ts` |
| High | Billing/New Bill | New bill loads all job cards and then customer carton catalogue with `limit=4000`; bill detail fetches all short/excess records plus job-card detail per line. | `src/app/(dashboard)/billing/new/page.tsx`, `src/app/(dashboard)/billing/[id]/page.tsx`, `src/app/api/bills/route.ts`, `src/app/api/short-excess/route.ts` |
| Medium | Reports | Report UI fetches report data into the browser and export triggers full export endpoints; needs row caps/streaming for larger reports. | `src/app/(dashboard)/reports/_components/ReportShell.tsx`, `src/app/api/reports/[reportId]/route.ts`, `src/app/api/reports/[reportId]/export/route.ts`, `src/lib/reports/modules/*` |

## Heavy table inventory

| Table/page | Current loading pattern | Recommendation | Risk |
|---|---|---|---|
| Purchase Orders table | `fetch('/api/purchase-orders')`; API includes `lineItems: true`, customer, tooling/readiness. | Add server-side `page`, `limit`, `status`, `q`; list response should include summary counts and line preview only. Detail drawer fetches full PO on demand. | Medium |
| Inventory Stock table | Full paper warehouse rows plus KPI enrichment on first inventory load. | Default to compact row endpoint, separate KPI endpoint, and tab-gated ledger/open PO/incoming loading. | Medium |
| Job Cards table | `/api/job-cards?yieldMetrics=1` returns full list and yield work for every row. | Add `page`, `limit`, `segment`, `q`, optional `yieldMetrics=summary`; compute detailed yield in drawer/on demand. | Medium |
| Production Stage table | Stage route returns whole stage board and enriched OEE/yield data. | Add `limit`, `cursor/page`, `lane/status`, and defer OEE/yield detail to expanded row or active row. | High |
| Designing/AW table | Client groups and renders `sortedVisualRows` with raw table and action cells. | Keep UI unchanged but move table state helpers and sort/filter/group helpers to shared functions; add server `limit` and search. | Medium |
| GRN PO picker and GRN lines | Preloads full inventory and all open POs; local filtering. | Use material search endpoint by default; open PO picker should request paged open POs after user opens picker. | Low-Medium |
| Billing list/new bill | New bill all job cards + carton `limit=4000`; bill list all bill line items. | Replace all job cards with customer/job-card search; clamp carton catalog to visible/search mode. | Medium |
| Plate/Tooling inventory ledgers | Multiple custom ledger tables over large in-memory arrays. | Add lane-specific APIs and shared enterprise table adapter for selection/search/export. | Medium-High |
| Reports table | UI receives report result rows and renders/sorts client-side. | Add report row cap for UI; exports should stream/generate server-side without UI hydration. | Low-Medium |

## Raw table duplication inventory

Shared table approaches already exist:

- `src/components/shared/DataTable.tsx`
- `src/components/design-system/DataTable.tsx`
- `src/components/ui/EnterpriseTableShell.tsx`
- `src/app/(dashboard)/reports/_components/ReportTable.tsx`

High-value duplicated raw table areas:

- Purchase order table: `src/app/(dashboard)/orders/purchase-orders/page.tsx`
- Designing/AW queue table: `src/app/(dashboard)/orders/designing/page.tsx`
- Inventory stock/open PO/incoming/GRN tables: `src/app/(dashboard)/inventory/page.tsx`, `src/app/(dashboard)/inventory/components/StockTab.tsx`, `OpenPosTab.tsx`, `IncomingTab.tsx`, `src/app/(dashboard)/inventory/grn/page.tsx`
- Production job cards, cutting queue, machine flow, stage board: `src/app/(dashboard)/production/job-cards/page.tsx`, `cutting-queue/page.tsx`, `machine-flow/page.tsx`, `stages/[stageKey]/page.tsx`
- Hub ledgers: `src/components/hub/HubInventoryShell.tsx`, `HubPlateDashboard.tsx`, `ToolingHubLedgerTable.tsx`, `MasterLedgerTable.tsx`
- Billing tables: `src/app/(dashboard)/billing/page.tsx`, `billing/[id]/page.tsx`, `billing/new/page.tsx`
- Smaller master/detail tables: dies, emboss blocks, operators, FG warehouse, detail pages.

Safe commonisation target is not a universal table rewrite. The safer target is a shared table-state and row-shell pattern:

- shared sort header
- selectable row state
- empty/loading rows
- sticky table frame
- row action slot
- server-page metadata and pagination controls
- debounced search param hook

## API payload and loading issues

| API route | Issue | Recommended change | Expected gain |
|---|---|---|---|
| `src/app/api/job-cards/route.ts` | `findMany` has no `take/skip`; includes nested stages; separate enrichment queries; optional yield metrics computed per row. | Add paged list contract and compact card DTO; detail route remains full. | High for job cards/cutting/billing/inventory. |
| `src/app/api/purchase-orders/route.ts` | Returns all matching POs with all `lineItems`; readiness/tooling calculated for all rows. | Add paginated list DTO with line counts/preview; fetch full line items in drawer/detail. | High for PO dashboard. |
| `src/app/api/inventory/paper-warehouse/route.ts` | Always reads all board inventory first; non-compact mode also reads open PO links and PRs, then computes KPIs over all rows. | Split list, KPI, and detail endpoints; default list should be paginated/filtered. | High for inventory/planning. |
| `src/app/api/planning/po-lines/route.ts` | Improved already, but still loads support tables: machines, inventory, paper warehouse, FG rows. | Continue compact list work; move support indexes to cached summaries. | Medium-High. |
| `src/app/api/production/stages/[stageKey]/route.ts` | Full stage board plus nested job cards/stages, PO line metadata, OEE/yield/PM enrichments. | Add `limit`, active status filter, and detail-on-demand enrichments. | High on busy production floors. |
| `src/app/api/inventory/paper-warehouse/open-pos/route.ts` | Returns every open vendor PO with lines and linked material summaries. | Add `limit`, `q`, `status`, `overdue`, `materialId`; detail route already exists. | Medium-High for GRN/inventory. |
| `src/app/api/bills/route.ts` | All bills with all line items for list page. | Add pagination and a list DTO without all line-item detail by default. | Medium. |
| `src/app/api/short-excess/route.ts` | `status=all` can return all records; bill detail uses it globally. | Add bill/job/po-line filters and limit; bill detail should request only relevant records. | Medium. |
| `src/app/api/plate-hub/dashboard/route.ts` | Single payload for triage, CTP, vendor, inventory, custody; no limit. | Lane-gated or lane-specific endpoint; dashboard loads active lane first. | Medium-High. |
| `src/app/api/procurement/material-requirements/route.ts` | Aggregation endpoint joins many domains for the full workbench. | Add compact workbench summary + detail drilldowns; cache slow indexes. | High. |
| `src/app/api/reports/[reportId]/route.ts` | Report data is loaded into UI; export has separate endpoint but same modules may compute full datasets. | UI row cap and server-side export generation/streaming. | Medium. |

## Widget loading issues

- Inventory page loads all widgets and tabs through `reloadAll` even when the user is on one warehouse tab.
- Purchase Orders loads executive metrics and the full table concurrently; metrics should remain separate but table should be compact.
- Machine Flow refreshes every 30 seconds, which is valid for a live board, but PM spotlight/detail data should stay modal-on-demand.
- Plate Hub and Tooling Hub dashboard components load lane data, ledgers, search support, export context, and modal state in large components.
- Reports load chart/table data together. Heavy chart data should be optional per view or summarized for first render.

## Duplicated filter/search/sort logic

Repeated local patterns found:

- Debounced text search in purchase orders, inventory, designing, GRN, planning, hub search bars.
- Sort header components reimplemented in stock, PO, planning/designing, production, reports.
- `filtered = useMemo(... rows.filter(...).sort(...))` patterns across inventory, job cards, purchase orders, GRN, masters, hubs.
- Checkbox selection and bulk action logic repeated in PO, AW queue, inventory stock, hub ledgers, job cards.
- Modal/detail loading repeated as local `selectedId`, `details`, `detailsLoading` state in incoming/open PO, inventory material drawer, planning drawer, hub audit modals.

Recommended shared pattern: a small shared list-state helper/hook and table-state utilities, not a new visual framework. Use existing `EnterpriseTableShell`/DataTable wrappers where possible.

## Recommended loading patterns

| Pattern | Apply to |
|---|---|
| Server-side pagination + limit clamping | Purchase Orders, Job Cards, Bills, Short/Excess, Open POs, Stage boards, Plate/Tooling ledgers, master lists that can grow. |
| Compact list DTO | Purchase Orders, Job Cards, Paper Warehouse, Production Stages, Plate Hub, Tooling Hub. |
| Tab-gated loading | Inventory stock/open POs/incoming/reports; procurement tabs/cards; plate/tooling lane boards. |
| Modal-on-demand detail | PO line details, bill line details, material logs/reservations/shortages, vendor PO logs, OEE/yield drilldown, plate/tooling audit logs. |
| Lazy chart/card widgets | Report charts, executive metrics beyond first KPI strip, production OEE widgets, dashboard alert panels. |
| Export server-side only | Reports, job-card reconciliation export, shade-card export, PO/PDF exports, warehouse reports. |

## Reports/PDF/export findings

- `src/app/(dashboard)/reports/_components/ReportShell.tsx` fetches full report data to the UI; keep UI result capped and use export endpoints for full datasets.
- `src/app/(dashboard)/reports/_components/ExportButtons.tsx` correctly downloads blobs, but export routes should stream or generate server-side and avoid requiring prior UI hydration.
- `src/app/api/job-cards/reconciliation-export/route.ts`, `src/app/api/reports/[reportId]/export/route.ts`, `src/app/api/hub/shade-card-hub/export/route.ts`, PO PDFs, and job-card PDFs should keep export-specific heavy work off list pages.

## Commonisation opportunities

| Opportunity | Files/modules | Safe? | Risk |
|---|---|---|---|
| Shared paged-list API params: `page`, `limit`, `q`, `sort`, clamping, metadata. | Existing `src/lib/api-list-params.ts`, list routes. | Yes, if response shape is versioned or backwards-compatible. | Low-Medium |
| Shared table state utilities: sort cycle, selection set, visible row selection, empty/loading rows. | PO, AW, inventory, production, hubs. | Yes, helper-only first. | Low |
| Shared `EnterpriseTable` adapter around existing `EnterpriseTableShell`. | Raw tables listed above. | Yes if opt-in per table. | Medium |
| Shared search debounce and URL sync hook. | PO, inventory, GRN, designing, planning, reports. | Yes. | Low |
| Shared detail drawer loader pattern. | Inventory material, vendor PO logs, PO drawer, hub audit, planning detail. | Yes if it only standardizes state/loading/errors. | Low-Medium |
| Compact list/detail route split. | PO, job cards, inventory, stage boards, hubs. | Yes, but requires caller-by-caller rollout. | Medium |
| Shared export contract. | Reports, hub exports, reconciliation exports. | Yes; avoid changing calculations. | Low-Medium |

## Priority order

### Phase 1: low-risk measurement and payload clamps

1. Add/request slow API logging and row-count logging to `job-cards`, `purchase-orders`, `paper-warehouse`, `open-pos`, `production/stages`, `material-requirements`, `bills`, and report routes.
2. Add `limit`/`page` parsing helpers using existing `src/lib/api-list-params.ts`.
3. Add non-breaking compact modes to `job-cards`, `purchase-orders`, `bills`, `open-pos`, and `short-excess`.
4. Change the heaviest callers to ask for compact first render only.

Expected gain: 20-50% faster first data availability on heavy pages; lower DB and JSON payload pressure.

### Phase 2: tab-gated and modal-on-demand loading

1. Inventory: load only active tab data; move job-card picker to search; split paper warehouse KPI/list/detail.
2. GRN: do not preload all inventory; use `/api/inventory/material-search` and open-PO search.
3. Billing: remove all job-card load from new bill; use customer/job-card lookup and relevant reconciliation filters.
4. Production: cutting queue and stage boards should request stage-specific compact rows instead of all job cards.
5. Plate/tooling hubs: lane-specific loading for initial view; audit/event logs on demand.

Expected gain: 40-70% less first-render payload on Inventory, GRN, Billing, and Production queues.

### Phase 3: table/commonisation rollout

1. Introduce shared table-state utilities without changing visuals.
2. Migrate repeated sort header and selection logic in PO, AW, Inventory, Production Job Cards, and HubInventoryShell.
3. Migrate small/simple masters to one consistent DataTable pattern only after large-list endpoints are paged.
4. Keep complex operational tables visually intact; commonise behavior first.

Expected gain: mostly maintainability, with 10-25% render improvement where memoized table state avoids repeated expensive filters/sorts.

## Risk level for proposed changes

- Low: logging, API limit clamps with existing defaults preserved, shared formatting/table-state helpers, export row caps with explicit export route.
- Medium: changing default list endpoints to paginated responses; mitigate with `?mode=compact` or `?paged=1` before replacing old contracts.
- Medium-High: production stage board compacting, because stage gating and OEE/yield calculations are business-visible.
- High: any refactor touching material reservation, PO readiness, yield/OEE, GRN quantity allocation, billing tax/rounding, short/excess tolerance, or procurement landed-cost/payment logic. These should be tested before and after with known fixtures.

## Do-not-touch areas until covered by tests

- Billing tax, rounding, GST split, discount, HSN/UOM behavior.
- Short/excess tolerance calculations and approval workflow.
- GRN accepted/rejected/penalty quantity math and material costing.
- Planning reservation/release/reversal and material shortage generation.
- Production OEE/yield calculations and stage completion counters.
- Procurement landed cost, cash-flow terms, supplier score, reorder radar, short-close authority.
- Existing permissions/auth checks and route access rules.
- Prisma schema/database migrations.

## Exact files/components/API routes needing work

Priority list:

- `src/app/api/job-cards/route.ts`
- `src/app/api/purchase-orders/route.ts`
- `src/app/api/inventory/paper-warehouse/route.ts`
- `src/app/api/inventory/paper-warehouse/open-pos/route.ts`
- `src/app/api/production/stages/[stageKey]/route.ts`
- `src/app/api/procurement/material-requirements/route.ts`
- `src/app/api/bills/route.ts`
- `src/app/api/short-excess/route.ts`
- `src/app/api/plate-hub/dashboard/route.ts`
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/inventory/grn/page.tsx`
- `src/app/(dashboard)/orders/purchase-orders/page.tsx`
- `src/app/(dashboard)/orders/designing/page.tsx`
- `src/app/(dashboard)/production/job-cards/page.tsx`
- `src/app/(dashboard)/production/cutting-queue/page.tsx`
- `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`
- `src/app/(dashboard)/billing/new/page.tsx`
- `src/app/(dashboard)/billing/[id]/page.tsx`
- `src/components/hub/HubPlateDashboard.tsx`
- `src/components/hub/HubToolingKanbanDashboard.tsx`
- `src/components/hub/HubInventoryShell.tsx`
- `src/components/hub/ToolingHubLedgerTable.tsx`
- `src/components/hub/MasterLedgerTable.tsx`
- `src/components/shared/DataTable.tsx`
- `src/components/design-system/DataTable.tsx`
- `src/components/ui/EnterpriseTableShell.tsx`
- `src/components/ui/Pagination.tsx`
- `src/app/(dashboard)/reports/_components/*`
- `src/lib/reports/modules/*`

## Verification run

Commands run:

- `npm run typecheck` - passed.
- `npx prisma validate` - passed.
- `npx next lint` - completed with existing warnings; no blocking lint errors.
- `git diff --check` - passed.
- Backend API route import validation - passed for 352 route files.
- `npx next build` - compiled successfully, then failed during page data collection with `Cannot find module './undefined'` from `.next/server/webpack-runtime.js` / `_document.js` require stack. This appears build/runtime manifest related and was not caused by this audit report.
- Browser smoke - could not be run because browser-control tooling was not exposed in this session.

Important: `npm run build` was intentionally not used because the package build script runs `prisma migrate deploy`; this audit must not deploy or mutate the database.

## Verification plan for implementation

Before implementation:

1. Capture baseline network timings and payload sizes for PO list, inventory page, job cards, cutting queue, stage board, GRN, new bill, reports.
2. Add server logs for elapsed time, row count, payload mode, and limit.
3. Create fixture checks for billing, GRN, reservations, OEE/yield, procurement landed cost, and short/excess math.

After each phase:

1. `npm run typecheck`
2. `npx prisma validate`
3. `npx next lint`
4. Route import validation
5. Targeted Vitest suites for touched modules
6. `npx next build`
7. Browser smoke for:
   - `/orders/purchase-orders`
   - `/orders/designing`
   - `/orders/planning`
   - `/inventory`
   - `/inventory/grn`
   - `/production/job-cards`
   - `/production/cutting-queue`
   - `/production/stages/cutting`
   - `/billing`
   - `/billing/new`
   - `/reports`

Smoke scenarios should check first render, search/filter, sort, row click, detail drawer/modal open, pagination, export button presence, and no calculation drift.

## Final implementation action plan after approval

1. Phase 1 PR: add list param helpers/logging and compact response modes without changing default UI behavior.
2. Phase 1.5 PR: change only selected first-render callers to compact modes with fallback to old response shape.
3. Phase 2 PRs by module: Inventory, PO, Job Cards/Production, Billing/GRN, Hubs, Reports.
4. Phase 3 PR: shared table-state utilities and table-shell adapters, one table family at a time.
5. Keep every phase reversible and contract-compatible. Do not change calculations, schema, permissions, or workflow labels without explicit approval and tests.

No deployment, commit, or major refactor was performed.
