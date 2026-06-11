import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

const prisma = new PrismaClient();

const sourcePath = "/Users/anikdua/Documents/Projects/Board Inventory  Final ci production .xlsx";
const now = new Date();

type SheetRow = {
  Material?: unknown;
  "Board / GSM"?: unknown;
  Size?: unknown;
  "Available(Packets)"?: unknown;
  "Packet size "?: unknown;
  "Sheets "?: unknown;
};

type ParsedRow = {
  materialCode: string;
  boardLabel: string;
  boardType: string;
  gsm: number;
  length: number;
  width: number;
  availablePackets: number;
  sheetsPerPacket: number;
  sheets: number;
  packetWeightKg: number;
  totalWeightKg: number;
};

function stamp() {
  return now.toISOString().replace(/[:.]/g, "-");
}

function asText(value: unknown) {
  return String(value ?? "").trim();
}

function asNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseBoardGsm(value: unknown) {
  const label = asText(value).replace(/\s+/g, " ");
  const match = label.match(/^(.*?)[\s-]*(\d+(?:\.\d+)?)\s*g(?:sm)?$/i);
  if (!match) throw new Error(`Could not parse Board / GSM value: "${label}"`);
  const boardType = match[1].trim();
  const gsm = Number(match[2]);
  if (!boardType || !Number.isFinite(gsm) || gsm <= 0) {
    throw new Error(`Invalid Board / GSM value: "${label}"`);
  }
  return { boardLabel: label, boardType, gsm: Math.round(gsm) };
}

function parseSize(value: unknown) {
  const label = asText(value).toLowerCase().replace(/\s+/g, " ");
  const match = label.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/i);
  if (!match) throw new Error(`Could not parse Size value: "${asText(value)}"`);
  const length = Number(match[1]);
  const width = Number(match[2]);
  if (!Number.isFinite(length) || !Number.isFinite(width) || length <= 0 || width <= 0) {
    throw new Error(`Invalid Size value: "${asText(value)}"`);
  }
  return { length, width };
}

function kgPerSheet(lengthIn: number, widthIn: number, gsm: number) {
  const squareMetres = lengthIn * widthIn * 0.00064516;
  return (squareMetres * gsm) / 1000;
}

