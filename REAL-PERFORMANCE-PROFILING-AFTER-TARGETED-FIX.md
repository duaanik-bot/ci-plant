# Real Performance Profiling After Targeted Fix

Date: 2026-06-10  
Runtime measured: authenticated production `next start` on `http://127.0.0.1:3016`  
Raw capture: `/tmp/ci-real-performance-after-targeted-fix.json`

## Executive Summary

This was a real browser/network profiling run against the production build, not a code-only audit. The previous build blocker is fixed, so this run used `npx next start` rather than `next dev`.

The targeted fixes reduced the worst measured bottleneck substantially. Tooling Hub API payload dropped from 564.0 KB in the previous dev-runtime trace to 10.1 KB in the production trace. Duplicate first-render API requests were eliminated in the profiled production run.

The remaining top bottlenecks are now Planning, Inventory, Job Card New, Designing/AW Queue, and Production Stage Board.

## Profiling Method

- Clean production build: `rm -rf .next tsconfig.tsbuildinfo && npx next build`.
- Production server: `npx next start -p 3016`.
- Auth: NextAuth credentials session for `anik@gmail.com`.
- Browser: Google Chrome driven through DevTools using a temporary profiler installed under `/tmp/ci-perf-runner`.
- Cache: disabled per page.
- Wait window: navigation to `networkidle2` plus 5.5 seconds for post-hydration requests.
- Payload: response body byte length from real browser responses.
- Rows: largest JSON arrays discovered recursively in API responses.

## Page Ranking

| Rank | Page/module | First render window | API count | API payload | Largest API | Slowest API | Duplicates |
| ---: | --- | ---: | ---: | ---: | --- | --- | ---: |
| 1 | Planning | 6,456 ms | 4 | 251.6 KB | `/api/masters/materials`, 158.3 KB | `/api/planning/po-lines?limit=300`, 1,927 ms | 0 |
| 2 | Inventory | 6,446 ms | 3 | 71.2 KB | `/api/inventory/paper-warehouse`, 69.3 KB | `/api/inventory/paper-warehouse`, 638 ms | 0 |
| 3 | Job Card New | 6,362 ms | 3 | 58.8 KB | `/api/purchase-orders?paged=1&limit=100`, 57.0 KB | same, 749 ms | 0 |
| 4 | Designing/AW Queue | 6,631 ms | 5 | 49.0 KB | `/api/designing/po-lines?mode=compact`, 34.3 KB | same, 2,351 ms | 0 |
| 5 | Production Stage Board | 6,452 ms | 4 | 22.8 KB | `/api/production/stages/cutting?limit=50&mode=compact&tab=pending`, 20.8 KB | same, 2,521 ms | 0 |
| 6 | Cutting Queue | 6,392 ms | 5 | 19.6 KB | `/api/job-cards?mode=compact&segment=cutting&limit=200`, 13.4 KB | same, 1,447 ms | 0 |
| 7 | Job Cards | 6,453 ms | 3 | 17.4 KB | `/api/job-cards?mode=compact&paged=1&limit=50`, 15.5 KB | same, 1,245 ms | 0 |
| 8 | Dashboard | 6,541 ms | 4 | 16.9 KB | `/api/purchase-orders?mode=compact&paged=1&limit=100`, 15.0 KB | same, 921 ms | 0 |
| 9 | Purchase Orders | 6,458 ms | 4 | 16.9 KB | `/api/purchase-orders?mode=compact&paged=1&limit=100`, 15.0 KB | same, 980 ms | 0 |
| 10 | Billing | 6,540 ms | 5 | 13.7 KB | `/api/masters/customers`, 10.8 KB | `/api/billing/queue`, 848 ms | 0 |
| 11 | Tooling Hub | 6,459 ms | 4 | 10.1 KB | `/api/tooling-hub/dashboard?tool=dies&view=board`, 6.2 KB | same, 1,080 ms | 0 |
| 12 | Procurement | 6,469 ms | 3 | 7.6 KB | `/api/procurement/dashboard`, 5.8 KB | same, 3,880 ms | 0 |
| 13 | Plate Hub | 6,219 ms | 3 | 4.5 KB | `/api/plate-hub/dashboard?view=board`, 2.7 KB | same, 2,193 ms | 0 |
| 14 | GRN | 6,157 ms | 3 | 2.8 KB | `/api/masters/registry`, 1.7 KB | `/api/procurement/grn?limit=50&q=&status=&supplier=&posted=`, 758 ms | 0 |
| 15 | New Bill | 6,453 ms | 2 | 1.9 KB | `/api/masters/registry`, 1.7 KB | same, 236 ms | 0 |
| 16 | Reports | 6,455 ms | 2 | 1.9 KB | `/api/masters/registry`, 1.7 KB | same, 202 ms | 0 |
| 17 | Stores Issue | 6,451 ms | 2 | 1.9 KB | `/api/masters/registry`, 1.7 KB | same, 201 ms | 0 |

