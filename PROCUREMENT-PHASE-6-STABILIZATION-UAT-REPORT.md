# Procurement Phase 6 Stabilization, UAT, and Regression Hardening Report

Date: 2026-06-10
Scope: Stabilization and regression hardening only. No new modules, no new procurement screens, no schema changes, no deployment, and no commit.

## Summary

Procurement Phase 6 focused on validating the Phase 5 procurement integration across PR, PO, GRN, warehouse visibility, planning/production status surfaces, supplier analytics, reports, payables, alerts, and Control Tower KPIs.

This pass used authenticated browser smoke testing, route/import validation, static validation, build validation, and code-path review. It did not intentionally create, approve, reject, convert, receive, QC, or post live procurement records because those are data-mutating UAT actions and should be executed by business users or against a disposable staging dataset.

## Scenario-Wise Test Results

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Raise PR from Planning shortage | Wiring verified, manual mutation pending | Planning page route loaded. PR creation wiring reviewed through procurement integration surfaces. Live PR creation not executed. |
| 2 | Raise PR from Warehouse shortage | Warehouse separation verified | Warehouse legacy PR flow remains moved/placeholder-only. No old Warehouse PR action was reintroduced. |
| 3 | Manual PR creation | Screen smoke passed | `/procurement/pr/new` rendered authenticated. Submit was not executed against live data. |
| 4 | Approve PR | Code path verified | PR detail/status handlers remain in Procurement module. Live approval not executed. |
| 5 | Reject PR with reason | Code path verified | Reject workflow route/UI wiring present in Procurement module. Live rejection not executed. |
| 6 | Convert approved PR to PO | Code path verified | Conversion wiring remains in Procurement module. Live conversion not executed. |
| 7 | Create manual PO | Screen smoke passed | `/procurement/po/new` rendered authenticated. Submit was not executed. |
| 8 | Create GRN from PO | Code path verified | GRN creation route/UI remained available under Procurement. Live GRN creation not executed. |
| 9 | Partial GRN receipt | Code path verified | GRN quantity fields and receipt status flow reviewed. Live partial receipt not executed. |
| 10 | Full GRN receipt | Code path verified | GRN receipt path preserved. Live full receipt not executed. |
| 11 | QC accepted quantity | Code path verified | QC accepted quantity fields and posting inputs preserved. Live QC not executed. |
| 12 | QC rejected quantity | Code path verified | Rejection quantity/reason flow preserved. Live QC rejection not executed. |
| 13 | Post GRN to stock | Guard reviewed | Stock posting remains guarded by `POSTED_TO_STOCK` status to reduce double-posting risk. Live stock mutation not executed. |
| 14 | Verify stock visibility in Warehouse | Smoke passed | `/inventory` loaded. Old Warehouse procurement pages show moved-flow placeholders. |
| 15 | Verify Planning shows PR/PO/ETA | Smoke passed | `/orders/planning` loaded. Procurement status integration remains wired through planning components. |
| 16 | Verify Production shows procurement status | Smoke passed | `/production/job-cards` loaded. Production procurement status integration remains wired. |
| 17 | Verify supplier analytics update | Smoke passed | `/procurement/suppliers` loaded. Live analytics update requires staged transaction data. |
| 18 | Verify rate intelligence | Smoke passed | Procurement report/analytics surfaces loaded. Historical rate calculations require staged data assertions. |
| 19 | Verify pending supplier invoice/payable preparation | Smoke passed | Pending supplier invoice report and dashboard payable card loaded. |
| 20 | Verify PR PDF | Route/import validated | PR PDF route remains build-valid. Live PDF download not executed without selecting a real PR. |
| 21 | Verify GRN PDF | Route/import validated | GRN PDF route remains build-valid. Live PDF download not executed without selecting a real GRN. |
| 22 | Verify Procurement reports | Smoke passed | Purchase rate variation and pending supplier invoices report routes loaded. |
| 23 | Verify alerts | API smoke passed | `/api/dashboard/alerts` returns controlled auth response unauthenticated and remains build-valid. |
| 24 | Verify dashboard Control Tower KPIs | Fixed and smoke passed | Dashboard rendered authenticated with KPI cards and no pool timeout after fix. |
| 25 | Verify search, filters, pagination, row click modals | Route smoke passed | List routes rendered. Deep interactive modal testing remains for manual UAT with live rows. |

## Bugs Found

1. Procurement dashboard could intermittently fail with Prisma `P2024` connection pool timeouts.
   - Cause: Control Tower endpoint launched many dashboard queries concurrently while the current dev database pool exposes `connection_limit: 1`.
   - Impact: `/api/procurement/dashboard` could return `500`, and `/procurement` could stall on first load.

2. Procurement dashboard was doing heavier work than needed.
   - Open PO count was tied to loaded PO rows.
   - Overdue PO count was derived from a capped row list.
   - Open PO rows included more data than the KPI count required.

3. Next dev server became stale after running production build while dev was still active.
   - Impact: browser showed `Loading workspace...` with missing `_next/static` chunks.
   - Fix was operational: stop dev server, clear `.next`, restart dev server before trusting browser smoke results.

## Bugs Fixed

1. Updated `src/app/api/procurement/dashboard/route.ts`.
   - Replaced unbounded open PO dashboard loading with separate `count()` calls and capped open PO row loading.
   - Corrected overdue delivery supplier display to use supplier name.
   - Serialized dashboard database reads to avoid pool exhaustion on low-connection environments.
   - Added a short 10-second in-memory dashboard payload coalescing cache after auth so duplicate first-load requests share the same payload.

