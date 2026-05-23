# Paper Warehouse Procurement Hub — Phase 2 Design

**Date:** 2026-05-23
**Status:** Approved design — ready for implementation plan
**Scope:** Phase 2 of the procurement initiative. Transforms the Paper Warehouse page into a tabbed procurement hub covering Sections 9–17 of the master prompt: direct PO fast-track, open-PO visibility, incoming deliveries timeline, RAG status system, unified material drawer, smart procurement suggestions, KPI strip, and reporting hub.

---

## 1. Context & current state

The Paper Warehouse lives at `src/app/(dashboard)/inventory/page.tsx` (2,736 lines — a monolith). It already has:

- A material inventory table with `shortage_sheets`, `daysOfCover`, `open_pr_id`/`open_pr_status`, `ageing_risk`
- A `procureState` modal for creating PRs from shortage rows (calls `/api/inventory/paper-warehouse/[id]/create-pr`)
- A material drawer (`materialDrawerRow`, `materialDrawerView`) with pseudo-tabs: history / reserved / available / shortage / free — backed by `/api/inventory/paper-warehouse/[id]/details` and `/[id]/reservations`
- KPI tiles (shortage, available, reserved, incoming, value, ageing risk) with `warehouseKpiFilter` driving table filtering
- No PO visibility — users can't see what's on order from this page
- No RAG status signal on rows

Phase 1 (PR Kanban) added `VendorPoRequisitionLink` (join table), `ordered` status, and the bulk generate-PO endpoint. Phase 2 builds on that foundation.

**Established facts (do not break):**
- `VendorMaterialPurchaseOrder` = vendor/procurement PO (NOT `PurchaseOrder` which is the customer/sales PO)
- `VendorMaterialPurchaseOrderLine` tracks boardGrade + gsm + totalWeightKg — no materialId FK today
- PR-linked POs are reachable via `VendorPoRequisitionLink → PurchaseRequisition.materialId`
- The existing `/orders/procurement` page manages vendor POs with GRN, receipts, logistics HUD — this page is untouched by Phase 2

---

## 2. Goals (Phase 2)

1. Transform the 2,736-line monolith into a tabbed shell + focused tab components
2. Add RAG (green/amber/red) procurement status signal to each material row
3. Add a unified material drawer (5 tabs replacing the existing pseudo-tab drawer)
4. Surface direct PO fast-track (no PR required) from warehouse rows and the drawer
5. Surface "generate PO from existing approved PR" from the drawer's Open PRs tab
6. Add Open POs tab — board-wide view of active vendor POs with GRN progress
7. Add Incoming tab — delivery timeline grouped by week
8. Add smart procurement suggestion strip in the drawer and inline on red rows
9. Upgrade the KPI strip to 5 actionable tiles (shortage / being-handled / incoming / open-PO value / avg days of cover)
10. Add Reports tab — spend by vendor, receipt accuracy, lead time trend

### Non-goals (Phase 3)
- Unified cross-module stock-math service
- Full audit hardening beyond existing `createAuditLog` pattern
- Warehouse-side inventory adjustments or write-offs

---

## 3. Data model changes (one additive migration)

### 3.1 `VendorMaterialPurchaseOrder`
Add one nullable FK:
```prisma
materialId  String?   @map("material_id")
material    Inventory? @relation(fields: [materialId], references: [id])
```

**Purpose:** Direct fast-track POs (created without a PR) populate `materialId` so they can be queried by material. PR-linked POs leave it null — already reachable via `VendorPoRequisitionLink`.

**Querying POs by material** uses UNION of both paths:
- PR-linked: `VendorPoRequisitionLink → PurchaseRequisition.materialId`
- Direct: `VendorMaterialPurchaseOrder.materialId`

Migration file: `prisma/migrations/20260523000000_vendor_po_material_fk/migration.sql`
```sql
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN "material_id" TEXT;
ALTER TABLE "vendor_material_purchase_orders"
  ADD CONSTRAINT "vendor_material_purchase_orders_material_id_fkey"
  FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "vendor_material_purchase_orders_material_id_idx"
  ON "vendor_material_purchase_orders"("material_id");
```

**Do NOT apply with `prisma migrate dev`** — `DATABASE_URL` points to the production Neon DB. Create the file manually; apply with `prisma migrate deploy`.

---

## 4. Architecture & file structure

### 4.1 Page shell

`src/app/(dashboard)/inventory/page.tsx` shrinks to ~300 lines. It holds:
- Active tab state (URL `?tab=stock|open-pos|incoming|reports`)
- Search query + `warehouseKpiFilter` (shared across tabs)
- Material drawer open/closed + which row
- Data fetch for the KPI strip and warehouse row list (Stock tab)

