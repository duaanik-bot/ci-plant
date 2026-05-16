# Database Migration Plan: colour.sql → CI-Production (Neon PostgreSQL)

> **Last updated:** May 2026  
> **Source:** MySQL 8.0 `colour` database (Laravel/phpMyAdmin export, 106MB)  
> **Target:** Neon PostgreSQL via Prisma (Next.js CI-Production)  
> **Strategy:** Big-bang migration using `scripts/migrate-from-legacy.ts`

---

## Pre-Migration Checklist

```bash
# 1. Convert charset (latin1 → UTF-8)
iconv -f latin1 -t utf8 colour.sql > colour_utf8.sql

# 2. Import into local MySQL 8.0
mysql -u root -p -e "CREATE DATABASE colour_legacy;"
mysql -u root -p colour_legacy < colour_utf8.sql

# 3. Set local MySQL env var in .env.migration (do NOT put in .env)
LOCAL_MYSQL_URL="mysql://root:PASSWORD@127.0.0.1:3306/colour_legacy"
DATABASE_URL="postgresql://..."  # Your Neon connection string

# 4. Install mysql2 as dev dependency
npm install --save-dev mysql2

# 5. Dry run first
npx tsx scripts/migrate-from-legacy.ts --dry-run

# 6. Real run
npx tsx scripts/migrate-from-legacy.ts
```

---

## What's Being Migrated

### ✅ GROUP 1 — Roles

| Old Table | Old Columns | New Model | New Columns | Notes |
|---|---|---|---|---|
| `roles` | id, name, display_name, created_at, updated_at | `Role` | roleName, permissions, wastageApproveLimitPct, canApproveArtwork, canReleaseDispatch | `name` → `roleName`; permissions default `{}`; booleans default false |

**23 roles being migrated:** Super Admin, Admin, Plant Head, Designer, Cutting, Printing, Coating, Lamination, Embossing, Leafing, Spot UV, Dye Cutting, Pasting, Billing, PO, Dye Breaking, Store, Gate Keeper, Dispatch, Manager, Deigntopasting, Desintojobcard, artwork

---

### ✅ GROUP 2A — Users (Admins)

| Old Table | Old Columns | New Model | New Columns | Notes |
|---|---|---|---|---|
| `admins` | id, role_id, name, email, mobile, password, status, deleted_at | `User` | name, email, pinHash, roleId, whatsappNumber, machineAccess, active | **password CANNOT be converted** — pinHash set to a temporary known PIN hash; status 1→active=true; skip deleted_at IS NOT NULL |

> ⚠️ **Auth:** Old passwords are Laravel bcrypt — incompatible with new PIN system. All migrated users get PIN `0000` by default. Use `/scripts/reset-pin.ts` to set real PINs after migration.

---

### ✅ GROUP 2B — Customers (Clients)

| Old Column | New Column | Transformation |
|---|---|---|
| `company_name` | `name` | Primary name; fallback to `full_name` if null |
| `email` | `email` | Direct |
| `mobile` | `contactPhone` | Direct |
| `first_name` + `last_name` | `contactName` | Concatenated |
| `gst` | `gstNumber` | Direct |
| `address` | `address` | Direct |
| `city` | Appended to `address` | Append city+pincode to address string |
| — | `source` | Set to `'migrated'` |
| — | `pan` | Empty string |
| — | `stateCode` | Empty string |
| — | `requiresArtworkApproval` | `false` |
| — | `creditLimit` | `0` |
| `deleted_at` | Filter | WHERE deleted_at IS NULL only |

**7 clients → 7 customers**

---

### ✅ GROUP 2C — Suppliers (Vendors)

| Old Column | New Column | Transformation |
|---|---|---|
| `name` | `name` | Direct |
| `email` | `email` | Direct |
| `phone_no` | `contactPhone` | Direct |
| `gst` | `gstNumber` | Direct |
| `address` | `address` | Direct |
| — | `materialTypes` | `[]` |
| — | `defaultForBoardGrades` | `[]` |
| — | `leadTimeDays` | `7` |
| — | `paymentTermsDays` | `30` |
| — | `active` | `true` |
| `deleted_at` | Filter | WHERE deleted_at IS NULL only |

**21 vendors → 21 suppliers**

---

### ✅ GROUP 2D — Die Masters (Dye Details)

| Old Column | New Column | Transformation |
|---|---|---|
| `dye_no` | `dyeNumber` | `Math.round(dye_no)` → Int |
| `dye_lock` | `pastingStyle` | `'BSO'→'BSO'`, `'lockbottom'→'LOCK_BOTTOM'`, else `'SPECIAL'` |
| `ups` | `ups` | `Math.round(ups)` → Int |
| `sheet_size` | `sheetSize` | Direct string (e.g. "15.75x20.75") |
| `carton_size` | `cartonSize` | Direct string (e.g. "100X48X48") |
| — | `dyeType` | `'Cutting Die'` default |
| — | `impressionCount` | `0` |
| — | `maxImpressions` | `100000` |
| — | `condition` | `'Good'` |
| — | `custodyStatus` | `'in_stock'` |
| — | `active` | `true` |
| `deleted_at` | Filter | WHERE deleted_at IS NULL only |

