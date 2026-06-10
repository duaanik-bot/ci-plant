# Procurement Phase 1 Warehouse Cleanup Report

Date: 2026-06-10

## Removed Warehouse Procurement Sections

- Removed Warehouse header actions for direct vendor PO creation and GRN stock receiving.
- Removed Warehouse procurement tabs for Open POs and Incoming procurement deliveries.
- Removed procurement-heavy Warehouse report content: vendor spend, PO counts, receipt accuracy, lead-time charts, procurement CSV export, and procurement report shortcuts.
- Replaced Warehouse procurement entry points with the required neutral message:
  "Procurement workflow moved to new Procurement module. New PR/PO/GRN flow will be enabled in next phase."
- Replaced `/inventory/grn` and `/inventory/purchase-requisitions` with neutral Phase 1 moved placeholders instead of old forms.

## Removed Old Forms And Modals

- Deleted old Warehouse bulk vendor PO dialog.
- Deleted old Warehouse direct PO dialog.
- Deleted old Warehouse Open POs tab component.
- Deleted old Warehouse Incoming tab component.
- Deleted old inventory PR card, PR edit drawer, Generate PO dialog, and GRN allocation prompt components.
- Removed the hidden legacy material details slide-over that still contained PR generation UI and handlers.
- Removed Warehouse PR modal state, validation, submit handlers, shortage selection state, buffer state, and old modal open/close wiring.

## Removed API Calls And Imports

- Removed Warehouse UI calls to:
  - `/api/inventory/paper-warehouse/direct-po`
  - `/api/inventory/paper-warehouse/[id]/direct-po`
  - `/api/inventory/paper-warehouse/open-pos`
  - `/api/inventory/paper-warehouse/[id]/open-pos`
  - `/api/inventory/paper-warehouse/[id]/create-pr`
  - `/api/material-shortages/[id]/create-pr`
  - `/api/inventory/grn`
  - `/api/inventory/grn/allocate-shortage`
  - `/api/purchase-requisitions`
- Removed Warehouse stock-list API enrichment queries for open PRs and open vendor POs from `/api/inventory/paper-warehouse`.
- Removed imports for deleted Warehouse procurement components.
- Removed the procurement suggestion helper from the Warehouse stock table.

## Preserved Warehouse Functions

- Paper Warehouse stock view.
- Stock filtering, sorting, shortage visibility, reorder/watch visibility, and reservation totals.
- Stock adjustment and bulk stock adjustment.
- Material drawer overview, reservations, and movement history.
- Stock ledger and paper ledger visibility.
- Inventory flow page, with UI wording changed from GRN to stock inward.
- Planning/warehouse visibility through existing Planning routes and warehouse stock data.

## Backend And Database Objects Left Untouched

- Prisma models and database schema were intentionally left untouched.
- Existing procurement API routes outside the Warehouse UI were left in place for Phase 2 separation decisions.
- Existing dedicated procurement module routes under `/orders/procurement` and `/api/procurement` were not modified.
- Existing supplier, item/material, inventory ledger, planning, purchase order, vendor PO, purchase requisition, and GRN database records were not deleted.

## Verification Results

- `npx prisma validate`: Passed.
- `npm run lint`: Passed with existing warnings in unrelated modules; no warnings remained in the changed Warehouse cleanup files after follow-up fixes.
- `npm run typecheck`: Failed on existing non-Warehouse type errors in:
  - `src/app/api/job-cards/route.ts`
  - `src/app/api/purchase-orders/route.ts`
  - `src/app/api/short-excess/route.ts`
- `npm run build`: Failed during type checking on the same pre-existing `src/app/api/job-cards/route.ts` `row.yield` type error. Compilation completed before the type-check failure.
- Browser smoke test on local dev server `http://localhost:3010`:
  - Dashboard: loaded without 404/server error.
  - Warehouse `/inventory#paper-ledger`: loaded and showed Paper Warehouse without 404/server error.
  - Planning Engine `/orders/planning`: loaded without 404/server error.
  - Inventory/Stock `/inventory`: loaded as the Warehouse stock page after data settled.
  - `/inventory/grn`: showed moved placeholder without 404/server error.
  - `/inventory/purchase-requisitions`: showed moved placeholder without 404/server error.

## Risks And Phase 2 Follow-Ups

- Typecheck/build are currently blocked by unrelated existing type errors outside the Warehouse cleanup scope.
- Some backend procurement endpoints remain available intentionally; Phase 2 should decide whether they become the new Procurement module contracts or are retired.
- Planning still has PR creation logic outside Warehouse. That was not removed because Phase 1 scope was Warehouse cleanup and separation.
- Inventory Flow still consumes existing backend summary fields for stock inward data while presenting non-GRN wording in the UI.
- The new Procurement module should own PR/PO/GRN creation, supplier selection, receipt/QC workflows, and vendor PO reporting.
