import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { n } from '@/lib/procurement-foundation'

type DbClient = typeof db | Prisma.TransactionClient

export type ProcurementProgressStatus =
  | 'Not Raised'
  | 'PR Raised'
  | 'PR Approved'
  | 'PO Created'
  | 'PO Sent'
  | 'Partially Received'
  | 'Fully Received'

export type MaterialProcurementSnapshot = {
  currentStock: number
  reservedStock: number
  availableStock: number
  openPoQty: number
  incomingQty: number
  productionRequirement: number
  safetyStock: number
  netRequirement: number
  procurementStatus: ProcurementProgressStatus
  linkedPrId: string | null
  linkedPrStatus: string | null
  linkedPoId: string | null
  linkedPoNumber: string | null
  expectedArrivalDate: string | null
  grnPosted: boolean
}

export type RateIntelligenceSnapshot = {
  item: string
  materialId: string | null
  lastPurchaseRate: number | null
  previousPurchaseRate: number | null
  threeMonthAverage: number | null
  sixMonthAverage: number | null
  bestHistoricalRate: number | null
  highestHistoricalRate: number | null
  flag: 'Rate Increased' | 'Rate Reduced' | 'Significant Increase' | 'Stable' | 'No History'
}

function isoDate(d: Date | null | undefined) {
  return d ? d.toISOString().slice(0, 10) : null
}

function jsonArray(value: Prisma.JsonValue): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return (value as unknown[]).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
}

function lineMatchesMaterial(line: { linkedPoLineIds: Prisma.JsonValue; boardGrade: string }, materialId: string, materialCode?: string | null) {
  const links = jsonArray(line.linkedPoLineIds)
  return links.some((x) => x.materialId === materialId) || Boolean(materialCode && line.boardGrade.toLowerCase().includes(materialCode.toLowerCase()))
}

function resolveStatus(input: {
  prStatus: string | null
  poStatus: string | null
  openPoQty: number
  incomingQty: number
  grnPosted: boolean
}): ProcurementProgressStatus {
  if (input.grnPosted && input.openPoQty <= 0) return 'Fully Received'
  if (input.incomingQty > 0 || input.poStatus === 'partial_received') return 'Partially Received'
  if (input.poStatus === 'sent' || input.poStatus === 'confirmed') return 'PO Sent'
  if (input.poStatus) return 'PO Created'
  if (input.prStatus === 'approved' || input.prStatus === 'converted_to_po') return 'PR Approved'
  if (input.prStatus) return 'PR Raised'
  return 'Not Raised'
}