> Note: Old columns `length`, `width`, `height` = carton dimensions in mm (already in `carton_size`). `automatic` = always '0'.

**273 dye records being migrated**

---

### ✅ GROUP 2E — Carton Masters (Old `cartons` table)

> ⚠️ The old `cartons` table = carton product masters (linked to clients). Maps to new `Carton` model.  
> Old `products` table = paper/board grades (raw materials). Maps to new `Inventory` model.

| Old Column | New Column | Transformation |
|---|---|---|
| `client_id` | `customerId` | Lookup old client_id → new Customer UUID |
| `carton_name` | `cartonName` | Direct |
| `carton_size` | `finishedLength`/`finishedWidth`/`finishedHeight` | Parse "LxWxH" → split into 3 Decimal fields (mm) |
| `gsm` | `gsm` | `Math.round(gsm)` |
| `art_work` | `artworkCode` | Direct |
| `rate` | `rate` | Direct (null→0) |
| `coating_type_id` | `coatingType` | Map old coating_type_id to string label (see Coating Types below) |
| `paper_type_id` | `boardGrade` | Map old paper_type_id to string label |
| `embossing_leafing` | — | 1 = has embossing (noted in metadata) |
| — | `gstPct` | `12` (default) |
| — | `source` | `'migrated'` |
| — | `pastingStyle` | `'LOCK_BOTTOM'` default |

**1,729 cartons being migrated**

**Carton size parsing:** `"185X35X60"` → finishedLength=185, finishedWidth=35, finishedHeight=60

**Coating type mapping (old coating_type_id → string):**  
1 → 'Matt', 2 → 'Gloss', 3 → 'Matt Lamination', 4 → 'Gloss Lamination', 5 → 'Soft Touch', else → 'None'

**Paper type mapping (old paper_type_id → boardGrade string):**  
1 → 'FBB', 2 → 'SBS', 3 → 'GD2/Grey Back', 7 → 'Art Card', else → 'Other'

---

### ✅ GROUP 3A — Inventory (Old `products` = Board/Paper Grades)

> The old `products` table stores paper/board specifications in format "WIDTHxLENGTH-GSM" (inches).

| Old Column | New Column | Transformation |
|---|---|---|
| `code` | `materialCode` | Direct (e.g. "0001") |
| `name` | `description` | Direct (e.g. "20X38-290") |
| `length` | `sheetLength` | Inches → mm: `parseFloat(length) * 25.4` |
| `width` | `sheetWidth` | Inches → mm: `parseFloat(width) * 25.4` |
| `gsm` | `gsm` | Direct Int |
| `quantity` | `qtyAvailable` | In sheets (Decimal) |
| `category_id` | `boardClassification` | 1 → 'A', 2 → 'B', else → 'C' |
| `product_type_id` | `boardType` | 1 → 'SBS', 2 → 'FBB', 7 → 'Art Card', else → 'Other' |
| — | `unit` | `'Sheets'` |
| — | `category` | `'A'` default |
| — | `qtyReserved` | `0` |
| — | `qtyFg` | `0` |
| — | `weightedAvgCost` | `0` |
| — | `reorderPoint` | `0` |
| — | `safetyStock` | `0` |
| — | `physicalStockSheets` | `0` |
| — | `shortageSheets` | `0` |
| — | `totalWeightKg` | `0` |
| — | `active` | `true` |
| `deleted_at` | Filter | WHERE deleted_at IS NULL |

**376 products → 376 inventory records**

---

### ✅ GROUP 3B — Vendor Material Purchase Orders (Old `material_orders`)

| Old Column | New Column | Transformation |
|---|---|---|
| `order_no` | `poNumber` | Direct (e.g. "RM/26-27/0001") |
| `vendor_id` | `supplierId` | Lookup old vendor_id → new Supplier UUID |
| `mo_date` | `orderDate` | Date field |
| `status_id` | `status` | 1→'draft', 2→'confirmed', 3→'partially_received', 4→'received', 5→'closed' |
| `remarks` | `remarks` | Direct |
| — | `createdBy` | First migrated admin's UUID |
| `deleted_at` | Filter | WHERE deleted_at IS NULL |

**1 material_order being migrated** (only 1 formal PO in old system: RM/26-27/0001)

---

### ✅ GROUP 3C — Vendor PO Lines (Old `material_order_items`)

| Old Column | New Column | Transformation |
|---|---|---|
| `material_order_id` | `vendorPoId` | Lookup old material_order_id → new VendorMaterialPurchaseOrder UUID |
| `product_id` | — | Used to get boardGrade/gsm from Inventory mapping |
| `item_name` | `boardGrade` + dimensions | Parse "WxH-GSM" → boardGrade from product lookup |
| `quantity` (packets) | `totalSheets` | quantity × item_per_packet |
| `total_weight` | `totalWeightKg` | Direct Decimal |
| `rate` | `ratePerKg` | Direct |
| `gst` | — | Not stored in new model |
| — | `grainDirection` | `'Long grain'` default |
| — | `linkedPoLineIds` | `[]` |
| `deleted_at` | Filter | WHERE deleted_at IS NULL |

