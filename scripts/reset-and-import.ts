/**
 * reset-and-import.ts
 *
 * PRODUCTION RESET — clears ALL trial/dummy data from the Neon PostgreSQL
 * database, then re-imports clean production data from the legacy CSVs.
 *
 * ⚠️  This is a DESTRUCTIVE operation on data only.
 *     - Schema, migrations, and code are NOT touched.
 *     - UI, UX, and application logic are NOT changed.
 *     - Only the rows in the database are cleared and replaced.
 *
 * USAGE:
 *   npx tsx scripts/reset-and-import.ts --dry-run   # safe preview — nothing written
 *   npx tsx scripts/reset-and-import.ts             # REAL run — clears and imports
 *
 * PREREQUISITES:
 *   DATABASE_URL must be set in .env (your Neon connection string)
 *   CSVs must exist in data/legacy-csv/ (already extracted)
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as bcrypt from "bcryptjs";
import { canonicalRoleSlug, USER_ROLE_OVERRIDES } from "./legacy-role-map";

// ─── Config ───────────────────────────────────────────────────────────────────

const DRY_RUN  = process.argv.includes("--dry-run");
const CSV_DIR  = path.join(__dirname, "../data/legacy-csv");
const LOG_FILE = path.join(__dirname, "../docs/reset-import-log.json");

const DEFAULT_PIN      = "0000";
const DEFAULT_PIN_HASH = bcrypt.hashSync(DEFAULT_PIN, 10);

// ─── CSV reader ───────────────────────────────────────────────────────────────

function readCsv(table: string): Record<string, string>[] {
  const filePath = path.join(CSV_DIR, `${table}.csv`);
  if (!fs.existsSync(filePath)) throw new Error(`CSV not found: ${filePath}`);
  const raw  = fs.readFileSync(filePath, "utf-8");
  const rows = parseCsv(raw);
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((cols) => {
    const vals: Record<string, string> = {};
    cols.forEach((v, i) => { vals[headers[i] ?? `col${i}`] = v; });
    return vals;
  }).filter((r) => Object.keys(r).length > 0);
}

function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      if (inQ && raw[i+1] === '"') { field += '"'; i++; }
      else { inQ = !inQ; }
    } else if (c === "," && !inQ) {
      cur.push(field); field = "";
    } else if ((c === "\n" || c === "\r") && !inQ) {
      if (c === "\r" && raw[i+1] === "\n") i++;
      cur.push(field); field = "";
      if (cur.length > 1 || (cur.length === 1 && cur[0] !== "")) rows.push(cur);
      cur = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const log  = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const warn = (m: string) => console.warn(`[${new Date().toISOString()}] ⚠️  ${m}`);

const str        = (v?: string) => (v ?? "").trim();
const num        = (v?: string) => parseFloat(str(v)) || 0;
const int        = (v?: string) => Math.round(num(v));
const bool       = (v?: string) => str(v) === "1";
const nullable   = (v?: string) => { const s = str(v); return s === "" ? null : s; };
const dateOrNull = (v?: string) => { const d = new Date(str(v)); return isNaN(d.getTime()) ? null : d; };
const date       = (v?: string, fb = new Date()) => dateOrNull(v) ?? fb;
const isDeleted  = (r: Record<string,string>) => str(r.deleted_at) !== "";

function parseCartonSize(s: string) {
  const p = s.toUpperCase().split("X").map((x) => parseFloat(x.trim()));
  return { length: p[0] ?? 0, width: p[1] ?? 0, height: p[2] ?? 0 };
}
const COATING: Record<string,string> = { "1":"Matt","2":"Gloss","3":"Matt Lamination","4":"Gloss Lamination","5":"Soft Touch" };
const PAPER:   Record<string,string> = { "1":"FBB","2":"SBS","3":"GD2 Grey Back","7":"Art Card" };
const STATUS:  Record<string,string> = { "1":"draft","2":"confirmed","3":"partially_received","4":"received","5":"closed" };

const mapCoating = (id: string) => COATING[str(id)] ?? "None";
const mapPaper   = (id: string) => PAPER[str(id)]   ?? "Other";
const mapStatus  = (id: string) => STATUS[str(id)]  ?? "draft";
const mapPasting = (v: string): "LOCK_BOTTOM"|"BSO"|"SPECIAL" => {
  const s = v.toLowerCase().trim();
  return s === "bso" ? "BSO" : s === "lockbottom" || s === "lock_bottom" ? "LOCK_BOTTOM" : !s ? "LOCK_BOTTOM" : "SPECIAL";
};
const inchToMm = (v: string) => Math.round(parseFloat(v || "0") * 25.4 * 100) / 100;

// ─── Step 0: Wipe ─────────────────────────────────────────────────────────────

async function wipeAllData(prisma: PrismaClient) {
  log("🗑️  Wiping all existing data (schema preserved)...");

  /**
   * PostgreSQL TRUNCATE with RESTART IDENTITY CASCADE:
   *   - Deletes all rows from every table
   *   - Resets auto-increment sequences
   *   - Cascades through all FK relationships automatically
   *   - Does NOT drop tables or alter schema
   *
   * We skip only _prisma_migrations (tracks applied migrations — must never be touched).
   */
  await prisma.$executeRawUnsafe(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename != '_prisma_migrations'
        ORDER BY tablename
      ) LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);

  log("   ✅ All tables cleared — schema intact, migrations intact");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`🚀 reset-and-import — DRY_RUN=${DRY_RUN}`);
  if (!DRY_RUN) {
    log("⚠️  LIVE MODE — trial data will be permanently deleted and replaced with production data");
  } else {
    log("👀 DRY RUN — validating CSVs and logic only, nothing will be written or deleted");
  }

  const prisma = new PrismaClient({ log: DRY_RUN ? [] : ["warn","error"] });

  // ── STEP 0: WIPE ──────────────────────────────────────────────────────────
  if (!DRY_RUN) {
    await wipeAllData(prisma);
  } else {
    log("   [DRY RUN] Skipping wipe — would clear all tables");
  }

  // ── ID maps ───────────────────────────────────────────────────────────────
  const maps = {
    roles:          new Map<string,string>(),
    admins:         new Map<string,string>(),
    clients:        new Map<string,string>(),
    vendors:        new Map<string,string>(),
    products:       new Map<string,string>(),
    dyes:           new Map<string,string>(),
    cartons:        new Map<string,string>(),
    materialOrders: new Map<string,string>(),
  };
  const counts: Record<string,number> = {};
  let SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

  // ── STEP 1: ROLES ─────────────────────────────────────────────────────────
  log("📋 Step 1/9 — roles → Role");
  let n = 0;
  // Legacy role names map onto canonical RBAC slugs (see legacy-role-map.ts).
  // Many legacy roles collapse to one canonical role, so cache by slug and
  // reuse a single Role row. prisma/seed.ts (run after import) enriches these
  // canonical roles with their real permission sets.
  const slugRoleId = new Map<string, string>();
  for (const row of readCsv("roles")) {
    const slug = canonicalRoleSlug(str(row.name));
    let roleId = slugRoleId.get(slug);
    if (!roleId) {
      roleId = crypto.randomUUID();
      if (!DRY_RUN) {
        const existing = await prisma.role.findUnique({ where: { roleName: slug } });
        if (existing) {
          roleId = existing.id;
        } else {
          await prisma.role.create({ data: {
            id: roleId, roleName: slug, permissions: {},
            wastageApproveLimitPct: 0, canApproveArtwork: false, canReleaseDispatch: false,
          }});
        }
      }
      slugRoleId.set(slug, roleId);
      n++;
    }
    maps.roles.set(row.id, roleId);
  }
  counts.roles = n;
  log(`   ✅ ${n} canonical roles (from ${readCsv("roles").length} legacy rows)`);

  // ── STEP 2: ADMINS → USER ─────────────────────────────────────────────────
  log("👤 Step 2/9 — admins → User");
  n = 0;
  for (const row of readCsv("admins").filter(r => !isDeleted(r))) {
    const id = crypto.randomUUID();
    maps.admins.set(row.id, id);
    if (n === 0) SYSTEM_USER_ID = id;
    let roleId = maps.roles.get(str(row.role_id));
    if (!roleId) { warn(`Admin ${row.id} (${row.name}): unknown role_id ${row.role_id} — skipped`); continue; }
    const overrideSlug = USER_ROLE_OVERRIDES[str(row.email)];
    if (overrideSlug && !DRY_RUN) {
      const ov = await prisma.role.findUnique({ where: { roleName: overrideSlug } });
      if (ov) roleId = ov.id;
    }
    if (!DRY_RUN) {
      await prisma.user.create({ data: {
        id, name: str(row.name), email: str(row.email),
        pinHash: DEFAULT_PIN_HASH, roleId,
        machineAccess: [], active: bool(row.status),
        whatsappNumber: nullable(row.mobile),
      }});
    }
    n++;
  }
  counts.users = n;
  log(`   ✅ ${n} users  ⚠️  All PINs = "${DEFAULT_PIN}" — must be reset after import`);

  // ── STEP 3: CLIENTS → CUSTOMER ────────────────────────────────────────────
  log("🏢 Step 3/9 — clients → Customer");
  n = 0;
  for (const row of readCsv("clients").filter(r => !isDeleted(r))) {
    const id = crypto.randomUUID();
    maps.clients.set(row.id, id);
    const name    = str(row.company_name) || str(row.full_name) || `${str(row.first_name)} ${str(row.last_name)}`.trim();
    const contact = `${str(row.first_name)} ${str(row.last_name)}`.trim() || name;
    const addr    = [str(row.address), str(row.city), str(row.pincode)].filter(Boolean).join(", ");
    if (!DRY_RUN) {
      await prisma.customer.create({ data: {
        id, name, gstNumber: str(row.gst), pan: "", stateCode: "",
        contactName: contact, contactPhone: str(row.mobile), email: str(row.email),
        address: addr, billingAddress: addr, shippingAddress: addr,
        creditLimit: 0, requiresArtworkApproval: false, active: true, source: "migrated",
      }});
    }
    n++;
  }
  counts.customers = n;
  log(`   ✅ ${n} customers`);

  // ── STEP 4: VENDORS → SUPPLIER ────────────────────────────────────────────
  log("🏭 Step 4/9 — vendors → Supplier");
  n = 0;
  for (const row of readCsv("vendors").filter(r => !isDeleted(r))) {
    const id = crypto.randomUUID();
    maps.vendors.set(row.id, id);
    if (!DRY_RUN) {
      await prisma.supplier.create({ data: {
        id, name: str(row.name) || "Unknown Supplier",
        gstNumber: str(row.gst), contactName: str(row.name),
        contactPhone: str(row.phone_no), email: str(row.email),
        address: str(row.address), materialTypes: [], defaultForBoardGrades: [],
        leadTimeDays: 7, paymentTermsDays: 30, active: true,
      }});
    }
    n++;
  }
  counts.suppliers = n;
  log(`   ✅ ${n} suppliers`);

  // ── STEP 5: PRODUCTS → INVENTORY ──────────────────────────────────────────
  log("📄 Step 5/9 — products (paper grades) → Inventory");
  const BTYPE: Record<string,string> = { "1":"SBS","2":"FBB","7":"Art Card" };
  const BCLASS: Record<string,"A"|"B"|"C"> = { "1":"A","2":"B" };
  const usedCodes = new Set<string>();
  const usedPhysKey = new Map<string, string>(); // composite (boardType|sheetLength|sheetWidth|gsm) → existing inventoryId
  let invDupSkipped = 0;
  n = 0;
  for (const row of readCsv("products").filter(r => !isDeleted(r))) {
    const id = crypto.randomUUID();
    let code = str(row.code) || `LEGACY-${row.id}`;
    if (usedCodes.has(code)) code = `${code}-${row.id}`;
    usedCodes.add(code);
    const boardType = BTYPE[str(row.product_type_id)] ?? "Other";
    const sheetLength = inchToMm(row.width);   // old 'width' = physical length
    const sheetWidth  = inchToMm(row.length);  // old 'length' = physical width
    const gsmVal = int(row.gsm);
    const physKey = `${boardType}|${sheetLength}|${sheetWidth}|${gsmVal}`;
    if (usedPhysKey.has(physKey)) {
      // Same physical paper as an earlier product — point legacy id at the existing inventory row
      maps.products.set(row.id, usedPhysKey.get(physKey)!);
      invDupSkipped++;
      continue;
    }
    usedPhysKey.set(physKey, id);
    maps.products.set(row.id, id);
    if (!DRY_RUN) {
      await prisma.inventory.create({ data: {
        id, materialCode: code,
        description: str(row.name) || `${row.length}x${row.width}-${row.gsm}`,
        boardType,
        boardClassification: BCLASS[str(row.category_id)] ?? "C",
        sheetLength,
        sheetWidth,
        gsm: gsmVal, unit: "Sheets", supplierId: null,
        category: BCLASS[str(row.category_id)] ?? "C",
        qtyAvailable: num(row.quantity), qtyReserved: 0, qtyFg: 0,
        weightedAvgCost: 0, reorderPoint: 0, safetyStock: 0,
        physicalStockSheets: 0, shortageSheets: 0, totalWeightKg: 0, active: true,
      }});
    }
    n++;
  }
  counts.inventory = n;
  counts.inventoryDuplicatesMerged = invDupSkipped;
  log(`   ✅ ${n} inventory records — ${invDupSkipped} duplicates merged on (boardType,length,width,gsm)`);

  // ── STEP 6: DYE_DETAILS → DYE ────────────────────────────────────────────
  log("🔧 Step 6/9 — dye_details → Dye");
  const usedDyeNums = new Set<number>();

  // Build a lookup: normalised carton_size → { oldId, dye_lock, ups, sheet_size }
  // Used in Step 7 to wire each carton to its die
  const normSize = (s: string) => s.trim().toUpperCase().replace(/\s/g, "");
  const dyeBySizeKey = new Map<string, { oldId: string; dye_lock: string; ups: string; sheet_size: string }>();

  n = 0;
  for (const row of readCsv("dye_details").filter(r => !isDeleted(r))) {
    const id = crypto.randomUUID();
    maps.dyes.set(row.id, id);
    let dyeNumber = int(row.dye_no) || int(row.id);
    if (!dyeNumber) dyeNumber = 1;
    // Find next free number — start from preferred, then preferred + 100000 offsets,
    // then linearly bump until unique. Guarantees uniqueness across all rows.
    while (usedDyeNums.has(dyeNumber)) dyeNumber++;
    usedDyeNums.add(dyeNumber);

    // Register this die by its carton_size for carton linkage in Step 7
    const sizeKey = normSize(str(row.carton_size));
    if (sizeKey && !dyeBySizeKey.has(sizeKey)) {
      dyeBySizeKey.set(sizeKey, {
        oldId:      row.id,
        dye_lock:   str(row.dye_lock),
        ups:        str(row.ups),
        sheet_size: str(row.sheet_size),
      });
    }

    if (!DRY_RUN) {
      await prisma.dye.create({ data: {
        id, dyeNumber, dyeType: "Cutting Die",
        ups: int(row.ups) || 1,
        sheetSize: str(row.sheet_size), cartonSize: str(row.carton_size),
        impressionCount: 0, maxImpressions: 100000,
        condition: "Good", custodyStatus: "in_stock", active: true,
        pastingStyle: mapPasting(str(row.dye_lock)),
      }});
    }
    n++;
  }
  counts.dyes = n;
  log(`   ✅ ${n} dies — ${dyeBySizeKey.size} unique carton sizes indexed for carton linkage`);

  // ── STEP 7: CARTONS → CARTON ──────────────────────────────────────────────
  log("📦 Step 7/9 — cartons → Carton (with die linkage + full spec enrichment)");
  const firstCustId = [...maps.clients.values()][0];
  let cartonsLinked = 0;
  let cartonsUnlinked = 0;
  n = 0;
  for (const row of readCsv("cartons")) {
    const id = crypto.randomUUID();
    maps.cartons.set(row.id, id);

    const customerId = maps.clients.get(str(row.client_id)) ?? firstCustId;
    if (!maps.clients.has(str(row.client_id))) {
      warn(`Carton ${row.id} "${row.carton_name}": client_id ${row.client_id} not found — using first customer`);
    }

    // Dimensions from carton_size string e.g. "185X35X60"
    const { length: fl, width: fw, height: fh } = parseCartonSize(str(row.carton_size));

    // ── Die linkage: match carton to its die by carton_size ──────────────
    // 77% of cartons share a carton_size with a known die — wire them up so
    // the app can read sheet size, ups, pasting style from the die master.
    const sizeKey    = normSize(str(row.carton_size));
    const matchedDie = dyeBySizeKey.get(sizeKey);
    const dyeId      = matchedDie ? maps.dyes.get(matchedDie.oldId) ?? null : null;

    // Pasting style: use the die's lock type if matched; otherwise fall back
    // to a best-guess from the coating (LOCK_BOTTOM is the factory default)
    const pastingStyle = matchedDie
      ? mapPasting(matchedDie.dye_lock)
      : "LOCK_BOTTOM";

    if (dyeId) { cartonsLinked++; } else { cartonsUnlinked++; }

    if (!DRY_RUN) {
      await prisma.carton.create({ data: {
        id,
        cartonName:     str(row.carton_name) || "Unnamed",
        customerId,

        // ── Pricing ──────────────────────────────────────────────────────
        rate:    num(row.rate),
        gstPct:  12,
        hsnCode: null,

        // ── Board specification ───────────────────────────────────────────
        boardGrade: mapPaper(str(row.paper_type_id)),  // FBB / SBS / Art Card / GD2 …
        gsm:        int(row.gsm) || 300,

        // ── Finished carton dimensions (mm) ──────────────────────────────
        finishedLength: fl,
        finishedWidth:  fw,
        finishedHeight: fh,
        blankLength:    0,   // not in old system — to be set by production team
        blankWidth:     0,

        // ── Pasting & die ─────────────────────────────────────────────────
        pastingStyle,         // from die master if matched, else LOCK_BOTTOM
        dyeId,                // linked to Dye record when carton_size matches
        dieMasterId: null,

        // ── Surface treatment ─────────────────────────────────────────────
        artworkCode:  nullable(row.art_work),
        laminateType: null,
        coatingType:  mapCoating(str(row.coating_type_id)),  // Matt / Gloss / Lamination …

        source: "migrated",
      }});
    }
    n++;
  }
  counts.cartons          = n;
  counts.cartonsLinkedToDie   = cartonsLinked;
  counts.cartonsWithoutDie    = cartonsUnlinked;
  log(`   ✅ ${n} carton masters — ${cartonsLinked} wired to die, ${cartonsUnlinked} without die match`);

  // ── STEP 8: MATERIAL_ORDERS → VENDOR PO ───────────────────────────────────
  log("🛒 Step 8/9 — material_orders → VendorMaterialPurchaseOrder");
  n = 0;
  for (const row of readCsv("material_orders").filter(r => !isDeleted(r))) {
    const id = crypto.randomUUID();
    maps.materialOrders.set(row.id, id);
    const supplierId = maps.vendors.get(str(row.vendor_id));
    if (!supplierId) { warn(`MaterialOrder ${row.id}: unknown vendor_id — skipped`); continue; }
    if (!DRY_RUN) {
      await prisma.vendorMaterialPurchaseOrder.create({ data: {
        id, poNumber: str(row.order_no), supplierId,
        status: mapStatus(str(row.status_id)),
        orderDate: date(row.mo_date), remarks: nullable(row.remarks),
        createdBy: SYSTEM_USER_ID,
        totalReceivedKg: 0, totalUsableReceivedKg: 0, accruedReceiptPayableInr: 0,
      }});
    }
    n++;
  }
  counts.vendorPOs = n;
  log(`   ✅ ${n} vendor POs`);

  // ── STEP 9: MATERIAL_ORDER_ITEMS → VENDOR PO LINES ────────────────────────
  log("📋 Step 9/9 — material_order_items → VendorPOLine");
  n = 0;
  for (const row of readCsv("material_order_items").filter(r => !isDeleted(r))) {
    const vendorPoId = maps.materialOrders.get(str(row.material_order_id));
    if (!vendorPoId) { warn(`MOItem ${row.id}: unknown material_order_id — skipped`); continue; }
    const inventoryId = maps.products.get(str(row.product_id));
    const totalSheets = Math.round(num(row.quantity) * num(row.item_per_packet));
    if (!DRY_RUN) {
      await prisma.vendorMaterialPurchaseOrderLine.create({ data: {
        vendorPoId, boardGrade: "Other", gsm: 0, grainDirection: "Long grain",
        totalSheets, totalWeightKg: num(row.total_weight),
        ratePerKg: row.rate_on ? num(row.rate_on) : null,
        freightTotalInr: 0, unloadingChargesInr: 0, insuranceMiscInr: 0,
        linkedPoLineIds: inventoryId ? [inventoryId] : [],
      }});
    }
    n++;
  }
  counts.vendorPOLines = n;
  log(`   ✅ ${n} PO lines`);

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  const logData = { completedAt: new Date().toISOString(), dryRun: DRY_RUN, counts };
  if (!DRY_RUN) fs.writeFileSync(LOG_FILE, JSON.stringify(logData, null, 2));

  console.log("\n");
  console.log("══════════════════════════════════════════════════════════");
  console.log(DRY_RUN
    ? "  ✅ DRY RUN COMPLETE — no changes made to database"
    : "  🚀 PRODUCTION IMPORT COMPLETE");
  console.log("══════════════════════════════════════════════════════════");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(6)} records`);
  }
  console.log("══════════════════════════════════════════════════════════");

  if (!DRY_RUN) {
    const totalRecords = Object.values(counts).reduce((a,b)=>a+b,0);
    console.log(`\n  Total records imported: ${totalRecords}`);
    console.log(`\n⚠️  REQUIRED NEXT STEPS:`);
    console.log(`  1. Reset all user PINs (currently all set to "${DEFAULT_PIN}"):`);
    console.log(`     npx tsx scripts/reset-pin.ts <email> <new-pin>`);
    console.log(`  2. Seed the machines (CUT-01, PRN-01..03, COT-01..02, DIE-A01..03/M01..02, PST-01..03):`);
    console.log(`     npm run db:seed`);
    console.log(`  3. Log saved to: docs/reset-import-log.json`);
    console.log(`\n  The application UI, logic, and schema are completely unchanged.`);
    console.log(`  Only the database rows have been replaced with production data.`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("\n❌ FAILED:", e.message ?? e);
  process.exit(1);
});
