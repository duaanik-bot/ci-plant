# Performance Commonisation Phase 1 Implementation Report

Date: 2026-06-10

## Executive summary

Phase 1 has been implemented as a conservative speed foundation. The changes add shared list parameter helpers, bounded first-render API loading, compact list contracts, and low-noise performance logging for the highest-priority routes from `PERFORMANCE-COMMONISATION-AUDIT-REPORT.md`.

No Prisma schema, migration, permission, auth, tax/GST, GRN costing, planning reservation, production OEE/yield calculation, procurement landed-cost, or supplier score logic was intentionally changed for this phase.

The working tree already contained many unrelated edits before/during this work. This report scopes the Phase 1 implementation to the list-loading and caller changes below.

## Files changed for Phase 1

Shared helper:

- `src/lib/api-list-params.ts`

API routes:

- `src/app/api/job-cards/route.ts`
- `src/app/api/purchase-orders/route.ts`
- `src/app/api/inventory/paper-warehouse/route.ts`
- `src/app/api/inventory/paper-warehouse/open-pos/route.ts`
- `src/app/api/bills/route.ts`
- `src/app/api/short-excess/route.ts`
- `src/app/api/production/stages/[stageKey]/route.ts`

First-render callers:

- `src/app/(dashboard)/orders/purchase-orders/page.tsx`
- `src/app/(dashboard)/production/job-cards/page.tsx`
- `src/app/(dashboard)/production/cutting-queue/page.tsx`
- `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/billing/page.tsx`
- `src/app/(dashboard)/billing/new/page.tsx`
- `src/app/(dashboard)/billing/[id]/page.tsx`

## Exact APIs improved

### `GET /api/job-cards`

Before:

- Returned the full matching job-card list by default.
- Included nested stages and PO-line enrichment for every row.
- Cutting Queue fetched the broad job-card list and filtered client-side.

After:

- Supports `page`, `limit`, `mode=compact`, `compact=1`, `export=true`, and `paged=1`.
- Default non-export limit is clamped to 150, max 500.
- `export=true` is the explicit escape hatch for larger payloads.
- `segment=cutting` now narrows the API result to jobs with a Cutting stage before returning rows.
- Compact mode returns first-table fields only and trims stage data to visible row metadata.
- Paged/compact calls return `{ rows, meta }`; legacy non-paged callers still receive an array.

### `GET /api/purchase-orders`

Before:

- Returned all matching POs with all line items.
- First render calculated readiness/tooling across every returned PO.

After:

- Supports `page`, `limit`, `q`, `sort`, `mode=compact`, `compact=1`, `export=true`, and `paged=1`.
- Default non-export limit is clamped to 100, max 500.
- Compact mode selects header fields, customer, and minimal line item fields required for list readiness/tooling/value display.
- Paged calls include a `total` count and `hasMore`.
- Legacy array response remains available for old callers.

### `GET /api/inventory/paper-warehouse`

Before:

- Broad first-render load could return every stock row and KPI-enriched row together.

After:

- Supports `page`, `limit`, `rowsOnly`, `compact=1`, `mode=compact`, `export=true`, and `paged=1`.
- Default non-export limit is clamped to 150, max 500.
- `rowsOnly`/compact mode slices returned rows for first render.
- Full mode still keeps KPI behavior, but returned rows are limited unless `export=true`.

### `GET /api/inventory/paper-warehouse/open-pos`

Before:

- Returned all open PO lines with nested PO/material context.

After:

- Supports `page`, `limit`, `q`, `compact=1`, `mode=compact`, `export=true`, and `paged=1`.
- Default non-export limit is clamped to 100, max 300.
- Compact mode omits nested `lineItems`.
- Legacy array response remains available for old callers.

### `GET /api/bills`

Before:

- Billing list could load all bills with line items.

After:

- Supports `page`, `limit`, `q`, `compact=1`, `mode=compact`, `export=true`, and `paged=1`.
- Default non-export limit is clamped to 100, max 300.
- Compact mode trims bill line item selection to fields used by the first visible list.
- Legacy array response remains available for old callers.

### `GET /api/short-excess`

Before:

- `status=all` could return all short/excess records.
- Bill detail reconciliation called the global list and filtered indirectly.

After:

- Supports `page`, `limit`, `billId`, `jobCardId`, `poLineItemId`, `compact=1`, `mode=compact`, `export=true`, and `paged=1`.
- Default non-export limit is clamped to 100, max 300.
- Bill detail now asks for the relevant bill-scoped short/excess records.
- Legacy array response remains available for old callers.

### `GET /api/production/stages/[stageKey]`

Before:

- Returned the full stage board payload for first render.

After:

- Supports `page`, `limit`, `compact=1`, `mode=compact`, and `export=true`.
- Default non-export limit is clamped to 150, max 400.
- Returned `jobCards` are sliced unless `export=true`.
- Compact mode trims each stage-board job card to first-render row fields.
- Existing stage metrics and calculations are preserved.

## Before/after loading behavior

