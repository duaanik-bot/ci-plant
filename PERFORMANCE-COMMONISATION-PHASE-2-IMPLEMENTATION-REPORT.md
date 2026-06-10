# Performance Commonisation Phase 2 Implementation Report

Date: 2026-06-10

## Executive summary

Phase 2 focused only on tab-gated loading and modal/on-demand detail loading. The implementation reduces first-render work in Inventory, Production Stage Boards, Billing/New Bill, Plate Hub, Tooling Hub, and Reports while preserving existing workflows and calculations.

Purchase Orders, Job Cards, Cutting Queue, Billing list/detail, and GRN were inspected. Purchase Orders and Job Cards/Cutting Queue were already using the Phase 1 compact/detail pattern. GRN is currently a moved-flow placeholder in this worktree and no longer preloads all inventory/open POs.

No database schema, Prisma migration, permission logic, production calculations, billing GST/tax/rounding, GRN costing, planning reservation, procurement landed cost, or supplier score logic was intentionally changed.

## Files changed

- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/billing/new/page.tsx`
- `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`
- `src/app/(dashboard)/reports/_components/ReportShell.tsx`
- `src/app/api/production/stages/[stageKey]/route.ts`
- `src/app/api/reports/[reportId]/route.ts`
- `src/app/api/plate-hub/dashboard/route.ts`
- `src/app/api/tooling-hub/dashboard/route.ts`
- `src/components/hub/HubPlateDashboard.tsx`
- `src/components/hub/HubToolingKanbanDashboard.tsx`

## Module-wise behavior

### Inventory

Previous loading behavior:

- First render called warehouse rows, stock states, alerts, paper ledger, job cards, and activity log together through the page-level reload path.

New loading behavior:

- First render loads only the visible paper warehouse stock/KPI data.
- Paper ledger loads only when the Reports tab is active.
- Stock-state material choices load only when the stock adjustment drawer is opened.
- Existing material drawer and reservations panel remain modal/on-demand.

APIs used:

- First render: `GET /api/inventory/paper-warehouse`
- Reports tab: `GET /api/inventory/paper-ledger`
- Adjustment drawer: `GET /api/inventory/stock-states`
- Detail panels: existing material drawer/reservation APIs

Fallback behavior:

- The existing `inventory:refresh` event still reloads the visible stock data.

### GRN

Previous loading behavior:

- The audit target was to stop preloading all inventory and all open POs.

Current behavior:

- `src/app/(dashboard)/inventory/grn/page.tsx` is currently a moved-flow placeholder pointing users back to warehouse stock/procurement. It does not preload inventory or open POs.

Change made:

- No code change required in Phase 2 for GRN in the current worktree.

Risk:

- When the full GRN workflow is restored, it should use searchable material/PO lookup and PO-line loading after PO selection.

### Purchase Orders

Previous loading behavior:

- Before Phase 1, first render could load full PO lists and all line items.

Current behavior:

- The page already uses `mode=compact&paged=1&limit=100`.
- Full PO line items and tooling status load only when `drawerPoId` is set.

Change made:

- No additional Phase 2 code change required.

APIs used:

- First render: `GET /api/purchase-orders?mode=compact&paged=1&limit=100`
- Drawer/detail: `GET /api/purchase-orders/[id]`
- Drawer tooling detail: `POST /api/purchase-orders/tooling-line-status`

### Job Cards and Cutting Queue

Previous loading behavior:

- Before Phase 1, Cutting Queue fetched the full job-card universe and filtered client-side.

Current behavior:

- Job Cards page uses compact paged job-card rows.
- Cutting Queue uses `segment=cutting` compact rows.
- Row updates still use existing job-card detail/update routes.

Change made:

- No additional Phase 2 code change required.

APIs used:

- Job Cards: `GET /api/job-cards?mode=compact&paged=1&limit=150&yieldMetrics=1`
- Cutting Queue: `GET /api/job-cards?mode=compact&segment=cutting&limit=200`
- Row actions: existing `GET/PATCH /api/job-cards/[id]`

### Production Stage Boards

Previous loading behavior:

- First render requested a broad stage-board payload and then filtered tabs client-side.

New loading behavior:

- Stage page sends the active tab in the stage API request.
- API filters returned rows by `tab=pending|make_ready|running|hold|completed`.
- API still returns `meta.tabCounts` so tab badges remain meaningful.
- The page requests `mode=compact&limit=150`.

APIs used:

- `GET /api/production/stages/[stageKey]?mode=compact&limit=150&tab=pending`
- Existing detail/action APIs remain unchanged for row actions and spotlight workflows.

Details moved/on-demand:

- Existing spotlight/detail actions still load or mutate heavy row state only on explicit user action.

Risk:

- The stage API still computes the cached full board before filtering returned rows. This phase reduces first-render payload and browser work; deeper query-level lane loading remains Phase 3/targeted API work.

### Billing/New Bill

Previous loading behavior:

- New Bill preloaded a broad job-card list on page mount.

New loading behavior:

- Job cards load only after a customer is selected.
- The lookup is compact, customer-scoped, paged, capped at 50 rows, and can be narrowed by search text.
- Existing prefill from `?jobCardId=` still fetches the chosen job card detail on demand.
- Reconciliation still fetches specific selected job cards after bill save.

APIs used:

- Customer search: `GET /api/customers?q=...`
- Job-card lookup: `GET /api/job-cards?mode=compact&paged=1&limit=50&customerId=...&q=...`
- Job-card prefill/reconciliation: `GET /api/job-cards/[id]`
- Short/excess creation: `POST /api/short-excess`

No calculation drift:

- GST/tax/rounding/discount math was not changed.

### Plate Hub

Previous loading behavior:

- Dashboard first render returned board lanes and master ledger rows together.

New loading behavior:

- Board view requests `GET /api/plate-hub/dashboard?view=board`.
- API returns board lane data with `ledgerRows: []` for board view.
- Switching to table view requests `view=table`, which returns ledger rows.
- Existing modal/action fetches remain explicit user actions.

APIs used:

- First render board: `GET /api/plate-hub/dashboard?view=board`
- Table/ledger: `GET /api/plate-hub/dashboard?view=table`
- Existing action/detail APIs remain unchanged.

Risk:

- Board KPI priority-ledger hint will be zero until table/ledger data is loaded because the ledger payload is intentionally deferred.

### Tooling Hub

Previous loading behavior:

- Dashboard first render returned board zones and ledger rows together.

New loading behavior:

- Board view requests `GET /api/tooling-hub/dashboard?tool=dies|blocks&view=board`.
- API returns board zone data with `ledgerRows: []` for board view.
- Switching to table view requests `view=table`, which returns ledger rows.
- Existing modal/action fetches remain explicit user actions.

APIs used:

- First render board: `GET /api/tooling-hub/dashboard?tool=...&view=board`
- Table/ledger: `GET /api/tooling-hub/dashboard?tool=...&view=table`
- Existing action/detail APIs remain unchanged.

### Reports

Previous loading behavior:

- UI loaded full report rows and chart data together.
- Export used the export endpoint but the UI query still hydrated the full result.

New loading behavior:

- UI requests capped preview rows: `preview=1&limit=100`.
- Chart data is omitted until the Chart tab is selected.
- When Chart is selected, the UI sends `includeChart=1`; chart data is capped to the preview limit.
- Export buttons use the clean filter/view query and continue to call the server-side export endpoint.

APIs used:

- Preview: `GET /api/reports/[reportId]?preview=1&limit=100`
- Chart preview: `GET /api/reports/[reportId]?preview=1&limit=100&includeChart=1`
- Full export: `GET /api/reports/[reportId]/export?format=xlsx|pdf&...`

## Components converted to tab-gated loading

- Inventory page: stock first, Reports tab loads ledger on entry.
- Production stage board: active tab sent to the API.
- Reports shell: table preview first, chart only when selected.
- Plate Hub: board first, ledger/table payload on table view.
- Tooling Hub: board first, ledger/table payload on table view.

## Details moved to modal/on-demand

- Inventory stock-state choices load on adjustment drawer open.
- Inventory material/reservation details remain drawer/panel-triggered.
- Purchase Order full detail/tooling remains drawer-triggered.
- New Bill job-card detail remains selected-job/prefill/reconciliation-triggered.
- Plate/Tooling hub modal/action details remain explicit-action-triggered.
- Reports chart data loads only when the user selects Chart.

## Fallback behavior

- Existing full report behavior remains available when `preview=1` is not supplied.
- Plate Hub and Tooling Hub full ledger behavior remains available with `view=table` or `includeLedger=1`.
- Production stage route still works without `tab`; it returns the existing broad row set subject to Phase 1 paging.
- Existing detail routes and action workflows remain unchanged.

## Risks

| Risk | Level | Mitigation |
|---|---|---|
| Inventory adjustment drawer now loads material choices on open, so the select may briefly be empty. | Low | Drawer fetch is automatic on open. |
| Stage board tab filtering happens after cached full-board computation. | Medium | Browser payload is reduced now; deeper query splitting is left for a safer Phase 3/API pass. |
| Stage tab counts use route metadata and may differ slightly from client-derived progress if local unsaved changes exist. | Low-Medium | Existing refresh/event paths still reload the board. |
| Plate Hub board view defers ledger rows, so ledger-based hint values are unavailable until table view. | Low | Table view loads full ledger rows on demand. |
| Tooling Hub board view defers ledger rows, so table-only summaries are unavailable until table view. | Low | Table view loads full ledger rows on demand. |
| Report preview caps UI rows at 100. | Low | Full export remains server-side through export endpoint. |

## Verification results

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | Passed | `tsc --noEmit` completed successfully after Phase 2 edits. |
| `npx prisma validate` | Passed | Prisma schema is valid. |
| `npx next lint` | Passed with warnings | Existing warning set remains; no new hub hook warnings after dependency fix. |
| `git diff --check` | Passed | No whitespace errors reported. |
| API route import validation | Passed | Imported 356 `src/app/api/**/route.ts` files successfully. |
| `npx next build` | Failed after compile | Direct `npx next build` compiled successfully, then failed during page-data collection with `PageNotFoundError: Cannot find module for page: /dispatch`. `npm run build` was not used because it runs `prisma migrate deploy`. |
| Browser smoke | Could not run | Browser-control tooling was not exposed in this session. No browser smoke across the requested pages could be performed. |

## Browser smoke coverage status

Requested pages were not browser-smoked because browser tooling was unavailable:

- Inventory
- GRN
- Purchase Orders
- Job Cards
- Cutting Queue
- Production Stage Board
- Billing
- New Bill
- Reports
- Plate Hub
- Tooling Hub

## Confirmation checklist

- No calculation drift intentionally introduced.
- No Prisma schema change.
- No database migration run.
- No deployment.
- No commit.
- No permission/auth change.
- No workflow removal.
- No route import failure found.
- Console errors and failed API calls could not be browser-verified because browser smoke was unavailable.

## Remaining Phase 3 commonisation work

- Move Inventory, Stage Board, Plate Hub, and Tooling Hub from response trimming to true lane/query-level APIs.
- Add shared paged table state and pagination controls for compact list contracts.
- Commonise repeated table sort/selection/search utilities.
- Add reusable drawer/detail loader helpers.
- Add report preview metadata to the UI, such as total row count and preview cap messaging.
- Add browser-smoke automation once browser tooling is available.
- Continue module-by-module commonisation without changing business calculations or workflows.
