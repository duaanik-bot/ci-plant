# Procurement Phase 5 Integration Hardening Report

Date: 2026-06-10

## Scope

Phase 5 rationalized Procurement as the purchasing source of truth across Planning, Warehouse, Production, Accounts-facing payables, Supplier Management, alerts, reports, and documents.

No unnecessary new screens were added. The work reused the existing Procurement dashboard, reports page, supplier analytics page, Planning drawer, Production job-card material card, Warehouse stock ledger visibility, and dashboard notification center.

## Planning Integration

- Added shared integration helper:
  - `src/lib/procurement-integration.ts`
- Planning material readiness now calculates and returns:
  - Current stock
  - Reserved stock
  - Available stock
  - Open PO quantity
  - Incoming GRN quantity
  - Production requirement
  - Safety stock
  - Net requirement
  - Procurement status
  - Linked PR
  - Linked PO number
  - Expected arrival date
  - GRN posted flag
- Updated readiness endpoint:
  - `src/app/api/planning/po-lines/[id]/reserve-material/route.ts`
- Net requirement formula implemented:
  - Production requirement + safety stock - available stock - incoming open PO
- Updated Planning UI types and Warehouse Snapshot card:
  - `src/components/planning/PlanningJobDetailDrawer.tsx`
  - `src/components/planning/engine/types.ts`
  - `src/components/planning/engine/SectionWarehouseSnapshot.tsx`
- Planning now surfaces procurement progress without opening Procurement.

## Production Integration

- Extended production material readiness snapshot:
  - `src/lib/job-card-board-material.ts`
- Updated Production job-card detail Material Readiness card:
  - `src/app/(dashboard)/production/job-cards/[id]/page.tsx`
- Production now shows:
  - Material required
  - Available stock
  - Incoming PO quantity
  - Linked PO number
  - Expected arrival date
  - Procurement status
  - GRN posted status
- Production planners can distinguish:
  - Ready for Production
  - Waiting for Material
  - Material Under Procurement

## Warehouse Integration

- Warehouse remains a passive receiver and stock visibility surface.
- No Warehouse PR/PO/GRN forms or legacy procurement modals were reintroduced.
- Existing Phase 4 read-only GRN inward ledger remains intact:
  - `src/app/api/inventory/grn-inward-ledger/route.ts`
  - Warehouse Reports tab shows posted GRN inward references.
- Final scan found no old Warehouse procurement UI/action phrases in:
  - `src/app/(dashboard)/inventory`
  - `src/components/inventory`

## Accounts Integration

- GRN stock posting now prepares a payable reference through existing supplier/PO/GRN accrual fields rather than creating a duplicate vendor ledger.
- Updated GRN posting route:
  - `src/app/api/procurement/grn/[id]/route.ts`
- Receipt-level payable accrual is written to `qcAccruedPayableInr`.
- PO-level accrued payable continues through `accruedReceiptPayableInr`.
- Audit payload now includes:
  - `payableReference`
  - `payableAccrual`
- Added pending supplier invoice/payable report through Procurement Reports:
  - `pending-supplier-invoices`

## Supplier Management Enhancements

- Supplier analytics now includes operational supplier profile sections without duplicating supplier master data:
  - Overview: supplier name, GST, contact, payment terms
  - Commercial: last purchase rate, average rate, open PO value, total procurement value
  - Operational: lead time, on-time delivery percentage, QC acceptance percentage, rejection percentage
  - History: purchase orders, GRNs, rate history, supplier notes
- Updated:
  - `src/app/api/procurement/supplier-analytics/route.ts`

## Rate Intelligence

- Added shared rate intelligence logic in:
  - `src/lib/procurement-integration.ts`
- Added Purchase Rate Variation report:
  - `type=purchase-rate-variation`
- Tracks:
  - Last purchase rate
  - Previous purchase rate
  - 3-month average
  - 6-month average
  - Best historical rate
  - Highest historical rate
  - Rate increased / reduced / significant increase flags
- The feature is available through existing Procurement Reports, avoiding a new screen.

## Procurement Control Tower

- Converted the existing Procurement dashboard into a single-page Control Tower:
  - `src/app/api/procurement/dashboard/route.ts`
  - `src/app/(dashboard)/procurement/_components/ProcurementScreens.tsx`
- Control Tower cards:
  - Critical shortages
  - Pending approvals
  - Open POs
  - Overdue deliveries
  - GRN pending posting
  - QC rejected receipts
  - Supplier follow-ups
  - Pending payable value
- Operational queues include quick links/actions for:
  - Approve PR
  - Convert PR
  - Receive material
  - Post GRN
  - Follow up supplier
  - Match invoice

## Reports Added

- Existing Procurement Reports page now supports:
  - Open PR Report
  - Approved PR Pending PO Report
  - Open PO Report
  - Overdue PO Report
  - Pending GRN Report
  - Supplier Performance Report
  - Purchase Rate Variation Report
  - QC Rejection Report
  - Monthly Procurement Summary
  - Pending Supplier Invoices
- Updated:
  - `src/app/api/procurement/reports/route.ts`
  - `src/app/(dashboard)/procurement/_components/ProcurementScreens.tsx`
- Reports remain server-side paginated and CSV-exportable.

## Alerts Added

- Reused the existing dashboard alert endpoint:
  - `src/app/api/dashboard/alerts/route.ts`