export async function getMaterialProcurementSnapshot(args: {
  materialId: string | null
  planningId?: string | null
  productionRequirement: number
  availableStock?: number
  reservedStock?: number
  safetyStock?: number
  client?: DbClient
}): Promise<MaterialProcurementSnapshot> {
  const client = args.client ?? db
  const productionRequirement = Math.max(0, args.productionRequirement)
  const safetyStock = Math.max(0, args.safetyStock ?? 0)
  if (!args.materialId) {
    return {
      currentStock: 0,
      reservedStock: 0,
      availableStock: 0,
      openPoQty: 0,
      incomingQty: 0,
      productionRequirement,
      safetyStock,
      netRequirement: productionRequirement + safetyStock,
      procurementStatus: 'Not Raised',
      linkedPrId: null,
      linkedPrStatus: null,
      linkedPoId: null,
      linkedPoNumber: null,
      expectedArrivalDate: null,
      grnPosted: false,
    }
  }

  const [material, shortage] = await Promise.all([
    client.inventory.findUnique({
      where: { id: args.materialId },
      select: { materialCode: true, qtyAvailable: true, qtyReserved: true, safetyStock: true },
    }),
    args.planningId
      ? client.materialShortage.findFirst({
          where: { materialId: args.materialId, planningId: args.planningId, status: { in: ['open', 'closed'] } },
          orderBy: { createdAt: 'desc' },
          select: { purchaseReqId: true },
        })
      : Promise.resolve(null),
  ])
  const linkedPr = shortage?.purchaseReqId
    ? await client.purchaseRequisition.findUnique({
        where: { id: shortage.purchaseReqId },
        select: { id: true, status: true },
      })
    : await client.purchaseRequisition.findFirst({
        where: {
          materialId: args.materialId,
          status: { in: ['draft', 'pending', 'approved', 'converted_to_po'] },
          ...(args.planningId ? { sourcePlanningId: args.planningId } : {}),
        },
        orderBy: { raisedAt: 'desc' },
        select: { id: true, status: true },
      })

  const pos = await client.vendorMaterialPurchaseOrder.findMany({
    where: {
      status: { in: ['draft', 'confirmed', 'sent', 'partial_received', 'received'] },
      isShortClosed: false,
      OR: [
        { materialId: args.materialId },
        ...(linkedPr?.id ? [{ purchaseRequisitionId: linkedPr.id }, { requisitionLinks: { some: { purchaseRequisitionId: linkedPr.id } } }] : []),
      ],
    },
    orderBy: { requiredDeliveryDate: 'asc' },
    include: { lines: true, receipts: true },
  })

  let openPoQty = 0
  let incomingQty = 0
  let linkedPoId: string | null = null
  let linkedPoNumber: string | null = null
  let expectedArrivalDate: string | null = null
  let poStatus: string | null = null
  let grnPosted = false

  for (const po of pos) {
    const matchedLines = po.lines.filter((line) => lineMatchesMaterial(line, args.materialId, material?.materialCode))
    const ordered = matchedLines.length
      ? matchedLines.reduce((sum, line) => sum + n(line.totalWeightKg), 0)
      : po.lines.reduce((sum, line) => sum + n(line.totalWeightKg), 0)
    const usable = n(po.totalUsableReceivedKg)
    const open = Math.max(0, ordered - usable)
    const pendingReceiptQty = po.receipts
      .filter((r) => r.qcStatus !== 'POSTED_TO_STOCK' && r.qcStatus !== 'CANCELLED')
      .reduce((sum, r) => sum + n(r.receivedQty), 0)
    openPoQty += open
    incomingQty += pendingReceiptQty
    grnPosted ||= po.receipts.some((r) => r.qcStatus === 'POSTED_TO_STOCK')
    if (!linkedPoId && ['draft', 'confirmed', 'sent', 'partial_received', 'received'].includes(po.status)) {
      linkedPoId = po.id
      linkedPoNumber = po.poNumber
      expectedArrivalDate = isoDate(po.estimatedArrivalAt ?? po.requiredDeliveryDate)
      poStatus = po.status
    }
  }

  const availableStock = Math.max(0, args.availableStock ?? n(material?.qtyAvailable))
  const reservedStock = Math.max(0, args.reservedStock ?? n(material?.qtyReserved))
  const currentStock = availableStock + reservedStock
  const netRequirement = Math.max(0, productionRequirement + safetyStock - availableStock - openPoQty)

  return {
    currentStock,
    reservedStock,
    availableStock,
    openPoQty,
    incomingQty,
    productionRequirement,
    safetyStock,
    netRequirement,
    procurementStatus: resolveStatus({ prStatus: linkedPr?.status ?? null, poStatus, openPoQty, incomingQty, grnPosted }),
    linkedPrId: linkedPr?.id ?? null,
    linkedPrStatus: linkedPr?.status ?? null,
    linkedPoId,
    linkedPoNumber,
    expectedArrivalDate,
    grnPosted,
  }
}

export function buildRateIntelligence(input: {
  item: string
  materialId?: string | null
  rows: Array<{ rate: number; date: Date }>
}): RateIntelligenceSnapshot {
  const rows = input.rows.filter((r) => r.rate > 0).sort((a, b) => b.date.getTime() - a.date.getTime())
  const avgSince = (months: number) => {
    const since = new Date()
    since.setMonth(since.getMonth() - months)
    const scoped = rows.filter((r) => r.date >= since)
    return scoped.length ? scoped.reduce((sum, r) => sum + r.rate, 0) / scoped.length : null
  }
  const last = rows[0]?.rate ?? null
  const previous = rows[1]?.rate ?? null
  let flag: RateIntelligenceSnapshot['flag'] = 'No History'
  if (last != null && previous != null) {
    const deltaPct = previous > 0 ? ((last - previous) / previous) * 100 : 0
    flag = deltaPct >= 10 ? 'Significant Increase' : deltaPct > 0 ? 'Rate Increased' : deltaPct < 0 ? 'Rate Reduced' : 'Stable'
  } else if (last != null) {
    flag = 'Stable'
  }
  return {
    item: input.item,
    materialId: input.materialId ?? null,
    lastPurchaseRate: last,
    previousPurchaseRate: previous,
    threeMonthAverage: avgSince(3),
    sixMonthAverage: avgSince(6),
    bestHistoricalRate: rows.length ? Math.min(...rows.map((r) => r.rate)) : null,
    highestHistoricalRate: rows.length ? Math.max(...rows.map((r) => r.rate)) : null,
    flag,
  }
}

export async function getPendingSupplierPayables(client: DbClient = db) {
  const rows = await client.vendorMaterialPurchaseOrder.findMany({
    where: { accruedReceiptPayableInr: { gt: 0 } },
    take: 100,
    orderBy: { updatedAt: 'desc' },
    include: { supplier: true, receipts: { orderBy: { receiptDate: 'desc' }, take: 1 } },
  })
  return rows.map((po) => ({
    poId: po.id,
    poNumber: po.poNumber,
    supplierId: po.supplierId,
    supplierName: po.supplier.name,
    payableReference: `PAYABLE-${po.poNumber}`,
    accruedPayableInr: n(po.accruedReceiptPayableInr),
    latestGrnDate: isoDate(po.receipts[0]?.receiptDate),
    invoiceStatus: 'pending_supplier_invoice' as const,
    paymentStatus: 'pending_payment' as const,
  }))
}
