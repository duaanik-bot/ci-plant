# Performance Commonisation Final Hardening Report

Date: 2026-06-10

## Executive summary

The post Phase 1-3 hardening pass re-audited the changed operational modules, checked first-render loading paths, verified route/API constraints, and fixed only safe leftover issues. The software is cleaner and safer for manual QA: the main heavy list paths now use compact/paged contracts, detail data is more often gated behind row/drawer/tab actions, and common table-state behavior is shared instead of duplicated.

This branch is ready for manual QA, but not staging-deploy-ready yet because direct `npx next build` still fails after successful compilation during Next page-data/manifest collection.

No deployment, commit, Prisma migration, schema change, auth/permission change, or business calculation change was performed.

## Final files changed in hardening

Hardening-specific fixes:

- `src/app/(dashboard)/stores/issue/page.tsx`
- `src/app/(dashboard)/production/job-cards/new/page.tsx`

Phase 1-3 files re-verified in this pass:

- `src/lib/api-list-params.ts`
- `src/lib/table-state.tsx`
- `src/app/api/job-cards/route.ts`
- `src/app/api/purchase-orders/route.ts`
- `src/app/api/inventory/paper-warehouse/route.ts`
- `src/app/api/inventory/paper-warehouse/open-pos/route.ts`
- `src/app/api/bills/route.ts`
- `src/app/api/short-excess/route.ts`
- `src/app/api/production/stages/[stageKey]/route.ts`
- `src/app/api/reports/[reportId]/route.ts`
- `src/app/api/plate-hub/dashboard/route.ts`
- `src/app/api/tooling-hub/dashboard/route.ts`
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/orders/purchase-orders/page.tsx`
- `src/app/(dashboard)/production/job-cards/page.tsx`
- `src/app/(dashboard)/production/job-cards/new/page.tsx`
- `src/app/(dashboard)/production/cutting-queue/page.tsx`
- `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`
- `src/app/(dashboard)/billing/page.tsx`
- `src/app/(dashboard)/billing/new/page.tsx`
- `src/app/(dashboard)/billing/[id]/page.tsx`
- `src/app/(dashboard)/reports/_components/ReportShell.tsx`
- `src/app/(dashboard)/reports/_components/ReportTable.tsx`
- `src/components/hub/HubPlateDashboard.tsx`
- `src/components/hub/HubToolingKanbanDashboard.tsx`

## Issues fixed in hardening

| Area | Issue | Fix |
|---|---|---|
| Stores Issue | Job-card auto-complete fetched `/api/job-cards` without compact/query/limit. | Switched to `mode=compact&paged=1&limit=50`, with `q` when search text is present. |
| Stores Issue | Job-card number lookup used a broad query param that was not part of the compact Phase 1 contract. | Switched lookup to compact `q=<jobNumber>&limit=5`. |
| New Job Card | PO auto-complete fetched all purchase orders. | Switched to `GET /api/purchase-orders?paged=1&limit=50&q=...`. |
| New Job Card | First render fetched all purchase orders. | Switched to `GET /api/purchase-orders?paged=1&limit=100`, preserving full line-item shape needed by the form. |

## Module re-audit summary

| Module | First-render behavior after hardening | Remaining concern |
|---|---|---|
| Dashboard | Not directly changed in this pass. | Browser smoke unavailable, so console/API status could not be verified. |
| Inventory | Loads visible paper warehouse first; ledger and stock-state support are gated. | Paper warehouse API still builds an in-memory mapped list before slicing; query-level pagination remains future work. |
| GRN | Current page is a moved-flow placeholder and does not preload broad inventory/open PO data. | Restored GRN workflow should use searchable material/PO lookup. |
| Purchase Orders | Compact paged first render, full PO/tooling in drawer. | Metrics endpoint still loads alongside the list; acceptable but can be cached later. |
| Designing/AW Queue | Main queue uses `/api/designing/po-lines`; row pushes are action-triggered. | Still a complex custom table and should remain custom until a dedicated migration/test pass. |
| Planning | Uses `limit` on `/api/planning/po-lines`; detail loads on row/drawer actions. | Planning calculations were left untouched. |
| Job Cards | Compact paged first render. New Job Card PO lookup is now capped. | Job-card detail page intentionally loads several detail endpoints. |
| Cutting Queue | Uses `mode=compact&segment=cutting&limit=200`. | Users/machines still load with queue because they are needed for visible assignment controls. |
| Production Stage Boards | Active tab rows requested with compact mode and limit; tab counts returned in metadata. | API still computes cached full board before response slicing. |
| Billing | Bill list uses compact paged loading; queue is separate and refreshed. | Billing queue polling remains every 30s by design. |
| New Bill | Job cards load only after customer selection; selected job-card detail loads on demand. | Customer carton catalog still uses `limit=4000`; this preserves current line-entry UX but is the main remaining payload risk. |
| Reports | UI loads capped preview rows; chart payload loads only when Chart is selected; export stays server-side. | Report query still computes full result before preview slicing. |
| Plate Hub | Board view defers ledger rows; table view loads ledger rows. | Dashboard API still queries all lanes internally. |
| Tooling Hub | Board view defers ledger rows; table view loads ledger rows. | Dashboard API still queries all zones internally. |

## Measurement notes

Browser/network tooling was unavailable, so exact runtime payload bytes and console/API smoke could not be captured. Static/request-level measurement from code inspection shows:

- Purchase Orders first-render list is capped at 100 compact rows.
- Job Cards first-render list is capped at 150 compact rows.
- Cutting Queue is capped at 200 cutting-segment compact rows.
- Bills list is capped at 100 compact rows.
- Short/Excess list is capped and bill/job/PO-line filterable.
- Reports UI preview is capped at 100 rows; export remains full server-side.
- New Bill job-card lookup is capped at 50 rows after customer selection.
- New Job Card PO lookup is capped at 50 search rows and 100 first-load rows.
- Stores Issue job-card lookup is capped at 50 search rows and 5 exact-number rows.

## API calls reduced

- Inventory first render no longer bundles stock states, alerts, paper ledger, job cards, and activity log with the stock list.
- New Bill no longer preloads a broad job-card universe.
- Plate Hub and Tooling Hub no longer ship ledger rows in board-view first payloads.
- Reports no longer ships chart data until selected.
- Stores Issue no longer fetches the broad job-card list for auto-complete.
- New Job Card no longer fetches the broad PO list for auto-complete or first load.

## Payload reduction notes

- Heavy operational lists now have explicit `limit` defaults and compact modes.
- Full nested detail remains available through detail routes, drawers, row actions, table view, or export endpoints.
- The biggest remaining payloads are compute-before-slice APIs: Paper Warehouse, Reports, Production Stage Board, Plate Hub, and Tooling Hub.

## Tables commonised

Commonised behavior without visual redesign:

- Purchase Orders: shared debounce and visible selection math.
- Inventory Stock: shared selection set and visible selection math.
- Job Cards: shared selection, selected rows, sort cycle, comparison, and empty/loading rows.
- Production Stage Board: shared visible selection math.
- Billing list: shared empty row and row-action slot.
- Reports table: reused `EnterpriseTableShell`.

## Tables intentionally left custom

- Designing/AW Queue: complex grouped operational workflow.
- Cutting Queue: role-sensitive production execution table.
- Billing New Bill line table: calculation-sensitive invoice entry.
- Plate Hub ledgers: large domain-specific ledger interactions.
- Tooling Hub ledgers: large domain-specific ledger interactions.
- GRN: current workflow is moved/placeholder in this worktree.

## Browser smoke results

Browser smoke could not be run because browser-control tooling was not exposed in this session.

Requested coverage not executed:

- Dashboard
- Inventory
- GRN
- Purchase Orders
- Designing/AW Queue
- Planning
- Job Cards
- Cutting Queue
- Production Stage Board
- Billing
- New Bill
- Reports
- Plate Hub
- Tooling Hub

Because browser smoke could not run, the following cannot be confirmed from an automated browser session:

- No console errors
- No failed API calls
- No broken modals/drawers
- No broken pagination
- No broken export buttons

## Verification command results

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | Passed | `tsc --noEmit` completed successfully. |
| `npx prisma validate` | Passed | Prisma schema is valid. |
| `npx next lint` | Passed with warnings | Existing hook dependency, a11y, and image warnings remain. |
| `git diff --check` | Passed | No whitespace errors. |
| API route import validation | Passed | Imported 370 `src/app/api/**/route.ts` files successfully. |
| `npx next build` | Failed after compile | Direct build compiled successfully, then failed during page-data/manifest collection with `ENOENT: no such file or directory, open '.next/server/pages-manifest.json'`. `npm run build` was not used because it runs `prisma migrate deploy`. |

## Deployment readiness

Manual QA readiness: yes, with known limitations.

Staging deploy readiness: no, not yet.

Blocking reason:

- `npx next build` still fails after compile during Next page-data/manifest collection. This should be fixed before staging deploy.

## Confirmations

- No deployment performed.
- No commit performed.
- No `prisma migrate deploy` run.
- No Prisma schema/migration change made.
- No auth/permission change made.
- No intentional calculation drift in billing GST/tax/rounding, GRN costing, planning reservation/release/reversal, production OEE/yield, or procurement landed cost/supplier score.

## Remaining risks

- Exact browser payload sizes and console/API failures need manual or automated browser QA.
- Direct Next build artifact/page-manifest failure blocks staging deploy.
- New Bill carton catalog still loads up to 4000 customer cartons to preserve current UX.
- Hub and report APIs still compute larger datasets before response trimming.
- Some existing lint warnings remain and should be addressed separately.

## Recommended next phase

Only one next phase is recommended before staging: build-blocker and smoke-QA closure.

1. Fix the Next build page-data/manifest issue.
2. Run browser smoke across the requested modules.
3. Capture actual network payload sizes for the main first-render pages.
4. Only after that, consider deeper query-level pagination for Paper Warehouse, Reports, Stage Boards, Plate Hub, and Tooling Hub.
