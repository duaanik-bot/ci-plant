# Purchase Requisition Kanban — Procurement Enhancement (Phase 1)

**Date:** 2026-05-22
**Status:** Approved design — ready for implementation plan
**Scope:** Phase 1 of a 3-phase procurement initiative. Covers the Purchase Requisition (PR) Kanban only (master-prompt Sections 1–8 plus the data foundation they require). Phase 2 (Paper Warehouse procurement center, Sections 9–17) and Phase 3 (unified inventory sync + auditability hardening, Sections 18–19) are separate spec → plan → build cycles.

---

## 1. Context & current state

This ERP (Next.js App Router + Prisma + dnd-kit) already has a functional PR Kanban at
`src/app/(dashboard)/inventory/purchase-requisitions/page.tsx`.

Established facts about the current system (do not break these):

- **Columns** are already Draft → Approved → Ordered → Received, mapped via
  `src/lib/purchase-requisition-status.ts` (`dbStatusToUiStage` / `uiStageToDbStatus`).
- The board currently **collapses all PRs of the same material into one card** per column.
- A **read-only** "Traceability" `SlideOverPanel` already exists on the board, surfacing linked
  jobs, reserved/available/incoming/received stock, and a timeline (via
  `/api/purchase-requests/[id]/traceability`).
- The **procurement PO** is `VendorMaterialPurchaseOrder` (the `PurchaseOrder` model is the
  *customer/sales* PO — unrelated). **GRN** is `VendorMaterialReceipt`, which already tracks
  received qty + QC and rolls up `totalReceivedKg` / `totalUsableReceivedKg` onto the PO.
- `PurchaseRequisition` is **single-material** (no line items). Status today:
  `pending | approved | converted_to_po | received | rejected`. It links to a PO via a single
  nullable FK `VendorMaterialPurchaseOrder.purchaseRequisitionId` → today this is **one PR → many
  POs**.
- The PR fields that already exist: `qtyRequired`, `boardType`, `sizeLabel`, `gsm`, `supplierId`,
  `expectedDelivery`, `estimatedValue`, `triggerReason`, `sourceJobCardId`, `sourcePlanningId`,
  `shortageId`.
- `convert-to-po` already creates a real `VendorMaterialPurchaseOrder` (one PR → one PO, one line).
- The board's **"Move → Ordered" button does NOT create a real PO** — it calls `/stage`, which
  flips status to `converted_to_po`, sets a fake `AUTO-...` poReference, and bumps
  `Inventory.qtyQuarantine` by the PR qty (used as a proxy for "incoming"). This is a source of
  truth/double-count risk we are fixing.
- **Audit logging already exists** and is pervasive: `createAuditLog` (writes the `AuditLog` model)
  is called on approve, stage move, convert-to-po, and delete. The list endpoint already
  reconstructs `orderedAt` / `receivedAt` from `AuditLog` rows.
- **Approval threshold:** PRs with `estimatedValue > ₹50,000` require `operations_head` or `md`
  role to approve (enforced in `/api/purchase-requisitions/[id]/approve`).

There is **no PUT/PATCH** on `/api/purchase-requisitions/[id]` today (only DELETE), and **no PR
field-level revision history** beyond the generic `AuditLog` status entries.

---

## 2. Goals (Phase 1)

1. Make Draft cards individually editable via a right-side slide-over, with lock-after-approve and
   field-level revision history.
2. Auto-consolidate PRs with identical procurement characteristics in the Ordered column.
3. Generate real vendor POs from the Ordered column via explicit single/bulk selection — **no
   popup when simply moving Approved → Ordered**.
4. Turn PO-backed Ordered cards into live procurement monitoring cards (synced from GRN).
5. Surface reservation visibility (Required / Reserved / Purchase-Required) on cards and drawer.
6. Redesign cards to be ~40–50% more compact.
7. Keep GRN as the sole receiving authority; all monitoring numbers are derived, never written from
   the board.

### Non-goals (deferred)
- Warehouse-side PO creation, Open-PO / Incoming-Deliveries views, procurement-status color system,
  the unified cross-module stock-math service. (Phases 2–3.)
- Adding `Warehouse` and `Procurement Category` as consolidation keys (not modeled today; deferred).

---

## 3. Workflow (confirmed with user)

- **Approved → Ordered:** simple move, **no dialog**. Sets PR status to the new `ordered` value.
  Cards landing in Ordered consolidate automatically by procurement characteristics.
- **Inside the Ordered column:** consolidated cards are selectable (single or multiple). A
  **Generate PO** action creates a PO for one selected card or all selected cards in bulk. This is
  the **only** place the Generate PO dialog appears.
