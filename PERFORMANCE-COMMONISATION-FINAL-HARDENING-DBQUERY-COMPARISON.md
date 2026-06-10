# Performance Commonisation Final Hardening DB Query Comparison

## Executive Summary

This pass compared old vs new behavior for the two pages touched in final hardening:

- `src/app/(dashboard)/stores/issue/page.tsx`
- `src/app/(dashboard)/production/job-cards/new/page.tsx`

The changes do reduce broad first-render/list loading risk. The old code called full list endpoints without `page`, `limit`, or compact query parameters. The new code caps lookup calls and, for Stores Issue, uses compact/paged job-card results.

No business logic, calculations, permissions, Prisma schema, migrations, deployment, or commits were changed in this pass.

## Data Sources Used

- `git show HEAD:<file>` to reconstruct old page behavior.
- `git diff` to compare current page/API behavior.
- Static API route inspection for Prisma query shape.
- Read-only Prisma counts:
  - `productionJobCards`: 9
  - `purchaseOrders`: 19
- `pg_stat_statements` availability check: enabled.
- `pg_stat_statements` aggregate sample for related tables.
- Verification commands listed below.

Because local row counts are small, runtime payload/time reduction is not dramatic in this dataset. The important improvement is the enforced upper bound as production data grows.

## Old vs New Query Comparison

| Page | Old first/list behavior | New first/list behavior | Impact |
| --- | --- | --- | --- |
| Stores Issue | Search used `GET /api/job-cards` with no params. Manual JC lookup used `GET /api/job-cards?jobCardNumber=<num>`, but the current API route does not apply `jobCardNumber` to the query shape after Phase 1; it falls back to default list behavior. | Search uses `GET /api/job-cards?mode=compact&paged=1&limit=50&q=<query>` when query length is at least 2. Manual JC lookup uses `GET /api/job-cards?mode=compact&paged=1&limit=5&q=<num>`. | Removes broad search list load. Manual lookup is capped to 5 rows and uses compact envelope. |
| Job Card New | First render used `GET /api/purchase-orders` with no params. Autocomplete also used `GET /api/purchase-orders` then filtered client-side. | First render uses `GET /api/purchase-orders?paged=1&limit=100`. Autocomplete uses `GET /api/purchase-orders?paged=1&limit=50&q=<query>` when query length is at least 2. | Removes unbounded PO list load. Search shifts filtering into the API route and caps result rows. |

## Endpoint Comparison

| Endpoint | Old params | New params | Pagination / cap | Compact select |
| --- | --- | --- | --- | --- |
| `/api/job-cards` from Stores Issue search | none | `mode=compact&paged=1&limit=50`, plus `q` for query length >= 2 | New max 50 rows for search. | Yes, compact response mapping is used. |
| `/api/job-cards` from Stores Issue manual JC number | `jobCardNumber=<num>` | `mode=compact&paged=1&limit=5&q=<num>` | New max 5 rows for exact-style lookup. | Yes, compact response mapping is used. |
| `/api/purchase-orders` from Job Card New first render | none | `paged=1&limit=100` | New max 100 PO rows. | No. This is intentional because the page still needs line items for PO-line selection. |
| `/api/purchase-orders` from Job Card New search | none | `paged=1&limit=50&q=<query>` | New max 50 PO rows. | No. The form needs line item fields after selection. |

## Row Limit Comparison

| Page/action | Old max rows requested | New max rows requested |
| --- | ---: | ---: |
| Stores Issue autocomplete | Unbounded at caller level. API before Phase 1 was unbounded; after Phase 1 default is 150 when no limit is passed. | 50 |
| Stores Issue manual JC lookup | Effectively unbounded/default list fallback in current API route despite `jobCardNumber` param. | 5 |
| Job Card New first render | Unbounded at caller level. API before Phase 1 was unbounded; after Phase 1 default is 100 when no limit is passed. | 100 explicit |
| Job Card New autocomplete | Unbounded at caller level. API before Phase 1 was unbounded; after Phase 1 default is 100 when no limit is passed. | 50 |

