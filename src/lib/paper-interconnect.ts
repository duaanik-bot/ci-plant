import type { PrismaClient } from '@prisma/client'
import { boardGradesMatch, normalizeBoardKey } from '@/lib/procurement-price-benchmark'

export type PaperRowForPriority = {
  id: string
  gsm: number
  boardGrade: string | null
  paperType: string
}

export function warehouseBoardLabel(row: Pick<PaperRowForPriority, 'boardGrade' | 'paperType'>): string {
  return (row.boardGrade?.trim() || row.paperType || '').trim()
}

/** Director / PO priority when any active material queue line matches spec and is starred. */
export function paperRowIndustrialPriority(
  row: PaperRowForPriority,
  queues: Array<{
    gsm: number
    boardType: string
    lineItem: { directorPriority: boolean; po: { isPriority: boolean } }
  }>,
): boolean {
  const wh = warehouseBoardLabel(row)
  const whNorm = normalizeBoardKey(wh)
  if (!whNorm || !row.gsm) return false
  return queues.some(
    (mq) =>
      mq.gsm === row.gsm &&
      boardGradesMatch(mq.boardType, whNorm) &&
      (mq.lineItem.directorPriority === true || mq.lineItem.po.isPriority === true),
  )
}

export async function loadMaterialQueuesForPriority(db: PrismaClient) {
  return db.materialQueue.findMany({
    include: {
      lineItem: {
        select: {
          directorPriority: true,
          po: { select: { isPriority: true } },
        },
      },
    },
  })
}

/** Linked customer PO numbers via mill lines (board+gsm match). */
export async function linkedCustomerPoNumbersForPaperRow(
  db: PrismaClient,
  row: Pick<PaperRowForPriority, 'gsm' | 'boardGrade' | 'paperType'>,
): Promise<string[]> {
  const whNorm = normalizeBoardKey(warehouseBoardLabel(row))
  if (!whNorm) return []
  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: { gsm: row.gsm },
    select: { boardGrade: true, linkedPoLineIds: true },
  })
  const poLineIds = new Set<string>()
  for (const ln of lines) {
    if (!boardGradesMatch(ln.boardGrade, whNorm)) continue
    const raw = ln.linkedPoLineIds
    const ids = Array.isArray(raw) ? (raw as string[]) : []
    for (const id of ids) poLineIds.add(id)
  }
  if (poLineIds.size === 0) return []
  const polis = await db.poLineItem.findMany({
    where: { id: { in: Array.from(poLineIds) } },
    select: { po: { select: { poNumber: true } } },
  })
  const nums = new Set<string>()
  for (const p of polis) nums.add(p.po.poNumber)
  return Array.from(nums)
}

export async function buildPaperGenealogy(
  db: PrismaClient,
  paperWarehouseId: string,
): Promise<{
  batch: { id: string; lotNumber: string | null; gsm: number; qtySheets: number; location: string | null }
  steps: Array<{ stage: string; label: string; detail: string; mono?: string }>
}> {
  const batch = await db.paperWarehouse.findUnique({
    where: { id: paperWarehouseId },
  })
  if (!batch) throw new Error('NOT_FOUND')

  const whNorm = normalizeBoardKey(warehouseBoardLabel(batch))
  const steps: Array<{ stage: string; label: string; detail: string; mono?: string }> = []

  const vendorLines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: { gsm: batch.gsm },
    include: {
      vendorPo: {
        select: {
          id: true,
          poNumber: true,
          status: true,
          supplier: { select: { name: true } },
        },
      },
    },
  })

  const matched = vendorLines.filter((l) => boardGradesMatch(l.boardGrade, whNorm))
  const seenVpo = new Set<string>()
  for (const vl of matched) {
    const vpo = vl.vendorPo
    if (seenVpo.has(vpo.id)) continue
    seenVpo.add(vpo.id)
    steps.push({
      stage: 'Vendor PO',
      label: vpo.poNumber,
      detail: `${vpo.supplier.name} · ${vpo.status}`,
      mono: vpo.poNumber,
    })

    const receipts = await db.vendorMaterialReceipt.findMany({
      where: { vendorPoId: vpo.id },
      orderBy: { receiptDate: 'desc' },
      take: 6,
    })
    for (const rec of receipts) {
      const qc =
        rec.qcStatus == null
          ? 'QC pending'
          : rec.qcStatus === 'FAILED'
            ? 'QC failed'
            : `QC ${rec.qcStatus}`
      steps.push({
        stage: 'GRN / Gate',
        label: `Receipt ${rec.id.slice(0, 8)}…`,
        detail: `${rec.receiptDate.toISOString().slice(0, 10)} · ${qc} · veh ${rec.vehicleNumber}`,
        mono: rec.scaleSlipId,
      })
    }
  }

  const poNums = await linkedCustomerPoNumbersForPaperRow(db, batch)
  for (const num of poNums.slice(0, 8)) {
    steps.push({
      stage: 'Customer PO',
      label: num,
      detail: 'Linked via mill line coverage',
      mono: num,
    })
  }

  const floorIssues = await db.paperIssueToFloor.findMany({
    where: {
      OR: [{ sourcePaperWarehouseId: batch.id }, { destinationWarehouseId: batch.id }],
    },
    include: {
      jobCard: { select: { jobCardNumber: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 12,
  })

  for (const iss of floorIssues) {
    steps.push({
      stage: 'Issued to floor',
      label: iss.jobCard ? `JC#${iss.jobCard.jobCardNumber}` : 'No job link',
      detail: `${iss.qtySheets.toLocaleString('en-IN')} sh · ${iss.operatorName} · ${iss.jobCard?.status ?? '—'}`,
      mono: iss.jobCard ? `JC#${iss.jobCard.jobCardNumber}` : undefined,
    })
  }

  if (batch.location?.toUpperCase() === 'FLOOR' || batch.originatedFromId) {
    steps.push({
      stage: 'Current',
      label: 'On floor stock',
      detail: batch.originatedFromId ? 'Split from main warehouse batch' : 'Floor location',
    })
  }

  return {
    batch: {
      id: batch.id,
      lotNumber: batch.lotNumber,
      gsm: batch.gsm,
      qtySheets: batch.qtySheets,
      location: batch.location,
    },
    steps,
  }
}

export function estimateKgForSheets(
  sheets: number,
  kgPerSheet: number | null,
): number | null {
  if (kgPerSheet == null || !Number.isFinite(kgPerSheet) || kgPerSheet <= 0) return null
  return Math.round(sheets * kgPerSheet * 1000) / 1000
}

export async function resolveKgPerSheetForPaper(
  db: PrismaClient,
  row: Pick<PaperRowForPriority, 'gsm' | 'boardGrade' | 'paperType'>,
): Promise<number | null> {
  const whNorm = normalizeBoardKey(warehouseBoardLabel(row))
  if (!whNorm) return null
  const candidates = await db.materialQueue.findMany({
    where: { gsm: row.gsm },
    select: { totalSheets: true, totalWeightKg: true, boardType: true },
    take: 120,
  })
  const mq = candidates.find((c) => c.totalSheets > 0 && boardGradesMatch(c.boardType, whNorm))
  if (!mq) return null
  return Number(mq.totalWeightKg) / mq.totalSheets
}

export const HIGH_PRIORITY_ISSUE_AUDIT_MESSAGE = 'High-Priority Issue Authorized by Anik Dua.'
