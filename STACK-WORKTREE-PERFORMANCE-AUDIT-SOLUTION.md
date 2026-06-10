# Stack And Worktree Performance Audit Solution

Date: 2026-06-03

## Executive Summary

The confirmed slow query `SELECT name FROM pg_timezone_names` is still the single biggest known historical DB offender, but the latest comparison showed no new calls since the previous inspection. The broader app slowdown risk now comes from full-list UI patterns: job cards, paper warehouse, planning warehouse selectors, and production/store screens that fetch broad datasets and filter locally.

The safest solution is not a blanket deletion/refactor. It is a staged cleanup:

1. Keep timezone data static: `['Asia/Kolkata']`.
2. Replace full-list endpoints with paginated list + compact summary + detail endpoints.
3. Gate heavy APIs by active tab/modal.
4. Clean local git/worktree clutter only when branches are merged and worktrees are clean.

## DB Query Findings

Current DB `pg_stat_statements` top-time evidence:

| Query / Source | Calls | Total Time | Mean | Finding |
|---|---:|---:|---:|---|
| `SELECT name FROM pg_timezone_names` | `95` | `18,479.4 ms` | `194.5 ms` | Historical issue; no new calls since previous check. |
| Supabase/dashboard introspection queries | low calls | high total | high mean | Mostly internal inspection/logging/catalog queries, not app render paths. |
| Prisma relation reads for PO lines/customers/cartons/material queue | high calls | low mean | low mean | Repetition points to N+1-style UI/API patterns. |
| Inventory dimension query | `540` | `232.4 ms` | `0.4 ms` | Cheap individually but repeated; should be cached or scoped. |

Latest timezone comparison:

- Previous calls: `95`
- Recent calls: `95`
- Delta: `0`

Conclusion: the timezone query is dormant right now, but the deployed/root caller has not been proven fixed because no local call site exists.

## Immediate Time Reduction Solution

### 1. Timezone Query

Current local mitigation exists:

```ts
export const TIMEZONE_OPTIONS = ['Asia/Kolkata'] as const
```

Required final fix:

- Inspect deployed build or other Supabase-connected clients.
- Replace any timezone DB/RPC call with `TIMEZONE_OPTIONS`.
- Never query `pg_timezone_names` from UI render paths, hooks, API routes, widgets, selectors, or RPCs.

Optional monitoring:

- Reset `pg_stat_statements` only after a release window if you want a clean before/after baseline.
- Re-check after exercising date/timezone UI. If calls remain `95`, issue is inactive.

### 2. Job Cards

Risk found:

These UI paths still fetch broad `/api/job-cards` lists:

- `src/app/(dashboard)/billing/new/page.tsx`
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/stores/issue/page.tsx`
- `src/app/(dashboard)/orders/designing/page.tsx`
- `src/app/(dashboard)/production/cutting-queue/page.tsx`
- `src/app/(dashboard)/production/job-cards/new/page.tsx`

Recommended API contract:

```text
GET /api/job-cards?page=1&pageSize=50&q=&status=&segment=&customerId=&sort=jobCardNumber.desc
```

Response:

```ts
{
  rows: JobCardListRow[]
  page: number
  pageSize: number
  total: number
}
```

Implementation rules:

- Default `pageSize=50`, max `100`.
- Keep `yieldMetrics=1` off by default; load yield only in detail drawer or explicit dashboard card.
- Return lightweight list fields only.
- Move audit timeline, stage history, material timeline, PDF data, and deep PO line context to detail endpoints.
- Debounce search at 300 ms.

Expected impact:

- Faster production/job-card screens.
- Lower DB call count for repeated Prisma relation fetches.
- Less client-side filtering and sorting work.

### 3. Paper Warehouse

Risk found:

`/api/inventory/paper-warehouse` computes a full warehouse snapshot, KPI, open PO state, open PR state, and days-of-cover in one response. These UI paths fetch it broadly:

- `src/components/planning/engine/SectionSmartMatch.tsx`
- `src/components/planning/engine/WarehousePopup.tsx`
- `src/components/planning/PlanningWarehouseModal.tsx`

Recommended split:

```text
GET /api/inventory/paper-warehouse/summary
GET /api/inventory/paper-warehouse?page=1&pageSize=50&q=&boardType=&gsm=&status=
GET /api/inventory/paper-warehouse/:id/details
GET /api/inventory/paper-warehouse/search?q=&limit=20
```

Implementation rules:

- Summary endpoint returns only KPI totals.
- List endpoint returns only visible table columns.
- Detail endpoint loads logs, reservations, shortages, PR/PO history only after row click.
- Smart-match and warehouse popup should use search/scoped candidates, not full warehouse.

### 4. Carton Catalogue

Already improved locally:

- `/api/cartons` default limit reduced from `4000` to `280`.
- Max limit reduced from `8000` to `500`.
- Search cap reduced to `100`.
- Recent order rows per carton reduced from `25` to `8`.

Next improvement:

- Return paginated metadata for admin/master table views.
- Keep autocomplete result size `20`.
- Move full previous-order history to `/api/cartons/:id/po-specs` or detail endpoint.

## Stack Audit

### Frontend

Main risk patterns:

- Broad fetch on mount.
- Client-side filtering after full list load.
- Heavy child tabs loading even when inactive.
- Details/history loaded before row click.

Fix standard:

- Use active-tab-gated queries.
- Use React Query stale times for stable master data.
- Use debounced search.
- Use detail drawers/modals for deep data.
- Add skeletons for table/list loads.

### API

Main risk patterns:

- Endpoints returning arrays with no pagination contract.
- Summary/KPI calculations coupled to full list payloads.
- Raw SQL endpoints without `limit/page` support.

Fix standard:

- Every table endpoint gets `page`, `pageSize`, `q`, and max limit clamp.
- Every dashboard card gets compact summary endpoint.
- Every detail panel gets a detail endpoint.
- Add slow request logging above `500 ms`.

### Database

Main risk patterns:

- Historical `pg_timezone_names` catalog lookup.
- Repeated relation reads that suggest N+1-style list hydration.
- Full warehouse and job-card list hydration.

Fix standard:

- Avoid system catalog queries in app paths.
- Add indexes only after measuring exact app filters.
- Prefer focused `select` clauses over `include` trees in list APIs.
- Use DB aggregation for summary cards.

## Worktree And File Audit

### Already Cleaned

- Removed `.next` build cache.
- Removed OS metadata and Office lock files.
- Removed 20 clean, unlocked `.claude` worktrees.
- Removed 5 untracked standalone DB-mutating smoke workflow scripts.

### Remaining Local Clutter

| Item | Size / Count | Status | Action |
|---|---:|---|---|
| `.claude` | about `2.9G` | 10 worktrees remain | Do not delete blindly; all remaining are dirty or locked. |
| `node_modules` | about `882M` | needed for local dev | Keep. |
| `logs/` | about `12K` | query audit logs | Keep or archive after review. |
| `.git/*.lock.bak` | 4 files | internal backup lock files | Safe to remove after ensuring no git process is running. |

### Remaining Worktrees

All remaining `.claude/worktrees/*` are dirty or locked:

- `agent-a21ec071ed1033cf7`: locked
- `crazy-feistel-424452`: dirty
- `great-black-58d238`: dirty
- `happy-knuth-b14524`: dirty
- `nifty-jang-40f02a`: dirty
- `planning-engine-on-po-fixes`: dirty
- `planning-engine-rebuild`: dirty
- `silly-margulis-0c41fe`: dirty
- `warehouse-popup-fix`: dirty
- `zealous-dewdney-8b6f57`: dirty

Recommended action:

- Review each dirty worktree.
- Commit, stash, or intentionally discard each one.
- Then remove with `git worktree remove <path>`.

## Branch Audit

### Safe Candidates To Delete Locally After Review

These are merged into `staging-supabase` according to `git branch --merged staging-supabase`.

Keep:

- `staging-supabase`
- `main`

Review/delete candidates:

- `claude/crazy-feistel-424452`
- `claude/distracted-cartwright-4c5632`
- `claude/dreamy-mendeleev-430d4d`
- `claude/dreamy-spence-d95e81`
- `claude/elated-benz`
- `claude/happy-knuth-b14524`
- `claude/hopeful-meninsky-a9f304`
- `claude/hungry-yalow-8fb95e`
- `claude/inspiring-nobel-57f810`
- `claude/jovial-mclean-f70dca`
- `claude/nervous-tereshkova-04a92b`
- `claude/nifty-jang-40f02a`
- `claude/nostalgic-wu-e395a5`
- `claude/objective-tharp-457024`
- `claude/optimistic-banzai-a4e0c6`
- `claude/planning-deltas-staging`
- `claude/practical-cerf-6741f0`
- `claude/silly-margulis-0c41fe`
- `claude/vigilant-raman-1a8d44`
- `claude/wizardly-maxwell-9fbe89`
- `feat/board-alloc-inches-master`
- `feat/bulk-po-import`
- `feat/carton-master-overhaul`
- `feat/centralized-master-data`
- `feat/paper-warehouse-procurement-phase2`
- `feat/pr-kanban-procurement`
- `feat/production-pipeline-execution-flow`
- `fix/planning-engine`
- `fix/warehouse-popup-actions`
- `integration/theme-masters-planning`
- `planning-engine-rebuild`
- `po-import-ai-deep-fixes`
- `po-import-six-features`
- `worktree-agent-a21ec071ed1033cf7`

Important:

- Do not delete branches currently attached to dirty/locked worktrees until those worktrees are resolved.
- For remote-tracking branches, prune only after confirming PRs are merged/closed.

### Not Merged Into `staging-supabase`

These need review before deletion:

- `claude/admiring-mccarthy-4b2429`
- `claude/awesome-babbage-ee11d3`
- `claude/cranky-morse-4c5183`
- `claude/fervent-poincare`
- `claude/gifted-morse-e75712`
- `claude/great-black-58d238`
- `claude/smart-match-staging`
- `claude/vigilant-jackson-e1bf9a`
- `claude/zealous-dewdney-8b6f57`
- `feat/warehouse-manual-reserve`
- `feat/warehouse-row-procurement`
- `worktree-planning-engine-rebuild`

## Recommended Cleanup Commands

Use only after reviewing dirty worktrees:

```bash
git worktree list
git status --short
```

Remove a resolved worktree:

```bash
git worktree remove .claude/worktrees/<name>
```

Delete a merged local branch:

```bash
git branch -d <branch-name>
```

Prune stale remote-tracking refs:

```bash
git fetch --prune
```

Remove backup git lock files only when no git process is running:

```bash
rm -f .git/*.lock.bak .git/objects/*.lock.bak
```

## Priority Execution Plan

### Phase 1: Monitoring And Safety

- Keep current timezone query logs.
- Re-check `pg_stat_statements` after using date/timezone UI.
- Resolve dirty worktrees one by one.

### Phase 2: API Contract Fixes

- Add pagination to `/api/job-cards`.
- Update all `/api/job-cards` consumers to use server params.
- Split `/api/inventory/paper-warehouse`.

### Phase 3: Frontend Render Fixes

- Gate heavy tabs.
- Debounce search.
- Load detail data only on row click.
- Use skeletons and stale cache for stable master data.

### Phase 4: Branch/File Cleanup

- Delete merged local branches after dirty worktrees are resolved.
- Prune remote refs.
- Keep only active report/log artifacts.

## Expected Time Reduction

The biggest expected gains:

- Timezone selector: remove up to `~195 ms` average query cost per call if a deployed caller exists.
- Job cards: reduce first-load payload and repeated relation fetches by returning 50 lightweight rows instead of all cards with deep context.
- Paper warehouse: reduce planning popup and smart-match latency by fetching scoped candidates instead of full warehouse snapshots.
- Cartons: already reduced broad catalogue payload from up to thousands of cartons/history rows to capped lightweight batches.

## Validation Required After Implementation

- `npm run typecheck`
- `npx prisma validate`
- `npm run lint`
- Browser smoke tests:
  - Dashboard
  - Inventory / Warehouse
  - Purchase Orders
  - Billing
  - Production Job Cards
  - Stores Issue
  - Planning Engine

Track:

- API count per page load
- duplicate API calls
- first table row render time
- search latency
- tab switch latency
- failed network calls
- console errors