## DB Query Shape Comparison

### Stores Issue / Job Cards

Old caller:

- `GET /api/job-cards`
- No `q`, `mode`, `paged`, `limit`, or `page`.
- Client filtered returned job cards by label.
- Higher client render/filter cost as job-card count grows.

New caller:

- `GET /api/job-cards?mode=compact&paged=1&limit=50&q=<query>`
- Manual lookup: `limit=5`.
- API applies `take` and `skip` unless `export=true`.
- Compact response removes full-row payload and returns only list-relevant fields.

Current Prisma shape for `/api/job-cards`:

- Main query: `db.productionJobCard.findMany({ where, orderBy, take, skip, include: { customer, machine, shiftOperator, stages } })`.
- Related query: `db.productionDowntimeLog.findMany` for returned card IDs only.
- Related query: `db.poLineItem.findMany` for returned job-card numbers only.
- `q` is resolved through `jobCardNumbersMatchingSearch`, narrowing by job-card number/customer/product before the list query.

The route still includes stages in the initial query and then maps compact stages down to a few fields. That is acceptable for the current Phase 1/2 design, but a future improvement could add a deeper compact-select query shape for Stores Issue only.

### Job Card New / Purchase Orders

Old caller:

- First render: `GET /api/purchase-orders`
- Search: `GET /api/purchase-orders`
- Client filtered all returned POs by PO number/customer name.

New caller:

- First render: `GET /api/purchase-orders?paged=1&limit=100`
- Search: `GET /api/purchase-orders?paged=1&limit=50&q=<query>`
- API uses `q` as `deepSearch`, applying `OR` filters to PO number, customer name, and line-item carton name.

Current Prisma shape for `/api/purchase-orders`:

- Main query: `db.purchaseOrder.findMany({ where, orderBy, take, skip, include: { customer, lineItems } })` for non-compact mode.
- Count query only when `paged` is requested.
- Dye lookup query is limited to die IDs found in the capped PO result set.

The Job Card New page intentionally does not request `mode=compact`, because it still needs PO line item fields immediately for line selection and auto summary fallback. The cap still prevents broad all-PO loading.

## Payload Comparison

Exact old payload sizes were not measurable from a live old build in this workspace without reverting code. The comparison below is based on enforced max rows and response shape:

| Page/action | Old payload risk | New payload bound |
| --- | --- | --- |
| Stores Issue search | All job-card list rows plus nested list enrichment. | At most 50 compact job-card rows. |
| Stores Issue manual lookup | Default/full list fallback risk. | At most 5 compact job-card rows. |
| Job Card New first render | All purchase orders with all line items. | At most 100 purchase orders with line items. |
| Job Card New search | All purchase orders with all line items, then client filtering. | At most 50 filtered purchase orders with line items. |

On the current local DB, the absolute row counts are 9 job cards and 19 purchase orders, so the practical payload is already small. The change is still valuable because it removes unbounded growth risk.

## Response Time Comparison

Authenticated browser/API timing for old vs new was not available in this session. Protected app pages return unauthenticated redirects in local smoke, and reverting to old code to measure old live endpoints would violate the keep-changes-safe flow.

Evidence available:

- API routes now emit `[perf:list]` diagnostics for list routes in development and slow production requests.
- `pg_stat_statements` is enabled.
- Aggregate pg-stat sample shows related `po_line_items` queries are frequent, but the data is not attributable to these two UI interactions or to old vs new code.

Read-only pg-stat aggregate sample, summarized:

| Query family | Observation |
| --- | --- |
| `po_line_items` selects | Multiple normalized entries, often sub-millisecond mean time on this small DB. |
| `purchase_orders` / job-card-adjacent queries | Present in aggregate stats, but not isolated by endpoint or deploy version. |
| Old vs new exact runtime | Not available from pg-stat without controlled before/after interaction labels or reset windows. |

## First Render API Call Comparison

