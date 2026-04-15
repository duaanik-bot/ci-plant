import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { PlateSize } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { plateNamesFromColoursNeededJson } from '@/lib/plate-triage-display'
import {
  cloneColoursNeededJson,
  countActiveShopfloorColours,
  countShopfloorActiveRows,
  findColourRowIndexByCanonicalKey,
  shopfloorInactiveCanonicalKeysFromJson,
} from '@/lib/plate-shopfloor-spec'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'

export const dynamic = 'force-dynamic'

const bodySchema = z
  .object({
    plateSize: z.nativeEnum(PlateSize).optional(),
    colourToggle: z
      .object({
        canonicalKey: z.string().min(1),
        active: z.boolean(),
      })
      .optional(),
  })
  .refine((b) => b.plateSize !== undefined || b.colourToggle !== undefined, {
    message: 'Send plateSize and/or colourToggle',
  })

function zoneMeta(row: { triageChannel: string | null; status: string }) {
  const okCtp = row.triageChannel === 'inhouse_ctp' && row.status === 'ctp_internal_queue'
  const okVend =
    row.triageChannel === 'outside_vendor' && row.status === 'awaiting_vendor_delivery'
  if (okCtp) return { ok: true as const, hubZone: HUB_ZONE.CTP_QUEUE, zoneName: 'CTP Queue' }
  if (okVend) return { ok: true as const, hubZone: HUB_ZONE.OUTSIDE_VENDOR, zoneName: 'Outside Vendor' }
  return { ok: false as const }
}

function activeColourLabels(rows: Record<string, unknown>[]): string[] {
  return rows
    .filter((r) => {
      const st = String(r.status ?? '').toLowerCase()
      if (st === 'destroyed') return false
      return r.hubShopfloorActive !== false
    })
    .map((r) => String(r.name ?? '').trim())
    .filter(Boolean)
}

function jsonSnapshot(row: {
  coloursNeeded: unknown
  plateSize: PlateSize | null
  numberOfColours: number
  newPlatesNeeded: number
}) {
  return {
    shopfloorInactiveCanonicalKeys: shopfloorInactiveCanonicalKeysFromJson(row.coloursNeeded),
    shopfloorActiveColourCount: countActiveShopfloorColours(row.coloursNeeded),
    plateSize: row.plateSize,
    plateColours: plateNamesFromColoursNeededJson(row.coloursNeeded),
    numberOfColours: row.numberOfColours,
    newPlatesNeeded: row.newPlatesNeeded,
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().formErrors[0] ?? 'Invalid body' },
      { status: 400 },
    )
  }

  const row = await db.plateRequirement.findUnique({ where: { id } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const zm = zoneMeta(row)
  if (!zm.ok) {
    return NextResponse.json(
      { error: 'Shop floor edits apply only to CTP queue or outside vendor lanes' },
      { status: 409 },
    )
  }

  const nextSize = parsed.data.plateSize
  const colourToggle = parsed.data.colourToggle
  const sizeChanging = nextSize !== undefined && nextSize !== row.plateSize
  const toggling = Boolean(colourToggle)

  if (!sizeChanging && !toggling) {
    return NextResponse.json({ ok: true, ...jsonSnapshot(row) })
  }

  try {
    await db.$transaction(async (tx) => {
      let coloursNeeded = cloneColoursNeededJson(row.coloursNeeded)

      if (sizeChanging && nextSize !== undefined) {
        const msg = `Plate size modified by operator in ${zm.zoneName}`
        await createPlateHubEvent(tx, {
          plateRequirementId: id,
          actionType: PLATE_HUB_ACTION.SHOPFLOOR_SIZE_EDIT,
          fromZone: zm.hubZone,
          toZone: zm.hubZone,
          details: {
            message: msg,
            zoneName: zm.zoneName,
            oldSize: row.plateSize,
            newSize: nextSize,
            requirementCode: row.requirementCode,
          },
        })
      }

      if (colourToggle) {
        const { canonicalKey, active } = colourToggle
        const before = activeColourLabels(coloursNeeded)
        const idx = findColourRowIndexByCanonicalKey(coloursNeeded, canonicalKey)
        if (idx < 0) {
          throw new Error('COLOUR_NOT_FOUND')
        }
        const label = String(coloursNeeded[idx]!.name ?? '').trim() || canonicalKey

        if (active) {
          delete coloursNeeded[idx]!.hubShopfloorActive
        } else {
          coloursNeeded[idx]!.hubShopfloorActive = false
        }

        if (countShopfloorActiveRows(coloursNeeded) < 1) {
          throw new Error('LAST_COLOUR')
        }

        const after = activeColourLabels(coloursNeeded)

        await createPlateHubEvent(tx, {
          plateRequirementId: id,
          actionType: PLATE_HUB_ACTION.SHOPFLOOR_COLOUR_TOGGLE,
          fromZone: zm.hubZone,
          toZone: zm.hubZone,
          details: {
            message: `${active ? 'Colour restored to burn list' : 'Colour removed from burn list'}: ${label} (${zm.zoneName})`,
            zoneName: zm.zoneName,
            canonicalKey,
            active,
            colourLabel: label,
            activeColourNamesBefore: before,
            activeColourNamesAfter: after,
            requirementCode: row.requirementCode,
          },
        })
      }

      await tx.plateRequirement.update({
        where: { id },
        data: {
          ...(sizeChanging && nextSize !== undefined ? { plateSize: nextSize } : {}),
          ...(toggling ? { coloursNeeded: coloursNeeded as object[] } : {}),
          lastStatusUpdatedAt: new Date(),
        },
      })
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === 'COLOUR_NOT_FOUND') {
      return NextResponse.json({ error: 'Colour channel not found on this job' }, { status: 400 })
    }
    if (msg === 'LAST_COLOUR') {
      return NextResponse.json(
        { error: 'At least one colour must stay active for burning' },
        { status: 400 },
      )
    }
    console.error('[shopfloor-spec]', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  const fresh = await db.plateRequirement.findUnique({ where: { id } })
  if (!fresh) return NextResponse.json({ error: 'Lost requirement' }, { status: 500 })

  return NextResponse.json({
    ok: true,
    ...jsonSnapshot(fresh),
  })
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const row = await db.plateRequirement.findUnique({ where: { id } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(jsonSnapshot(row))
}
