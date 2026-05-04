import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Material id is required' }, { status: 400 })

  const material = await db.inventory.findUnique({
    where: { id },
    select: {
      id: true,
      materialCode: true,
      description: true,
      boardType: true,
      boardClassification: true,
      gsm: true,
      sheetLength: true,
      sheetWidth: true,
      qtyQuarantine: true,
    },
  })
  if (!material) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const [logs, reservations] = await Promise.all([
    db.stockMovement.findMany({
      where: { materialId: id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        movementType: true,
        qty: true,
        refType: true,
        refId: true,
        createdAt: true,
      },
    }),
    db.materialReservation.findMany({
      where: { materialId: id, reservedSheets: { gt: 0 } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        planningId: true,
        requiredSheets: true,
        reservedSheets: true,
        shortageSheets: true,
        status: true,
        updatedAt: true,
        jobCard: {
          select: {
            id: true,
            jobCardNumber: true,
            status: true,
            customer: { select: { name: true } },
          },
        },
      },
    }),
  ])

  const shortages = await db.materialShortage.findMany({
    where: { materialId: id, status: 'open' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      jobCardId: true,
      planningId: true,
      shortageQty: true,
      remainingQty: true,
      requiredByDate: true,
      createdAt: true,
    },
  })

  const shortageJobCards = shortages.length
    ? await db.productionJobCard.findMany({
        where: {
          id: { in: shortages.map((s) => s.jobCardId).filter((v): v is string => typeof v === 'string' && v.length > 0) },
        },
        select: { id: true, jobCardNumber: true, status: true },
      })
    : []
  const shortageJobCardMap = new Map(shortageJobCards.map((j) => [j.id, j]))

  const planningIds = Array.from(
    new Set(reservations.map((r) => r.planningId).filter((v): v is string => typeof v === 'string' && v.length > 0)),
  )

  const planningLines = planningIds.length
    ? await db.poLineItem.findMany({
        where: { id: { in: planningIds } },
        select: {
          id: true,
          cartonName: true,
          po: { select: { poNumber: true } },
        },
      })
    : []

  const lineById = new Map(planningLines.map((l) => [l.id, l]))

  return NextResponse.json({
    material: {
      ...material,
      sheetLength: material.sheetLength ? Number(material.sheetLength) : null,
      sheetWidth: material.sheetWidth ? Number(material.sheetWidth) : null,
    },
    logs: logs.map((l) => ({
      ...l,
      qty: Number(l.qty),
      createdAt: l.createdAt.toISOString(),
    })),
    reservations: reservations.map((r) => {
      const line = r.planningId ? lineById.get(r.planningId) : null
      return {
        id: r.id,
        planningId: r.planningId,
        cartonName: line?.cartonName ?? null,
        poNumber: line?.po.poNumber ?? null,
        requiredSheets: Number(r.requiredSheets),
        reservedSheets: Number(r.reservedSheets),
        shortageSheets: Number(r.shortageSheets),
        status: r.status,
        reservedAt: r.updatedAt.toISOString(),
        jobCard: r.jobCard
          ? {
              id: r.jobCard.id,
              jobCardNumber: r.jobCard.jobCardNumber,
              status: r.jobCard.status,
              customerName: r.jobCard.customer.name,
            }
          : null,
      }
    }),
    shortages: shortages.map((s) => {
      const jc = s.jobCardId ? shortageJobCardMap.get(s.jobCardId) : null
      const materialIncoming = Number(material.qtyQuarantine ?? 0)
      const priority = materialIncoming > 0 ? 'normal' : 'urgent'
      return {
        id: s.id,
        jobCardId: s.jobCardId ?? 'Legacy / reference missing',
        jobCardNumber: jc?.jobCardNumber ?? null,
        planningId: s.planningId,
        requiredQty: Number(s.shortageQty),
        pendingShortage: Number(s.remainingQty),
        requiredByDate: s.requiredByDate ? s.requiredByDate.toISOString() : null,
        priority,
        status: jc?.status ?? null,
      }
    }),
  })
}
