import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  kind: z.enum(['requirement', 'plate']),
  id: z.string().uuid(),
})

/** Undo Mark Plate Ready — return item to CTP, vendor lane, or rack. */
export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { kind, id } = parsed.data

  try {
    if (kind === 'requirement') {
      const row = await db.plateRequirement.findUnique({ where: { id } })
      if (!row) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })
      if (row.status !== 'READY_ON_FLOOR') {
        return NextResponse.json({ error: 'Not on custody floor' }, { status: 409 })
      }

      let nextStatus: string
      let toZone: string
      let clearTriageChannel = false
      if (row.triageChannel === 'inhouse_ctp') {
        nextStatus = 'ctp_internal_queue'
        toZone = HUB_ZONE.CTP_QUEUE
      } else if (row.triageChannel === 'outside_vendor') {
        nextStatus = 'awaiting_vendor_delivery'
        toZone = HUB_ZONE.OUTSIDE_VENDOR
      } else if (row.triageChannel === 'stock_available') {
        nextStatus = 'pending'
        toZone = HUB_ZONE.INCOMING_TRIAGE
        clearTriageChannel = true
      } else {
        return NextResponse.json({ error: 'Cannot infer return lane' }, { status: 409 })
      }

      await db.$transaction(async (tx) => {
        await tx.plateRequirement.update({
          where: { id },
          data: {
            status: nextStatus,
            ...(clearTriageChannel ? { triageChannel: null } : {}),
            lastStatusUpdatedAt: new Date(),
          },
        })
        const poLineId = row.poLineId?.trim()
        if (clearTriageChannel && poLineId) {
          const line = await tx.poLineItem.findUnique({
            where: { id: poLineId },
            select: { specOverrides: true },
          })
          if (line) {
            const spec = (line.specOverrides as Record<string, unknown> | null) || {}
            await tx.poLineItem.update({
              where: { id: poLineId },
              data: {
                specOverrides: mergeOrchestrationIntoSpec(spec, {
                  plateFlowStatus: PLATE_FLOW.triage,
                }) as object,
              },
            })
          }
        }
        await createPlateHubEvent(tx, {
          plateRequirementId: id,
          actionType: PLATE_HUB_ACTION.REVERSED_READY,
          fromZone: HUB_ZONE.CUSTODY_FLOOR,
          toZone,
          details: { kind: 'requirement', requirementCode: row.requirementCode, nextStatus },
        })
      })
      return NextResponse.json({ ok: true })
    }

    const plate = await db.plateStore.findUnique({ where: { id } })
    if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })
    if (plate.status !== 'READY_ON_FLOOR') {
      return NextResponse.json({ error: 'Not on custody floor' }, { status: 409 })
    }

    const prev = String(plate.hubPreviousStatus ?? '').trim() || 'ready'

    await db.$transaction(async (tx) => {
      await tx.plateStore.update({
        where: { id },
        data: {
          status: prev,
          hubCustodySource: null,
          hubPreviousStatus: null,
          lastStatusUpdatedAt: new Date(),
        },
      })
      await createPlateHubEvent(tx, {
        plateStoreId: id,
        actionType: PLATE_HUB_ACTION.REVERSED_READY,
        fromZone: HUB_ZONE.CUSTODY_FLOOR,
        toZone: HUB_ZONE.LIVE_INVENTORY,
        details: {
          kind: 'plate',
          plateSetCode: plate.plateSetCode,
          restoredStatus: prev,
        },
      })
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[reverse-plate-ready]', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }
}