- A consolidated Ordered card has two appearances:
  - **Awaiting PO** (status `ordered`, no linked PO): shows the Generate PO affordance.
  - **PO created** (status `converted_to_po`, linked PO): monitoring card, live-synced from GRN.
- **Received:** manual move stays available; auto-*suggest* when the linked PO is fully received
  (no forced auto-flip).

---

## 4. Data model changes (additive, no breaking changes)

### 4.1 `PurchaseRequisition`
Add nullable fields:
- `remarks String?` — Procurement Remarks.
- `requiredByDate DateTime? @db.Date` — the demand's required date (distinct from
  `expectedDelivery`, which is the vendor delivery date).

Reuse existing `sizeLabel` for "Sheet Size", `boardType`, `gsm`, `supplierId` (Vendor Preference).

### 4.2 New PR status `ordered`
- `ordered` = in Ordered column, consolidated, awaiting PO.
- `converted_to_po` = real vendor PO created (monitoring).
- Both map to the **Ordered** UI stage.
- `src/lib/purchase-requisition-status.ts`:
  - `dbStatusToUiStage`: `'ordered' → 'ordered'`, `'converted_to_po' → 'ordered'`,
    `'received' → 'received'`.
  - `uiStageToDbStatus('ordered') → 'ordered'` (the awaiting-PO state).
  - `mapFilterToDbStatuses('ordered')` returns `['ordered', 'converted_to_po']`.
- `PrDbStatus` type adds `'ordered'`.

### 4.3 New join model `VendorPoRequisitionLink` (many PRs → one PO)
```
model VendorPoRequisitionLink {
  id                    String   @id @default(uuid())
  vendorPoId            String   @map("vendor_po_id")
  purchaseRequisitionId String   @map("purchase_requisition_id")
  allocatedQty          Decimal  @map("allocated_qty") @db.Decimal(12, 3)
  createdAt             DateTime @default(now()) @map("created_at")

  vendorPo VendorMaterialPurchaseOrder @relation(fields: [vendorPoId], references: [id], onDelete: Cascade)
  pr       PurchaseRequisition         @relation(fields: [purchaseRequisitionId], references: [id], onDelete: Cascade)

  @@unique([vendorPoId, purchaseRequisitionId])
  @@index([purchaseRequisitionId])
  @@map("vendor_po_requisition_links")
}
```
The existing single FK `VendorMaterialPurchaseOrder.purchaseRequisitionId` is **retained** for
backward compatibility with existing rows; new POs populate the join table (and may also set the
FK to the first PR for legacy reads).

### 4.4 `VendorMaterialPurchaseOrder`
Add nullable fields needed by the Generate PO dialog:
- `paymentTerms String?`
- `transportTerms String?`

---

## 5. Consolidation engine

New pure, unit-tested lib `src/lib/pr-consolidation.ts` (mirrors `planning-sheet-cut.ts` /
`planning-smart-match.ts` style: pure functions + Vitest).

- **Grouping key:** `materialId | boardType | gsm | sizeLabel`.
- Merges **across vendors** (vendor is chosen at PO time, not a grouping key).
- For each group returns: `{ key, materialId, materialCode, boardType, gsm, sizeLabel,
  totalQty, members: [{ prId, qty, supplierId, requiredByDate }], suggestedSupplierId
  (most common among members), earliestRequiredDate }`.
- Used by the board to render consolidated Ordered cards, and re-run server-side during PO
  generation so the client cannot desync the grouping.

---

## 6. UX

All UI uses existing design tokens (`ds-*`, `var(--brand-*)`), `SlideOverPanel`, `PageHeader`.

### 6.1 Compact card (Section 8)
~40–50% shorter. Remove the always-visible checkbox row, "Delete card" button, and multi-line
paragraphs from the resting card. Dense 2-line layout:
- Line 1: `Material Code` · `Board Type` · priority indicator.
- Line 2: `Qty` · `Reserved` · `Purchase Req'd` · `Due date` · `🔗 N jobs`.
- Move / delete / select actions move into the drawer or a hover/overflow affordance.
- Auto-from-shortage `⚡ Auto` badge retained.

### 6.2 Draft edit drawer (Sections 2, 6, 19)
Clicking a card opens a `SlideOverPanel`.
- **Draft (status `pending`):** editable — Material (read-only code/description + "Change material"
  picker that re-points `materialId`), Board Type, GSM, Sheet Size, Required Qty, Required Date,
  Vendor Preference, Procurement Remarks. Buttons: **Save Draft**, **Delete**, **Approve**
  (respects the ₹50k role threshold).
