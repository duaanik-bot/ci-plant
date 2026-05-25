/**
 * migrate-from-legacy.ts
 *
 * Big-bang migration: colour.sql (MySQL) → CI-Production (Neon PostgreSQL via Prisma)
 *
 * USAGE:
 *   npx tsx scripts/migrate-from-legacy.ts           # real run
 *   npx tsx scripts/migrate-from-legacy.ts --dry-run # validate only, no writes
 *
 * PREREQUISITES:
 *   1. iconv -f latin1 -t utf8 colour.sql > colour_utf8.sql
 *   2. mysql -u root -p -e "CREATE DATABASE colour_legacy;"
 *      mysql -u root -p colour_legacy < colour_utf8.sql
 *   3. Add to .env.migration (git-ignored):
 *        LOCAL_MYSQL_URL=mysql://root:PASSWORD@127.0.0.1:3306/colour_legacy
 *   4. npm install --save-dev mysql2
 */

import { PrismaClient } from "@prisma/client";
import * as mysql from "mysql2/promise";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as bcrypt from "bcryptjs";

// ─── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const LOG_FILE = path.join(__dirname, "../docs/migration-log.json");

// Load env from .env.migration if it exists, else fall back to process.env
function loadMigrationEnv() {
  const envFile = path.join(__dirname, "../.env.migration");
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...rest] = trimmed.split("=");
        process.env[key.trim()] = rest.join("=").trim();
      }
    }
  }
}
loadMigrationEnv();

const MYSQL_URL =
  process.env.LOCAL_MYSQL_URL ||
  "mysql://root:@127.0.0.1:3306/colour_legacy";

