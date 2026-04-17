import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  buildDirectorStageSyncPatch,
  computeLifeBars,
  deriveDirectorStageKey,
  lineValueRupee,
  poReceiptAgeDays,
  stageWipDays,
  toolingSnapshotFromRow,
} from '@/lib/director-command-center-lifecycle'
import { dyeMapFromRows } from '@/lib/po-tooling-critical'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const lines = await db.poLineItem.findMany({
    where: {
      po: { status: { in: ['draft', 'confirmed'] } },
    },
    include: {
      po: { include: { customer: { select: { id: true, name: true } } } },
    },
    orderBy: [{ directorPriority: 'desc' }, { directorHold: 'asc' }, { createdAt: 'desc' }],
    take: 400,
  })

  const jcByNumber = new Map<number, Awaited<ReturnType<typeof db.productionJobCard.findFirst>>>()
  const jobNumbers = Array.from(
    new Set(lines.map((l) => l.jobCardNumber).filter((n): n is number => n != null)),
  )
  for (const num of jobNumbers) {
    if (!jcByNumber.has(num)) {
      const jc = await db.productionJobCard.findFirst({ where: { jobCardNumber: num } })
      jcByNumber.set(num, jc)
    }
  }

  const dieIds = Array.from(
    new Set(lines.map((l) => l.dieMasterId).filter((id): id is string => Boolean(id))),
  )
  const dyeRows =
    dieIds.length > 0
      ? await db.dye.findMany({
          where: { id: { in: dieIds }, active: true },
          select: {
            id: true,
            custodyStatus: true,
            condition: true,
            dyeNumber: true,
            location: true,
            hubStatusFlag: true,
          },
        })
      : []
  const dyeById = dyeMapFromRows(dyeRows)

  const now = new Date()
  const syncUpdates: { id: string; data: Record<string, unknown> }[] = []

  const rows = lines.map((li) => {
    const jc = li.jobCardNumber ? jcByNumber.get(li.jobCardNumber) ?? null : null
    const d = li.dieMasterId ? dyeById.get(li.dieMasterId) : undefined
    const snap = d ? toolingSnapshotFromRow(d) : null
    const stageKey = deriveDirectorStageKey(li, li.po, jc, snap)
    const patch = buildDirectorStageSyncPatch(li, stageKey, now)
    if (Object.keys(patch).length > 0) {
      syncUpdates.push({ id: li.id, data: patch as Record<string, unknown> })
    }

    const lifeBars = computeLifeBars(li, li.po, jc, snap)

    return {
      id: li.id,
      cartonName: li.cartonName,
      quantity: li.quantity,
      rate: li.rate != null ? Number(li.rate) : null,
      lineValue: lineValueRupee(li),
      planningStatus: li.planningStatus,
      materialProcurementStatus: li.materialProcurementStatus,
      directorPriority: li.directorPriority,
      directorHold: li.directorHold,
      directorBroadcastNote: li.directorBroadcastNote,
      directorCurrentStageKey: li.directorCurrentStageKey ?? stageKey,
      stageKeyDerived: stageKey,
      stageWipDays: {
        artwork: stageWipDays('artwork', li, now),
        tooling: stageWipDays('tooling', li, now),
        material: stageWipDays('material', li, now),
        production: stageWipDays('production', li, now),
        logistics: stageWipDays('logistics', li, now),
      },
      lifeBars,
      ageDaysSincePoReceipt: poReceiptAgeDays(li.po.poDate, now),
      po: {
        id: li.po.id,
        poNumber: li.po.poNumber,
        status: li.po.status,
        poDate: li.po.poDate.toISOString(),
        customer: li.po.customer,
      },
      jobCardNumber: li.jobCardNumber,
      artworkCode: li.artworkCode,
      fileUrl: jc?.fileUrl ?? null,
    }
  })

  if (syncUpdates.length > 0) {
    await db.$transaction(
      syncUpdates.map((u) =>
        db.poLineItem.update({
          where: { id: u.id },
          data: u.data,
        }),
      ),
    )
  }

  return NextResponse.json(rows)
}