2. Confirmed Warehouse remains procurement-free in UI.
   - `/inventory/purchase-requisitions` shows the moved-workflow placeholder.
   - `/inventory/grn` shows the moved-workflow placeholder.
   - Legacy Warehouse procurement UI forms/buttons were not reintroduced.

## Performance Findings

| Area | Result | Notes |
|---|---|---|
| Procurement dashboard first load | Improved stability; cold dev API still around 7.1s against remote DB | No timeout after fix. Duplicate first-load requests coalesced. Warm repeat observed at 35ms. |
| Procurement dashboard visible browser load | Passed | Settled Control Tower content observed after clean restart. Warm browser check observed at 435ms. |
| PR list first load | Passed | Authenticated route rendered, approx. 2.6s during compiled dev smoke. |
| PO list first load | Passed | Authenticated route rendered, approx. 1.2s during smoke. |
| GRN list first load | Passed | Authenticated route rendered, approx. 1.2s during smoke. |
| Reports first load | Passed | Reports routes rendered, approx. 1.0-1.2s during smoke. |
| Supplier analytics load | Passed | Supplier analytics route rendered, approx. 1.2s during smoke. |
| Planning procurement-status load | Passed with caution | Planning route rendered, approx. 2.3s during smoke. |
| Production procurement-status load | Passed with caution | Production job cards rendered, approx. 1.3s during smoke; one earlier broad concurrent sweep hit DB pool pressure on job-card API before dashboard fix. |

Remaining performance note: the dashboard cold read still performs many independent aggregate/list queries. It is stable now, but staging should profile this endpoint with production-like connection pool settings and real data volume. A future hardening pass can consolidate dashboard aggregates into fewer SQL queries or a read-optimized summary endpoint.

## UI Simplification Notes

- Warehouse procurement pages remain neutral placeholders instead of hidden legacy forms.
- Procurement actions remain in the Procurement module.
- No new screens or modules were added.
- No old Warehouse procurement forms were silently kept active in Warehouse UI.

## Stock Posting Verification

- GRN stock posting code path remains isolated to Procurement GRN handling.
- Double-posting risk is reduced by checking posted status before stock mutation.
- Live stock mutation was not executed in this pass to avoid changing production-like data.
- Warehouse stock visibility smoke passed through `/inventory`.

## Planning, Production, and Warehouse Integration Verification

- Planning page smoke passed: `/orders/planning`.
- Production job card list smoke passed: `/production/job-cards`.
- Warehouse stock page smoke passed: `/inventory`.
- Warehouse legacy procurement routes smoke passed as placeholders:
  - `/inventory/purchase-requisitions`
  - `/inventory/grn`

## Supplier, Report, and Document Verification

- Supplier analytics page smoke passed: `/procurement/suppliers`.
- Reports smoke passed:
  - `/procurement/reports?type=purchase-rate-variation`
  - `/procurement/reports?type=pending-supplier-invoices`
- PR PDF and GRN PDF routes passed build/import validation.
- Live PDF generation was not executed because that requires selecting real PR/GRN records for a data-aware manual UAT pass.

## API and Route Validation

- Direct unauthenticated API smoke returned controlled `401` responses for protected procurement routes after clean restart:
  - `/api/procurement/dashboard`
  - `/api/procurement/pr?limit=20`
  - `/api/procurement/po?limit=20`
  - `/api/procurement/grn?limit=20`
  - `/api/procurement/reports?type=purchase-rate-variation&limit=20`
  - `/api/procurement/reports?type=pending-supplier-invoices&limit=20`
  - `/api/procurement/supplier-analytics`
  - `/api/dashboard/alerts`
  - `/api/inventory/grn-inward-ledger`
- Route/import validation completed by enumerating Procurement and GRN inward route files and by successful production build.

## Build and Test Results

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npx prisma validate` | Passed |
| `npm run lint` | Passed with existing warnings |
| `npm run build` | Passed |
| `git diff --check` | Passed |
| Backend import/syntax validation | Passed via typecheck/build |
| Prisma validation | Passed |
| Browser smoke | Passed for Procurement, Planning, Production, Warehouse, Billing, Reports, Supplier Analytics |

Known non-blocking warnings:
- `next.config.js` contains existing unrecognized `experimental.viewTransition`.
- Existing ESLint warnings remain in unrelated areas for hook dependencies, image usage, and a11y attributes.

## Risks and Follow-Up Notes for Manual UAT

1. Execute the full mutating workflow on staging or a disposable dataset:
   Planning/Warehouse requirement -> PR -> approval/rejection -> PO -> GRN -> QC -> stock posting -> payable preparation.

2. Verify real PDFs with actual PR and GRN records.

3. Profile cold Procurement dashboard API in staging with production-like pool settings and realistic procurement volume.

4. Validate row click modals, filters, pagination, and search with realistic row counts.

5. Confirm audit logs after live PR approval/rejection, PO conversion, GRN QC, and stock posting.

## Go-Live Readiness Status

Status: Ready for staging/manual business-user UAT, not final production go-live yet.

Rationale: build, typecheck, Prisma validation, lint, route smoke, Warehouse separation, and dashboard stability all pass. The remaining items are data-mutating business scenarios that should be performed in staging with accountable test records before go-live.
