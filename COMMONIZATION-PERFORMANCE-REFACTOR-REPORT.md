# Commonization Performance Refactor Report

## 1. Summary of what was commonized

- Added shared Indian display formatting helpers for INR, Indian-grouped integers/numbers, Indian date/date-time display, status text normalization, and label-part joining.
- Centralized billing short/excess tolerance flag calculation into the dispatch/packing helper so Bill Detail and New Bill use the same tolerance math.
- Added shared API list limit clamping and used it in customer/carton list endpoints to keep oversized or invalid list requests bounded while preserving defaults.
- Added shared material display/extraction helpers for material description labels, size labels, linked material refs, and linked material ids.
- Replaced duplicated frontend row formatting in Billing, Bill Detail, New Bill reconciliation, Inventory Stock, and Incoming PO log display with shared helpers.
- Replaced duplicated backend linked-material extraction in paper warehouse and vendor PO routes with shared helpers.

## 2. Files changed

Files touched by this commonization pass:

- `src/lib/display-formatters.ts`
- `src/lib/api-list-params.ts`
- `src/lib/material-display.ts`
- `src/lib/dispatch-packing.ts`
- `src/app/(dashboard)/billing/page.tsx`
- `src/app/(dashboard)/billing/[id]/page.tsx`
- `src/app/(dashboard)/billing/new/page.tsx`
- `src/app/(dashboard)/inventory/components/StockTab.tsx`
- `src/app/(dashboard)/inventory/components/IncomingTab.tsx`
- `src/app/api/cartons/route.ts`
- `src/app/api/customers/route.ts`
- `src/app/api/inventory/paper-warehouse/route.ts`
- `src/app/api/inventory/paper-warehouse/open-pos/route.ts`
- `src/app/api/masters/materials/route.ts`
- `src/app/api/procurement/vendor-pos/[id]/route.ts`

Note: the worktree already contained other modified/untracked files before this pass. Those unrelated changes were left intact and not reverted.

## 3. Helpers/components added

- `src/lib/display-formatters.ts`
  - `formatIndianNumber`
  - `formatIndianInteger`
  - `formatInr`
  - `formatDateIn`
  - `formatDateTimeIn`
  - `statusText`
  - `joinLabelParts`
- `src/lib/api-list-params.ts`
  - `clampListLimit`
- `src/lib/material-display.ts`
  - `materialDescriptionLabel`
  - `materialSizeDisplay`
  - `linkedMaterialRefs`
  - `linkedMaterialIds`
- `src/lib/dispatch-packing.ts`
  - `computeToleranceFlag`

No shared visual table component was introduced; this pass intentionally kept existing JSX/table markup in place.

## 4. Pages migrated

- Billing list page: shared date, whole-INR, and quantity formatting.
- Bill Detail page: shared INR/quantity formatting and shared reconciliation tolerance flagging.
- New Bill page: shared INR/quantity formatting and shared reconciliation tolerance flagging.
- Inventory Stock tab: shared quantity formatting and board/GSM label joining.
- Inventory Incoming tab: shared quantity, date/time, and status text formatting for incoming PO summaries and PO log modal content.

## 5. Backend query/load improvements

- `/api/customers` now uses shared list-limit clamping with the same default/max behavior.
- `/api/cartons` now uses shared list-limit clamping with the same default/max behavior. New Bill already requests the bounded carton catalogue limit instead of the old oversized request.
- `/api/inventory/paper-warehouse` now uses shared linked-material id extraction and size label formatting.
- `/api/inventory/paper-warehouse/open-pos` and `/api/procurement/vendor-pos/[id]` now use shared linked-material ref extraction.
- `/api/masters/materials` now uses shared material description label construction.

## 6. What was intentionally not changed for UX safety

- No CSS classes, table structure, modal positioning, routes, labels, permissions, or workflows were intentionally changed in this pass.
- No generic table renderer was introduced because that would risk visible layout drift.
- Existing page-specific JSX, buttons, row click behavior, and modal behavior were left in place.
- Existing API response field names were preserved.
- Existing warning-style flows were not converted into hard blockers.
- Existing unrelated dirty worktree changes were not reverted or folded into this refactor.

## 7. Verification commands run and results

- `npm run typecheck` - passed.
- `npx prisma validate` - passed.
- `git diff --check` - passed.
- `npx next lint` - completed with existing warnings. No new blocking lint errors were reported.
- Changed route import validation with `npx tsx -e "(async () => { ... })()"` - passed.
- `npx next build` - attempted. It reached production build after config warnings, then hung after Google font download retry messages (`fonts.gstatic.com` socket/reset failures). The hanging `next build` processes were stopped and confirmed gone.

`npm run build` was not used because this repo's build script runs `prisma migrate deploy`, which was avoided to honor the no-deploy/no-commit safety instruction.

## 8. Remaining safe future commonization opportunities

- Extend `formatIndianInteger`, `formatInr`, and `joinLabelParts` across PO, GRN, Dispatch, Short & Excess, Reports, Planning, and Production tables.
- Add a string-array PO-line id extractor for legacy `linkedPoLineIds: string[]` uses in procurement lead-buffer and weight reconciliation code.
- Gradually centralize stock row search text, stock badge/status text, and warehouse KPI number formatting.
- Centralize bill/invoice line math only after confirming the current discount, HSN, UOM, and persisted amount behavior end to end.
- Add shared pagination/search param helpers to list endpoints that still parse `limit`, `page`, `q`, and `sort` inline.
- Add focused tests for `computeToleranceFlag`, `clampListLimit`, and linked material extraction.

