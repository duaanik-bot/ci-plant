# Planning Page Performance Audit

Date: 2026-06-09

## Current Bottlenecks Found

- Initial load calls `/api/planning/po-lines` and waits for a single heavy response before rendering the workspace.
- The planning list route previously returned every root scalar on `po_line_items` because the query used `include`; this pulled fields not needed by the grid.
- The same route performed one production job-card query per PO line when `jobCardNumber` existed.
- The same route performed one stock-movement reservation lookup per line with a selected planning material.
- The list route loaded all active inventory, all positive paper warehouse rows, all active FG rows, and all machines before mapping every line.
- Main-page search is client-side over the loaded dataset, so first load still pays for the whole dataset.
- Grid rendering is paginated to 25/50/100 rows, which helps DOM size, but all rows are still sorted, grouped, scored, and searched in memory.
- Detail modal/drawer behavior is mostly lazy, but opening planning detail can call reservation-control, gang-candidates, reserve-material, material masters, and paper warehouse fallback/detail endpoints.
- Warehouse modal, warehouse popup, and Smart Match fetch `/api/inventory/paper-warehouse` with no compact planning mode, causing unnecessary KPI/consumption work for planning-only pickers.
- Several save/action flows refresh the full planning list after each mutation, which is safe but can feel slow after row-level actions.

## Exact Files Changed

- `src/app/(dashboard)/orders/planning/page.tsx`
- `src/components/planning/PlanningJobDetailDrawer.tsx`
- `src/components/planning/PlanningWarehouseModal.tsx`
- `src/components/planning/engine/SectionSmartMatch.tsx`
- `src/components/planning/engine/WarehousePopup.tsx`
- `src/app/api/planning/po-lines/route.ts`
- `src/app/api/inventory/paper-warehouse/route.ts`
- `PLANNING-PAGE-PERFORMANCE-AUDIT.md`

Note: the worktree already contained many unrelated edits in planning and inventory files. The list above is the file set touched for this audit/fix pass.

## API Calls Optimized

- `/api/planning/po-lines`
  - Added slow API logging over 500 ms.
  - Added optional `limit` clamping with a maximum of 600 while preserving the unbounded default for existing callers.
  - Planning page now requests `limit=300` for compact first-load behavior.
  - Replaced broad root scalar loading with explicit `select`.
  - Batched production job-card lookup by `jobCardNumber` instead of one query per line.
  - Batched selected-material stock-movement reservation totals instead of one reservation helper call per selected line/material.
- `/api/inventory/paper-warehouse?rowsOnly=1`
  - Added a real compact mode for planning warehouse pickers.
  - Compact mode returns after the inventory rows query and skips open PO fanout, purchase requisition scan, KPI aggregation, and days-of-cover calculation.

## Query/Payload Reductions

- Planning list no longer returns unused PO-line root fields such as GST, HSN, director broadcast timestamps, height, lock flags, and other full record scalars.
- Planning list keeps only the relation fields used by the page/grid/modal summary.
- Job-card and reservation lookups are set-based instead of per-line.
- Warehouse planning picker calls now avoid procurement status enrichment and consumption calculations.

## Frontend Render Fixes

- Planning first load now explicitly requests compact list data with `limit=300`.
- Planning search uses `useDeferredValue`, keeping typing and tab switching smoother while the grid filters the current loaded rows.
- Existing grid pagination remains in place at 25/50/100 rows.

## Search/Filter Fixes

- Kept current client-side search behavior for the loaded compact set.
- Deferred the search query to reduce synchronous render pressure on each keystroke.
- Server-side search remains a recommended follow-up if the planning queue grows beyond the compact limit.

## Calculation Fixes

- No business calculation formulas were changed in this pass.
- Requirement, cut-plan, reservation, release, reverse, push-to-production, and material requirement logic were preserved.
- Reservation availability in the planning list now uses batched stock-movement totals for the selected planning material, matching the existing helper semantics without per-row calls.

## Prioritized Fixes

### Phase 1: logging and measurement

