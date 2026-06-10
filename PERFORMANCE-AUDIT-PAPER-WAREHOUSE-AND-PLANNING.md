# Performance Audit: Paper Warehouse and Planning APIs

Date: 2026-06-10
Scope: `/api/inventory/paper-warehouse` and `/api/planning/po-lines`
Mode: Audit only; no implementation changes.

## Executive Summary

Both endpoints are functionally stable but carry different performance risks.

- `/api/inventory/paper-warehouse` is moderate risk. It fetches all board inventory rows before slicing and computes KPIs in memory. Current dataset is small enough to pass, but growth will increase response time and payload pressure.
- `/api/planning/po-lines` is higher risk. The database plan is cheap, but the route performs multiple broad Prisma reads, heavy in-memory enrichment, and returns a large enriched object to a complex frontend.

## Evidence Collected

Source measurements:

- Browser/server smoke logs from staging readiness and this audit.
- Direct Prisma timing against configured remote Supabase database.
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` approximations.
- Source review of route and frontend fetch patterns.

Observed server logs:

| Endpoint | Observed API Time |
| --- | ---: |
| `/api/inventory/paper-warehouse` | `718ms` in latest profiling; previously `1048ms` and `3296ms` |
| `/api/planning/po-lines` | `2195ms` in latest profiling; previously `3106ms` and `5320ms` |

## `/api/inventory/paper-warehouse`

### Current Implementation

Route: `src/app/api/inventory/paper-warehouse/route.ts`

Flow:

1. Auth check.
2. Fetches all active inventory rows where `boardType` and `gsm` are present.
3. Maps all rows to warehouse DTOs.
4. Filters search in memory.
5. Computes full KPI block from all filtered rows.
6. Slices page rows after mapping/filtering.
7. Computes days-of-cover only for page rows.
8. Returns rows plus KPI/meta.

### Measured Profile

| Metric | Result |
| --- | ---: |
| Prisma inventory query time | `678ms` |
| Rows fetched before slice | `295` |
| Default rows returned | `150` |
| Default payload size | `51KB` |
| Export-style full row payload estimate | `102KB` |
| DB actual plan time | `0.796ms` |
| DB plan cost | `24.55` |
| DB plan rows | `291` |

### Database Cost

Plan summary:

- `Seq Scan` on `inventory`
- Filter: `active AND board_type IS NOT NULL AND gsm IS NOT NULL`
- In-memory sort by `board_type`, `gsm`, `material_code`
- Shared hit blocks: `9`
- No disk reads in sampled plan

Interpretation: database execution is cheap at current volume. The slower API time is dominated by Prisma/network/serialization and app-side processing, not database CPU.

### Risks

| Risk | Evidence | Severity |
| --- | --- | --- |
| Unpaginated base query | Fetches all matching rows before page slicing | Medium |
| KPI requires full row scan | KPI computed over full mapped set | Medium |
| Search in memory | Search is applied after full fetch | Medium |
| Payload growth | Default payload 51KB at 150 rows; full estimate 102KB at 295 rows | Low now, Medium as inventory grows |
| Duplicate requests | Warehouse page can call stock states, ledger, paper warehouse, drawer genealogy depending on interactions | Medium |

### Optimized Opportunities

| Area | Current | Opportunity |
| --- | --- | --- |
| Pagination | App slices after fetching all rows | Push `take`/`skip` and search filters into Prisma for table rows |
| KPI | Derived from full row set in API request | Split KPI endpoint with short cache, or compute aggregate SQL |
| Search | In-memory string concatenation | Prisma `OR` search on `materialCode`, `boardType`, `boardClassification` |
| Sorting | DB sort over full set | Add/confirm index for `(active, boardType, gsm, materialCode)` only if volume grows |
| Days of cover | Page-only helper after slice | Keep page-only; avoid computing for KPI-only calls |
| Payload | Full row objects | Add compact mode as default for table; hydrate details on drawer open |

## `/api/planning/po-lines`

### Current Implementation

Route: `src/app/api/planning/po-lines/route.ts`

Flow:

1. Auth check.
2. Fetch PO lines with nested PO/customer, shade card, material queue, carton, die master.
3. Fetch machines.
4. Fetch all active inventory rows.
5. Fetch positive paper warehouse rows.
6. Fetch finished-goods inventory rows.
7. Fetch production job cards for job-card numbers in list.
8. Fetch stock movement reservations for selected material pairs.
9. Perform heavy enrichment per line: spec pack resolution, sheet math, tooling interlock, material gate, board matching, selected material lookup, FG stock matching, readiness scoring, duration estimates.
10. Return enriched array directly.

### Measured Profile

| Metric | Result |
| --- | ---: |
| PO line primary Prisma query | `565ms` |
| PO line rows | `21` |
| Raw PO line payload before enrichment | `47KB` |
| Secondary measured DB time total | `1191ms` |
| Total measured DB/Prisma time | `1756ms` |
| Server log API time | `2195ms` |
| DB actual plan time for core join/order | `0.158ms` |
| DB plan cost for core join/order | `41.64` |

Secondary query breakdown:

| Query | Rows | Time |
| --- | ---: | ---: |
| Job cards by job card number | 8 | `258ms` |
| Machines | 13 | `183ms` |
| Active inventory | 295 | `195ms` |
| Paper warehouse positive qty | 9 | `186ms` |
| Finished goods inventory | 0 | `184ms` |
| Reservation stock movements | 10 | `185ms` |

### Database Cost

Plan summary:

- `Seq Scan` on `po_line_items`
- Nested loop to `purchase_orders`
- Memoized index scan for repeated `po_id`
- Sort by director priority, PO priority, hold, created date
- Shared hit blocks: `62`
- No disk reads in sampled plan

Interpretation: database cost is low at current row count. The performance issue is the number of Prisma round trips, nested include hydration, broad side-table reads, and expensive enrichment/serialization.

### Risks

| Risk | Evidence | Severity |
| --- | --- | --- |
| Broad side-table reads | All active inventory rows fetched for each planning list request | High |
| Heavy enrichment in list endpoint | Material gate, tooling, readiness, stock insight per row | High |
| Large frontend component | Planning page ~1333 lines; multiple stateful actions and filters | Medium |
| Payload growth | Raw payload already 47KB for only 21 lines before enrichment | Medium |
| Repeated reference data | Machines/inventory/paper rows refetched per request | Medium |
| Frontend render cost | Planning page rendered 4959 body chars after wait; complex tables/drawers | Medium |
| Duplicate requests | Planning page fetches customers and planning lines; action handlers refetch line data | Medium |
| N+1 risk | Current route batches job cards/reservations, but per-row enrichment does repeated array scans against inventory/paper rows | Medium |

### Optimized Opportunities

| Area | Current | Opportunity |
| --- | --- | --- |
| List endpoint responsibility | Returns full enriched planning model | Split into list summary plus detail/readiness endpoints |
| Inventory lookup | Fetch all active inventory rows | Fetch only material candidates needed by visible rows, or cache reference lookup |
| Reference data | Machines/inventory/paper fetched per call | Cache machines and paper reference data with short TTL |
| Enrichment | Computes every readiness field for every list row | Lazy-compute deep readiness on drawer/open row; keep table fields minimal |
| Payload | Enriched array direct response | Add paged envelope and compact mode as default |
| Filtering | Planning status/customer only | Preserve server-side filters; avoid full list for client-only filters |
| Rendering | Dense page with many actions | Virtualized table or smaller rows; keep details in drawer |

## Current vs Optimized Comparison

| Endpoint | Current Pattern | Optimized Direction |
| --- | --- | --- |
| Paper Warehouse | Full fetch -> map/filter/KPI -> slice | SQL/page first for rows; separate cached KPI aggregate |
| Paper Warehouse | Default 150 heavy rows | Compact table rows plus detail drawer fetch |
| Planning PO Lines | Multi-query broad read plus full enrichment | Compact planning board endpoint + lazy readiness/detail hydration |
| Planning PO Lines | Reference data fetched every request | Short cached reference endpoints for machines/material candidates |
| Planning PO Lines | Per-row in-memory matching | Pre-index maps by material id/board/gsm before enrichment |

## Recommendations

Priority 1:

- Split `/api/planning/po-lines` into compact list and detail/readiness hydration.
- Cache planning reference data: machines, active inventory material candidates, paper warehouse stock.
- Add response-size logging for planning list responses.

Priority 2:

- Move paper warehouse table pagination/search into SQL.
- Split warehouse KPI calculation from row list and cache KPI separately.

Priority 3:

- Add frontend request de-duplication and stale-while-revalidate behavior for Planning and Warehouse.
- Add payload budget checks for large list endpoints.

## Conclusion

The database is not the bottleneck at current scale. The main bottlenecks are server-side orchestration, broad Prisma reads, in-memory enrichment, response payload size, and frontend complexity.
