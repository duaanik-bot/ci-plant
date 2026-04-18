import type { PrismaClient } from '@prisma/client'
import { boardGradesMatch, normalizeBoardKey } from '@/lib/procurement-price-benchmark'
import { computeMaterialGate } from '@/lib/planning-interlock'
import { warehouseBoardLabel } from '@/lib/paper-interconnect'

export type JobCardBoardMaterialSnapshot = {
  requiredSheets: number
  issuedToFloorSheets: number
  balanceSheets: number
  sheetsIssuedJobField: number
  batchLotNumber: string | null
  boardStatus: 'available' | 'out_of_stock'
  materialShortage: boolean
  paperWarehouseSheetsForSpec: number
  planningMaterialGateStatus: string
  materialPendingWatermark: boolean
  warehouseHandshake: { issuedAt: string; custodianName: string } | null
  ledgerLink: { gsm: number; board: string } | null
}

export async function computeBoardMaterialForJobCard(
  db: PrismaClient,
  jc: { id: string; totalSheets: number; sheetsIssued: number },
  poLine: {
    materialProcurementStatus: string
    materialQueue: { totalSheets: number; boardType: string; gsm: number } | null
  } | null,
): Promise<JobCardBoardMaterialSnapshot> {
  const [invRows, issues] = await Promise.all([
    db.inventory.findMany({
      where: { active: true },
      select: { materialCode: true, description: true, qtyAvailable: true, qtyReserved: true },
    }),
    db.paperIssueToFloor.findMany({
      where: { productionJobCardId: jc.id },
      orderBy: { createdAt: 'desc' },
      include: {
        source: {
          select: {
            lotNumber: true,
            gsm: true,
            boardGrade: true,
            paperType: true,
            qtySheets: true,
          },
        },
      },
    }),
  ])

  const materialGate = computeMaterialGate({
    materialQueue: poLine?.materialQueue ?? null,
    materialProcurementStatus: poLine?.materialProcurementStatus ?? '',
    inventoryRows: invRows,
  })

  const issuedToFloorSheets = issues.reduce((s, i) => s + i.qtySheets, 0)
  const requiredSheets = jc.totalSheets
  const balanceSheets = requiredSheets - issuedToFloorSheets
  const latest = issues[0]
  const primaryLot = latest?.source.lotNumber ?? null

  let paperWarehouseSheetsForSpec = 0
  if (poLine?.materialQueue) {
    const mq = poLine.materialQueue
    const normBoard = normalizeBoardKey(mq.boardType)
    const rows = await db.paperWarehouse.findMany({
      where: { gsm: mq.gsm, qtySheets: { gt: 0 } },
      select: { boardGrade: true, paperType: true, qtySheets: true },
    })
    for (const r of rows) {
      const label = warehouseBoardLabel(r)
      if (normBoard && boardGradesMatch(label, normBoard)) {
        paperWarehouseSheetsForSpec += r.qtySheets
      }
    }
  }

  const boardOutOfStock = paperWarehouseSheetsForSpec <= 0
  const materialShortage = paperWarehouseSheetsForSpec < requiredSheets

  const materialPendingWatermark =
    materialGate.status === 'shortage' || materialGate.status === 'ordered'

  return {
    requiredSheets,
    issuedToFloorSheets,
    balanceSheets,
    sheetsIssuedJobField: jc.sheetsIssued,
    batchLotNumber: primaryLot,
    boardStatus: boardOutOfStock ? 'out_of_stock' : 'available',
    materialShortage,
    paperWarehouseSheetsForSpec,
    planningMaterialGateStatus: materialGate.status,
    materialPendingWatermark,
    warehouseHandshake: latest
      ? {
          issuedAt: latest.createdAt.toISOString(),
          custodianName: latest.operatorName,
        }
      : null,
    ledgerLink: poLine?.materialQueue
      ? { gsm: poLine.materialQueue.gsm, board: poLine.materialQueue.boardType }
      : null,
  }
}
