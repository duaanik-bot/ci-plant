import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'
import {
  PLATE_SCRAP_REASON_CODE_LIST,
  plateScrapReasonLabel,
} from '@/lib/plate-scrap-reasons'
import { formatLifetimePerformanceSummary, mergeEffectiveCycleData } from '@/lib/plate-cycle-ledger'

export const dynamic = 'force-dynamic'

type ColourRow = {
  name?: string
  type?: string
  status?: string
  scrapReasonCode?: string
  scrappedAt?: string
}

const bodySchema = z.object({
  plateStoreId: z.string().uuid(),
  colourNames: z.array(z.string().min(1)).min(1),
  reasonCode: z.enum(PLATE_SCRAP_REASON_CODE_LIST),
})

function recountPlateMetrics(colours: ColourRow[]) {
  const active = colours.filter((c) => String(c?.status ?? '').toLowerCase() !== 'destroyed')
  const numberOfColours = active.length
  const totalPlates = active.length
  const newPlates = active.filter((c) => String(c?.status ?? '').toLowerCase() === 'new').length
  const oldPlates = active.filter((c) => {
    const s = String(c?.status ?? '').toLowerCase()
    return s === 'old' || s === 'returned'
  }).length
  return { numberOfColours, totalPlates, newPlates, oldPlates }
}

/** Mark specific colour channels destroyed; log reason; optionally retire whole set. */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { plateStoreId, colourNames, reasonCode } = parsed.data
  const reasonLabel = plateScrapReasonLabel(reasonCode)
  const nowIso = new Date().toISOString()

  const plate = await db.plateStore.findUnique({ where: { id: plateStoreId } })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })

  const allowed = ['ready', 'returned', 'in_stock', 'READY_ON_FLOOR']
  if (!allowed.includes(plate.status)) {
    return NextResponse.json(
      { error: 'Plate cannot be scrapped in its current status' },
      { status: 409 },
    )
  }

  const colours = (Array.isArray(plate.colours) ? plate.colours : []) as ColourRow[]
  if (!colours.length) {
    return NextResponse.json({ error: 'Plate has no colour channels' }, { status: 400 })
  }

  const wanted = new Set(colourNames.map((n) => n.trim().toLowerCase()).filter(Boolean))
  const matched = new Set<string>()

  const nextColours = colours.map((row) => {
    const name = String(row?.name ?? '').trim()
    const st = String(row?.status ?? '').toLowerCase()
    if (!name || st === 'destroyed') return row
    if (!wanted.has(name.toLowerCase())) return row
    matched.add(name.toLowerCase())
    return {
      ...row,
      status: 'destroyed',
      scrapReasonCode: reasonCode,
      scrappedAt: nowIso,
    }
  })

  for (const w of Array.from(wanted)) {
    if (!matched.has(w)) {
      return NextResponse.json(
        { error: `No active plate channel matched: ${colourNames.find((n) => n.trim().toLowerCase() === w) ?? w}` },
        { status: 400 },
      )
    }
  }

  const { numberOfColours, totalPlates, newPlates, oldPlates } = recountPlateMetrics(nextColours)
  const fullyGone = numberOfColours === 0

  const fromZone =
    plate.status === 'READY_ON_FLOOR' ? HUB_ZONE.CUSTODY_FLOOR : HUB_ZONE.LIVE_INVENTORY

  const lifetimeCycle = mergeEffectiveCycleData({
    cycleData: plate.cycleData,
    colours: plate.colours,
  })
  const perf = formatLifetimePerformanceSummary(lifetimeCycle)
  const lifetimePerformance =
    perf.length > 0
      ? `Plate scrapped. Lifetime performance: ${perf}.`
      : 'Plate scrapped. Lifetime performance: (no cycle data).'

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateStore.update({
      where: { id: plateStoreId },
      data: {
        colours: nextColours as object[],
        numberOfColours,
        totalPlates,
        newPlates,
        oldPlates,
        ...(!fullyGone ? { lastStatusUpdatedAt: new Date() } : {}),
        ...(fullyGone
          ? {
              status: 'destroyed',
              destroyedAt: new Date(),
              destroyedBy: user!.id,
              destroyedReason: `${reasonLabel} (channels: ${colourNames.join(', ')})`,
              hubCustodySource: null,
              hubPreviousStatus: null,
            }
          : {}),
      },
    })

    await tx.plateStoreScrapEvent.create({
      data: {
        plateStoreId,
        scrappedNames: colourNames,
        reasonCode,
        reasonLabel,
        performedBy: user!.id,
      },
    })

    await createPlateHubEvent(tx, {
      plateStoreId,
      actionType: PLATE_HUB_ACTION.SCRAPPED,
      fromZone,
      toZone: fullyGone ? HUB_ZONE.OTHER : fromZone,
      details: {
        scrappedColourNames: colourNames,
        colourNames,
        reasonCode,
        reasonLabel,
        fullyDestroyed: fullyGone,
        lifetimePerformance,
        cycleDataSnapshot: lifetimeCycle,
      },
    })

    return u
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: plateStoreId,
    newValue: {
      scrapChannels: colourNames,
      reasonCode,
      fullyDestroyed: fullyGone,
    },
  })

  return NextResponse.json({ ok: true, plate: updated })
}