The first-render window includes the fixed 5.5 second settle period, so pages cluster around 6 seconds. For relative ranking, API payload and slowest API are more useful than the wall-clock window.

## Top APIs After Targeted Fix

| Rank | API | Calls | Total payload | Max time | Largest array | Main issue |
| ---: | --- | ---: | ---: | ---: | --- | --- |
| 1 | `/api/masters/materials` | 1 | 158.3 KB | 320 ms | `$[291]` | Planning loads full material master before interaction. |
| 2 | `/api/planning/po-lines?limit=300` | 1 | 91.4 KB | 1,927 ms | `$[21]` | High limit and nested `specOverrides`, PO/customer data. |
| 3 | `/api/inventory/paper-warehouse` | 1 | 69.3 KB | 638 ms | `rows[150]` | Inventory still loads 150 warehouse rows first. |
| 4 | `/api/purchase-orders?paged=1&limit=100` | 1 | 57.0 KB | 749 ms | `rows[19]` | Job Card New lookup still returns nested line items/readiness. |
| 5 | `/api/designing/po-lines?mode=compact` | 1 | 34.3 KB | 2,351 ms | `$[11]` | Compact helped, but row enrichment remains non-trivial. |
| 6 | `/api/purchase-orders?mode=compact&paged=1&limit=100` | 2 | 29.9 KB | 980 ms | `rows[19]` | Used by Dashboard redirect and Purchase Orders. |
| 7 | `/api/masters/registry` | 17 | 28.4 KB | 583 ms | `UNIT.values[9]` | Small per call, repeated on every module. |
| 8 | `/api/masters/customers` | 2 | 21.6 KB | 422 ms | `$[23]` | Full customers still preloaded in AW Queue and Billing. |
| 9 | `/api/production/stages/cutting?limit=50&mode=compact&tab=pending` | 1 | 20.8 KB | 2,521 ms | `jobCards[6]` | Still includes nested job/stage/spec data. |
| 10 | `/api/job-cards?mode=compact&paged=1&limit=50` | 1 | 15.5 KB | 1,245 ms | `rows[9]` | Compact list still includes customer, PO line, and stages. |

## Old Vs New Comparison

