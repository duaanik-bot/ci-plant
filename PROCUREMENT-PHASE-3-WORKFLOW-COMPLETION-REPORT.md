# Procurement Phase 3 Workflow Completion Report

Date: 2026-06-10

## Completed PR Workflow

- Draft PR creation remains in the new Procurement module only.
- Added server-side PR list filters for status, priority, source, item/search, created by, and required date.
- Added draft-only PR edit support through the PR detail API.
- Added workflow actions:
  - Submit draft PR for approval.
  - Approve pending PR.
  - Reject pending/approved PR with reason.
  - Convert approved PR to PO.
- Added duplicate Planning PR protection using `sourcePlanningId` and linked shortage records.
- Linked Planning shortage records back to the new PR so existing Planning readiness can show PR status.
- Added PR line state derived from status and PO links:
  - Open
  - Converted
  - Partially Converted
  - Cancelled
- Added audit payload events:
  - `PR_CREATED`
  - `PR_SUBMITTED`
  - `PR_APPROVED`
  - `PR_REJECTED`
  - `PR_UPDATED`

## Completed PO Workflow

- Added server-side PO filters for status, supplier, item/search, expected delivery, and overdue-only.
- PO creation supports:
  - Manual PO.
  - Approved PR conversion.
  - Multiple approved PRs merged into one supplier PO using `VendorPoRequisitionLink`.
- Prevents duplicate PO conversion from PRs already linked to a PO.
- Added PO detail action handling:
  - Mark Sent
  - Create GRN
  - Print PO
  - Close with reason
  - Cancel with reason
- Added line-level receiving progress derived from ordered quantity and usable received quantity:
  - Ordered Qty
  - Received Qty
  - Balance Qty
  - Cancelled Qty
  - Receiving %
- Added audit payload events:
  - `PO_CREATED`
  - `PO_SENT`
  - `PO_CLOSED`
  - `PO_CANCELLED`
  - `PO_UPDATED`

## Completed GRN Workflow

- GRN creation remains PO-only.
- Draft GRN save does not update stock.
- Added draft/QC update support.
- Added validation:
  - Closed/cancelled POs cannot create GRNs.
  - Accepted + rejected quantity cannot exceed receiving quantity.
  - Receiving quantity cannot exceed PO balance unless admin override is supplied.
  - Posted GRNs cannot be posted again.
- Added QC fields:
  - Accepted Qty
  - Rejected Qty
  - Rejection Reason
  - QC Remarks
  - QC status derivation for pending, accepted, rejected, partial accepted, posted, and cancelled states.
- Added audit payload events:
  - `GRN_CREATED`
  - `GRN_UPDATED`
  - `GRN_QC_UPDATED`
  - `GRN_POSTED_TO_STOCK`
  - `GRN_CANCELLED`

## Warehouse Stock Posting Logic

- Warehouse receives stock only through GRN `post_to_stock`.
- Draft GRN does not mutate inventory.
- Stock posting increments inventory only by accepted quantity.
- Rejected quantity is stored on GRN and never increases stock.
- Posting creates `StockMovement` rows with:
  - Movement type `procurement_inward`
  - Source ref type `procurement_grn`
  - GRN reference id
  - Posted user id
  - GRN/PO reference note
- PO received totals and status update automatically to partial or fully received.

## Planning Engine Linkage

- Planning Raise PR now calls the new Procurement PR API.
- New PR creation writes the PR id back to the matching `MaterialShortage` when available.
- Duplicate PR creation from the same Planning shortage is blocked unless explicitly allowed.
- Existing Planning readiness paths can display linked PR status from `MaterialShortage.purchaseReqId`.

## Dashboard KPIs Added

- Open PRs
- Pending Approval PRs
- Approved PRs
- Open POs
- Overdue POs
- Pending GRNs
- Posted GRNs Today
- Open PO Value
- Monthly Purchase Value
- Average PR to PO Time
- Average PO to GRN Time
- Supplier On-Time Delivery %
- QC Rejection %
- Critical Shortages Linked To PR

## Table, Filter, And Search Improvements

- PR, PO, and GRN lists use shared `DataTable`.
- Full-row click remains enabled.
- Added server-side query filters and clamped limits.
- Supplier/item/PR/PO selector options remain clamped and searchable through the options endpoint.
- Detail data loads from detail endpoints instead of being bundled into dashboard/list first render.

## PDF / Print Foundation

- Added PO print/PDF endpoint:
  - `/api/procurement/po/[id]/pdf`
  - `/api/v1/procurement/po/[id]/print`
- Added GRN print/PDF endpoint:
  - `/api/procurement/grn/[id]/pdf`
  - `/api/v1/procurement/grn/[id]/print`
- PO print reuses the existing vendor material PO PDF utility.
- GRN print uses a lightweight document-ready `jsPDF` layout.

## Permission Handling

- Reused the existing auth/session checks and Procurement module RBAC from Phase 2.
- Did not add a parallel permission system.
- Fine-grained role-aware action hiding is not fully expanded yet because the existing role model has broad module access rather than per-action permissions.

## Bugs Fixed

- Fixed GRN accepted quantity fallback logic from Phase 2.
- Fixed Planning PR creation to call the new Procurement PR API instead of old material-shortage PR creation logic.
- Fixed audit action typing by storing workflow event names in audit payloads while keeping DB action values compatible.
- Added duplicate PR/PO conversion guards.
- Added stock posting double-post guard.

## Verification Results

- `npx prisma validate`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with existing repo warnings only.
- `npm run build`: passed.
- Browser/server smoke via `http://localhost:3010`:
  - Procurement Dashboard, PR list, PR create, PO list, PO create, GRN list, GRN create, Warehouse, and Planning routes returned expected unauthenticated `307` redirects to `/login`.
  - Procurement API list/dashboard routes returned expected unauthenticated `401`.
  - Dev server logs showed clean route/API compilation during smoke checks.

## Remaining Gaps For Phase 4

- Full edit pages for PR/PO/GRN can be made richer; Phase 3 API supports draft edits, but UI edit screens are still minimal.
- True per-line GRN posting needs dedicated receipt-line persistence if future requirements require exact line-by-line posting rather than proportional allocation.
- Fine-grained action permissions should be added if the role system gains Procurement User / Approver / Viewer / Admin sub-roles.
- Email PO action is still a disabled foundation control; dispatch email integration can be wired in Phase 4.
- Average PR-to-PO metric is currently placeholder-safe because existing schema does not store a direct conversion timestamp separate from PO creation/link time for all historical rows.
- Advanced pagination UI controls can be added on top of the server-side pagination contract.