All rendering delegates to tab components.

### 4.2 New files

```
src/app/(dashboard)/inventory/
  components/
    WarehouseKpiStrip.tsx       — 5-tile KPI bar (replaces inline tiles)
    StockTab.tsx                — extracted inventory table + RAG signal
    OpenPosTab.tsx              — active vendor POs with GRN progress
    IncomingTab.tsx             — delivery timeline grouped by week
    ReportsTab.tsx              — spend / accuracy / lead-time charts
    MaterialDrawer.tsx          — unified 5-tab drawer
    DirectPoDialog.tsx          — fast-track PO + from-PR PO creation dialog

src/lib/
  procurement-rag.ts            — pure fn computeRag() → 'green'|'amber'|'red'
  procurement-rag.test.ts       — 6 Vitest unit tests
  procurement-suggestions.ts    — pure fn computeSuggestion() → ProcurementSuggestion|null
  procurement-suggestions.test.ts — 4 Vitest unit tests

src/app/api/inventory/paper-warehouse/
  [id]/direct-po/route.ts       — POST: fast-track PO for a material
  [id]/open-pos/route.ts        — GET: POs linked to a specific material (drawer tab)
  open-pos/route.ts             — GET: all active POs board-wide (OpenPosTab)
  reports/route.ts              — GET: spend/accuracy/lead-time aggregates (ReportsTab)
```

### 4.3 Modified files

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `materialId` nullable FK on `VendorMaterialPurchaseOrder` |
| `src/app/(dashboard)/inventory/page.tsx` | Extract to shell; wire tabs + drawer + KPI strip |
| `src/app/api/inventory/paper-warehouse/route.ts` | Add `hasOpenPo` boolean to each row in list response |

---

## 5. RAG signal system

### 5.1 Logic (`src/lib/procurement-rag.ts`)

```typescript
export type ProcurementRag = 'green' | 'amber' | 'red'

export function computeRag(row: {
  shortage_sheets: number
  open_pr_id: string | null
  open_pr_status: string | null
  hasOpenPo: boolean
}): ProcurementRag {
  if (row.shortage_sheets <= 0) return 'green'
  if (row.hasOpenPo || (row.open_pr_id && row.open_pr_status !== 'received')) return 'amber'
  return 'red'
}
```

### 5.2 Data source

`hasOpenPo` added to the warehouse list API response — a join-count on `VendorMaterialPurchaseOrder` via both paths (PR-linked + direct FK). No new table; computed in the existing list query.

### 5.3 Visual expression

- Left-border on the table row: `border-l-2 border-ds-success/warning/error`
- Dot in the Status column: filled circle, `bg-ds-success/warning/error`
- Red rows also show a subtle `⚡ ~N kg` suggestion chip in the Status cell

### 5.4 Tests (6)

1. No shortage → green
2. Shortage + open PR (not received) → amber
3. Shortage + open PO → amber
4. Shortage + nothing → red
5. Shortage + received PR only → red
6. Zero shortage + stale received PR → green

---

## 6. Material Drawer (`MaterialDrawer.tsx`)

Replaces the existing inline `SlideOverPanel` block. Uses `GlobalPopoutModal` with `mode="preview"`.

### 6.1 Props

```typescript
type MaterialDrawerProps = {
  row: PaperWarehouseRow | null
  isOpen: boolean
  onClose: () => void
  onPrCreated: () => void
  onPoCreated: () => void
}
```

### 6.2 Tabs

| Tab | Content | Endpoint |
|-----|---------|----------|
| **Overview** | Stock tiles (available/reserved/incoming/shortage/DoC) + RAG badge + smart suggestion strip | `materialDrawerData` already fetched |
| **Reservations** | Job cards holding reservations — qty, job number, product, required date | Existing `/paper-warehouse/[id]/reservations` |
| **Open PRs** | PRs in pending/approved/ordered for this material — status, qty, required date, "Generate PO →" button | `/purchase-requisitions?materialId=X` (extend list filter) |
| **Open POs** | POs for this material with GRN progress bar — PO number, vendor, ordered kg, received kg, ETA | New `/paper-warehouse/[id]/open-pos` |
| **History** | Receipt ledger (existing genealogy/details view) | Existing `/paper-warehouse/[id]/details` |

Each tab **fetches lazily** on first activation. Active tab in local state (not URL — drawer is transient).

### 6.3 Smart suggestion strip (Overview tab)

Shown only when RAG is amber or red:
```
⚡ Suggested reorder: 4,200 kg  (covers ~45 days)
  [Create PR]   [Fast-track PO →]
```

"Create PR" calls the existing `/paper-warehouse/[id]/create-pr` endpoint.
"Fast-track PO →" opens `DirectPoDialog` in `mode="direct"`.

