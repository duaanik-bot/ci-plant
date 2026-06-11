import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

const affectedTables = [
  "audit_logs",
  "communication_logs",
  "bill_line_items",
  "bills",
  "dispatches",
  "short_excess_records",
  "material_weight_reconciliations",
  "material_queue",
  "vendor_quality_debit_notes",
  "vendor_material_receipts",
  "vendor_material_po_lines",
  "vendor_po_requisition_links",
  "vendor_material_purchase_orders",
  "purchase_requisitions",
  "grn_shortage_allocations",
  "material_shortages",
  "material_reservations",
  "stock_movements",
  "production_downtime_logs",
  "production_oee_ledgers",
  "production_stage_records",
  "paper_issue_to_floor",
  "sheet_issue_records",
  "plate_hub_events",
  "plate_requirements",
  "waste_records",
  "ncrs",
  "qc_records",
  "sheet_issues",
  "bom_lines",
  "workflow_stages",
  "job_stages",
  "jobs",
  "purchase_orders",
  "po_line_items",
  "production_job_cards",
] as const;

const deleteOrder = [
  "communication_logs",
  "audit_logs",
  "bill_line_items",
  "bills",
  "dispatches",
  "short_excess_records",
  "material_weight_reconciliations",
  "material_queue",
  "vendor_quality_debit_notes",
  "vendor_material_receipts",
  "vendor_material_po_lines",
  "vendor_po_requisition_links",
  "vendor_material_purchase_orders",
  "purchase_requisitions",
  "grn_shortage_allocations",
  "material_shortages",
  "material_reservations",
  "stock_movements",
  "production_downtime_logs",
  "production_oee_ledgers",
  "production_stage_records",
  "paper_issue_to_floor",
  "sheet_issue_records",
  "plate_hub_events",
  "plate_requirements",
  "waste_records",
  "ncrs",
  "qc_records",
  "sheet_issues",
  "bom_lines",
  "workflow_stages",
  "job_stages",
  "jobs",
  "po_line_items",
  "purchase_orders",
  "production_job_cards",
] as const;

const inventoryBalanceColumns = [
  "qty_quarantine",
  "qty_available",
  "qty_reserved",
  "qty_fg",
  "physical_stock_sheets",
  "shortage_sheets",
  "total_weight_kg",
] as const;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function tableExists(table: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('public.${table}') IS NOT NULL AS exists`,
  );
  return Boolean(rows[0]?.exists);
}

async function countRows(table: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM "${table}"`,
  );
  return Number(rows[0]?.count ?? 0);
}

async function readRows(table: string) {
  return prisma.$queryRawUnsafe(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${table}" t`,
  ) as Promise<Array<{ rows: unknown[] }>>;
}

async function deleteRows(table: string) {
  const rows = await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  return Number(rows);
}

async function resetInventoryBalances(tx: { $executeRawUnsafe: (query: string) => Promise<number> }) {
  const setClause = inventoryBalanceColumns.map((column) => `"${column}" = 0`).join(", ");
  return tx.$executeRawUnsafe(`UPDATE "inventory" SET ${setClause}`);
}

async function main() {
  const startedAt = new Date();
  const backup: Record<string, unknown[]> = {};
  const beforeCounts: Record<string, number> = {};
  const afterCounts: Record<string, number> = {};
  const deletedCounts: Record<string, number> = {};
  const skippedTables: string[] = [];

  for (const table of affectedTables) {
    if (!(await tableExists(table))) {
      skippedTables.push(table);
      continue;
    }
    beforeCounts[table] = await countRows(table);
    const [{ rows }] = await readRows(table);
    backup[table] = Array.isArray(rows) ? rows : [];
  }

  const backupPath = join(process.cwd(), `OPERATIONAL-DATA-RESET-BACKUP-${stamp()}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        createdAt: startedAt.toISOString(),
        scope: "Orders, Printing/Planning, Live Production, Procurement operational transaction reset",
        preserved:
          "Masters, UI/UX, users, customers, suppliers, cartons/products, machines, roles, material definitions, reorder settings",
        tables: backup,
      },
      null,
      2,
    ),
  );

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "dispatches" SET "bill_id" = NULL WHERE "bill_id" IS NOT NULL`);
      await tx.$executeRawUnsafe(
        `UPDATE "plate_store" SET "current_job_card_id" = NULL WHERE "current_job_card_id" IS NOT NULL`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "shade_cards" SET "issued_job_card_id" = NULL WHERE "issued_job_card_id" IS NOT NULL`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "po_line_items" SET "shade_card_id" = NULL WHERE "shade_card_id" IS NOT NULL`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "production_job_cards" SET "plate_set_id" = NULL WHERE "plate_set_id" IS NOT NULL`,
      );

      for (const table of deleteOrder) {
        if (skippedTables.includes(table)) continue;
        const deleted = await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
        deletedCounts[table] = Number(deleted);
      }

      deletedCounts.inventoryBalanceReset = Number(await resetInventoryBalances(tx));
    },
    { timeout: 120_000 },
  );

  for (const table of affectedTables) {
    if (skippedTables.includes(table)) continue;
    afterCounts[table] = await countRows(table);
  }

  const finishedAt = new Date();
  const reportPath = join(process.cwd(), "OPERATIONAL-DATA-RESET-REPORT.md");
  const report = [
    "# Operational Data Reset Report",
    "",
    `Started: ${startedAt.toISOString()}`,
    `Finished: ${finishedAt.toISOString()}`,
    "",
    "## Scope",
    "",
    "Reset operational entries across Orders, Printing/Planning, Live Production, and Procurement.",
    "",
    "## Preserved",
    "",
    "- UI/UX and application code",
    "- Database schema and migrations",
    "- Users, roles, customers, suppliers",
    "- Carton/product masters",
    "- Material definitions and reorder settings",
    "- Machine and instrument masters",
    "- Plate store, die, emboss block, and shade card masters",
    "",
    "## Cleared",
    "",
    ...Object.entries(beforeCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, before]) => `- ${table}: ${before} -> ${afterCounts[table] ?? "n/a"}`),
    "",
    "## Inventory Balance Reset",
    "",
    `Material master balance fields reset to zero for ${deletedCounts.inventoryBalanceReset ?? 0} inventory rows: ${inventoryBalanceColumns.join(", ")}.`,
    "",
    "## Backup",
    "",
    `Full JSON backup written before deletion: ${backupPath}`,
    "",
    "## Notes",
    "",
    "- This was a transactional-data reset only; no masters, UI, schema, or workflows were removed.",
    "- Job card numbers and database sequences were not reset.",
    "- Audit and communication rows were cleared as part of the fresh operational handover scope.",
    "",
  ].join("\n");
  writeFileSync(reportPath, report);

  console.log(
    JSON.stringify(
      {
        backupPath,
        reportPath,
        beforeCounts,
        afterCounts,
        deletedCounts,
        skippedTables,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
