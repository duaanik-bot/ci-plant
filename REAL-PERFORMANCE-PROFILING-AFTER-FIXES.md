# Real Performance Profiling After Fixes

Date: 2026-06-10  
Runtime measured: authenticated production `next start` on `http://127.0.0.1:3016`  
Raw capture: `/tmp/ci-real-performance-after-fixes-final.json`

## Executive Summary

The final production profiling run shows duplicate first-render API calls eliminated across all profiled modules. Tooling Hub remains dramatically improved from the original runtime bottleneck, and this continuation reduced Planning, Inventory, and Job Card New payloads using measured bottleneck fixes only.

No schema, migration, deployment, permission, workflow, or calculation changes were made.

## Page Ranking After Fixes

| Rank | Page/module | API count | API payload | Slowest API | Duplicate APIs |
| ---: | --- | ---: | ---: | --- | ---: |
| 1 | Planning | 3 | 93.2 KB | `/api/planning/po-lines?limit=75`, 2,212 ms | 0 |
| 2 | Designing/AW Queue | 5 | 49.1 KB | `/api/designing/po-lines?mode=compact`, 2,837 ms | 0 |
| 3 | Inventory | 3 | 25.6 KB | `/api/inventory/paper-warehouse?paged=1&limit=50`, 966 ms | 0 |
| 4 | Production Stage Board | 4 | 22.8 KB | `/api/production/stages/cutting?limit=50&mode=compact&tab=pending`, 3,582 ms | 0 |
| 5 | Dashboard | 4 | 20.1 KB | `/api/purchase-orders?mode=compact&paged=1&limit=100`, 1,110 ms | 0 |
| 6 | Purchase Orders | 4 | 20.1 KB | `/api/purchase-orders?mode=compact&paged=1&limit=100`, 1,167 ms | 0 |
| 7 | Cutting Queue | 5 | 19.6 KB | `/api/job-cards?mode=compact&segment=cutting&limit=50`, 1,686 ms | 0 |
| 8 | Job Cards | 3 | 17.4 KB | `/api/job-cards?mode=compact&paged=1&limit=50`, 1,604 ms | 0 |
| 9 | Job Card New | 3 | 17.2 KB | `/api/purchase-orders?paged=1&limit=50&mode=compact&lookup=job-card`, 813 ms | 0 |
| 10 | Billing | 5 | 13.7 KB | `/api/bills?compact=1&paged=1&limit=100`, 1,269 ms | 0 |
| 11 | Tooling Hub | 4 | 10.1 KB | `/api/tooling-hub/dashboard?tool=dies&view=board`, 1,572 ms | 0 |
| 12 | Procurement | 3 | 8.5 KB | `/api/procurement/dashboard`, 4,416 ms | 0 |
| 13 | Plate Hub | 3 | 4.5 KB | `/api/plate-hub/dashboard?view=board`, 2,193 ms | 0 |
| 14 | GRN | 3 | 3.7 KB | `/api/procurement/grn?limit=50&q=&status=&supplier=&posted=`, 857 ms | 0 |
| 15 | New Bill | 2 | 1.9 KB | `/api/masters/registry`, 275 ms | 0 |
| 16 | Reports | 2 | 1.9 KB | `/api/masters/registry`, 377 ms | 0 |
| 17 | Stores Issue | 2 | 1.9 KB | `/api/masters/registry`, 286 ms | 0 |

## Top APIs After Fixes

| Rank | API | Calls | Payload | Max time | Largest array | Recommendation |
| ---: | --- | ---: | ---: | ---: | --- | --- |
| 1 | `/api/planning/po-lines?limit=75` | 1 | 91.4 KB | 2,212 ms | `$[21]` | Add a true compact Planning list contract in a later approved pass. |
| 2 | `/api/purchase-orders?mode=compact&paged=1&limit=100` | 2 | 36.3 KB | 1,167 ms | `rows[19]` | Keep as-is for main PO page; readiness is visible there. |
| 3 | `/api/designing/po-lines?mode=compact` | 1 | 34.3 KB | 2,837 ms | `$[11]` | Remaining enrichment is row-detail candidate. |
| 4 | `/api/masters/registry` | 17 | 28.4 KB | 399 ms | `UNIT.values[9]` | App-level registry provider/cache remains useful. |
| 5 | `/api/inventory/paper-warehouse?paged=1&limit=50` | 1 | 23.7 KB | 966 ms | `rows[50]` | Aggregate KPI SQL could reduce server work later. |
| 6 | `/api/masters/customers` | 2 | 21.6 KB | 565 ms | `$[23]` | Convert remaining full customer preloads to shared lookup. |
| 7 | `/api/production/stages/cutting?limit=50&mode=compact&tab=pending` | 1 | 20.8 KB | 3,582 ms | `jobCards[6]` | Move job/stage/spec enrichment to detail view. |
| 8 | `/api/job-cards?mode=compact&paged=1&limit=50` | 1 | 15.5 KB | 1,604 ms | `rows[9]` | Remove stages from compact list only after UI review. |
| 9 | `/api/purchase-orders?paged=1&limit=50&mode=compact&lookup=job-card` | 1 | 15.3 KB | 813 ms | `rows[19]` | Acceptable after compact lookup change. |
| 10 | `/api/job-cards?mode=compact&segment=cutting&limit=50` | 1 | 13.4 KB | 1,686 ms | `rows[0].stages[9]` | Stage timeline-on-demand remains future work. |

## Before Vs After Highlights

| Area | Before | After | Result |
| --- | ---: | ---: | --- |
| Tooling Hub API payload | 564.0 KB original | 10.1 KB | Full inventory removed from first render. |
| Planning API payload | 251.6 KB | 93.2 KB | Hidden materials preload removed; list limit lowered. |
| Inventory API payload | 71.2 KB | 25.6 KB | First page reduced to 50 rows. |
| Job Card New API payload | 58.8 KB | 17.2 KB | Compact PO lookup added. |
| Duplicate API groups | Multiple in original trace | 0 | First-render duplicate calls eliminated. |

## Failed Calls And Console Errors

No failed API calls were captured.

Observed `net::ERR_ABORTED` entries were Next route prefetch/navigation requests (`_rsc`) cancelled during page transitions, not API failures.

Dashboard still logs one non-API 404 resource message. It should be checked separately as a static asset/favicon hygiene item.

## Verification Results

| Check | Result |
| --- | --- |
| `rm -rf .next tsconfig.tsbuildinfo && npx next build` | Passed |
| `npm run typecheck -- --pretty false` | Passed |
| `npx prisma validate` | Passed |
| `npx next lint` | Passed with existing warnings |
| `git diff --check` | Passed before report writing |
| Route import validation | Passed, 386 API route files imported |
| Production browser profiling | Passed |

## Remaining Risks

- Procurement cold dashboard remains slow at 4,416 ms with a small payload. This needs DB-level query-plan/log review or a more explicit summary/detail split.
- Stage Board remains slow at 3,582 ms for six rows because it still returns nested stage/job/spec enrichment.
- Planning is still the largest first-render payload due to nested operational data, even after removing the hidden material master preload.
- Registry appears once per module visit; a shared client provider would reduce cross-navigation repeat calls but was intentionally not added in this pass.

## Staging Readiness

Ready for manual QA. Do not deploy blindly until QA confirms Planning drawer material lookup, Inventory first-page behavior, Job Card New PO/line selection, and Procurement dashboard values.
