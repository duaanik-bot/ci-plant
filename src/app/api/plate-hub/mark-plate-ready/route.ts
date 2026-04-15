import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { PlateSize } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'
import {
  commitShopfloorColoursForCustody,
  newPlatesNeededFromCommitted,
} from '@/lib/plate-shopfloor-spec'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  kind: z.enum(['requirement', 'plate']),
  id: z.string().uuid(),
  /** Final sheet size from shop-floor card (optional; defaults to DB). */
  plateSize: z.nativeEnum(PlateSize).optional(),
})

/** Move CTP / vendor requirement or rack plate into Custody Floor (preparation staging). */
export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { kind, id, plateSize: clientPlateSize } = parsed.data

  try {
    if (kind === 'requirement') {
      const row = await db.plateRequirement.findUnique({ where: { id } })
      if (!row) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })

      const okCtp =
        row.triageChannel === 'inhouse_ctp' && row.status === 'ctp_internal_queue'
      const okVendor =
        row.triageChannel === 'outside_vendor' && row.status === 'awaiting_vendor_delivery'
      if (!okCtp && !okVendor) {
        return NextResponse.json(
          { error: 'Requirement is not in CTP queue or vendor lane' },
          { status: 409 },
        )
      }

      const fromZone = okCtp ? HUB_ZONE.CTP_QUEUE : HUB_ZONE.OUTSIDE_VENDOR

      const { committed, error: commitErr } = commitShopfloorColoursForCustody(row.coloursNeeded)
      if (commitErr) {
        return NextResponse.json({ error: commitErr }, { status: 400 })
      }

      const resolvedSize = clientPlateSize ?? row.plateSize

      await db.$transaction(async (tx) => {
        await tx.plateRequirement.update({
          where: { id },
          data: {
            status: 'READY_ON_FLOOR',
            lastStatusUpdatedAt: new Date(),
            coloursNeeded: committed as object[],
            numberOfColours: committed.length,
            newPlatesNeeded: newPlatesNeededFromCommitted(committed),
            ...(resolvedSize ? { plateSize: resolvedSize } : {}),
          },
        })
        await createPlateHubEvent(tx, {
          plateRequirementId: id,
          actionType: PLATE_HUB_ACTION.MARKED_READY,
          fromZone,
          toZone: HUB_ZONE.CUSTODY_FLOOR,
          details: {
            kind: 'requirement',
            requirementCode: row.requirementCode,
            previousStatus: row.status,
            committedPlateSize: resolvedSize,
            committedColourNames: committed.map((c) => String(c.name ?? '').trim()).filter(Boolean),
            committedPlateCount: committed.length,
          },
        })
      })
      return NextResponse.json({ ok: true })
    }

    const plate = await db.plateStore.findUnique({ where: { id } })
    if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })

    const rackOk = ['ready', 'returned', 'in_stock'].includes(plate.status)
    if (!rackOk) {
      return NextResponse.json(
        { error: 'Only rack inventory plates can be marked ready for custody' },
        { status: 409 },
      )
    }

    await db.$transaction(async (tx) => {
      await tx.plateStore.update({
        where: { id },
        data: {
          status: 'READY_ON_FLOOR',
          hubCustodySource: 'rack',
          hubPreviousStatus: plate.status,
          issuedTo: null,
          issuedAt: null,
          lastStatusUpdatedAt: new Date(),
        },
      })
      await createPlateHubEvent(tx, {
        plateStoreId: id,
        actionType: PLATE_HUB_ACTION.MARKED_READY,
        fromZone: HUB_ZONE.LIVE_INVENTORY,
        toZone: HUB_ZONE.CUSTODY_FLOOR,
        details: {
          kind: 'plate',
          plateSetCode: plate.plateSetCode,
          previousStatus: plate.status,
        },
      })
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[mark-plate-ready]', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }
}