- Add slow API logging for planning list requests over 500 ms.
- Record response row count and elapsed time for before/after observations.

### Phase 2: backend payload/query optimization

- Replace broad root `include` list query with explicit `select`.
- Clamp list limits and default the grid to compact first-load data.
- Batch production job-card lookup by job-card number.
- Batch selected-material reservation totals from stock movements.

### Phase 3: frontend render/list optimization

- Keep grid pagination active.
- Avoid refetching more rows than the grid needs for normal first load.
- Defer deeper analysis to the existing center modal/drawer.

### Phase 4: search/filter optimization

- Keep lightweight client-side search for the loaded compact result.
- Add server-side search/pagination later if the planning queue regularly exceeds the clamp.

### Phase 5: modal/detail lazy loading

- Preserve existing lazy detail loading.
- Convert planning warehouse pickers to compact warehouse fetches where safe.

### Phase 6: verification and regression testing

- Run typecheck and targeted planning tests.
- Run build/lint where feasible.
- Smoke test `/orders/planning`: first load, search, filter/view switch, row click, center modal/drawer, reservation controls, push actions, and requirement calculation.

## Before/After Timing Observations

- `/api/inventory/paper-warehouse?rowsOnly=1`
  - Before the second compact-mode fix during smoke: 4.4-5.6 s, because the endpoint still performed open PO and purchase requisition work before returning compact rows.
  - After compact early return: 403 ms in the dev server log.
- `/api/planning/po-lines?limit=300`
  - After this pass: 3.6-3.9 s in dev server logs against the remote database, returning 21 rows with 8 batched job cards and 6 batched selected-material reservation totals.
  - The route still logs as slow, so remaining backend work is real: inventory/material scans, paper warehouse scan, FG matching, and repeated dev Strict Mode loads remain visible.
- Browser smoke:
  - `/orders/planning` rendered the Planning workspace and grid.
  - Search for `00870` narrowed the grid to the expected two NICODUCE rows.
  - Row click opened the Planning Engine modal with Product Info, Cut Plan, Smart Match, Warehouse, and Reserve-related surfaces visible.

## Risks Or Pending Follow-Ups

- The list route still does several whole-table support reads (`inventory`, FG inventory, paper warehouse, machines). Next phase should add compact material indexes or grouped aggregate queries for these.
- Main page still refreshes the full compact list after many actions; row-level optimistic updates or targeted row refetches would improve action responsiveness.
- Detail modal opening still triggers multiple calls (`reserve-material`, `gang-candidates`, `masters/materials`, compact warehouse). These should be staged by active section or cached per modal session.
- React dev Strict Mode produced duplicate planning list calls during browser smoke. Production behavior should avoid the dev-only double mount, but the route should still be robust.
- I did not execute stock-mutating actions such as reserve/release/reverse stock or push-to-production in the live browser smoke. I verified the modal/action surfaces were present without changing production-like data.

## Verification Commands And Results

- `npx tsc --noEmit --pretty false` - passed.
- `npm run lint` - passed with existing warnings across the repo.
- `npx vitest run 'src/app/api/planning/po-lines/[id]/reserve-material/route.test.ts' 'src/app/api/planning/po-lines/[id]/reservation-control/route.test.ts' 'src/app/api/planning/po-lines/[id]/gang-candidates/route.test.ts' src/components/planning/engine/planningRequirement.test.ts src/components/planning/engine/WarehousePopup.test.tsx` - passed, 33 tests.
- Broader targeted run including `src/components/planning/engine/PlanningEngineBody.test.tsx` - 33 passed, 1 failed. The failure expected a `Warehouse Availability` label that was not present in the current dirty component state.
- `npm run build` - compiled and type-checked, then failed during static prerender with a React RSC payload/version error on `/`, `/orders/planning`, and `/orders/purchase-orders`. This appears repo/build-environment level, not isolated to the changed route.
- Browser smoke on `http://localhost:3002/orders/planning` - passed for first load, search, row click, and modal visibility checks.