| Page | Old first render | New first render |
| --- | --- | --- |
| Stores Issue | No broad automatic job-card fetch on initial mount; broad job-card fetch occurred when autocomplete searched. URL `jobCardId` still loads detail by ID. | Same first-render behavior; lookup interaction is now capped/compact. |
| Job Card New | One broad `GET /api/purchase-orders` on mount. | One capped `GET /api/purchase-orders?paged=1&limit=100` on mount. |

## Search / Select Interaction Comparison

| Page | Old search/select | New search/select | Regression risk |
| --- | --- | --- | --- |
| Stores Issue | Search fetched all job cards and filtered labels client-side. Selecting still called `/api/job-cards/{id}/sheet-context`. | Search fetches capped compact rows. Selecting still calls the same detail endpoint. | Low. Required selected detail fields still come from unchanged detail route. |
| Job Card New | Search fetched all POs and filtered client-side. Selecting a PO used row data already in local PO list. Selecting line still calls `/api/planning/po-lines/{lineId}` for detail. | Search fetches capped PO rows via API filtering. Selecting PO/line workflow unchanged. | Medium-low. If the desired PO is beyond the first 100 and user does not search, user must type search text. This is intended and safer for large datasets. |

## Duplicate Query Check

Static search of the two touched pages confirms:

- `stores/issue/page.tsx` no longer contains broad `fetch('/api/job-cards')`.
- `stores/issue/page.tsx` uses compact/paged job-card lookup and detail-on-demand.
- `job-cards/new/page.tsx` no longer contains broad first-render/search `fetch('/api/purchase-orders')`.
- `job-cards/new/page.tsx` uses explicit capped PO list/search queries.

Other broad calls exist elsewhere in the app, but those are outside this requested two-page comparison.

## Functional Regression Checks

Static checks:

- Stores Issue still selects job cards by ID and loads full issue context through `/api/job-cards/{id}/sheet-context`.
- Stores Issue still supports manual numeric lookup.
- Job Card New still receives line items in the first-render PO list because it intentionally does not use compact mode.
- Job Card New still fetches selected line detail through `/api/planning/po-lines/{lineId}`.
- No business calculation paths were changed.

Runtime smoke:

- Full authenticated browser smoke was not available in this thread.
- Previous built-app unauthenticated HTTP smoke showed protected pages returning expected `307` redirects.

## Supabase / Postgres Findings

- Database access was available for read-only Prisma checks.
- `pg_stat_statements` is installed/enabled.
- Exact old vs new endpoint timings are not available from aggregate pg-stat rows because queries are normalized and not labeled by UI page, deploy version, or request source.
- The local dataset is small, so controlled payload/time comparison would understate the production benefit.

## Build Blocker Status

The Next build blocker is fixed.

`rm -rf .next && npx next build` completed successfully in this pass:

- Compile passed.
- Page-data collection passed.
- Static generation completed.
- Final optimization and build trace collection completed.
- Route size table emitted.

The earlier `.next/server/pages-manifest.json missing` condition was not reproduced after the build-blocker fix.

## Verification Results

| Command | Result | Notes |
| --- | --- | --- |
| `rm -rf .next && npx next build` | Passed | Completed fully. Existing `experimental.viewTransition` warning remains. |
| `npm run typecheck` | Passed after clearing stale `tsconfig.tsbuildinfo` | First run hit stale `.next/types` references after clean build; `rm -f tsconfig.tsbuildinfo && npm run typecheck` passed. |
| `npx prisma validate` | Passed | Schema valid. |
| `npx next lint` | Passed with warnings | Existing warnings remain. |
| `git diff --check` | Passed | No whitespace errors. |
| Route import validation | Passed | Imported 386 API route files. |
| Browser smoke | Not available | Browser automation tooling was not exposed in this thread. |

## Final Recommendation

The two final-hardening changes do reduce broad first-render/list-loading risk:

- Stores Issue job-card lookup is now capped and compact.
- Job Card New purchase-order first render/search is now capped.

Build status is green after the prior blocker fix. The branch is ready for manual QA. Staging deploy should wait for authenticated browser/manual smoke of Stores Issue and Job Card New, especially verifying that users can find POs/job cards beyond the initial capped first page by typing search text.

