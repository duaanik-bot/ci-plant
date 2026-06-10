# Inventory And Planning Runtime Profile

Date: 2026-06-10  
Runtime: authenticated production `next start` on `http://127.0.0.1:3016`

## Summary

Inventory and Planning now profile correctly in the production browser run. The earlier 404-shell capture issue is no longer present after the build manifest fix and production profiling setup.

## Files Changed

- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/api/inventory/paper-warehouse/route.ts`
- `src/app/(dashboard)/orders/planning/page.tsx`
- `src/components/planning/PlanningJobDetailDrawer.tsx`
- `src/app/api/masters/materials/route.ts`

## Inventory Measurement

| Metric | Before | After |
| --- | ---: | ---: |
| API requests | 3 | 3 |
| API payload | 71.2 KB | 25.6 KB |
| Largest API | `/api/inventory/paper-warehouse`, 69.3 KB | `/api/inventory/paper-warehouse?paged=1&limit=50`, 23.7 KB |
| Slowest API | `/api/inventory/paper-warehouse`, 638 ms | `/api/inventory/paper-warehouse?paged=1&limit=50`, 966 ms |
| Rows loaded | 150 | 50 |
| Duplicate APIs | 0 | 0 |

Change made:

- Inventory first render now requests `paged=1&limit=50`.
- Paper warehouse default non-export limit is now 50.
- KPI calculation remains server-side and unchanged.

## Planning Measurement

| Metric | Before | After |
| --- | ---: | ---: |
| API requests | 4 | 3 |
| API payload | 251.6 KB | 93.2 KB |
| Largest API | `/api/masters/materials`, 158.3 KB | `/api/planning/po-lines?limit=75`, 91.4 KB |
| Slowest API | `/api/planning/po-lines?limit=300`, 1,927 ms | `/api/planning/po-lines?limit=75`, 2,212 ms |
| Broad material rows | 291 | 0 on first render |
| Planning list limit | 300 | 75 |
| Duplicate APIs | 0 | 0 |

Change made:

- Planning first render now requests 75 line rows instead of 300.
- `PlanningJobDetailDrawer` no longer loads `/api/masters/materials` before the drawer is open.
- `/api/masters/materials` now supports compact lookup mode for drawer-only option loading.

## APIs Called Before Interaction

Inventory:

- `/api/auth/session`
- `/api/masters/registry`
- `/api/inventory/paper-warehouse?paged=1&limit=50`

Planning:

- `/api/auth/session`
- `/api/masters/registry`
- `/api/planning/po-lines?limit=75`

## APIs No Longer Called Before Interaction

- `/api/masters/materials` no longer loads during Planning first render.

## Remaining Bottlenecks

- Planning `/api/planning/po-lines?limit=75` still returns nested `specOverrides`, `orchestration`, `designerCommand`, `plateHubPayload`, `jobCard`, and `jobCard.stages`.
- Inventory still computes KPI over the full matched set before returning the first page. This preserves KPI behavior, but the query can still be improved later with aggregate SQL.

## QA Checklist

- Inventory first page renders stock rows.
- Inventory search/filter still returns expected rows.
- Inventory material drawer opens and existing genealogy/reservation actions still work.
- Planning page renders rows and KPIs.
- Planning row click opens the detail drawer.
- Planning drawer material options load after drawer open.
- Planning reservation/release/reversal logic remains unchanged.

## Staging Readiness

Inventory and Planning are now measured in production mode. The payload reductions are real and the remaining issues are documented. Ready for manual QA, with Planning compact-list work left as a future workflow-sensitive optimization.
