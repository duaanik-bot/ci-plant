# Production Data Import — Instructions for Claude Code

> **Purpose:** Wipe all trial/dummy data from the CI-Production Neon PostgreSQL database and import the real production data from the legacy CSV files.
>
> **What changes:** Only the rows in the database. Schema, migrations, UI, UX, and application logic are NOT touched.

---

## Context

This is the CI-Production app (Next.js + Prisma + Neon PostgreSQL).

We have extracted all legacy production data from the old MySQL system (`colour.sql`) into CSV files located at:

```
data/legacy-csv/
  roles.csv              (23 roles)
  admins.csv             (36 staff users)
  clients.csv            (7 customers)
  vendors.csv            (21 suppliers)
  products.csv           (377 board/paper grades → Inventory)
  dye_details.csv        (273 die masters)
  cartons.csv            (1,734 carton masters)
  carton_prices.csv      (historical only, not imported)
  material_orders.csv    (1 formal PO)
  material_order_items.csv  (4 PO lines)
  material_inwards.csv   (703 GRN receipts)
  material_inward_items.csv (1,741 GRN line items)
```

The import script is at `scripts/reset-and-import.ts`.

---

## What You Need to Do

### Step 1 — Install dependencies (if not already installed)

```bash
npm install --save-dev bcryptjs
npm install --save-dev @types/bcryptjs
```

### Step 2 — Confirm the DATABASE_URL is set

The `.env` file must have a valid `DATABASE_URL` pointing to the Neon PostgreSQL database. Do not change this. Just confirm it exists and is non-empty.

### Step 3 — Dry run first (SAFE — reads only, writes nothing)

```bash
npx tsx scripts/reset-and-import.ts --dry-run
```

Review the output. You should see counts like:
- 23 roles
- ~30 users
- 7 customers
- 21 suppliers
- ~376 inventory records
- 273 dies
- ~1,734 carton masters (with ~1,338 wired to a die, ~396 without)
- 1 vendor PO + 4 PO lines

If the dry run completes without errors, proceed to Step 4.

### Step 4 — Run the real import (DESTRUCTIVE — clears all trial data)

```bash
npx tsx scripts/reset-and-import.ts
```

This will:
1. Clear ALL existing rows from all public tables (schema is preserved)
2. Import all production data from the CSVs in the correct order
3. Save a log to `docs/reset-import-log.json`

### Step 5 — Post-import actions (REQUIRED)

After the import completes:

**5a. Seed the 12 machines (CI-01 to CI-12):**
```bash
npm run db:seed
```

**5b. Reset user PINs** — all users currently have PIN `0000`. Reset each active user's PIN:
```bash
npx tsx scripts/reset-pin.ts <email> <new-pin>
```

---

## Important Notes

- All user passwords from the old system (Laravel bcrypt) are incompatible with the new PIN system. Every user imported gets PIN `"0000"` as a placeholder. Real PINs must be set after import.
- 1,338 of 1,734 carton masters are linked to their die masters (dyeId populated). The remaining 396 have `dyeId: null` — these need to be manually assigned to dies by the production team after import.
- GRN receipts and inward/outward movement history are NOT imported — the system will start fresh for all goods movements.
- Do NOT run `prisma migrate reset` — that would drop the schema. This script only wipes rows, not structure.

---

## If Something Goes Wrong

If the import fails partway through:
1. Check the error message — most issues are either a missing CSV column or a FK constraint
2. The database may be in a partial state. Re-run the full script — it starts by wiping all data, so a second run is safe
3. Check `docs/reset-import-log.json` for the counts from the last successful run

---

## Verification After Import

Once done, open the app and confirm:
- Customer list shows 7 customers
- Carton master list shows ~1,729 cartons (5 deleted records excluded)
- Inventory shows ~376 board grades
- Supplier list shows 21 suppliers
- Staff login works with PIN `0000`

The app UI, logic, and schema will look and work exactly as before — only the data is different.