---

## 7. Direct PO + Generate-from-PR

### 7.1 `DirectPoDialog.tsx`

Single dialog, two modes:

```typescript
type DirectPoDialogProps = {
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  mode: 'direct' | 'from-pr'
  prId?: string
  prefillQty?: number
  onSuccess: () => void
  onClose: () => void
}
```

**Fields (both modes):** Vendor (searchable dropdown from `/api/procurement/suppliers`), Qty kg (pre-filled), Delivery Date, Payment Terms, Transport Terms, Remarks.

**`direct` mode** submits to `POST /api/inventory/paper-warehouse/[materialId]/direct-po`.
**`from-pr` mode** submits to `POST /api/purchase-requisitions/generate-po` with `{ prIds: [prId], vendorId, ... }` (Phase 1 endpoint, reused).

### 7.2 `POST /api/inventory/paper-warehouse/[materialId]/direct-po`

Auth: `requireRole('stores', 'production_manager', 'operations_head', 'md')`

Body: `{ supplierId, qtyKg, sizeLabel?, ratePerKg?, deliveryDate?, paymentTerms?, transportTerms?, remarks? }`

Logic:
1. Fetch `Inventory` row to get `boardGrade` + `gsm`
2. Create `VendorMaterialPurchaseOrder` with `materialId` populated, `status = 'draft'`
3. Create one `VendorMaterialPurchaseOrderLine` (`boardGrade`, `gsm`, `totalWeightKg = qtyKg`)
4. No `VendorPoRequisitionLink` (no PR)
5. `createAuditLog`
6. Return `{ poId, poNumber }`

### 7.3 Generate-from-PR entry point

In the material drawer's **Open PRs tab**, each row with `status = 'approved'` or `'ordered'` has a "Generate PO →" button. This opens `DirectPoDialog` in `mode="from-pr"` with the PR's qty pre-filled. On submit it calls the existing Phase 1 endpoint — no new API.

---

## 8. Open POs Tab + Incoming Tab

### 8.1 `GET /api/inventory/paper-warehouse/open-pos`

Returns all `VendorMaterialPurchaseOrder` rows where status is not `received` and `isShortClosed = false`.

Response row:
```typescript
{
  id, poNumber, supplierId, vendorName,
  materialId, materialCode, boardGrade, gsm,
  orderedKg: number,       // sum of line.totalWeightKg
  receivedKg: number,      // totalReceivedKg
  pendingKg: number,       // orderedKg - receivedKg
  requiredDeliveryDate: string | null,
  status: string,
  logisticsStatus: string | null,
  daysOverdue: number | null,
  linkedPrIds: string[]    // from VendorPoRequisitionLink
}
```

