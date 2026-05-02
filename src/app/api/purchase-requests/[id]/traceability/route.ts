import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const nz = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const formatSheetDim = (value: unknown) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n.toString()
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const pr = await db.purchaseRequisition.findUnique({
    where: { id },
    include: { material: true },
  })
  if (!pr) return NextResponse.json({ error: 'Purchase request not found' }, { status: 404 })

  const shortages = await db.materialShortage.findMany({
    where: {
      OR: [
        { purchaseReqId: pr.id },
        ...(pr.shortageId ? [{ id: pr.shortageId }] : []),
        ...(pr.sourceJobCardId ? [{ jobCardId: pr.sourceJobCardId, materialId: pr.materialId }] : []),
      ],
    },
    orderBy: { createdAt: 'asc' },
  })

  const jobIds = Array.from(new Set(shortages.map((s) => s.jobCardId)))
  const jobs = jobIds.length
    ? await db.productionJobCard.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, jobCardNumber: true, customerId: true },
      })
    : []
  const customerIds = Array.from(new Set(jobs.map((j) => j.customerId)))
  const customers = customerIds.length
    ? await db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } })
    : []
  const customerMap = new Map(customers.map((c) => [c.id, c.name]))
  const jobMap = new Map(jobs.map((j) => [j.id, j]))

  const lineByJobNo = jobs.length
    ? new Map(
        (
          await db.poLineItem.findMany({
            where: { jobCardNumber: { in: jobs.map((j) => j.jobCardNumber) } },
            select: { jobCardNumber: true, cartonName: true, po: { select: { poNumber: true } } },
          })
        ).map((l) => [l.jobCardNumber, l]),
      )
    : new Map<number, { cartonName: string; po: { poNumber: string } }>()

  const movements = await db.stockMovement.findMany({
    where: { materialId: pr.materialId },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { id: true, movementType: true, qty: true, refType: true, refId: true, createdAt: true },
  })

  const allocations = shortages.length
    ? await db.grnShortageAllocation.findMany({
        where: { shortageId: { in: shortages.map((s) => s.id) } },
        orderBy: { createdAt: 'asc' },
      })
    : []

  const linkedJobs = shortages.map((s) => {
    const jc = jobMap.get(s.jobCardId)
    const line = jc ? lineByJobNo.get(jc.jobCardNumber) : undefined
    return {
      shortageId: s.id,
      product: line?.cartonName ?? 'Legacy / reference missing',
      customer: jc ? customerMap.get(jc.customerId) ?? 'Legacy / reference missing' : 'Legacy / reference missing',
      poRef: line?.po.poNumber ?? 'Legacy / reference missing',
      jobCardNo: jc?.jobCardNumber ?? null,
      requiredSheets: nz(s.shortageQty),
      shortageSheets: nz(s.remainingQty),
      prStatus: pr.status,
      requiredByDate: s.requiredByDate ? s.requiredByDate.toISOString() : null,
    }
  })

  const stock = {
    available: nz(pr.material.qtyAvailable),
    reserved: nz(pr.material.qtyReserved),
    incoming: nz(pr.material.qtyQuarantine),
    shortage: nz(pr.material.shortageSheets),
    receivedViaGrn: movements
      .filter((m) => m.movementType === 'grn_quarantine')
      .reduce((sum, m) => sum + nz(m.qty), 0),
  }

  const timeline: Array<{ at: string; event: string; detail: string }> = [
    { at: pr.raisedAt.toISOString(), event: 'PR created', detail: `Qty ${nz(pr.qtyRequired).toLocaleString('en-IN')}` },
  ]
  if (pr.approvedAt) timeline.push({ at: pr.approvedAt.toISOString(), event: 'PR approved', detail: 'Approved' })
  if (pr.status === 'converted_to_po' || pr.status === 'received') {
    timeline.push({ at: (pr.approvedAt ?? pr.raisedAt).toISOString(), event: 'Ordered', detail: pr.poReference ?? 'PO linked' })
  }
  for (const m of movements) {
    if (m.movementType === 'grn_quarantine') {
      timeline.push({ at: m.createdAt.toISOString(), event: 'GRN received', detail: `${nz(m.qty).toLocaleString('en-IN')} sheets` })
    }
  }
  for (const a of allocations) {
    timeline.push({ at: a.createdAt.toISOString(), event: 'Allocated', detail: `${nz(a.allocatedQty).toLocaleString('en-IN')} sheets` })
  }
  timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  return NextResponse.json({
    pr: {
      id: pr.id,
      status: pr.status,
      totalQty: nz(pr.qtyRequired),
      priority: shortages.length > 0 && nz(pr.material.qtyQuarantine) <= 0 ? 'Urgent' : 'Normal',
      requiredByDate:
        shortages
          .map((s) => (s.requiredByDate ? s.requiredByDate.toISOString() : null))
          .filter((v): v is string => !!v)
          .sort()[0] ?? null,
      poReference: pr.poReference ?? null,
    },
    material: {
      materialCode: pr.material.materialCode,
      boardType: pr.material.boardType ?? '-',
      classification: pr.material.boardClassification ?? '-',
      size: (() => {
        const l = formatSheetDim(pr.material.sheetLength)
        const w = formatSheetDim(pr.material.sheetWidth)
        return l && w ? `${l}x${w}` : '-'
      })(),
      gsm: pr.material.gsm ?? null,
    },
    linkedJobs,
    stock,
    timeline,
  })
}
