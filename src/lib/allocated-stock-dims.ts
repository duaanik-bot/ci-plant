import type { PrismaClient } from '@prisma/client'
import { warehouseBoardLabel } from '@/lib/paper-interconnect'
import { boardGradesMatch, normalizeBoardKey } from '@/lib/procurement-price-benchmark'
import { evaluateGrainFit, type GrainFitStatus } from '@/lib/sheet-size-grain-fit'

export type AllocatedStockDims = {
  paperWarehouseId: string
  sheetSizeLabel: string | null
  grainDirection: string | null
  warehouseBayId: string | null
  palletId: string | null
  lotNumber: string | null
}

/**
 * FIFO main-warehouse batch matching PO line material queue (GSM + board grade).
 */
export async function get_allocated_stock_dims(
  db: PrismaClient,
  args: { poLineItemId: string },
): Promise<AllocatedStockDims | null> {
  const line = await db.poLineItem.findUnique({
    where: { id: args.poLineItemId },
    include: {
      materialQueue: { select: { gsm: true, boardType: true } },
    },
  })
  if (!line?.materialQueue) return null
  const normBoard = normalizeBoardKey(line.materialQueue.boardType)
  if (!normBoard) return null

  const rows = await db.paperWarehouse.findMany({
    where: {
      gsm: line.materialQueue.gsm,
      qtySheets: { gt: 0 },
    },
    orderBy: [{ receiptDate: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      lotNumber: true,
      sheetSizeLabel: true,
      grainDirection: true,
      warehouseBayId: true,
      palletId: true,
      boardGrade: true,
      paperType: true,
      location: true,
    },
  })

  for (const r of rows) {
    if ((r.location ?? '').trim().toUpperCase() === 'FLOOR') continue
    const label = warehouseBoardLabel(r)
    if (!boardGradesMatch(label, normBoard)) continue
    return {
      paperWarehouseId: r.id,
      sheetSizeLabel: r.sheetSizeLabel,
      grainDirection: r.grainDirection,
      warehouseBayId: r.warehouseBayId,
      palletId: r.palletId,
      lotNumber: r.lotNumber,
    }
  }
  return null
}

export function formatIssuedStockDisplay(stock: AllocatedStockDims): string {
  const size = stock.sheetSizeLabel?.trim() || '—'
  const grain = stock.grainDirection?.trim() || '—'
  return `Issued Stock: ${size}. | Grain: ${grain}`
}

export function formatInventoryLocationPointer(stock: AllocatedStockDims): string {
  const bay = stock.warehouseBayId?.trim() || '—'
  const pallet = stock.palletId?.trim() || '—'
  return `Pick from: ${bay} | Pallet: ${pallet}`
}

export function computePaperRowGrainFit(
  sheetSizeLabel: string | null | undefined,
  awTargetSheetSize: string | null | undefined,
): GrainFitStatus {
  return evaluateGrainFit(sheetSizeLabel, awTargetSheetSize).status
}

export async function applyAllocatedStockToJobCard(
  db: PrismaClient,
  jobCardId: string,
  stock: AllocatedStockDims,
  awTargetSheetSize: string | null | undefined,
): Promise<void> {
  const grainFitStatus = computePaperRowGrainFit(stock.sheetSizeLabel, awTargetSheetSize)
  await db.productionJobCard.update({
    where: { id: jobCardId },
    data: {
      allocatedPaperWarehouseId: stock.paperWarehouseId,
      issuedStockDisplay: formatIssuedStockDisplay(stock),
      inventoryLocationPointer: formatInventoryLocationPointer(stock),
      grainFitStatus,
    },
  })
}

/** After paper issue to floor: sync dims from source warehouse row + AW target from PO line. */
export async function syncJobCardFromPaperIssueSource(
  db: PrismaClient,
  params: { jobCardId: string; sourcePaperWarehouseId: string },
): Promise<void> {
  const [src, jc] = await Promise.all([
    db.paperWarehouse.findUnique({
      where: { id: params.sourcePaperWarehouseId },
      select: {
        id: true,
        sheetSizeLabel: true,
        grainDirection: true,
        warehouseBayId: true,
        palletId: true,
        lotNumber: true,
      },
    }),
    db.productionJobCard.findUnique({
      where: { id: params.jobCardId },
      select: { jobCardNumber: true },
    }),
  ])
  if (!src || !jc?.jobCardNumber) return

  const poLine = await db.poLineItem.findFirst({
    where: { jobCardNumber: jc.jobCardNumber },
    select: { specOverrides: true },
  })
  const spec =
    poLine?.specOverrides && typeof poLine.specOverrides === 'object'
      ? (poLine.specOverrides as Record<string, unknown>)
      : {}
  const awTarget =
    typeof spec.actualSheetSize === 'string' ? spec.actualSheetSize.trim() || null : null

  const stock: AllocatedStockDims = {
    paperWarehouseId: src.id,
    sheetSizeLabel: src.sheetSizeLabel,
    grainDirection: src.grainDirection,
    warehouseBayId: src.warehouseBayId,
    palletId: src.palletId,
    lotNumber: src.lotNumber,
  }
  await applyAllocatedStockToJobCard(db, params.jobCardId, stock, awTarget)
}