function parseWorkbook() {
  const workbook = XLSX.readFile(sourcePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json<SheetRow>(sheet, { defval: null });
  const rows = rawRows
    .map((row, index): ParsedRow => {
      const materialCode = asText(row.Material);
      if (!materialCode) throw new Error(`Blank Material at Excel row ${index + 2}`);
      const { boardLabel, boardType, gsm } = parseBoardGsm(row["Board / GSM"]);
      const { length, width } = parseSize(row.Size);
      const availablePackets = asNumber(row["Available(Packets)"]);
      const sheetsPerPacket = asNumber(row["Packet size "]);
      const sheets = asNumber(row["Sheets "]);
      const calculatedSheets = Math.round(availablePackets * sheetsPerPacket);
      if (sheetsPerPacket <= 0) throw new Error(`Invalid Packet size for ${materialCode}`);
      if (Math.abs(calculatedSheets - sheets) > 1) {
        throw new Error(
          `Sheet mismatch for ${materialCode}: packets ${availablePackets} × packet size ${sheetsPerPacket} = ${calculatedSheets}, Excel Sheets = ${sheets}`,
        );
      }
      const perSheetKg = kgPerSheet(length, width, gsm);
      return {
        materialCode,
        boardLabel,
        boardType,
        gsm,
        length,
        width,
        availablePackets,
        sheetsPerPacket,
        sheets: Math.round(sheets),
        packetWeightKg: Number((perSheetKg * sheetsPerPacket).toFixed(6)),
        totalWeightKg: Number((perSheetKg * sheets).toFixed(6)),
      };
    });

  const duplicates = rows
    .map((row) => row.materialCode)
    .filter((code, index, all) => all.indexOf(code) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Material codes in workbook: ${Array.from(new Set(duplicates)).join(", ")}`);
  }
  return rows;
}

async function main() {
  const parsedRows = parseWorkbook();
  const excelCodes = new Set(parsedRows.map((row) => row.materialCode));
  const existingInventory = await prisma.inventory.findMany({
    orderBy: { materialCode: "asc" },
  });
  const existingCodes = new Set(existingInventory.map((row) => row.materialCode));
  const missingCodes = parsedRows.filter((row) => !existingCodes.has(row.materialCode));
  if (missingCodes.length > 0) {
    throw new Error(`Missing inventory master codes: ${missingCodes.map((row) => row.materialCode).join(", ")}`);
  }

  const paperWarehouseBefore = await prisma.paperWarehouse.findMany({ orderBy: { createdAt: "asc" } });
  const stockMovementsBefore = await prisma.stockMovement.findMany({ orderBy: { createdAt: "asc" } });
  const backupPath = join(process.cwd(), `BOARD-INVENTORY-FINAL-IMPORT-BACKUP-${stamp()}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        createdAt: now.toISOString(),
        sourcePath,
        inventoryBefore: existingInventory,
        paperWarehouseBefore,
        stockMovementsBefore,
      },
      null,
      2,
    ),
  );

  const excelByCode = new Map(parsedRows.map((row) => [row.materialCode, row]));
  const extraInventory = existingInventory.filter((row) => !excelCodes.has(row.materialCode));
  const nonZeroRows = parsedRows.filter((row) => row.sheets > 0);

  await prisma.$transaction(
    async (tx) => {
      await tx.stockMovement.deleteMany({});
      await tx.paperWarehouse.deleteMany({});

      await tx.inventory.updateMany({
        data: {
          qtyQuarantine: 0,
          qtyAvailable: 0,
          qtyReserved: 0,
          qtyFg: 0,
          physicalStockSheets: 0,
          shortageSheets: 0,
          totalWeightKg: 0,
        },
      });

      for (const row of parsedRows) {
        await tx.inventory.update({
          where: { materialCode: row.materialCode },
          data: {
            description: `${row.boardType} · ${row.gsm} GSM · ${row.length} x ${row.width}`,
            boardType: row.boardType,
            boardClassification: row.boardType,
            sheetLength: row.length,
            sheetWidth: row.width,
            gsm: row.gsm,
            unit: "sheets",
            qtyAvailable: row.sheets,
            physicalStockSheets: row.sheets,
            qtyQuarantine: 0,
            qtyReserved: 0,
            qtyFg: 0,
            shortageSheets: 0,
            totalWeightKg: row.totalWeightKg,
            packetWeight: row.packetWeightKg,
            sheetsPerPacket: row.sheetsPerPacket,
            active: true,
          },
        });
      }

      if (extraInventory.length > 0) {
        await tx.inventory.updateMany({
          where: { materialCode: { in: extraInventory.map((row) => row.materialCode) } },
          data: {
            active: false,
            qtyQuarantine: 0,
            qtyAvailable: 0,
            qtyReserved: 0,
            qtyFg: 0,
            physicalStockSheets: 0,
            shortageSheets: 0,
            totalWeightKg: 0,
          },
        });
      }

      for (const row of nonZeroRows) {
        const material = await tx.inventory.findUnique({
          where: { materialCode: row.materialCode },
          select: { id: true, storageLocation: true, weightedAvgCost: true },
        });
        if (!material) throw new Error(`Material not found during import: ${row.materialCode}`);
        const lotNumber = `OPENING-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${row.materialCode}`.slice(0, 64);
        await tx.paperWarehouse.create({
          data: {
            paperType: row.boardType,
            boardGrade: row.boardType,
            gsm: row.gsm,
            qtySheets: row.sheets,
            lotNumber,
            rate: Number(material.weightedAvgCost) > 0 ? material.weightedAvgCost : null,
            coaReference: "BOARD-INVENTORY-FINAL-EXCEL",
            receiptDate: now,
            location: material.storageLocation || "MAIN",
            sheetSizeLabel: `${row.length} × ${row.width} in`,
            supplierGsm: row.gsm,
            status: "in_stock",
          },
        });
        await tx.stockMovement.create({
          data: {
            materialId: material.id,
            movementType: "opening_balance",
            qty: row.sheets,
            refType: "board_inventory_excel",
            refId: row.materialCode,
            reservedByName: "Board Inventory Final Excel",
          },
        });
      }
    },
    { timeout: 120_000 },
  );

  const [inventoryAfter, activeAfter, nonZeroAfter, paperWarehouseAfter, stockMovementAfter] = await Promise.all([
    prisma.inventory.count(),
    prisma.inventory.count({ where: { active: true } }),
    prisma.inventory.count({ where: { qtyAvailable: { gt: 0 } } }),
    prisma.paperWarehouse.count(),
    prisma.stockMovement.count(),
  ]);
  const totalSheets = parsedRows.reduce((sum, row) => sum + row.sheets, 0);
  const totalPackets = parsedRows.reduce((sum, row) => sum + row.availablePackets, 0);
  const totalWeightKg = parsedRows.reduce((sum, row) => sum + row.totalWeightKg, 0);
  const topRows = [...nonZeroRows].sort((a, b) => b.sheets - a.sheets).slice(0, 15);

  const reportPath = join(process.cwd(), "BOARD-INVENTORY-FINAL-IMPORT-REPORT.md");
  writeFileSync(
    reportPath,
    [
      "# Board Inventory Final Import Report",
      "",
      `Imported at: ${now.toISOString()}`,
      `Source workbook: ${sourcePath}`,
      "",
      "## Import Summary",
      "",
      `- Excel rows processed: ${parsedRows.length}`,
      `- Excel material codes missing in DB: 0`,
      `- Nonzero stock rows imported: ${nonZeroRows.length}`,
      `- Total available packets: ${totalPackets}`,
      `- Total available sheets: ${totalSheets}`,
      `- Estimated total stock weight kg: ${Number(totalWeightKg.toFixed(3))}`,
      `- Active inventory rows after import: ${activeAfter}`,
      `- Inventory rows with available stock after import: ${nonZeroAfter}`,
      `- Paper ledger rows after import: ${paperWarehouseAfter}`,
      `- Opening stock movement rows after import: ${stockMovementAfter}`,
      "",
      "## Mapping Rules",
      "",
      "- `Material` mapped to `inventory.materialCode`.",
      "- `Board / GSM` parsed into `boardType`, `boardClassification`, and `gsm`.",
      "- `Size` parsed as inch length and width.",
      "- `Sheets` mapped to `qtyAvailable` and `physicalStockSheets`.",
      "- `Available(Packets)` retained through calculated packet size validation.",
      "- `Packet size` mapped to `sheetsPerPacket`.",
      "- Existing current stock balances were zeroed before importing Excel stock.",
      "- Old `paper_warehouse` rows were cleared and recreated only for nonzero Excel rows.",
      "- Extra inventory codes not present in Excel were zeroed and deactivated, not deleted.",
      "",
      "## Extra Codes Deactivated",
      "",
      ...(extraInventory.length > 0
        ? extraInventory.map((row) => `- ${row.materialCode}`)
        : ["- None"]),
      "",
      "## Largest Imported Stock Rows",
      "",
      ...topRows.map((row) => `- ${row.materialCode}: ${row.sheets} sheets (${row.availablePackets} packets)`),
      "",
      "## Backup",
      "",
      `Backup written before import: ${backupPath}`,
      "",
    ].join("\n"),
  );

  console.log(
    JSON.stringify(
      {
        sourcePath,
        backupPath,
        reportPath,
        excelRows: parsedRows.length,
        nonZeroRows: nonZeroRows.length,
        totalSheets,
        totalPackets,
        totalWeightKg: Number(totalWeightKg.toFixed(3)),
        inventoryAfter,
        activeAfter,
        nonZeroAfter,
        paperWarehouseAfter,
        stockMovementAfter,
        deactivatedExtraCodes: extraInventory.map((row) => row.materialCode),
        validatedSample: [...excelByCode.values()].slice(0, 5),
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