**4 order items (deleted items excluded)**

---

### ✅ GROUP 3D — GRN Receipts + Line Items (Old `material_inwards` + `material_inward_items`)

> **Critical constraint:** New `VendorMaterialReceipt` requires a `vendorPoId` FK (NOT NULL). Old `material_inwards` didn't have formal POs — the `material_order_no` field stores supplier bill/LR numbers as free text.

**Solution:** Create one **legacy bridge PO** per supplier that had inward receipts. These bridge POs have status `'closed'` and are clearly marked as legacy migration data.

| Old Column | New Column | Transformation |
|---|---|---|
| `vendor_id` | → Bridge PO `supplierId` | Each unique vendor_id gets a bridge VendorMaterialPurchaseOrder |
| `receipt_no` | `scaleSlipId` | Direct (e.g. "REC0001") |
| `bill_no` | `vehicleNumber` | Repurposed (stores supplier invoice no) |
| `bill_date` | `receiptDate` | Direct |
| `total` | — | Total amount (not stored — historical reference only) |
| — | `receivedQty` | SUM of `total_weight` from `material_inward_items` (Step 12) |
| — | `receivedByName` | `'Migrated Record'` |
| — | `qcStatus` | `'PASSED'` (historical — assumed passed) |
| — | `qcRemarks` | "Migrated: N line item(s), X total sheets, Y kg" |

**702 material_inwards → 702 VendorMaterialReceipt records** (+ N bridge POs where N = unique vendors)

**`material_inward_items` handling (Step 12):** The new schema has no receipt line sub-model. Line items are rolled up: `total_weight` is summed per `material_inward_id` and written to `VendorMaterialReceipt.receivedQty`. Sheet count and item count are stored in `qcRemarks` for traceability.

---

### ✅ GROUP 3E — Carton Pricing History (Old `carton_prices`)

> New system has no direct equivalent. Stored as a `priceHistory` JSON blob on the Carton record using Prisma `$executeRawUnsafe` to write to an additional column OR stored as-is in a separate archive step.

**Decision:** Store as a JSON comment in migration logs only. Carton pricing in new system is on `PoLineItem.rate`. The 4,370 historical price records are archived to `docs/carton_prices_archive.json`.

---

## ❌ Tables NOT Being Migrated (and Why)

| Old Table | Rows | Reason |
|---|---|---|
| `warehouse_items` | 4,877 | FK to `warehouses` (excluded). `warehouses` = finished goods delivery records, not raw material stock. These are historical dispatch data, not current stock. |
| `issues` + `issue_items` | 440 / 3,597 | FK to `job_cards` (excluded from migration scope). Cannot orphan-insert. |
| `paper_warehouses` | 0 | Table is **empty** — nothing to migrate. |
| `trimmed_paper_stock` | 0 | Table is **empty** — nothing to migrate. |
| `machines` | 0 | Table is **empty** — old system never populated machines. New machines (CI-01 to CI-12) must be seeded via `db:seed`. |
| `admins.users` (Laravel users) | ~5 | Generic Laravel auth users, not production staff. Not relevant. |

---

## ID Mapping Strategy

All old integer IDs are remapped to new UUIDs. An in-memory map tracks the mappings during migration. Order of operations matters:

```
1. roles          → Role
2. admins         → User         (needs roles map)
3. clients        → Customer
4. vendors        → Supplier
5. products       → Inventory    (no deps)
6. dye_details    → Dye          (no deps)
7. cartons (old)  → Carton       (needs clients→Customer map, dye_details→Dye map)
8. material_orders → VendorMaterialPurchaseOrder (needs vendors→Supplier map)
9. material_order_items → VendorMaterialPurchaseOrderLine (needs above)
10. material_inwards bridge POs → VendorMaterialPurchaseOrder
11. material_inwards → VendorMaterialReceipt (needs bridge POs)
```

---

## Post-Migration Actions

1. **Reset all user PINs** — Run `npx tsx scripts/reset-pin.ts` for each active user.
2. **Set machine records** — Run `npm run db:seed` to create CI-01 through CI-12 if not already seeded.
3. **Verify carton counts** — Check carton count in new system matches 1,729.
4. **Verify inventory** — Check 376 inventory records imported with correct GSM/dimensions (inches → mm).
5. **Check customer linkages** — Verify cartons link to correct customers.
6. **Review bridge POs** — All 702 historical GRN receipts linked to bridge POs marked `status='closed'`. Review and correct if needed.
7. **Check GRN receivedQty** — Step 12 updates each receipt's weight from inward items. Verify totals look correct.
8. **Archive carton prices** — Open `docs/carton_prices_archive.json` for historical rate reference.