| Module | Previous API payload | New API payload | API count change | Duplicate change | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Tooling Hub | 564.0 KB | 10.1 KB | 7 to 4 | 3 duplicate groups to 0 | Full inventory removed from board first render. |
| Designing/AW Queue | 105.4 KB | 49.0 KB | 9 to 5 | 4 duplicate groups to 0 | Compact mode strips heavy spec override keys. |
| Procurement | 15.3 KB | 7.6 KB | 5 to 3 | 2 duplicate groups to 0 | Shared URL dedupe removed repeated dashboard calls. |
| GRN | 5.6 KB | 2.8 KB | 5 to 3 | 2 duplicate groups to 0 | Shared URL dedupe removed repeated list calls. |
| Plate Hub | 9.7 KB | 4.5 KB | 5 to 3 | 2 duplicate groups to 0 | Board dashboard load deduped. |
| Purchase Orders | 34.7 KB | 16.9 KB | 6 to 4 | 2 duplicate groups to 0 | In-flight guard removed duplicate compact list/session pattern in production. |
| Dashboard | 34.7 KB | 16.9 KB | 6 to 4 | 2 duplicate groups to 0 | Dashboard redirects to Purchase Orders for this user. |
| Job Cards | 21.6 KB | 17.4 KB | 4 to 3 | 1 duplicate group to 0 | Limit reduced to 50 and yield metrics removed. |
| Billing | 16.4 KB | 13.7 KB | 6 to 5 | 1 duplicate group to 0 | Full customer preload remains a smaller optimization target. |
| Reports | 3.9 KB | 1.9 KB | 3 to 2 | 1 duplicate group to 0 | Landing stays lightweight. |

The previous trace was captured against warmed `next dev` because production build was blocked at the time. The new trace is a production `next start` trace. Payload and request-shape comparisons are still valid, but absolute timings are not strictly apples-to-apples.

## APIs Returning More Than 100 Rows

| Page | API | Array | Rows | Payload |
| --- | --- | --- | ---: | ---: |
| Planning | `/api/masters/materials` | `$` | 291 | 158.3 KB |
| Inventory | `/api/inventory/paper-warehouse` | `rows` | 150 | 69.3 KB |

## Nested Relations Still Loaded Before Interaction

- `/api/planning/po-lines?limit=300`: `specOverrides`, `orchestration`, `designerCommand`, `plateHubPayload`, `po.customer`.
- `/api/purchase-orders?paged=1&limit=100`: `customer`, `lineItems`, `lineItems.specOverrides`, `readiness`.
- `/api/designing/po-lines?mode=compact`: `specOverrides`, `po.customer`, `jobCard`, `readiness`.
- `/api/production/stages/cutting?limit=50&mode=compact&tab=pending`: `stageRecord`, `jobCard`, `jobCard.customer`, `jobCard.poMeta.specOverrides`.
- `/api/job-cards?mode=compact&paged=1&limit=50`: `customer`, `poLine`, `stages`.
- `/api/job-cards?mode=compact&segment=cutting&limit=200`: `customer`, `poLine`, `stages`.

## Duplicate Requests

No duplicate API requests were captured in the production profiling run.

## Failed Requests And Console Errors

No failed API calls were captured.

Several non-API Next route prefetches were aborted during navigation, for example `_rsc` requests from Reports, Stage Board, Plate Hub, and Tooling Hub. These are browser/navigation prefetch aborts, not failed API calls.

One Dashboard console error was captured for a `404 (Not Found)` resource. It was not an API response and should be checked separately, likely as a static asset/favicon request.

## Commonisation Opportunity Ranking

| Rank | Area | Opportunity | Expected speed gain |
| ---: | --- | --- | --- |
| 1 | Planning | Replace full material master preload with capped searchable lookup and summary data. | High |
| 2 | Inventory | Clamp/lazy-load warehouse rows and tab-specific detail data. | High |
| 3 | Job Card New | Use compact PO lookup and load PO lines/readiness only after selection. | High |
| 4 | Cutting Queue | Reduce `limit=200`, use stage-specific compact rows, detail-on-demand for stages. | Medium-high |
| 5 | Production Stage Board | Split visible lane rows from nested stage/job/spec detail. | Medium-high |
| 6 | Registry | App-level cache/provider for `/api/masters/registry`. | Medium |
| 7 | Customers | Replace broad customer list preload with shared capped search. | Medium |

## Final Recommendation

The targeted fixes achieved the intended runtime improvement and the build now passes. The branch is ready for manual QA, but not yet a blind staging deploy, because Planning, Inventory, Job Card New, and Cutting Queue still have broad first-render query patterns that should be validated with users before another change pass.