| Area | Before | After | Expected gain |
|---|---|---|---|
| Purchase Orders | Full PO list and all line items on first render. | First render requests `mode=compact&paged=1&limit=100`. | High: smaller JSON and bounded readiness/tooling work. |
| Job Cards | Full job-card list with nested relations. | First render requests `mode=compact&paged=1&limit=150`. | High on large production datasets. |
| Cutting Queue | Broad job-card list, then browser filters to cutting rows. | API receives `segment=cutting&mode=compact&limit=200`. | High: fewer rows sent to the browser. |
| Inventory | Job-card picker/support load could request broad job-card list. | Inventory first-render job-card request is compact and limited. | Medium: avoids a wide support payload. |
| Billing list | Potentially full bill list and line items. | Billing list requests `compact=1&paged=1&limit=100`. | Medium. |
| New Bill | Broad job-card list on load. | Job-card request is compact and limited to 300. | Medium; Phase 2 should replace this with search. |
| Bill detail | Global short/excess fetch. | Bill-scoped compact short/excess fetch. | Medium. |
| Stage board | Full board returned by default. | First render asks for a bounded job-card page. | Medium-High. |

## Response-shape changes

- Compact and explicitly paged calls return:

```json
{
  "rows": [],
  "meta": {
    "page": 1,
    "limit": 100,
    "total": null,
    "hasMore": false,
    "mode": "compact"
  }
}
```

- Existing non-compact/non-paged calls still return the previous array/object shape where practical.
- `export=true` bypasses normal first-render caps, while still flowing through route auth and existing logic.
- First-render callers updated in this phase now handle both legacy arrays and paged `{ rows }` envelopes.

## Performance logging

Added route-level list diagnostics through `logListPerformance`:

- route name
- elapsed milliseconds
- row count
- effective limit
- mode
- export flag

Logging is intentionally low detail and does not include sensitive payload values. In production it only logs slow list calls by default; in development it logs useful diagnostics for tuning.

## Backward compatibility notes

- Old callers that do not send `compact=1`, `mode=compact`, or `paged=1` still receive the prior broad response style.
- No endpoint path was removed or renamed.
- No database schema or migrations were changed.
- No permission/auth checks were removed.
- Detail pages and existing full-detail routes remain responsible for full nested data.
- The Phase 1 caller changes use defensive parsing so they accept both old arrays and new paged envelopes.

## Risks and mitigations

| Risk | Level | Mitigation |
|---|---|---|
| A table may previously have relied on seeing every row immediately. | Medium | First-render callers were changed only where safest; `export=true` and legacy calls remain available. |
| Some pages may need visible pagination controls to reach beyond the first capped page. | Medium | Phase 1 only creates the API contract. Phase 2 should add UI pagination/search where needed. |
| Compact DTO may omit a field a row action assumes exists. | Medium | Updated callers parse compact rows only in first-render paths; detail/full behavior remains available. Typecheck passed. |
| Stage route still computes the full cached board before slicing. | Medium | This phase reduces response payload first. Query-level slicing and lane-gated enrichments are left for Phase 2 to avoid calculation risk. |
| Paper warehouse full mode still computes KPI context over broader data. | Medium | Returned row payload is capped now; splitting KPI/list/detail is a Phase 2 item. |
| Dirty working tree contains unrelated changes. | Medium | This report scopes implementation files and does not claim unrelated changes as Phase 1 work. |

## Verification results

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | Passed | `tsc --noEmit` completed successfully. |
| `npx prisma validate` | Passed | Prisma schema is valid. |
| `npx next lint` | Passed with warnings | Existing lint warnings remain, mostly hook dependencies, `<img>` usage, and a11y warnings. |
| `git diff --check` | Passed | No whitespace errors reported. |
| API route import validation | Passed | Imported 352 `src/app/api/**/route.ts` files successfully. |
| `npx next build` | Failed after compile | Production compile succeeded, then page data collection failed with `PageNotFoundError: Cannot find module for page: /_document`. `npm run build` was not used because it runs `prisma migrate deploy`. |
| Browser smoke | Could not run | Browser-control tooling was not exposed in this session. No deployment/server smoke was attempted. |

## Remaining Phase 2 items

- Add visible pagination/search controls for compact/paged tables that currently consume only the first page.
- Replace New Bill's broad job-card load with customer/job-card search and on-demand selection.
- Move Cutting Queue and Stage Board deeper filtering into route-level query constraints instead of post-fetch slicing where calculations allow.
- Split Inventory Paper Warehouse into list, KPI, and detail/on-demand contracts.
- Add tab-gated loading for inventory tabs and procurement/hub dashboards.
- Move reports and exports toward UI row caps plus server-side export generation.
- Start commonising duplicated table-state patterns only after the Phase 1 contracts are accepted.

## Do-not-touch areas respected

- Billing tax/GST/rounding logic.
- GRN quantity/costing math.
- Planning reservation/release logic.
- Production OEE/yield calculations.
- Procurement landed cost and supplier score logic.
- Prisma schema and migrations.
- Auth and permission checks.
- Existing user workflow and visual layout.

## Final action plan after approval

1. Review Phase 1 route contracts with real page usage and confirm default limits.
2. Add explicit pagination/search UI to Purchase Orders, Job Cards, Bills, and Stage Boards.
3. Convert Billing New Bill and GRN PO/material pickers to search-first loading.
4. Split Inventory Paper Warehouse KPI/list/detail payloads.
5. Add small shared table-state utilities for sort, selection, empty/loading rows, and paged metadata.
6. Migrate one table at a time to shared state utilities without visual redesign.
7. Re-run full verification after each module, keeping calculations and workflows unchanged.

## Deployment and git status

- Not deployed.
- Not committed.
- No Prisma migration command was run.
- No Phase 2 or Phase 3 refactor was performed.