// Default PIN hash for "0000" — users must reset after migration
const DEFAULT_PIN = "0000";
const DEFAULT_PIN_HASH = bcrypt.hashSync(DEFAULT_PIN, 10);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function warn(msg: string) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] ⚠️  ${msg}`);
}

function parseCartonSize(sizeStr: string | null): {
  length: number;
  width: number;
  height: number;
} {
  if (!sizeStr) return { length: 0, width: 0, height: 0 };
  const parts = sizeStr.toUpperCase().split("X").map((p) => parseFloat(p.trim()));
  return {
    length: parts[0] ?? 0,
    width: parts[1] ?? 0,
    height: parts[2] ?? 0,
  };
}

function mapCoatingType(id: number | null): string {
  const map: Record<number, string> = {
    1: "Matt",
    2: "Gloss",
    3: "Matt Lamination",
    4: "Gloss Lamination",
    5: "Soft Touch",
  };
  return id ? (map[id] ?? "None") : "None";
}

function mapPaperType(id: number | null): string {
  const map: Record<number, string> = {
    1: "FBB",
    2: "SBS",
    3: "GD2 Grey Back",
    4: "Kraft",
    7: "Art Card",
  };
  return id ? (map[id] ?? "Other") : "Other";
}

function mapPastingStyle(dyeLock: string | null): "LOCK_BOTTOM" | "BSO" | "SPECIAL" {
  if (!dyeLock) return "LOCK_BOTTOM";
  const v = dyeLock.toLowerCase().trim();
  if (v === "bso") return "BSO";
  if (v === "lockbottom" || v === "lock_bottom" || v === "lock bottom") return "LOCK_BOTTOM";
  return "SPECIAL";
}

function mapStatusId(statusId: number | null): string {
  const map: Record<number, string> = {
    1: "draft",
    2: "confirmed",
    3: "partially_received",
    4: "received",
    5: "closed",
  };
  return statusId ? (map[statusId] ?? "draft") : "draft";
}

function inchesToMm(inches: string | number | null): number {
  if (inches === null || inches === undefined) return 0;
  return Math.round(parseFloat(String(inches)) * 25.4 * 100) / 100;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`🚀 Starting migration — DRY_RUN=${DRY_RUN}`);

  const prisma = new PrismaClient({
    log: DRY_RUN ? [] : ["warn", "error"],
  });

  const conn = await mysql.createConnection(MYSQL_URL);
  log("✅ MySQL connected");

  // ID maps: old int ID → new UUID string
  const maps = {
    roles: new Map<number, string>(),
    admins: new Map<number, string>(),
    clients: new Map<number, string>(),
    vendors: new Map<number, string>(),
    products: new Map<number, string>(),       // old product (paper grade) → Inventory UUID
    dyes: new Map<number, string>(),           // old dye_detail id → Dye UUID
    cartons: new Map<number, string>(),        // old carton id → Carton UUID
    materialOrders: new Map<number, string>(), // old material_order id → VendorPO UUID
    bridgePOs: new Map<number, string>(),      // vendor_id → bridge VendorPO UUID
    inwardReceipts: new Map<number, string>(), // old material_inward id → VendorMaterialReceipt UUID
  };

  const migrationLog: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    counts: {},
    errors: [],
  };

  // ══════════════════════════════════════════════════════
  // STEP 1: ROLES → Role
  // ══════════════════════════════════════════════════════
  log("📋 Step 1: Migrating roles...");
  const [rolesRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, name, display_name, created_at, updated_at FROM roles ORDER BY id"
  );

  let rolesCount = 0;
  for (const row of rolesRows) {
    const newId = crypto.randomUUID();
    maps.roles.set(row.id, newId);

    if (!DRY_RUN) {
      await prisma.role.upsert({
        where: { roleName: row.name },
        update: {},
        create: {
          id: newId,
          roleName: row.name,
          permissions: {},
          wastageApproveLimitPct: 0,
          canApproveArtwork: false,
          canReleaseDispatch: false,
        },
      });
    }
    rolesCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, roles: rolesCount };
  log(`   ✅ ${rolesCount} roles migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 2: ADMINS → User
  // ══════════════════════════════════════════════════════
  log("👤 Step 2: Migrating admins → users...");
  const [adminsRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, role_id, name, email, mobile, status, created_at, updated_at FROM admins WHERE deleted_at IS NULL ORDER BY id"
  );

  let adminsCount = 0;
  let firstAdminId: string | null = null;

  for (const row of adminsRows) {
    const newId = crypto.randomUUID();
    maps.admins.set(row.id, newId);
    if (!firstAdminId) firstAdminId = newId;

    const roleId = maps.roles.get(row.role_id);
    if (!roleId) {
      warn(`Admin ${row.id} (${row.name}) has unknown role_id ${row.role_id} — skipping`);
      continue;
    }

    if (!DRY_RUN) {
      await prisma.user.upsert({
        where: { email: row.email },
        update: {
          name: row.name,
          active: row.status === 1,
          whatsappNumber: row.mobile ?? null,
        },
        create: {
          id: newId,
          name: row.name,
          email: row.email,
          pinHash: DEFAULT_PIN_HASH,
          roleId: roleId,
          machineAccess: [],
          active: row.status === 1,
          whatsappNumber: row.mobile ?? null,
        },
      });
    }
    adminsCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, users: adminsCount };
  log(`   ✅ ${adminsCount} users migrated (all PINs set to "${DEFAULT_PIN}" — must be reset)`);

  if (!firstAdminId && !DRY_RUN) {
    throw new Error("No admin migrated — cannot proceed (need at least 1 user for createdBy fields)");
  }
  const SYSTEM_USER_ID = firstAdminId ?? "00000000-0000-0000-0000-000000000001";

  // ══════════════════════════════════════════════════════
  // STEP 3: CLIENTS → Customer
  // ══════════════════════════════════════════════════════
  log("🏢 Step 3: Migrating clients → customers...");
  const [clientsRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, first_name, last_name, full_name, company_name, email, mobile, address, city, pincode, gst, created_at, updated_at FROM clients WHERE deleted_at IS NULL ORDER BY id"
  );

  let clientsCount = 0;
  for (const row of clientsRows) {
    const newId = crypto.randomUUID();
    maps.clients.set(row.id, newId);

    const name = row.company_name || row.full_name || `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
    const contactName = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
    const addressParts = [row.address, row.city, row.pincode].filter(Boolean);
    const fullAddress = addressParts.join(", ");

    if (!DRY_RUN) {
      await prisma.customer.upsert({
        where: { id: newId },
        update: {},
        create: {
          id: newId,
          name,
          gstNumber: row.gst ?? "",
          pan: "",
          stateCode: "",
          contactName: contactName || name,
          contactPhone: row.mobile ?? "",
          email: row.email ?? "",
          address: fullAddress,
          billingAddress: fullAddress,
          shippingAddress: fullAddress,
          creditLimit: 0,
          requiresArtworkApproval: false,
          active: true,
          source: "migrated",
        },
      });
    }
    clientsCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, customers: clientsCount };
  log(`   ✅ ${clientsCount} customers migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 4: VENDORS → Supplier
  // ══════════════════════════════════════════════════════
  log("🏭 Step 4: Migrating vendors → suppliers...");
  const [vendorsRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, name, email, phone_no, gst, address FROM vendors WHERE deleted_at IS NULL ORDER BY id"
  );

  let vendorsCount = 0;
  for (const row of vendorsRows) {
    const newId = crypto.randomUUID();
    maps.vendors.set(row.id, newId);

    if (!DRY_RUN) {
      await prisma.supplier.upsert({
        where: { id: newId },
        update: {},
        create: {
          id: newId,
          name: row.name ?? "Unknown Supplier",
          gstNumber: row.gst ?? "",
          contactName: row.name ?? "",
          contactPhone: row.phone_no ?? "",
          email: row.email ?? "",
          address: row.address ?? "",
          materialTypes: [],
          defaultForBoardGrades: [],
          leadTimeDays: 7,
          paymentTermsDays: 30,
          active: true,
        },
      });
    }
    vendorsCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, suppliers: vendorsCount };
  log(`   ✅ ${vendorsCount} suppliers migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 5: PRODUCTS (paper grades) → Inventory
  // ══════════════════════════════════════════════════════
  log("📦 Step 5: Migrating products (paper grades) → inventory...");
  const [productsRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, code, name, length, width, gsm, quantity, category_id, product_type_id, weight_per_piece FROM products WHERE deleted_at IS NULL ORDER BY id"
  );

  const boardTypeMap: Record<number, string> = { 1: "SBS", 2: "FBB", 7: "Art Card" };
  const classMap: Record<number, "A" | "B" | "C"> = { 1: "A", 2: "B" };

  let productsCount = 0;
  // Track codes to avoid duplicate materialCode conflicts
  const usedCodes = new Set<string>();

  for (const row of productsRows) {
    const newId = crypto.randomUUID();
    maps.products.set(row.id, newId);

    const sheetLengthMm = inchesToMm(row.width);  // Note: old "width" = actual length dim
    const sheetWidthMm  = inchesToMm(row.length); // Note: old "length" = actual width dim
    const boardType = boardTypeMap[row.product_type_id] ?? "Other";
    const boardClass = classMap[row.category_id] ?? "C";

    // Deduplicate materialCode (old DB has duplicates like '0004' for two different grades)
    let matCode = (row.code ?? `LEGACY-${row.id}`).trim();
    if (usedCodes.has(matCode)) matCode = `${matCode}-${row.id}`;
    usedCodes.add(matCode);

    if (!DRY_RUN) {
      await prisma.inventory.upsert({
        where: { materialCode: matCode },
        update: {
          qtyAvailable: parseFloat(row.quantity ?? "0"),
        },
        create: {
          id: newId,
          materialCode: matCode,
          description: row.name ?? `${row.length}x${row.width}-${row.gsm}`,
          boardType: boardType,
          boardClassification: boardClass,
          sheetLength: sheetLengthMm,
          sheetWidth: sheetWidthMm,
          gsm: row.gsm ?? 0,
          unit: "Sheets",
          supplierId: null,
          category: boardClass,
          qtyAvailable: parseFloat(row.quantity ?? "0"),
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
    productsCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, inventory: productsCount };
  log(`   ✅ ${productsCount} inventory records migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 6: DYE_DETAILS → Dye
  // ══════════════════════════════════════════════════════
  log("🔧 Step 6: Migrating dye_details → dyes...");
  const [dyesRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, dye_no, dye_lock, ups, sheet_size, carton_size, created_at FROM dye_details WHERE deleted_at IS NULL ORDER BY id"
  );

  let dyesCount = 0;
  const usedDyeNumbers = new Set<number>();

  for (const row of dyesRows) {
    const newId = crypto.randomUUID();
    maps.dyes.set(row.id, newId);

    let dyeNumber = Math.round(parseFloat(row.dye_no ?? row.id));
    if (usedDyeNumbers.has(dyeNumber)) dyeNumber = row.id; // use raw id if duplicate
    usedDyeNumbers.add(dyeNumber);

    if (!DRY_RUN) {
      await prisma.dye.upsert({
        where: { dyeNumber },
        update: {},
        create: {
          id: newId,
          dyeNumber,
          dyeType: "Cutting Die",
          ups: Math.round(parseFloat(row.ups ?? "1")),
          sheetSize: row.sheet_size ?? "",
          cartonSize: row.carton_size ?? "",
          impressionCount: 0,
          maxImpressions: 100000,
          condition: "Good",
          custodyStatus: "in_stock",
          active: true,
          pastingStyle: mapPastingStyle(row.dye_lock),
        },
      });
    }
    dyesCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, dyes: dyesCount };
  log(`   ✅ ${dyesCount} die records migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 7: CARTONS (product masters) → Carton
  // ══════════════════════════════════════════════════════
  log("📦 Step 7: Migrating old cartons → Carton product masters...");
  const [cartonsRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, client_id, carton_name, carton_size, rate, coating_type_id, paper_type_id, gsm, art_work, embossing_leafing, created_at FROM cartons ORDER BY id"
  );

  let cartonsCount = 0;
  for (const row of cartonsRows) {
    const newId = crypto.randomUUID();
    maps.cartons.set(row.id, newId);

    const customerId = maps.clients.get(row.client_id);
    if (!customerId) {
      warn(`Carton ${row.id} (${row.carton_name}) references unknown client_id ${row.client_id} — setting to first customer`);
    }

    const { length: fl, width: fw, height: fh } = parseCartonSize(row.carton_size);
    const boardGrade = mapPaperType(row.paper_type_id);
    const coatingType = mapCoatingType(row.coating_type_id);

    if (!DRY_RUN) {
      await prisma.carton.upsert({
        where: { id: newId },
        update: {},
        create: {
          id: newId,
          cartonName: row.carton_name ?? "Unnamed Carton",
          customerId: customerId ?? (maps.clients.values().next().value as string),
          rate: row.rate ?? 0,
          gstPct: 12,
          hsnCode: null,
          boardGrade: boardGrade,
          gsm: Math.round(parseFloat(row.gsm ?? "300")),
          finishedLength: fl,
          finishedWidth: fw,
          finishedHeight: fh,
          blankLength: 0,
          blankWidth: 0,
          pastingStyle: "LOCK_BOTTOM",
          dyeId: null,
          dieMasterId: null,
          artworkCode: row.art_work ?? null,
          laminateType: null,
          coatingType: coatingType,
          source: "migrated",
        },
      });
    }
    cartonsCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, cartons: cartonsCount };
  log(`   ✅ ${cartonsCount} carton product masters migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 8: MATERIAL_ORDERS → VendorMaterialPurchaseOrder
  // ══════════════════════════════════════════════════════
  log("🛒 Step 8: Migrating material_orders → VendorMaterialPurchaseOrder...");
  const [moRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, order_no, vendor_id, mo_date, status_id, remarks FROM material_orders WHERE deleted_at IS NULL ORDER BY id"
  );

  let moCount = 0;
  for (const row of moRows) {
    const newId = crypto.randomUUID();
    maps.materialOrders.set(row.id, newId);

    const supplierId = maps.vendors.get(row.vendor_id);
    if (!supplierId) {
      warn(`MaterialOrder ${row.id} references unknown vendor_id ${row.vendor_id} — skipping`);
      continue;
    }

    if (!DRY_RUN) {
      await prisma.vendorMaterialPurchaseOrder.upsert({
        where: { poNumber: row.order_no },
        update: {},
        create: {
          id: newId,
          poNumber: row.order_no,
          supplierId,
          status: mapStatusId(row.status_id),
          orderDate: new Date(row.mo_date),
          remarks: row.remarks ?? null,
          createdBy: SYSTEM_USER_ID,
          totalReceivedKg: 0,
          totalUsableReceivedKg: 0,
          accruedReceiptPayableInr: 0,
        },
      });
    }
    moCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, vendorPOs: moCount };
  log(`   ✅ ${moCount} vendor POs migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 9: MATERIAL_ORDER_ITEMS → VendorMaterialPurchaseOrderLine
  // ══════════════════════════════════════════════════════
  log("📋 Step 9: Migrating material_order_items → VendorMaterialPurchaseOrderLine...");
  const [moItemRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, material_order_id, product_id, item_name, quantity, total_weight, rate, rate_on, item_per_packet FROM material_order_items WHERE deleted_at IS NULL ORDER BY id"
  );

  let moItemCount = 0;
  for (const row of moItemRows) {
    const vendorPoId = maps.materialOrders.get(row.material_order_id);
    if (!vendorPoId) {
      warn(`MaterialOrderItem ${row.id} references unknown material_order_id ${row.material_order_id} — skipping`);
      continue;
    }

    // Get inventory record for this product_id to get boardGrade/gsm
    const inventoryId = maps.products.get(row.product_id);
    const totalSheets = Math.round(
      parseFloat(row.quantity ?? "0") * parseFloat(row.item_per_packet ?? "100")
    );

    if (!DRY_RUN) {
      await prisma.vendorMaterialPurchaseOrderLine.create({
        data: {
          vendorPoId,
          boardGrade: "Other", // enriched separately
          gsm: 0,              // enriched separately
          grainDirection: "Long grain",
          totalSheets,
          totalWeightKg: parseFloat(row.total_weight ?? "0"),
          ratePerKg: row.rate_on ? parseFloat(row.rate_on) : null,
          freightTotalInr: 0,
          unloadingChargesInr: 0,
          insuranceMiscInr: 0,
          linkedPoLineIds: inventoryId ? [inventoryId] : [],
        },
      });
    }
    moItemCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, vendorPOLines: moItemCount };
  log(`   ✅ ${moItemCount} vendor PO lines migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 10: MATERIAL_INWARDS → bridge POs + VendorMaterialReceipt
  // ══════════════════════════════════════════════════════
  log("📥 Step 10: Migrating material_inwards → GRN receipts...");

  // Find all unique vendor_ids that have inwards
  const [inwardVendors] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT DISTINCT vendor_id FROM material_inwards WHERE deleted_at IS NULL"
  );

  // Create one bridge PO per vendor (for attaching historical receipts)
  let bridgePOCount = 0;
  for (const { vendor_id } of inwardVendors) {
    const supplierId = maps.vendors.get(vendor_id);
    if (!supplierId) {
      warn(`No Supplier found for vendor_id ${vendor_id} — bridge PO skipped`);
      continue;
    }
    const bridgeId = crypto.randomUUID();
    maps.bridgePOs.set(vendor_id, bridgeId);
    const bridgePoNumber = `LEGACY-BRIDGE-V${vendor_id}`;

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
          remarks: `Legacy migration bridge PO — historical receipts from vendor_id ${vendor_id}`,
          createdBy: SYSTEM_USER_ID,
          totalReceivedKg: 0,
          totalUsableReceivedKg: 0,
          accruedReceiptPayableInr: 0,
        },
      });
    }
    bridgePOCount++;
  }
  log(`   📌 ${bridgePOCount} bridge POs created for legacy receipts`);

  // Now migrate the inwards themselves
  const [inwardsRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, receipt_no, vendor_id, bill_no, bill_date, subtotal, total_gst, total, material_order_no, created_at FROM material_inwards WHERE deleted_at IS NULL ORDER BY id"
  );

  let inwardsCount = 0;
  for (const row of inwardsRows) {
    const vendorPoId = maps.bridgePOs.get(row.vendor_id);
    if (!vendorPoId) {
      warn(`MaterialInward ${row.id} (${row.receipt_no}) has no bridge PO — skipping`);
      continue;
    }

    const billDate = row.bill_date ? new Date(row.bill_date) : new Date(row.created_at);

    if (!DRY_RUN) {
      const receipt = await prisma.vendorMaterialReceipt.create({
        data: {
          vendorPoId,
          receiptDate: billDate,
          receivedQty: 0, // will be updated in Step 12 from material_inward_items
          vehicleNumber: row.bill_no ?? "LEGACY",
          scaleSlipId: row.receipt_no ?? `INWARD-${row.id}`,
          receivedByName: "Migrated Record",
          qcStatus: "PASSED",
        },
      });
      maps.inwardReceipts.set(row.id, receipt.id);
    } else {
      // In dry run, still build the map for validation downstream
      maps.inwardReceipts.set(row.id, crypto.randomUUID());
    }
    inwardsCount++;
  }
  migrationLog.counts = { ...migrationLog.counts as object, grnReceipts: inwardsCount };
  log(`   ✅ ${inwardsCount} GRN receipts migrated`);

  // ══════════════════════════════════════════════════════
  // STEP 11: CARTON_PRICES → Archive JSON
  // ══════════════════════════════════════════════════════
  log("💾 Step 11: Archiving carton_prices to docs/carton_prices_archive.json...");
  const [pricesRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT cp.id, cp.carton_id, c.carton_name, cp.quantity, cp.price, cp.created_at FROM carton_prices cp LEFT JOIN cartons c ON c.id = cp.carton_id ORDER BY cp.carton_id, cp.created_at"
  );

  const archivePath = path.join(__dirname, "../docs/carton_prices_archive.json");
  if (!DRY_RUN) {
    fs.writeFileSync(archivePath, JSON.stringify(pricesRows, null, 2));
  }
  log(`   ✅ ${pricesRows.length} carton price records archived`);
  migrationLog.counts = { ...migrationLog.counts as object, cartonPricesArchived: pricesRows.length };

  // ══════════════════════════════════════════════════════
  // STEP 12: MATERIAL_INWARD_ITEMS → update GRN receivedQty
  //
  // The new schema has no receipt line sub-model, so we roll
  // up total_weight per material_inward_id and write it onto
  // the VendorMaterialReceipt.receivedQty field.
  // ══════════════════════════════════════════════════════
  log("📦 Step 12: Rolling up material_inward_items → GRN receivedQty...");
  const [inwardItemsRows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT
       material_inward_id,
       SUM(COALESCE(total_weight, 0))   AS total_kg,
       SUM(COALESCE(total_item, 0))     AS total_sheets,
       COUNT(*)                          AS item_count
     FROM material_inward_items
     WHERE deleted_at IS NULL
     GROUP BY material_inward_id
     ORDER BY material_inward_id`
  );

  let inwardItemsUpdated = 0;
  let inwardItemsSkipped = 0;

  for (const row of inwardItemsRows) {
    const receiptId = maps.inwardReceipts.get(row.material_inward_id);
    if (!receiptId) {
      warn(`material_inward_items: no receipt mapped for inward_id ${row.material_inward_id} — skipping`);
      inwardItemsSkipped++;
      continue;
    }

    const totalKg = parseFloat(row.total_kg ?? "0");
    const totalSheets = parseInt(row.total_sheets ?? "0", 10);

    if (!DRY_RUN) {
      await prisma.vendorMaterialReceipt.update({
        where: { id: receiptId },
        data: {
          receivedQty: totalKg,
          // Store total sheets in qcRemarks for reference — the schema has no sheets field on receipts
          qcRemarks: totalSheets > 0
            ? `Migrated: ${row.item_count} line item(s), ${totalSheets} total sheets, ${totalKg} kg`
            : `Migrated: ${row.item_count} line item(s), ${totalKg} kg`,
        },
      });
    }
    inwardItemsUpdated++;
  }

  migrationLog.counts = {
    ...(migrationLog.counts as object),
    grnReceiptsUpdatedWithWeight: inwardItemsUpdated,
    grnReceiptsWithNoItems: inwardItemsSkipped,
  };
  log(`   ✅ ${inwardItemsUpdated} GRN receipts updated with actual weight from inward items`);
  if (inwardItemsSkipped > 0) {
    warn(`   ${inwardItemsSkipped} inward item groups had no matching receipt (were soft-deleted inwards)`);
  }

  // ══════════════════════════════════════════════════════
  // FINAL: Summary
  // ══════════════════════════════════════════════════════
  migrationLog.completedAt = new Date().toISOString();

  if (!DRY_RUN) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(migrationLog, null, 2));
  }

  console.log("\n");
  console.log("═══════════════════════════════════════════════════");
  console.log("  MIGRATION COMPLETE" + (DRY_RUN ? " (DRY RUN — nothing written)" : ""));
  console.log("═══════════════════════════════════════════════════");
  const counts = migrationLog.counts as Record<string, number>;
  for (const [key, val] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(22)} ${String(val).padStart(6)} records`);
  }
  console.log("═══════════════════════════════════════════════════");

  if (!DRY_RUN) {
    console.log(`\n⚠️  POST-MIGRATION ACTIONS REQUIRED:`);
    console.log(`  1. Reset all user PINs: npx tsx scripts/reset-pin.ts <email> <newpin>`);
    console.log(`  2. Seed machines (CUT/PRN/COT/DIE/PST): npm run db:seed`);
    console.log(`  3. Review ${bridgePOCount} legacy bridge POs in vendor_material_purchase_orders`);
    console.log(`  4. Verify carton sizes parsed correctly (check finishedLength/Width/Height)`);
    console.log(`  5. Verify inventory board types and dimensions (inches → mm conversion)`);
    console.log(`  6. Check GRN receipts — receivedQty now reflects actual kg from inward items`);
    console.log(`  7. Historical carton prices saved to: docs/carton_prices_archive.json`);
  }

  await conn.end();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});