Resolves materialCode via:
- Direct POs: `VendorMaterialPurchaseOrder.materialId → Inventory.materialCode`
- PR-linked POs: `VendorPoRequisitionLink → PurchaseRequisition → Inventory.materialCode` (first PR's material)

### 8.2 `OpenPosTab.tsx`

Table columns: PO Number · Vendor · Material · Ordered kg · Received kg · Pending kg · ETA · Status

GRN progress bar: thin `div` inside the Received kg cell, `width = receivedKg/orderedKg * 100%`, colour = `ds-success` when ≥100%, `ds-warning` otherwise.

Overdue rows: `bg-ds-error/5` row tint + `ds-error` text on ETA cell when `daysOverdue > 0` and `pendingKg > 0`.

Filter chips: All / Dispatched / In Transit / At Gate / Overdue. Search by PO number or vendor.

### 8.3 `IncomingTab.tsx`

Same data as `OpenPosTab` — reuses `useOpenPos()` React Query hook (fetched once, cached across tab switches). Filters for POs with `requiredDeliveryDate` set, sorts ascending, groups by ISO week client-side.

Layout: week header → `Week of 26 May · 3 POs · 12,400 kg` → PO cards showing vendor, material, pending kg, logistics badge. Empty state links to Open POs tab.

---

## 9. Smart Suggestions

### 9.1 `src/lib/procurement-suggestions.ts`

```typescript
export type ProcurementSuggestion = {
  suggestedKg: number
  coversDays: number
  basis: 'reorder_level' | 'consumption'
}

export function computeSuggestion(row: {
  shortage_sheets: number
  incoming_sheets: number
  reorder_level: number
  daysOfCover: number | null
  packet_weight: number
}): ProcurementSuggestion | null
// Returns null when shortage_sheets <= 0
// suggestedKg = max(reorder_level, shortage_sheets) × packet_weight, capped at 90-day buffer
// basis = 'reorder_level' if reorder_level > shortage_sheets, else 'consumption'
```

### 9.2 Tests (4)

1. No shortage → null
2. Shortage < reorder_level → uses reorder_level, basis = 'reorder_level'
3. Shortage > reorder_level → uses shortage, basis = 'consumption'
4. Incoming partially covers shortage → net shortage drives qty

---

## 10. KPI Strip (`WarehouseKpiStrip.tsx`)

Five tiles, all data from the existing warehouse list payload (no new API):

| Tile | Computed from | Colour logic | Click action |
|------|--------------|--------------|--------------|
| Materials in shortage | Count of red RAG rows | `ds-error` always | Filter to red rows |
| Being handled | Count of amber RAG rows | `ds-warning` always | Filter to amber rows |
| Incoming this week | Sum pendingKg where `daysOverdue` ≥ -7 | `ds-ink` | Switch to Incoming tab |
| Open PO value | Sum pendingKg × ratePerKg where known | `ds-ink` | Switch to Open POs tab |
| Avg days of cover | Mean `daysOfCover` across non-zero rows | >30 → `ds-success`, 10–30 → `ds-warning`, <10 → `ds-error` | No filter |

Replaces the existing `warehouseKpiFilter` tile row inline in `page.tsx`. Tiles 1 and 2 set `warehouseKpiFilter`; tiles 3 and 4 change the active tab.

---

## 11. Reports Tab (`ReportsTab.tsx`)

**`GET /api/inventory/paper-warehouse/reports`** — three aggregates in one response:

```typescript
{
  spendByVendor: Array<{ vendorName, totalInr, poCount }>  // last 90 days
  receiptAccuracy: Array<{ vendorName, orderedKg, receivedKg, accuracyPct }>
  leadTimeTrend: Array<{ month: string, avgDays: number }>  // last 6 months
}
```

Derived entirely from `VendorMaterialPurchaseOrder` + `VendorMaterialReceipt` — no new tables.

Charts reuse the `PriceTrendSparkline` / `DeliveryAccuracyChart` dynamic import pattern already in `src/app/(dashboard)/orders/procurement/_components/ProcurementCharts.tsx`. Reports tab fetches lazily on first activation.

---

## 12. API summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/inventory/paper-warehouse/route.ts` | GET (extend) | Add `hasOpenPo` to each row |
| `/api/inventory/paper-warehouse/[id]/direct-po` | POST (new) | Fast-track PO from warehouse |
| `/api/inventory/paper-warehouse/[id]/open-pos` | GET (new) | POs for one material (drawer tab) |
| `/api/inventory/paper-warehouse/open-pos` | GET (new) | All active POs board-wide |
| `/api/inventory/paper-warehouse/reports` | GET (new) | Aggregates for Reports tab |
| `/api/purchase-requisitions` | GET (extend) | Add `?materialId=` filter |

Existing endpoints untouched: `/[id]/create-pr`, `/[id]/reservations`, `/[id]/details`, `/[id]/genealogy`, and all Phase 1 PR Kanban endpoints.

---

## 13. Testing

**Unit (Vitest):**
- `src/lib/procurement-rag.test.ts` — 6 tests (green/amber/red logic)
- `src/lib/procurement-suggestions.test.ts` — 4 tests (suggestion qty + basis)

**Browser verification:**
- Stock tab renders with RAG left-borders; red/amber/green counts match KPI strip tiles
- Click KPI tile → table filters correctly
- Open material drawer → all 5 tabs load; Overview shows suggestion strip on shortage rows
- Direct PO dialog → creates PO, materialId populated, appears in Open POs tab
- Generate-from-PR dialog → reuses Phase 1 endpoint, PO links to PR in VendorPoRequisitionLink
- Open POs tab → GRN progress bar, overdue row tint, filter chips
- Incoming tab → grouped by week, sorted ascending
- Reports tab → three charts render from aggregated data

---

## 14. Risks / watch-outs

- **`VendorMaterialPurchaseOrderLine` has no `materialId`** — resolving materialCode for PR-linked POs requires going through the join table chain. The board-wide open-pos endpoint must handle both paths (UNION query or two fetches merged).
- **Legacy direct POs** (created before Phase 2 with `materialId = null` and no linked PR) will appear in the board-wide tab without a material code. Show "—" gracefully; do not error.
- **`inventory` table primary key** — confirm `Inventory.id` is the correct FK target for `materialId`. The `Inventory` model is the paper warehouse stock record (not `Material` which is the master catalogue).
- **Reports tab cold start** — the aggregation query spans 90 days of POs + receipts. Add a DB index on `VendorMaterialPurchaseOrder.order_date` if the query is slow.
- **Tab URL param** — `?tab=` must not conflict with any existing query params on the inventory page. Current params are `?search=` and `?shortage=`. Use `?warehouseTab=` to avoid collision.
