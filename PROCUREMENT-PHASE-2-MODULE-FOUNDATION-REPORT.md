# Procurement Phase 2 Module Foundation Report

Date: 2026-06-10

## Built Procurement Module Foundation

- Added dedicated Procurement navigation under the main dashboard shell.
- Added Procurement RBAC module key and granted Accounts access alongside full-system roles.
- Added core pages:
  - `/procurement`
  - `/procurement/pr`
  - `/procurement/pr/new`
  - `/procurement/pr/[id]`
  - `/procurement/po`
  - `/procurement/po/new`
  - `/procurement/po/[id]`
  - `/procurement/grn`
  - `/procurement/grn/new`
  - `/procurement/grn/[id]`
- Added shared Procurement screen foundation using `DataTable`, compact KPI cards, full-row list navigation, and full-page create forms.
- Added row-click support to the shared `DataTable` component.

## Dashboard And Lists

- Added compact Procurement dashboard KPI endpoint and UI for:
  - Open PRs
  - Approved PRs
  - Open POs
  - Pending GRNs
  - Overdue POs
  - Today's Receipts
  - Open PO Value
  - Critical Shortages Linked To PR
- Added PR, PO, and GRN list pages using the shared table component.
- List detail data loads from detail routes after row navigation instead of being bundled into the dashboard.

## Forms And Detail Pages

- Added full-page PR creation form for Planning, Warehouse, and Manual sources.
- Added full-page PO creation form for approved PR conversion or manual procurement.
- Added full-page GRN creation form from PO.
- Added PR/PO/GRN detail pages with header details, line items, statuses, and foundation actions.
- Kept Send, Print, and Email as non-posting foundation actions where backend integrations are not built yet.

## API Foundation

- Added internal module APIs:
  - `GET /api/procurement/dashboard`
  - `GET/POST /api/procurement/pr`
  - `GET/PATCH /api/procurement/pr/[id]`
  - `GET/POST /api/procurement/po`
  - `GET/PATCH /api/procurement/po/[id]`
  - `GET/POST /api/procurement/grn`
  - `GET/PATCH /api/procurement/grn/[id]`
  - `GET /api/procurement/options`
- Added requested v1 API surface:
  - `GET /api/v1/procurement/dashboard`
  - `GET/POST /api/v1/procurement/pr`
  - `GET/PATCH /api/v1/procurement/pr/[id]`
  - `POST /api/v1/procurement/pr/[id]/convert-to-po`
  - `GET/POST /api/v1/procurement/po`
  - `GET/PATCH /api/v1/procurement/po/[id]`
  - `POST /api/v1/procurement/po/[id]/create-grn`
  - `GET/POST /api/v1/procurement/grn`
  - `GET/PATCH /api/v1/procurement/grn/[id]`
  - `POST /api/v1/procurement/grn/[id]/post-to-stock`
- Added clamped, searchable supplier/item/PR/PO option loading for form selectors.

## Connections

- Planning Engine Raise PR now creates a draft PR through the new Procurement API instead of the old material-shortage PR endpoint.
- Warehouse stock/reorder rows now expose a clean `Raise PR` action linking into `/procurement/pr/new` with prefilled source, material, and quantity.
- Warehouse still has no PO/GRN actions after Phase 1 cleanup.

## Data Integrity

- No Prisma migration was added.
- Existing supplier, inventory, PR, vendor PO, vendor receipt, stock movement, and audit log tables were reused.
- Historical PO/GRN/read models were left intact.
- GRN draft save does not update stock.
- GRN post-to-stock updates accepted stock quantity, PO receipt totals/status, stock movement ledger, and audit trail.

## Verification Results

- `npx prisma validate`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with existing repo warnings only.
- `npm run build`: passed. Build warning remains for existing `next.config.js` experimental `viewTransition` key and existing lint warnings.
- Route smoke against `http://localhost:3010`:
  - `/procurement`, `/procurement/pr`, `/procurement/pr/new`, `/procurement/po`, `/procurement/po/new`, `/procurement/grn`, `/procurement/grn/new`, `/inventory`, and `/orders/planning` returned expected unauthenticated `307` redirects to `/login`.
  - `/api/v1/procurement/dashboard` returned expected unauthenticated `401`.

## Risks And Phase 3 Follow-Ups

- Existing legacy procurement-related API routes still exist for historical/read compatibility and old non-Warehouse modules; they were not hard-deleted in this phase.
- Supplier payable integration is represented through GRN/PO accrual fields and audit trail, but a dedicated Accounts payable posting flow is not built yet.
- The v1 action endpoints are foundation endpoints; richer validation, approval controls, and status workflow hardening should be expanded in the next phase.
- List endpoints are clamped and foundation-ready; deeper pagination/filter/sort contracts can be formalized once UX requirements settle.
