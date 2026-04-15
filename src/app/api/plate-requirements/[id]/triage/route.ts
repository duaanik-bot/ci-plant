import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { PlateSize, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  channel: z.enum(['stock_available', 'inhouse_ctp', 'outside_vendor']),
  /** @deprecated Ignored — rack reservation lane removed; stock path goes to custody floor. */
  rackSlot: z.string().min(1).optional(),
  /** Required for CTP/vendor/stock when requirement and carton master have no size */
  plateSize: z.nativeEnum(PlateSize).optional(),
})

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    const first = parsed.error.flatten().fieldErrors
    const hint = [first.channel, first.plateSize].flat().filter(Boolean)[0]
    return NextResponse.json(
      {
        error:
          hint ??
          'Invalid triage payload — use channel inhouse_ctp | outside_vendor | stock_available, and plateSize when required.',
      },
      { status: 400 },
    )
  }

  const existing = await db.plateRequirement.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const channel = parsed.data.channel
  let nextStatus = existing.status
  if (channel === 'inhouse_ctp') nextStatus = 'ctp_internal_queue'
  if (channel === 'outside_vendor') nextStatus = 'awaiting_vendor_delivery'
  /** Stock path: skip "awaiting rack" — stage directly on custody floor (rack pull / burn prep). */
  if (channel === 'stock_available') nextStatus = 'READY_ON_FLOOR'

  let resolvedPlateSize: PlateSize | null =
    parsed.data.plateSize ?? existing.plateSize ?? null
  if (!resolvedPlateSize && existing.poLineId?.trim()) {
    const line = await db.poLineItem.findUnique({
      where: { id: existing.poLineId.trim() },
      select: { cartonId: true },
    })
    if (line?.cartonId) {
      const carton = await db.carton.findUnique({
        where: { id: line.cartonId },
        select: { plateSize: true },
      })
      resolvedPlateSize = carton?.plateSize ?? null
    }
  }

  if (
    (channel === 'inhouse_ctp' || channel === 'outside_vendor' || channel === 'stock_available') &&
    !resolvedPlateSize
  ) {
    return NextResponse.json(
      {
        error:
          'Plate size is required — set it on the carton master or choose a size when dispatching.',
      },
      { status: 400 },
    )
  }

  const plateFlowStatus =
    channel === 'inhouse_ctp'
      ? PLATE_FLOW.ctp_queue
      : channel === 'outside_vendor'
        ? PLATE_FLOW.vendor_queue
        : PLATE_FLOW.burning_complete

  let updated
  try {
    const toZone =
      channel === 'inhouse_ctp'
        ? HUB_ZONE.CTP_QUEUE
        : channel === 'outside_vendor'
          ? HUB_ZONE.OUTSIDE_VENDOR
          : HUB_ZONE.CUSTODY_FLOOR

    updated = await db.$transaction(async (tx) => {
      const req = await tx.plateRequirement.update({
        where: { id },
        data: {
          triageChannel: channel,
          status: nextStatus,
          lastStatusUpdatedAt: new Date(),
          ...(channel === 'stock_available'
            ? { reservedRackSlot: null, plateSize: resolvedPlateSize! }
            : {}),
          ...((channel === 'inhouse_ctp' || channel === 'outside_vendor') && resolvedPlateSize
            ? { plateSize: resolvedPlateSize }
            : {}),
        },
      })

      const poLineId = existing.poLineId?.trim()
      if (poLineId) {
        const line = await tx.poLineItem.findUnique({
          where: { id: poLineId },
          select: { specOverrides: true },
        })
        if (line) {
          const spec = (line.specOverrides as Record<string, unknown> | null) || {}
          await tx.poLineItem.update({
            where: { id: poLineId },
            data: {
              specOverrides: mergeOrchestrationIntoSpec(spec, { plateFlowStatus }) as object,
            },
          })
        }
      }

      await createPlateHubEvent(tx, {
        plateRequirementId: id,
        actionType: PLATE_HUB_ACTION.DISPATCHED,
        fromZone: HUB_ZONE.INCOMING_TRIAGE,
        toZone,
        details: {
          channel,
          triageChannel: channel,
          status: nextStatus,
          plateFlowStatus,
          plateSize: resolvedPlateSize ?? undefined,
          rackSlot: parsed.data.rackSlot?.trim() || undefined,
        },
      })

      return req
    })
  } catch (e) {
    console.error('[plate-requirements/triage]', e)
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      return NextResponse.json(
        { error: 'Triage dispatch failed: linked PO line is missing. Hub state was not changed.' },
        { status: 409 },
      )
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: msg || 'Triage dispatch failed due to a database error.' },
      { status: 500 },
    )
  }

  try {
    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'plate_requirements',
      recordId: id,
      newValue: { triageChannel: channel, status: nextStatus, plateFlowStatus },
    })
  } catch (e) {
    console.error('[plate-requirements/triage] audit log', e)
  }

  return NextResponse.json({ ok: true, requirement: updated })
}