- **After Approve:** core fields become read-only. A **Revision History** section lists field
  changes from `AuditLog` (field, old → new, user, timestamp).
- **Reservation block (all statuses):** Required / Reserved / Purchase-Required totals + linked Job
  Cards, product names, reservation qtys/dates — sourced from `linkedShortages` and the existing
  traceability data.

### 6.3 Ordered column (Sections 3, 4, 5)
- Cards are **consolidated** (e.g. three Duplex-230 PRs → one card: total qty + expandable member
  PRs).
- Each consolidated **awaiting-PO** card has a **select checkbox**; a toolbar **Generate PO** button
  enables when ≥1 selected (single or bulk).
- **Generate PO dialog** (only popup): Vendor, Delivery Date, Payment Terms, Transport Terms,
  Remarks. Displays consolidated qty, linked PRs, material details. Supports manual qty adjustment
  and split (drop a PR from this PO). On confirm → creates the PO(s), links PRs, flips them to
  `converted_to_po`.
- **PO-created cards** become **monitoring cards**: PO Number, Vendor, Ordered / Received / Pending
  qty, ETA, Status (e.g. Partial Receipt), live-synced from GRN. No Generate PO button.

### 6.4 Received column
Final receipt summary. Manual move retained; auto-suggest move-to-Received when the linked PO is
fully received.

---

## 7. API changes

- **`PUT /api/purchase-requisitions/[id]` (new):** edit draft fields (boardType, gsm, sizeLabel,
  qtyRequired, requiredByDate, supplierId, remarks, re-point materialId). Rejects edits when
  status ≠ `pending`. Writes one `AuditLog` row per changed field.
- **`PUT /api/purchase-requisitions/[id]/stage` (adjust):** `ordered` now sets status `ordered`
  (not `converted_to_po`) and **no longer mutates `qtyQuarantine`**. Other transitions unchanged.
- **`POST /api/purchase-requisitions/generate-po` (new — core of the order step):**
  Body `{ prIds: string[], vendorId, deliveryDate, paymentTerms, transportTerms, remarks,
  lineAdjustments? }`. Re-runs the consolidation engine server-side over the given PRs (one PO line
  per group), creates one `VendorMaterialPurchaseOrder`, writes `VendorPoRequisitionLink` rows with
  per-PR `allocatedQty`, flips PRs to `converted_to_po`, audit-logs. The existing single-PR
  `convert-to-po` endpoint is kept and delegates to this logic.
- **`GET /api/purchase-requisitions` (extend):** also return `boardType, gsm, sizeLabel,
  requiredByDate, remarks, supplierId`, and for Ordered cards the PO monitoring fields (poNumber,
  vendor, orderedQty, receivedQty, pendingQty, eta, status) by joining the linked PO via the join
  table. Consolidation grouping runs client-side via the shared lib (the board already fetches the
  full list).

---

## 8. Sync & auditability (Sections 7, 18–19 — partial, Phase 1 surface)

- **GRN is the sole receiving authority.** No receiving logic added to the Kanban. Monitoring
  numbers (received/pending) are **derived** from `VendorMaterialReceipt` rollups
  (`totalReceivedKg` vs line `totalWeightKg`) — never written from the board.
- **Incoming-stock fix:** `ordered` status no longer touches `Inventory.qtyQuarantine`. "Incoming"
  derives from real open POs. (Removing the existing bump is part of the stage-route adjustment;
  verify nothing else relies on the old behavior.)
- Every PR mutation (edit, approve, stage move, PO generation, delete) writes `AuditLog`, extending
  the existing pattern.

---

## 9. Testing

- **Unit (Vitest):** `pr-consolidation.test.ts` — grouping keys, cross-vendor merge, qty totals,
  vendor suggestion, single-member groups, empty input, mixed materials.
- **Browser preview:** verify board renders, compact cards, draft drawer edit/save/approve + lock +
  revision history, Ordered consolidation, single + bulk Generate PO, monitoring card numbers.
- Existing tests must stay green (`npm test`, `npm run typecheck`).

---

## 10. Risks / watch-outs

- **`qtyQuarantine` semantics:** confirm no other module reads it expecting the PR-move bump before
  removing it. If it's load-bearing elsewhere, gate the change behind the PO-derived incoming
  calculation instead of a hard removal.
- **Legacy ordered rows** currently sit at `converted_to_po` with fake poReferences and no real PO.
  The monitoring view must degrade gracefully (no linked PO → show "legacy / no PO" rather than
  erroring).
- **`mapFilterToDbStatuses`** and any external consumers of the `ordered` filter must include both
  `ordered` and `converted_to_po`.
