/**
 * import-from-csv.ts
 *
 * CSV-based migration: data/legacy-csv/*.csv → Neon PostgreSQL via Prisma
 * No MySQL installation required — reads pre-extracted CSV files.
 *
 * USAGE:
 *   npx tsx scripts/import-from-csv.ts           # real import
 *   npx tsx scripts/import-from-csv.ts --dry-run # validate only, no writes
 *
 * PREREQUISITES:
 *   1. DATABASE_URL must be set in .env (your Neon connection string)
 *   2. CSVs must exist in data/legacy-csv/ (already extracted)
 *   3. npx prisma generate  (if not already done)
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as bcrypt from "bcryptjs";
import { canonicalRoleSlug, USER_ROLE_OVERRIDES } from "./legacy-role-map";

// ─── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN  = process.argv.includes("--dry-run");
const CSV_DIR  = path.join(__dirname, "../data/legacy-csv");
const LOG_FILE = path.join(__dirname, "../docs/csv-import-log.json");

const DEFAULT_PIN      = "0000";
const DEFAULT_PIN_HASH = bcrypt.hashSync(DEFAULT_PIN, 10);

// ─── CSV reader ──────────────────────────────────────────────────────────────

function readCsv(table: string): Record<string, string>[] {
  const filePath = path.join(CSV_DIR, `${table}.csv`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    if (vals.length === 0) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (c === "," && !inQuote) {
      result.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string)  { console.log(`[${new Date().toISOString()}] ${msg}`); }
function warn(msg: string) { console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`); }

function str(v: string | undefined): string  { return (v ?? "").trim(); }
function num(v: string | undefined): number  { return parseFloat(str(v)) || 0; }
function int(v: string | undefined): number  { return Math.round(num(v)); }
function bool(v: string | undefined): boolean { return str(v) === "1"; }
function nullable(v: string | undefined): string | null { const s = str(v); return s === "" ? null : s; }
function dateOrNull(v: string | undefined): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function date(v: string | undefined, fallback = new Date()): Date {
  return dateOrNull(v) ?? fallback;
}

function isDeleted(row: Record<string, string>): boolean {
  return str(row.deleted_at) !== "";
}

function parseCartonSize(s: string): { length: number; width: number; height: number } {
  if (!s) return { length: 0, width: 0, height: 0 };
  const parts = s.toUpperCase().split("X").map((p) => parseFloat(p.trim()));
  return { length: parts[0] ?? 0, width: parts[1] ?? 0, height: parts[2] ?? 0 };
}

function mapCoatingType(id: string): string {
  const map: Record<string, string> = {
    "1": "Matt", "2": "Gloss", "3": "Matt Lamination",
    "4": "Gloss Lamination", "5": "Soft Touch",
  };
  return map[str(id)] ?? "None";
}

function mapPaperType(id: string): string {
  const map: Record<string, string> = {
    "1": "FBB", "2": "SBS", "3": "GD2 Grey Back", "7": "Art Card",
  };
  return map[str(id)] ?? "Other";
}

function mapPastingStyle(dyeLock: string): "LOCK_BOTTOM" | "BSO" | "SPECIAL" {
  const v = dyeLock.toLowerCase().trim();
  if (v === "bso") return "BSO";
  if (v === "lockbottom" || v === "lock_bottom" || v === "lock bottom") return "LOCK_BOTTOM";
  if (!v) return "LOCK_BOTTOM";
  return "SPECIAL";
}

function mapStatusId(id: string): string {
  const map: Record<string, string> = {
    "1": "draft", "2": "confirmed", "3": "partially_received",
    "4": "received", "5": "closed",
  };
  return map[str(id)] ?? "draft";
}

function inchesToMm(v: string): number {
  return Math.round(parseFloat(v || "0") * 25.4 * 100) / 100;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`🚀 Starting CSV import — DRY_RUN=${DRY_RUN}`);

  const prisma = new PrismaClient({ log: DRY_RUN ? [] : ["warn", "error"] });

  // ID maps: old string id → new UUID
  const maps = {
    roles:          new Map<string, string>(),
    admins:         new Map<string, string>(),
    clients:        new Map<string, string>(),
    vendors:        new Map<string, string>(),
    products:       new Map<string, string>(),
    dyes:           new Map<string, string>(),
    cartons:        new Map<string, string>(),
    materialOrders: new Map<string, string>(),
    bridgePOs:      new Map<string, string>(),
    inwardReceipts: new Map<string, string>(),
  };

  const counts: Record<string, number> = {};
  let SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

  // ══════════════════════════════════════════════════════
  // STEP 1: roles → Role
  // ══════════════════════════════════════════════════════
  log("📋 Step 1: roles → Role...");
  const roles = readCsv("roles");
  let n = 0;
  // Legacy role names map onto canonical RBAC slugs (see legacy-role-map.ts).
  // prisma/seed.ts owns the real permission sets for these slugs, so only
  // create a stub if the canonical role does not exist yet.
  const slugRoleId = new Map<string, string>();
  for (const row of roles) {
    const slug = canonicalRoleSlug(str(row.name));
    let roleId = slugRoleId.get(slug);
    if (!roleId) {
      roleId = crypto.randomUUID();
      if (!DRY_RUN) {
        const role = await prisma.role.upsert({
          where: { roleName: slug },
          update: {},
          create: {
            id: roleId,
            roleName: slug,
            permissions: {},
            wastageApproveLimitPct: 0,
            canApproveArtwork: false,
            canReleaseDispatch: false,
          },
        });
        roleId = role.id;
      }
      slugRoleId.set(slug, roleId);
      n++;
    }
    maps.roles.set(row.id, roleId);
  }
  counts.roles = n;
  log(`   ✅ ${n} canonical roles (from ${roles.length} legacy rows)`);

  // ══════════════════════════════════════════════════════
  // STEP 2: admins → User
  // ══════════════════════════════════════════════════════
  log("👤 Step 2: admins → User...");
  const admins = readCsv("admins").filter((r) => !isDeleted(r));
  n = 0;
  for (const row of admins) {
    const newId = crypto.randomUUID();
    maps.admins.set(row.id, newId);
    if (n === 0) SYSTEM_USER_ID = newId;

    let roleId = maps.roles.get(str(row.role_id));
    if (!roleId) { warn(`Admin ${row.id} (${row.name}) unknown role_id ${row.role_id} — skipping`); continue; }
    const overrideSlug = USER_ROLE_OVERRIDES[str(row.email)];
    if (overrideSlug && !DRY_RUN) {
      const ov = await prisma.role.findUnique({ where: { roleName: overrideSlug } });
      if (ov) roleId = ov.id;
    }

    if (!DRY_RUN) {
      await prisma.user.upsert({
        where: { email: str(row.email) },
        update: { name: str(row.name), active: bool(row.status), whatsappNumber: nullable(row.mobile) },
        create: {
          id: newId,
          name: str(row.name),
          email: str(row.email),
          pinHash: DEFAULT_PIN_HASH,
          roleId,
          machineAccess: [],
          active: bool(row.status),
          whatsappNumber: nullable(row.mobile),
        },
      });
    }
    n++;
  }
  counts.users = n;
  log(`   ✅ ${n} users (all PINs = "${DEFAULT_PIN}" — reset after import)`);

  // ══════════════════════════════════════════════════════
  // STEP 3: clients → Customer
  // ══════════════════════════════════════════════════════
  log("🏢 Step 3: clients → Customer...");
  const clients = readCsv("clients").filter((r) => !isDeleted(r));
  n = 0;
  for (const row of clients) {
    const newId = crypto.randomUUID();
    maps.clients.set(row.id, newId);

    const name = str(row.company_name) || str(row.full_name) ||
      `${str(row.first_name)} ${str(row.last_name)}`.trim();
    const contactName = `${str(row.first_name)} ${str(row.last_name)}`.trim() || name;
    const address = [str(row.address), str(row.city), str(row.pincode)].filter(Boolean).join(", ");

    if (!DRY_RUN) {
      await prisma.customer.upsert({
        where: { id: newId },
        update: {},
        create: {
          id: newId,
          name,
          gstNumber: str(row.gst),
          pan: "",
          stateCode: "",
          contactName,
          contactPhone: str(row.mobile),
          email: str(row.email),
          address,
          billingAddress: address,
          shippingAddress: address,
          creditLimit: 0,
          requiresArtworkApproval: false,
          active: true,
          source: "migrated",
        },
      });
    }
    n++;
  }
  counts.customers = n;
  log(`   ✅ ${n} customers`);

  // ══════════════════════════════════════════════════════
  // STEP 4: vendors → Supplier
  // ══════════════════════════════════════════════════════
  log("🏭 Step 4: vendors → Supplier...");
  const vendors = readCsv("vendors").filter((r) => !isDeleted(r));
  n = 0;
  for (const row of vendors) {
    const newId = crypto.randomUUID();
    maps.vendors.set(row.id, newId);
    if (!DRY_RUN) {
      await prisma.supplier.upsert({
        where: { id: newId },
        update: {},
        create: {
          id: newId,
          name: str(row.name) || "Unknown Supplier",
          gstNumber: str(row.gst),
          contactName: str(row.name),
          contactPhone: str(row.phone_no),
          email: str(row.email),
          address: str(row.address),
          materialTypes: [],
          defaultForBoardGrades: [],
          leadTimeDays: 7,
          paymentTermsDays: 30,
          active: true,
        },
      });
    }
    n++;
  }
  counts.suppliers = n;
  log(`   ✅ ${n} suppliers`);

  // ══════════════════════════════════════════════════════
  // STEP 5: products (paper grades) → Inventory
  // ══════════════════════════════════════════════════════
  log("📄 Step 5: products → Inventory...");
  const products = readCsv("products").filter((r) => !isDeleted(r));
  const boardTypeMap: Record<string, string> = { "1": "SBS", "2": "FBB", "7": "Art Card" };
  const classMap: Record<string, "A" | "B" | "C"> = { "1": "A", "2": "B" };
  const usedCodes = new Set<string>();
  n = 0;
  for (const row of products) {
    const newId = crypto.randomUUID();
    maps.products.set(row.id, newId);

    const sheetLengthMm = inchesToMm(row.width);  // old width col = actual length
    const sheetWidthMm  = inchesToMm(row.length); // old length col = actual width
    const boardType = boardTypeMap[str(row.product_type_id)] ?? "Other";
    const boardClass = classMap[str(row.category_id)] ?? "C";

    let matCode = str(row.code) || `LEGACY-${row.id}`;
    if (usedCodes.has(matCode)) matCode = `${matCode}-${row.id}`;
    usedCodes.add(matCode);

    if (!DRY_RUN) {
      await prisma.inventory.upsert({
        where: { materialCode: matCode },
        update: { qtyAvailable: num(row.quantity) },
        create: {
          id: newId,
          materialCode: matCode,
          description: str(row.name) || `${row.length}x${row.width}-${row.gsm}`,
          boardType,
          boardClassification: boardClass,
          sheetLength: sheetLengthMm,
          sheetWidth: sheetWidthMm,
          gsm: int(row.gsm),
          unit: "Sheets",
          supplierId: null,
          category: boardClass,
          qtyAvailable: num(row.quantity),
          qtyReserved: 0,
          qtyFg: 0,
          weightedAvgCost: 0,
          reorderPoint: 0,
          safetyStock: 0,
          physicalStockSheets: 0,
          shortageSheets: 0,
          totalWeightKg: 0,
          active: true,
        },
      });
    }
    n++;
  }
  counts.inventory = n;
  log(`   ✅ ${n} inventory records`);

  // ══════════════════════════════════════════════════════
  // STEP 6: dye_details → Dye
  // ══════════════════════════════════════════════════════
  log("🔧 Step 6: dye_details → Dye...");
  const dyes = readCsv("dye_details").filter((r) => !isDeleted(r));
  const usedDyeNums = new Set<number>();
  n = 0;
  for (const row of dyes) {
    const newId = crypto.randomUUID();
    maps.dyes.set(row.id, newId);

    let dyeNumber = int(row.dye_no) || int(row.id);
    if (usedDyeNums.has(dyeNumber)) dyeNumber = int(row.id);
    usedDyeNums.add(dyeNumber);

    if (!DRY_RUN) {
      await prisma.dye.upsert({
        where: { dyeNumber },
        update: {},
        create: {
          id: newId,
          dyeNumber,
          dyeType: "Cutting Die",
          ups: int(row.ups) || 1,
          sheetSize: str(row.sheet_size),
          cartonSize: str(row.carton_size),
          impressionCount: 0,
          maxImpressions: 100000,
          condition: "Good",
          custodyStatus: "in_stock",
          active: true,
          pastingStyle: mapPastingStyle(str(row.dye_lock)),
        },
      });
    }
    n++;
  }
  counts.dyes = n;
  log(`   ✅ ${n} die records`);

  // ══════════════════════════════════════════════════════
  // STEP 7: cartons → Carton
  // ══════════════════════════════════════════════════════
  log("📦 Step 7: cartons → Carton...");
  const cartons = readCsv("cartons");
  const firstCustomerId = [...maps.clients.values()][0];
  n = 0;
  for (const row of cartons) {
    const newId = crypto.randomUUID();
    maps.cartons.set(row.id, newId);

    const customerId = maps.clients.get(str(row.client_id)) ?? firstCustomerId;
    if (!maps.clients.has(str(row.client_id))) {
      warn(`Carton ${row.id} (${row.carton_name}): unknown client_id ${row.client_id} — using first customer`);
    }

    const { length: fl, width: fw, height: fh } = parseCartonSize(str(row.carton_size));

    if (!DRY_RUN) {
      await prisma.carton.upsert({
        where: { id: newId },
        update: {},
        create: {
          id: newId,
          cartonName: str(row.carton_name) || "Unnamed",
          customerId,
          rate: num(row.rate),
          gstPct: 12,
          hsnCode: null,
          boardGrade: mapPaperType(str(row.paper_type_id)),
          gsm: int(row.gsm) || 300,
          finishedLength: fl,
          finishedWidth: fw,
          finishedHeight: fh,
          blankLength: 0,
          blankWidth: 0,
          pastingStyle: "LOCK_BOTTOM",
          dyeId: null,
          dieMasterId: null,
          artworkCode: nullable(row.art_work),
          laminateType: null,
          coatingType: mapCoatingType(str(row.coating_type_id)),
          source: "migrated",
        },
      });
    }
    n++;
  }
  counts.cartons = n;
  log(`   ✅ ${n} carton product masters`);

  // ══════════════════════════════════════════════════════
  // STEP 8: material_orders → VendorMaterialPurchaseOrder
  // ══════════════════════════════════════════════════════
  log("🛒 Step 8: material_orders → VendorPO...");
  const matOrders = readCsv("material_orders").filter((r) => !isDeleted(r));
  n = 0;
  for (const row of matOrders) {
    const newId = crypto.randomUUID();
    maps.materialOrders.set(row.id, newId);
    const supplierId = maps.vendors.get(str(row.vendor_id));
    if (!supplierId) { warn(`MaterialOrder ${row.id}: unknown vendor_id ${row.vendor_id}`); continue; }
    if (!DRY_RUN) {
      await prisma.vendorMaterialPurchaseOrder.upsert({
        where: { poNumber: str(row.order_no) },
        update: {},
        create: {
          id: newId,
          poNumber: str(row.order_no),
          supplierId,
          status: mapStatusId(str(row.status_id)),
          orderDate: date(row.mo_date),
          remarks: nullable(row.remarks),
          createdBy: SYSTEM_USER_ID,
          totalReceivedKg: 0,
          totalUsableReceivedKg: 0,
          accruedReceiptPayableInr: 0,
        },
      });
    }
    n++;
  }
  counts.vendorPOs = n;
  log(`   ✅ ${n} vendor POs`);

  // ══════════════════════════════════════════════════════
  // STEP 9: material_order_items → VendorMaterialPurchaseOrderLine
  // ══════════════════════════════════════════════════════
  log("📋 Step 9: material_order_items → VendorPOLine...");
  const moItems = readCsv("material_order_items").filter((r) => !isDeleted(r));
  n = 0;
  for (const row of moItems) {
    const vendorPoId = maps.materialOrders.get(str(row.material_order_id));
    if (!vendorPoId) { warn(`MOItem ${row.id}: unknown material_order_id ${row.material_order_id}`); continue; }
    const inventoryId = maps.products.get(str(row.product_id));
    const totalSheets = Math.round(num(row.quantity) * num(row.item_per_packet));
    if (!DRY_RUN) {
      await prisma.vendorMaterialPurchaseOrderLine.create({
        data: {
          vendorPoId,
          boardGrade: "Other",
          gsm: 0,
          grainDirection: "Long grain",
          totalSheets,
          totalWeightKg: num(row.total_weight),
          ratePerKg: row.rate_on ? num(row.rate_on) : null,
          freightTotalInr: 0,
          unloadingChargesInr: 0,
          insuranceMiscInr: 0,
          linkedPoLineIds: inventoryId ? [inventoryId] : [],
        },
      });
    }
    n++;
  }
  counts.vendorPOLines = n;
  log(`   ✅ ${n} vendor PO lines`);

  // ══════════════════════════════════════════════════════
  // STEP 10: material_inwards → bridge POs + VendorMaterialReceipt
  // ══════════════════════════════════════════════════════
  log("📥 Step 10: material_inwards → GRN receipts...");
  const inwards = readCsv("material_inwards").filter((r) => !isDeleted(r));

  // Create one bridge PO per unique vendor
  const uniqueVendorIds = [...new Set(inwards.map((r) => str(r.vendor_id)))];
  let bridgePOCount = 0;
  for (const vendorId of uniqueVendorIds) {
    const supplierId = maps.vendors.get(vendorId);
    if (!supplierId) { warn(`No supplier for vendor_id ${vendorId} — bridge PO skipped`); continue; }
    const bridgeId = crypto.randomUUID();
    maps.bridgePOs.set(vendorId, bridgeId);
    const bridgePoNumber = `LEGACY-BRIDGE-V${vendorId}`;
    if (!DRY_RUN) {
      await prisma.vendorMaterialPurchaseOrder.upsert({
        where: { poNumber: bridgePoNumber },
        update: {},
        create: {
          id: bridgeId,
          poNumber: bridgePoNumber,
          supplierId,
          status: "closed",
          orderDate: new Date("2024-08-01"),
          remarks: `Legacy migration bridge PO — historical receipts from vendor_id ${vendorId}`,
          createdBy: SYSTEM_USER_ID,
          totalReceivedKg: 0,
          totalUsableReceivedKg: 0,
          accruedReceiptPayableInr: 0,
        },
      });
    }
    bridgePOCount++;
  }
  log(`   📌 ${bridgePOCount} bridge POs created`);

  n = 0;
  for (const row of inwards) {
    const vendorPoId = maps.bridgePOs.get(str(row.vendor_id));
    if (!vendorPoId) { warn(`Inward ${row.id}: no bridge PO for vendor_id ${row.vendor_id}`); continue; }
    const billDate = date(row.bill_date, date(row.created_at));
    if (!DRY_RUN) {
      const receipt = await prisma.vendorMaterialReceipt.create({
        data: {
          vendorPoId,
          receiptDate: billDate,
          receivedQty: 0,
          vehicleNumber: str(row.bill_no) || "LEGACY",
          scaleSlipId: str(row.receipt_no) || `INWARD-${row.id}`,
          receivedByName: "Migrated Record",
          qcStatus: "PASSED",
        },
      });
      maps.inwardReceipts.set(str(row.id), receipt.id);
    } else {
      maps.inwardReceipts.set(str(row.id), crypto.randomUUID());
    }
    n++;
  }
  counts.grnReceipts = n;
  log(`   ✅ ${n} GRN receipts`);

  // ══════════════════════════════════════════════════════
  // STEP 11: material_inward_items → update GRN receivedQty
  // ══════════════════════════════════════════════════════
  log("⚖️  Step 11: rolling up inward items → GRN weights...");
  const inwardItems = readCsv("material_inward_items").filter((r) => !isDeleted(r));

  // Group by material_inward_id
  const weightMap = new Map<string, { kg: number; sheets: number; count: number }>();
  for (const row of inwardItems) {
    const inwardId = str(row.material_inward_id);
    const existing = weightMap.get(inwardId) ?? { kg: 0, sheets: 0, count: 0 };
    existing.kg += num(row.total_weight);
    existing.sheets += int(row.total_item);
    existing.count += 1;
    weightMap.set(inwardId, existing);
  }

  let updated = 0;
  for (const [inwardId, totals] of weightMap.entries()) {
    const receiptId = maps.inwardReceipts.get(inwardId);
    if (!receiptId) { continue; }
    if (!DRY_RUN) {
      await prisma.vendorMaterialReceipt.update({
        where: { id: receiptId },
        data: {
          receivedQty: totals.kg,
          qcRemarks: `Migrated: ${totals.count} line item(s), ${totals.sheets} sheets, ${totals.kg.toFixed(2)} kg`,
        },
      });
    }
    updated++;
  }
  counts.grnWeightsUpdated = updated;
  log(`   ✅ ${updated} GRN receipts updated with actual weight`);

  // ══════════════════════════════════════════════════════
  // FINAL: Summary
  // ══════════════════════════════════════════════════════
  const log_data = { startedAt: new Date().toISOString(), dryRun: DRY_RUN, counts };
  if (!DRY_RUN) fs.writeFileSync(LOG_FILE, JSON.stringify(log_data, null, 2));

  console.log("\n");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  IMPORT COMPLETE" + (DRY_RUN ? " (DRY RUN — nothing written)" : ""));
  console.log("═══════════════════════════════════════════════════════");
  for (const [key, val] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(25)} ${String(val).padStart(6)} records`);
  }
  console.log("═══════════════════════════════════════════════════════");

  if (!DRY_RUN) {
    console.log(`\n⚠️  POST-IMPORT ACTIONS REQUIRED:`);
    console.log(`  1. Reset all user PINs:  npx tsx scripts/reset-pin.ts <email> <newpin>`);
    console.log(`  2. Seed machines:        npm run db:seed`);
    console.log(`  3. Review ${bridgePOCount} legacy bridge POs in vendor_material_purchase_orders`);
    console.log(`  4. Log saved to:         docs/csv-import-log.json`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("❌ Import failed:", e);
  process.exit(1);
});
