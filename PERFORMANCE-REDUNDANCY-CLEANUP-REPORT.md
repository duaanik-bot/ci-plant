# Performance And Redundancy Cleanup Report

## Root Causes Found

- Supabase `pg_stat_statements` confirms `SELECT name FROM pg_timezone_names` has been executed repeatedly in the live database, but no local call site exists in this worktree.
- Several list flows still rely on broad client-side arrays and local filtering, especially job cards and paper warehouse views.
- The carton autocomplete/catalogue endpoint allowed very large payloads: default `limit=4000`, max `8000`, and `25` recent PO rows per carton.
- Some existing pages still fetch complete job-card or warehouse datasets on mount for local search, filters, bulk actions, or modal support.

## Files Changed

- `src/app/api/cartons/route.ts`
- `src/app/(dashboard)/billing/new/page.tsx`
- `src/app/(dashboard)/orders/purchase-orders/[id]/page.tsx`
- `src/lib/timezones.ts`
- `PERFORMANCE-REDUNDANCY-CLEANUP-REPORT.md`

## Database / Query Issues Found

Supabase DB stats showed this exact query:

```sql
SELECT name FROM pg_timezone_names
```

Observed stats:

- Calls: `95`
- Total execution time: `18,479.434 ms`
- Mean execution time: `194.520 ms`
- Max execution time: `2,595.723 ms`
- Rows returned total: `113,620`
- Stats reset timestamp: `2026-05-19 10:36:45 UTC`

This is a confirmed live DB issue. It is expensive and should not run from UI render paths, hooks, selectors, widgets, or repeated API calls.

## Timezone Query Investigation Result

Local searches were performed for:

- `pg_timezone_names`
- `pg_catalog.pg_timezone_names`
- `get_timezones`
- `timezone_names`
- `timezone`
- `time_zone`
- `timeZone`
- Supabase RPC patterns
- Prisma `$queryRaw` / `$queryRawUnsafe` timezone patterns

No local call site was found. Because the DB stats prove the query exists but the worktree does not contain it, the likely source is one of:

- A deployed branch/build that differs from this local checkout.
- Another app, service, script, dashboard widget, or external client connected to the same Supabase project.
- A generated/dependency path not present in this repository snapshot.

Added a static constant for the intended local replacement:

```ts
export const TIMEZONE_OPTIONS = ['Asia/Kolkata'] as const
```

No local UI wiring was changed because no timezone selector/date-picker call site exists in this worktree.

## Redundancy Removed

No UI tabs/buttons/pages were removed in this pass. The prompt asks to remove only confirmed stale, duplicate, unused, or unreachable code. This audit did not establish a safe removal target within the timeboxed local pass.

## Table-Load Improvements

`GET /api/cartons` was tightened:

- Default limit reduced from `4000` to `280`.
- Max limit reduced from `8000` to `500`.
- Search result query cap reduced from up to `800` to up to `100`.
- Returned previous-order history per carton reduced from `25` queried PO line rows to `8`.

Callers updated:

- New invoice carton catalogue load changed from `limit=4000` to `limit=280`.
- Edit purchase order carton catalogue load changed from `limit=4000` to `limit=280`.

Remaining table-load risks:

- `/api/job-cards` still returns an array and has no response metadata or server-side pagination contract.
- Several job-card consumers fetch all job cards for local filtering or action context.
- `/api/inventory/paper-warehouse` still computes a full warehouse row set plus KPI data in a single endpoint.

## Widget-Load Improvements

No dashboard/widget endpoint was changed in this pass. The audit found the architectural risk: widgets should use compact summary endpoints rather than full list endpoints, but implementing that safely requires per-module contracts and UI updates.

## APIs Optimized

- `/api/cartons`

This endpoint is used by carton autocomplete/catalogue workflows. The response remains an array for compatibility, but large catalogue payloads are now clamped.

## Modules Tested

Static/code validation performed:

- Local source search for timezone query and related patterns.
- Local source search for broad `limit=4000` / `limit=5000` patterns.
- Diff review for changed files.
- `npm run typecheck` passed.
- `npx prisma validate` passed.
- `npm run lint` passed with pre-existing warnings.

Browser smoke tests across all modules were not completed in this pass.

`npm run build` was not run because the project build script executes `prisma migrate deploy` against the configured Supabase database. This cleanup did not require a schema change, and running deployment migrations would be outside the safe/no-schema-change scope.

## Before / After Timings

Measured Supabase timezone DB stat before code changes:

- `SELECT name FROM pg_timezone_names`: mean `194.520 ms`, max `2,595.723 ms`.

No before/after browser timing was measured for the local UI. The carton endpoint change reduces requested row counts and joined history rows, but exact load-time impact should be measured against production data after deployment.

## Remaining Risks

- The confirmed timezone query is not fixed in this local worktree because its call site is absent.
- Deployed code or another connected Supabase client must be inspected to remove the live timezone DB lookup.
- Job-card, paper warehouse, production queue, stores issue, planning warehouse modal, and cutting queue flows still have all-list fetch patterns.
- Introducing true server-side pagination requires UI pagination state, stable query params, active-tab gating, and updated bulk-action behavior.

## Deployment Notes

- No database schema change was made.
- No Prisma migration was added.
- The `/api/cartons` response shape remains an array.
- Existing callers asking for `limit=4000` were changed to `limit=280`.
- Any external caller requesting more than `500` cartons will now be clamped.

## Next Recommended Fixes

1. Inspect the deployed branch/build and any other Supabase-connected clients for `SELECT name FROM pg_timezone_names`.
2. Replace the deployed timezone lookup with `TIMEZONE_OPTIONS` from `src/lib/timezones.ts`.
3. Add server-side pagination contracts to `/api/job-cards` and update current consumers incrementally.
4. Split `/api/inventory/paper-warehouse` into compact list, summary/KPI, and detail endpoints.
5. Convert job-card and warehouse search/filter state into debounced server query params.
6. Add lightweight slow API logging for requests over `500 ms` if not already present in the deployment stack.