## 9. Deployment note

No deployment or commit was performed.

Because this pass changes shared frontend and backend TypeScript modules and API route imports, a normal app rebuild/restart or redeploy is required for production to pick up the changes. No Prisma schema change was made and no database migration is required by this pass.

## 10. Deployment Readiness Review

Status: conditionally ready for deployment after a clean production build retry. The commonization slice passed type, Prisma, diff whitespace, lint, route import, and helper behavior checks. The only blocking verification item observed in this review was external Google Fonts network failure/hang during `npx next build`.

Review scope:

- Read this report and reviewed the current git diff/status.
- Separated commonization-slice files from unrelated dirty worktree files.
- Reviewed touched commonization files for visible UI/UX, route, label, table column, modal, auth/permission, API contract, and business-logic drift.
- Found and fixed two deployment-safety drift risks before final review:
  - Bill Detail whole-number INR values were restored to the old loose `maximumFractionDigits: 2` display behavior via `formatInrLoose`.
  - New Bill carton catalogue loading was restored to the existing `limit=4000` request so the picker does not silently shrink the loaded customer catalogue.

Commonization-slice files reviewed:

- `src/lib/display-formatters.ts`
- `src/lib/api-list-params.ts`
- `src/lib/material-display.ts`
- `src/lib/dispatch-packing.ts`
- `src/app/(dashboard)/billing/page.tsx`
- `src/app/(dashboard)/billing/[id]/page.tsx`
- `src/app/(dashboard)/billing/new/page.tsx`
- `src/app/(dashboard)/inventory/components/StockTab.tsx`
- `src/app/(dashboard)/inventory/components/IncomingTab.tsx`
- `src/app/api/cartons/route.ts`
- `src/app/api/customers/route.ts`
- `src/app/api/inventory/paper-warehouse/route.ts`
- `src/app/api/inventory/paper-warehouse/open-pos/route.ts`
- `src/app/api/masters/materials/route.ts`
- `src/app/api/procurement/vendor-pos/[id]/route.ts`

Pre-existing or unrelated dirty worktree changes observed and not reviewed as part of the commonization slice:

- `next.config.js`
- `src/app/(dashboard)/inventory/components/BulkVendorPoDialog.tsx`
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/orders/designing/page.tsx`
- `src/app/(dashboard)/orders/purchase-orders/[id]/page.tsx`
- `src/app/(dashboard)/stores/short-excess/page.tsx`
- `src/app/api/inventory/grn/route.ts`
- `src/app/api/planning/po-lines/[id]/reserve-material/route.test.ts`
- `src/app/api/planning/po-lines/[id]/reserve-material/route.ts`
- `src/app/api/planning/po-lines/route.ts`
- `src/app/api/short-excess/route.ts`
- `src/lib/emboss-conditions.ts`
- `src/lib/material-readiness-service.ts`
- `src/lib/plate-engine.ts`
- `src/lib/pre-press-finalize.ts`
- `src/lib/production-os-resolvers.ts`
- `tsconfig.tsbuildinfo`
- Untracked existing items: `PERFORMANCE-REDUNDANCY-CLEANUP-REPORT.md`, `STACK-WORKTREE-PERFORMANCE-AUDIT-SOLUTION.md`, `SUPABASE-TIMEZONE-QUERY-COMPARISON-REPORT.md`, `logs/`, `src/lib/timezones.ts`

Verification rerun in this deployment-safety review:

- `npm run typecheck` - passed.
- `npx prisma validate` - passed.
- `git diff --check` - passed.
- `npx next lint` - completed successfully with existing warnings only; no blocking lint errors.
- Changed API route import validation - passed.
- Helper behavior probes for `computeToleranceFlag`, `clampListLimit`, `linkedMaterialRefs`, `materialDescriptionLabel`, `materialSizeDisplay`, and `formatInrLoose` - passed.
- `npx next build` - attempted again. It reached `Creating an optimized production build ...`, then showed external Google Fonts network errors from `fonts.googleapis.com` (`ECONNRESET`, socket hang up) and hung after retries. The stuck build processes were stopped and confirmed gone.

Smoke testing:

- Browser automation was not callable in this session after tool discovery, so interactive browser smoke tests for Billing, New Bill, Bill Detail, Inventory Stock, and Incoming PO logs were not performed.
- API route smoke was covered by changed route import validation. Runtime API calls requiring an authenticated app session were not exercised here.

Deployment conclusion:

- The commonization slice is deployment-safe from static/type/import/helper-review perspective after the two drift fixes above.
- The only observed blocker for this slice is the external Google Fonts/network build hang. No code compile error surfaced before the build hung.
- A deployment should wait for one clean `npx next build` or equivalent CI build in an environment that can fetch/cache the configured fonts.
- If deploying the entire current dirty worktree, the pre-existing unrelated modified files listed above need owner review because they were outside this commonization deployment-safety review.
