import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

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
      attributes: true,
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
    where: { materialId: id, status: { not: 'closed' } },
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

  const shortageIds = shortages.map((s) => s.id)
  const shortagePrs = shortageIds.length
    ? await db.purchaseRequisition.findMany({
        where: { shortageId: { in: shortageIds } },
        select: { id: true, shortageId: true, status: true },
      })
    : []
  const prByShortageId = new Map(
    shortagePrs
      .filter((p): p is { id: string; shortageId: string; status: string } => typeof p.shortageId === 'string' && p.shortageId.length > 0)
      .map((p) => [p.shortageId, p]),
  )

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
  const planningLogIds = Array.from(
    new Set(
      logs
        .filter((l) => (l.refType || '').startsWith('planning_'))
        .map((l) => l.refId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  )
  const jobCardLogIds = Array.from(
    new Set(
      logs
        .filter((l) => (l.refType || '').startsWith('job_card_'))
        .map((l) => l.refId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  )
  const allPlanningIds = Array.from(new Set([...planningIds, ...planningLogIds]))

  const planningLines = allPlanningIds.length
    ? await db.poLineItem.findMany({
        where: { id: { in: allPlanningIds } },
        select: {
          id: true,
          cartonName: true,
          jobCardNumber: true,
          po: { select: { poNumber: true } },
        },
      })
    : []
  const jobCardsFromPlanningNumbers = Array.from(
    new Set(
      planningLines
        .map((line) => line.jobCardNumber)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
    ),
  )
  const jobCardsById = jobCardLogIds.length
    ? await db.productionJobCard.findMany({
        where: { id: { in: jobCardLogIds } },
        select: { id: true, jobCardNumber: true, status: true, customer: { select: { name: true } } },
      })
    : []
  const jobCardsByNumber = jobCardsFromPlanningNumbers.length
    ? await db.productionJobCard.findMany({
        where: { jobCardNumber: { in: jobCardsFromPlanningNumbers } },
        select: { id: true, jobCardNumber: true, status: true, customer: { select: { name: true } } },
      })
    : []

  const lineById = new Map(planningLines.map((l) => [l.id, l]))
  const jobCardById = new Map(jobCardsById.map((j) => [j.id, j]))
  const jobCardByNumber = new Map(jobCardsByNumber.map((j) => [j.jobCardNumber, j]))

  return NextResponse.json({
    material: {
      ...material,
      boardType: normalizeBoardTypeForStorage(material.boardType),
      boardClassification: normalizeBoardTypeForStorage(material.boardClassification),
      sheetLength: material.sheetLength ? Number(material.sheetLength) : null,
      sheetWidth: material.sheetWidth ? Number(material.sheetWidth) : null,
      sourceTraceability: (() => {
        const raw = typeof material.attributes === 'string' ? material.attributes : ''
        if (!raw) return null
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          const t = parsed.traceability
          return typeof t === 'string' ? t : null
        } catch {
          return null
        }
      })(),
      leftoverMeta: (() => {
        const raw = typeof material.attributes === 'string' ? material.attributes : ''
        if (!raw) return null
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          const sourceMaterialId = typeof parsed.sourceMaterialId === 'string' ? parsed.sourceMaterialId : null
          const sourcePlanningId = typeof parsed.sourcePlanningId === 'string' ? parsed.sourcePlanningId : null
          const sourceJobCardId = typeof parsed.sourceJobCardId === 'string' ? parsed.sourceJobCardId : null
          const sourceParentSize = typeof parsed.sourceParentSize === 'string' ? parsed.sourceParentSize : null
          const leftoverSize = typeof parsed.leftoverSize === 'string' ? parsed.leftoverSize : null
          const cutSizeUsed = typeof parsed.cutSizeUsed === 'string' ? parsed.cutSizeUsed : null
          const remarks = typeof parsed.remarks === 'string' ? parsed.remarks : null
          const isLeftover = parsed.leftover === true || String(material.materialCode || '').toUpperCase().startsWith('LEFTOVER-')
          return {
            isLeftover,
            sourceMaterialId,
            sourcePlanningId,
            sourceJobCardId,
            sourceParentSize,
            leftoverSize,
            cutSizeUsed,
            remarks,
          }
        } catch {
          return null
        }
      })(),
    },
    logs: logs.map((l) => ({
      id: l.id,
      movementType: l.movementType,
      qty: Number(l.qty),
      refType: l.refType,
      refId: l.refId,
      createdAt: l.createdAt.toISOString(),
      reservationContext: (() => {
        if (!l.refType || !l.refId) return null
        if (l.refType.startsWith('planning_')) {
          const line = lineById.get(l.refId)
          const linkedJob = line?.jobCardNumber ? jobCardByNumber.get(line.jobCardNumber) : null
          return {
            planningId: l.refId,
            cartonName: line?.cartonName ?? null,
            poNumber: line?.po.poNumber ?? null,
            jobCard: linkedJob
              ? {
                  id: linkedJob.id,
                  jobCardNumber: linkedJob.jobCardNumber,
                  status: linkedJob.status,
                  customerName: linkedJob.customer.name,
                }
              : null,
          }
        }
        if (l.refType.startsWith('job_card_')) {
          const job = jobCardById.get(l.refId)
          return {
            planningId: null,
            cartonName: null,
            poNumber: null,
            jobCard: job
              ? {
                  id: job.id,
                  jobCardNumber: job.jobCardNumber,
                  status: job.status,
                  customerName: job.customer.name,
                }
              : null,
          }
        }
        return null
      })(),
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
        prId: prByShortageId.get(s.id)?.id ?? null,
        prStatus: prByShortageId.get(s.id)?.status ?? null,
      }
    }),
  })
}
