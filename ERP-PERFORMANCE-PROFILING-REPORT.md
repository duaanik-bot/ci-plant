# ERP Performance Profiling Report

Date: 2026-06-10
Mode: Authenticated browser smoke plus server logs, source review, and direct DB/Prisma profiling
No code changes made.

## Summary

Procurement is stable and comparatively lightweight after freeze. The largest remaining performance risks sit in Planning, Warehouse, and Production job-card/stage workflows.

## Browser Page Timing

Measured with production build served locally and authenticated in-app browser navigation.

| Page | Observed DOM Ready | Observed After Wait | Body Chars | Hard Error |
| --- | ---: | ---: | ---: | --- |
| Dashboard `/` | 192ms | 2692ms | 2870 | No |
| Planning `/orders/planning` | 84ms | 2585ms | 4959 | No |
| Production `/production/job-cards` | 130ms | 2631ms | 2001 | No |
| Warehouse `/inventory` | 81ms | 2582ms | 12248 | No |
| Procurement `/procurement` | 81ms | 2581ms | 986 | No |
| Reports `/reports` | 80ms | 2581ms | 975 | No |
| Job Cards `/production/job-cards` | 98ms | 2599ms | 2001 | No |

Note: the browser sandbox did not expose `fetch` or `performance.getEntriesByType`, so API timing was captured through server logs, Prisma timing, and route analysis.

## API Timing Evidence

| Endpoint | Evidence | Timing |
| --- | --- | ---: |
| `/api/planning/po-lines` | Server log latest | 2195ms |
| `/api/planning/po-lines` | Prior smoke | 3106ms and 5320ms |
| `/api/inventory/paper-warehouse` | Server log latest | 718ms |
| `/api/inventory/paper-warehouse` | Prior smoke | 1048ms and 3296ms |
| `/api/purchase-orders` | Duplicate server logs during profiling | 1129ms and 1161ms |

## Payload and Row Evidence

| Endpoint | Rows | Payload / Size | Notes |
| --- | ---: | ---: | --- |
| Paper warehouse | 295 fetched, 150 returned | 51KB default, 102KB full estimate | Fetches all matching rows before slicing |
| Planning PO lines | 21 PO lines | 47KB raw before enrichment | Enriched payload is larger than raw measurement |
| Planning active inventory side read | 295 rows | 76KB | Refetched as reference data for planning list |

## Slowest Endpoints

1. `/api/planning/po-lines`
   - Business impact: high; planners use this as a primary operating page.
   - Cause: broad side reads, per-row enrichment, large route responsibility.

2. `/api/inventory/paper-warehouse`
   - Business impact: high; warehouse users depend on stock visibility.
   - Cause: all-row fetch, in-memory filtering/KPI, row slicing after mapping.

3. `/api/purchase-orders`
   - Business impact: medium; duplicated during profiling.
   - Cause: likely duplicate page requests or repeated list loading from overlapping pages.

## Duplicate Requests

Observed:

- `/api/purchase-orders` appeared twice in server logs during profiling.

Likely risks from source review:

- Planning row actions refetch line detail.
- Production job-card detail fetches job card, material readiness, material timeline, users, machines, and tooling checks.
- Warehouse page can load stock states, paper warehouse rows, ledger, and drawer genealogy.

## Render Bottlenecks

| Area | Evidence | Risk |
| --- | --- | --- |
| Warehouse | Body text `12248` chars after load; dense table/page | Table render and filtering cost |
| Planning | Large page file and heavy endpoint | State/render complexity |
| Production stage screen | Stage page ~2796 lines | High client complexity and operator clutter |
| Job-card detail | Detail page ~1760 lines with many fetches | Chattiness and modal/action complexity |

## Largest Responses

Measured/estimated:

- Paper warehouse default response: 51KB.
- Paper warehouse full row estimate: 102KB.
- Planning raw PO line payload before enrichment: 47KB.
- Planning active inventory side data: 76KB.

The Planning final response is expected to exceed 47KB because the route enriches each row before returning.

## Business Impact Ranking

| Rank | Finding | Business Impact | Priority |
| ---: | --- | --- | --- |
| 1 | Planning list endpoint is slow and overloaded | Planners wait on core daily work | P1 |
| 2 | Warehouse paper list fetches all rows before paging | Stock visibility can degrade as inventory grows | P1 |
| 3 | Production job-card/stage screens are large and fetch-heavy | Shopfloor execution may slow and confuse operators | P2 |
| 4 | Duplicate purchase-order API calls | Adds unnecessary load | P2 |
| 5 | Existing lint warnings and Next config warning | Release hygiene risk | P4 |

## Recommendations

Priority 1:

- Split Planning list API into compact list and lazy detail/readiness endpoints.
- Push Warehouse pagination/search into SQL and split KPI aggregation.

Priority 2:

- Profile Production job-card detail and stage endpoints with realistic data.
- Consolidate job-card detail fetches into a single execution context endpoint.

Priority 3:

- Add API response-size logging and duplicate-request monitoring.
- Add frontend request de-duplication for list pages.

## Conclusion

ERP performance is acceptable for current UAT scale, but Planning and Warehouse should be optimized before larger staging/business rollout. Production modernization should follow once performance telemetry is in place.
