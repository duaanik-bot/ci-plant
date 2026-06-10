# Targeted Runtime Performance Fix Report

Date: 2026-06-10

## Executive Summary

This pass focused only on measured runtime bottlenecks from the production browser profiles. It did not redesign UI, change workflows, change business calculations, alter permissions, change Prisma schema, run migrations, deploy, or commit.

The biggest already-fixed bottleneck remains Tooling Hub: first-render API payload is now 10.1 KB versus the original 564.0 KB dev-runtime trace. This continuation pass then reduced the newly measured Planning, Inventory, Job Card New, and Cutting Queue first-render payloads while preserving existing detail routes and workflows.

## Files Changed

This pass touched:

- `src/components/planning/PlanningJobDetailDrawer.tsx`
- `src/app/api/masters/materials/route.ts`
- `src/app/(dashboard)/orders/planning/page.tsx`
- `src/app/api/inventory/paper-warehouse/route.ts`
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/production/job-cards/new/page.tsx`
- `src/app/(dashboard)/production/cutting-queue/page.tsx`
- `src/app/api/purchase-orders/route.ts`
- `src/app/api/procurement/dashboard/route.ts`

Previously completed targeted files remain part of the overall performance initiative:

- `src/app/api/tooling-hub/dashboard/route.ts`
- `src/components/hub/HubToolingKanbanDashboard.tsx`
- `src/app/api/designing/po-lines/route.ts`
- `src/app/(dashboard)/orders/designing/page.tsx`
- `src/app/(dashboard)/production/job-cards/page.tsx`
- `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`
- `src/app/(dashboard)/orders/purchase-orders/page.tsx`
- `src/app/(dashboard)/procurement/_components/ProcurementScreens.tsx`
- `src/components/hub/HubPlateDashboard.tsx`

## APIs Changed

| API | Change | Compatibility |
| --- | --- | --- |
| `/api/masters/materials` | Added `compact=1`, `mode=compact`, `q`, and capped `limit` support for lightweight material lookup. | Full existing response remains default. |
| `/api/inventory/paper-warehouse` | Default non-export limit reduced from 150 to 50; Inventory caller now requests `paged=1&limit=50`. | Export and explicit larger limits remain supported within existing clamps. |
| `/api/purchase-orders` | Compact job-card lookup mode added with `lookup=job-card`; skips readiness/tooling enrichment for job-card source selection. | Existing compact/full PO responses remain available. |
| `/api/procurement/dashboard` | Independent dashboard queries are now issued in parallel and an unused `receipts` include was removed from open PO rows. | Response shape and calculations are unchanged. |
| `/api/planning/po-lines` | First-render caller now requests `limit=75` instead of 300. | Existing route behavior remains available for explicit callers. |

## Duplicate Calls Removed

Production profiling after this pass captured zero duplicate first-render API requests across Dashboard, Inventory, Planning, Purchase Orders, Procurement, GRN, Designing/AW Queue, Job Cards, Cutting Queue, Production Stage Board, Billing, New Bill, Reports, Plate Hub, Tooling Hub, Stores Issue, and Job Card New.

## Payload Reduction

| Module | Before this continuation | After this continuation | Result |
| --- | ---: | ---: | --- |
| Planning | 251.6 KB | 93.2 KB | -158.4 KB |
| Inventory | 71.2 KB | 25.6 KB | -45.6 KB |
| Job Card New | 58.8 KB | 17.2 KB | -41.6 KB |
| Tooling Hub | 564.0 KB original | 10.1 KB | Inventory no longer loads before interaction. |

## Query Reduction

- Planning no longer triggers the hidden `/api/masters/materials` full master preload before a row detail drawer is opened.
- Inventory first render now loads 50 warehouse rows instead of 150.
- Job Card New first render now uses compact job-card PO lookup instead of full PO rows with readiness/spec enrichment.
- Procurement dashboard now runs independent counts/lists concurrently rather than serially.
- Cutting Queue now requests `limit=50` instead of `limit=200`.

## Before Vs After Runtime Measurements

Raw after-fixes capture: `/tmp/ci-real-performance-after-fixes-final.json`

| Module | API count | API payload | Slowest API |
| --- | ---: | ---: | --- |
| Tooling Hub | 4 | 10.1 KB | `/api/tooling-hub/dashboard?tool=dies&view=board`, 1,572 ms |
| Procurement | 3 | 8.5 KB | `/api/procurement/dashboard`, 4,416 ms |
| Production Stage Board | 4 | 22.8 KB | `/api/production/stages/cutting?limit=50&mode=compact&tab=pending`, 3,582 ms |
| Designing/AW Queue | 5 | 49.1 KB | `/api/designing/po-lines?mode=compact`, 2,837 ms |
| Job Cards | 3 | 17.4 KB | `/api/job-cards?mode=compact&paged=1&limit=50`, 1,604 ms |
| Purchase Orders | 4 | 20.1 KB | `/api/purchase-orders?mode=compact&paged=1&limit=100`, 1,167 ms |
| Plate Hub | 3 | 4.5 KB | `/api/plate-hub/dashboard?view=board`, 2,193 ms |
| Billing | 5 | 13.7 KB | `/api/bills?compact=1&paged=1&limit=100`, 1,269 ms |
| GRN | 3 | 3.7 KB | `/api/procurement/grn?limit=50&q=&status=&supplier=&posted=`, 857 ms |
| Inventory | 3 | 25.6 KB | `/api/inventory/paper-warehouse?paged=1&limit=50`, 966 ms |
| Planning | 3 | 93.2 KB | `/api/planning/po-lines?limit=75`, 2,212 ms |

## Remaining Risks

- Procurement dashboard is still cold-query slow despite parallelization; the payload is small, so remaining work is DB/query-plan level.
- Production Stage Board still spends several seconds enriching six rows. Moving stage/job enrichment fully on demand remains a larger workflow-sensitive change.
- Planning still returns nested `specOverrides`, `jobCard`, and stage data in the list; further reduction needs a dedicated compact Planning row contract.
- Registry and session calls are not duplicated per page, but `/api/masters/registry` still appears once per module visit.

## Manual QA Checklist

- Tooling Hub board opens with lane counts and no missing inventory workflow.
- Tooling inventory loads when search/table mode is used.
- Planning list opens, row drawer opens, material options load only after drawer open.
- Inventory stock tab shows first 50 rows and existing filters/search still work.
- Job Card New can search/select a PO and line item, then create draft/final job card.
- Cutting Queue still shows cutting rows and save-counter workflow works.
- Purchase Orders list, drawer, readiness display, confirm/revert/delete/PDF actions still work.
- Procurement dashboard cards and lists display the same values.
- Billing GST/tax/rounding and GRN quantity/costing must be regression-tested by business users.

## Staging Readiness Assessment

Build and automated profiling are healthy, and the changes are scoped/reversible. The branch is ready for manual QA. Staging deploy should wait for QA sign-off on Planning drawer material lookup, Inventory pagination expectations, and Job Card New PO selection.
