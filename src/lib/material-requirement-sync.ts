import type { Prisma } from '@prisma/client'
import { kgToMetricTons } from '@/lib/board-mrp'
import { computeLineBoardMrp } from '@/lib/procurement-mrp-service'
import { db } from '@/lib/db'

export const BOARD_FORMULA_VERSION = 'erp_board_v1'

type DbClient = typeof db | Prisma.TransactionClient

const TERMINAL = new Set(['on_order', 'dispatched', 'paper_ordered', 'received'])

/**
 * Recompute MaterialQueue rows for every line on a customer PO.
 * Does not downgrade procurement status for lines already on order / received.
 */
export async function syncMaterialRequirementsForPurchaseOrder(
  purchaseOrderId: string,
  client: DbClient = db,
): Promise<void> {
  const po = await client.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      lineItems: {
        include: { dieMaster: { select: { sheetSize: true, ups: true } } },
      },
    },
  })
  if (!po) return

  for (const line of po.lineItems) {
    if (line.materialProcurementStatus === 'received') {
      continue
    }

    const computed = computeLineBoardMrp(line, line.dieMaster)
    if (!computed.ok) {
      if (!TERMINAL.has(line.materialProcurementStatus)) {
        await client.materialQueue.deleteMany({ where: { poLineItemId: line.id } })
        await client.poLineItem.update({
          where: { id: line.id },
          data: { materialProcurementStatus: 'not_calculated' },
        })
      }
      continue
    }

    const tons = kgToMetricTons(computed.mrp.weightKg)
    await client.materialQueue.upsert({
      where: { poLineItemId: line.id },
      create: {
        purchaseOrderId: po.id,
        poLineItemId: line.id,
        boardType: computed.boardType,
        gsm: computed.gsm,
        grainDirection: computed.grainDirection,
        sheetLengthMm: computed.sheetLengthMm,
        sheetWidthMm: computed.sheetWidthMm,
        ups: computed.ups,
        wastagePct: computed.wastagePct,
        orderQty: line.quantity,
        totalSheets: computed.mrp.sheetsWithWastage,
        totalWeightKg: computed.mrp.weightKg,
        totalMetricTons: tons,
        formulaVersion: BOARD_FORMULA_VERSION,
      },
      update: {
        boardType: computed.boardType,
        gsm: computed.gsm,
        grainDirection: computed.grainDirection,
        sheetLengthMm: computed.sheetLengthMm,
        sheetWidthMm: computed.sheetWidthMm,
        ups: computed.ups,
        wastagePct: computed.wastagePct,
        orderQty: line.quantity,
        totalSheets: computed.mrp.sheetsWithWastage,
        totalWeightKg: computed.mrp.weightKg,
        totalMetricTons: tons,
        formulaVersion: BOARD_FORMULA_VERSION,
        calculatedAt: new Date(),
      },
    })

    if (!TERMINAL.has(line.materialProcurementStatus)) {
      await client.poLineItem.update({
        where: { id: line.id },
        data: { materialProcurementStatus: 'pending' },
      })
    }
  }
}