- Added/expanded procurement alerts for:
  - Material shortage affecting production
  - Overdue PO
  - GRN pending posting
  - GRN pending over 2 days
  - Supplier delivery due today
  - PR pending approval
  - PO pending sending
  - QC rejection recorded
  - Critical shortage PR not converted
  - PO fully received
  - GRN posted
- No new notification system was created.

## Document Engine

- Added shared procurement document helper:
  - `src/lib/procurement-documents.ts`
- PR and GRN print routes now use the shared procurement document helper:
  - `src/app/api/procurement/pr/[id]/pdf/route.ts`
  - `src/app/api/procurement/grn/[id]/pdf/route.ts`
- PO print continues to use the existing shared vendor PO PDF helper:
  - `src/lib/vendor-po-pdf.ts`
- This removes route-specific PR/GRN PDF layout logic and aligns documents toward a common ERP document engine.

## Commonization Completed

- Shared integration formulas:
  - `getMaterialProcurementSnapshot`
  - `buildRateIntelligence`
  - `getPendingSupplierPayables`
- Shared document helper:
  - `buildProcurementDocumentPdf`
- Reused existing:
  - `DataTable`
  - `KpiTile`
  - Procurement report page
  - Supplier analytics page
  - Dashboard alerts
  - Planning readiness drawer
  - Production job-card material card
- Avoided duplicate:
  - Supplier masters
  - Accounts vendor ledgers
  - New notification center
  - New standalone rate screen
  - New Planning/Production procurement dashboards

## Performance Improvements

- Procurement Control Tower uses one compact summary endpoint.
- Analytics remain lazy loaded.
- Reports remain server-side paginated.
- Supplier/item searches remain debounced in Procurement forms/reports.
- Planning and Production receive small procurement status snapshots rather than full procurement histories.
- PDF generation remains route-triggered and does not block list rendering.
- Warehouse old procurement bundles remain removed from active Warehouse UI.

## Full Workflow Test Results

Automated full data mutation from Sales Order to Payable was not executed against production data in this phase to avoid creating real PR/PO/GRN/payable records.

Validated workflow wiring and route behavior:

- Sales Order to Planning:
  - Planning material readiness endpoint compiles and returns enhanced procurement fields.
- Planning to PR:
  - Existing Planning Raise PR path remains wired to the new Procurement PR API.
- PR to PO:
  - Procurement PO conversion routes remain available through existing PR detail and v1 wrappers.
- PO to GRN:
  - Existing Procurement PO detail and v1 create-GRN wrapper remain available.
- GRN to Warehouse Stock:
  - GRN posting updates inventory stock movement and locks posted GRNs from silent edit.
- GRN to Accounts Payable:
  - GRN posting now writes receipt-level payable accrual and PO-level accrued payable reference.
- Warehouse visibility:
  - GRN inward ledger endpoint remains available for posted procurement stock movements.
- Production visibility:
  - Production job-card material card now exposes procurement status, linked PO, expected arrival, and GRN posted state.
- Audit:
  - PR/PO/GRN actions continue writing audit logs; GRN posting audit now includes payable reference.

Smoke test on `http://localhost:3010`:

- `/procurement`: 307 to login, expected unauthenticated behavior.
- `/procurement/reports?type=purchase-rate-variation`: 307 to login, expected.
- `/procurement/reports?type=pending-supplier-invoices`: 307 to login, expected.
- `/procurement/suppliers`: 307 to login, expected.
- `/orders/planning`: 307 to login, expected.
- `/production/job-cards`: 307 to login, expected.
- `/inventory`: 307 to login, expected.
- `/billing`: 307 to login, expected.
- `/api/v1/procurement/dashboard`: 401 unauthorised, expected.
- `/api/v1/procurement/reports?type=supplier-performance`: 401 unauthorised, expected.
- `/api/v1/procurement/reports?type=purchase-rate-variation`: 401 unauthorised, expected.
- `/api/v1/procurement/reports?type=monthly-procurement-summary`: 401 unauthorised, expected.
- `/api/v1/procurement/reports?type=pending-supplier-invoices`: 401 unauthorised, expected.
- `/api/v1/procurement/supplier-analytics`: 401 unauthorised, expected.
- `/api/dashboard/alerts`: 401 unauthorised, expected.
- `/api/inventory/grn-inward-ledger`: 401 unauthorised, expected.

## Build And Validation Results

- `npm run typecheck`: passed.
- `npx prisma validate`: passed.
- `npm run lint`: passed with pre-existing warnings.
- `npm run build`: passed after clean `.next` rebuild.
- Dev server smoke route compilation: passed.
- Local dev server was stopped after smoke checks.

Known existing warning:

- `experimental.viewTransition` remains unrecognized by the installed Next.js version.

## Remaining Risks

- Full end-to-end mutation test was not run against production data; a seeded staging workflow should be used for a true transaction reconciliation test.
- Payable integration prepares references and accruals, but supplier invoice matching/payment lifecycle still depends on expanding the existing Accounts/Billing module for vendor-side bills.
- Procurement statuses are computed from current PR/PO/GRN state rather than persisted as a separate workflow table.
- Rate intelligence is history-based and will be strongest after enough clean PO rate history exists.
- Supplier manual responsiveness rating remains defaulted/foundation-based until a controlled rating input exists.
- Some legacy backend endpoints under Inventory still exist for compatibility, but active Warehouse UI remains procurement-free.

