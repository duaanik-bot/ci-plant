import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { resolveRequirementFromLine } from '@/lib/production-os-resolvers'

export const dynamic = 'force-dynamic'

type TimelineEvent = {
  at: string
  event: string
  detail: string
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const jc = await db.productionJobCard.findUnique({ where: { id } })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })
  const planningLine = jc.jobCardNumber
    ? await db.poLineItem.findFirst({
        where: { jobCardNumber: jc.jobCardNumber },
        select: { id: true, quantity: true, specOverrides: true, materialQueue: true, carton: true },
      })
    : null

  const [reservationByJob, reservationByPlanning, shortagesByJob, shortagesByPlanning] = await Promise.all([
    db.materialReservation.findFirst({ where: { jobCardId: id } }),
    planningLine
      ? db.materialReservation.findFirst({
          where: { planningId: planningLine.id },
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve(null),
    db.materialShortage.findMany({ where: { jobCardId: id }, orderBy: { createdAt: 'asc' } }),
    planningLine
      ? db.materialShortage.findMany({
          where: { planningId: planningLine.id },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
  ])
  const reservation = reservationByJob ?? reservationByPlanning
  const shortageMap = new Map<string, (typeof shortagesByJob)[number]>()
  for (const s of [...shortagesByJob, ...shortagesByPlanning]) shortageMap.set(s.id, s)
  const shortages = Array.from(shortageMap.values()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  const materialIds = Array.from(
    new Set([
      ...(reservation?.materialId ? [reservation.materialId] : []),
      ...shortages.map((s) => s.materialId),
    ]),
  )

  const [prs, movements, allocations] = await Promise.all([
    db.purchaseRequisition.findMany({
      where: {
        OR: [
          { sourceJobCardId: id },
          ...(planningLine ? [{ sourcePlanningId: planningLine.id }] : []),
          { shortageId: { in: shortages.map((s) => s.id) } },
        ],
      },
      orderBy: { raisedAt: 'asc' },
    }),
    materialIds.length
      ? db.stockMovement.findMany({
          where: {
            materialId: { in: materialIds },
            OR: [{ refId: id }, { refType: 'grn' }, { movementType: 'reserve' }],
          },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
    shortages.length
      ? db.grnShortageAllocation.findMany({
          where: { shortageId: { in: shortages.map((s) => s.id) } },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
  ])

  const events: TimelineEvent[] = []

  if (reservation) {
    events.push({
      at: reservation.createdAt.toISOString(),
      event: 'Planning requirement created',
      detail: `Required ${Number(reservation.requiredSheets).toLocaleString('en-IN')} sheets`,
    })
  } else if (planningLine) {
    const req = resolveRequirementFromLine({
      line: {
        ...planningLine,
        specOverrides: planningLine.specOverrides || {},
        materialQueue: planningLine.materialQueue || {},
        carton: planningLine.carton || {},
      },
      qtyOverride: planningLine.quantity ?? undefined,
    })
    events.push({
      at: jc.createdAt.toISOString(),
      event: 'Planning requirement created',
      detail: `Required ${Number(req.requiredSheets).toLocaleString('en-IN')} sheets`,
    })
  }

  for (const m of movements) {
    if (m.movementType === 'reserve' && m.refId === id) {
      events.push({ at: m.createdAt.toISOString(), event: 'Stock reserved', detail: `${Number(m.qty).toLocaleString('en-IN')} sheets reserved` })
    }
    if (m.movementType === 'grn_quarantine') {
      events.push({ at: m.createdAt.toISOString(), event: 'GRN received', detail: `${Number(m.qty).toLocaleString('en-IN')} sheets received` })
    }
  }

  for (const s of shortages) {
    events.push({
      at: s.createdAt.toISOString(),
      event: 'Shortage created',
      detail: `${Number(s.shortageQty).toLocaleString('en-IN')} sheets`,
    })
  }

  for (const p of prs) {
    events.push({ at: p.raisedAt.toISOString(), event: 'PR created', detail: `PR ${p.id.slice(0, 8)} · ${p.status}` })
    if (p.status === 'converted_to_po') {
      events.push({ at: p.createdAt.toISOString(), event: 'PO ordered', detail: p.poReference ? `PO ${p.poReference}` : 'PO reference pending' })
    }
    if (p.status === 'received') {
      events.push({ at: p.createdAt.toISOString(), event: 'PR received', detail: `PR ${p.id.slice(0, 8)} received` })
    }
  }

  for (const a of allocations) {
    events.push({ at: a.createdAt.toISOString(), event: 'Stock allocated', detail: `${Number(a.allocatedQty).toLocaleString('en-IN')} sheets allocated` })
  }

  if (events.length === 0) {
    events.push({
      at: jc.createdAt.toISOString(),
      event: 'Legacy / reference missing',
      detail: 'No linked material reservation records found for this job card.',
    })
  }

  events.sort((a, b) => a.at.localeCompare(b.at))

  return NextResponse.json({ events })
}
