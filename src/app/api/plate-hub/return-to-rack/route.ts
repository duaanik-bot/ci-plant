import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { plateScrapReasonLabel } from '@/lib/plate-scrap-reasons'
export const dynamic = 'force-dynamic'

const firstOriginSchema = z.enum(['inhouse_ctp', 'outside_vendor', 'legacy_unknown'])

const bodySchema = z.object({
  plateStoreId: z.string().uuid(),
  returnedColourNames: z.array(z.string().min(1)).min(1),
  firstOrigin: firstOriginSchema,
})

type ColourRow = {
  name?: string
  type?: string
  status?: string
  scrapReasonCode?: string
  scrappedAt?: string
  reuseCount?: number
  firstOrigin?: string
  lastReturnAt?: string
}

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

/** Custody → rack: reuse increment + origin on returned channels; scrap omitted channels (single transaction). */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { plateStoreId, returnedColourNames, firstOrigin } = parsed.data
  const returnedSet = new Set(returnedColourNames.map((n) => n.trim().toLowerCase()).filter(Boolean))
  if (returnedSet.size === 0) {
    return NextResponse.json({ error: 'Select at least one plate returning to rack' }, { status: 400 })
  }

  const plate = await db.plateStore.findUnique({ where: { id: plateStoreId } })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })
  if (plate.status !== 'READY_ON_FLOOR') {
    return NextResponse.json({ error: 'Only custody floor plates can return to rack' }, { status: 409 })
  }

  const colours = (Array.isArray(plate.colours) ? plate.colours : []) as ColourRow[]
  const activeRows = colours.filter((c) => String(c?.status ?? '').toLowerCase() !== 'destroyed')
  const activeNames = activeRows
    .map((c) => String(c?.name ?? '').trim())
    .filter(Boolean)
  const activeLower = new Set(activeNames.map((n) => n.toLowerCase()))

  for (const r of Array.from(returnedSet)) {
    if (!activeLower.has(r)) {
      return NextResponse.json(
        { error: `Not an active channel on this set: ${returnedColourNames.find((n) => n.trim().toLowerCase() === r) ?? r}` },
        { status: 400 },
      )
    }
  }

  const nowIso = new Date().toISOString()
  const scrapReasonCode = 'custody_not_returned' as const
  const scrapReasonLabel = plateScrapReasonLabel(scrapReasonCode)
  const omittedNames: string[] = []

  const nextColours = colours.map((row) => {
    const name = String(row?.name ?? '').trim()
    const st = String(row?.status ?? '').toLowerCase()
    if (!name || st === 'destroyed') return row

    if (!returnedSet.has(name.toLowerCase())) {
      omittedNames.push(name)
      return {
        ...row,
        status: 'destroyed',
        scrapReasonCode,
        scrappedAt: nowIso,
      }
    }

    const prevReuse = Math.max(0, Math.floor(Number(row.reuseCount) || 0))
    return {
      ...row,
      reuseCount: prevReuse + 1,
      firstOrigin,
      lastReturnAt: nowIso,
    }
  })

  const { numberOfColours, totalPlates, newPlates, oldPlates } = recountPlateMetrics(nextColours)
  const fullyGone = numberOfColours === 0
  const prevStatus =
    String(plate.hubPreviousStatus ?? '').trim() && ['ready', 'returned', 'in_stock'].includes(String(plate.hubPreviousStatus))
      ? String(plate.hubPreviousStatus)
      : 'ready'

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateStore.update({
      where: { id: plateStoreId },
      data: {
        colours: nextColours as object[],
        numberOfColours,
        totalPlates,
        newPlates,
        oldPlates,
        status: fullyGone ? 'destroyed' : prevStatus,
        ...(fullyGone
          ? {
              destroyedAt: new Date(),
              destroyedBy: user!.id,
              destroyedReason: `Custody return — all channels removed (${omittedNames.join(', ')})`,
              hubCustodySource: null,
              hubPreviousStatus: null,
            }
          : {
              hubCustodySource: null,
              hubPreviousStatus: null,
              issuedTo: null,
              issuedAt: null,
            }),
        lastStatusUpdatedAt: new Date(),
        ...(fullyGone
          ? {}
          : {
              destroyedAt: null,
              destroyedBy: null,
              destroyedReason: null,
            }),
      },
    })

    if (omittedNames.length > 0) {
      await tx.plateStoreScrapEvent.create({
        data: {
          plateStoreId,
          scrappedNames: omittedNames,
          reasonCode: scrapReasonCode,
          reasonLabel: scrapReasonLabel,
          performedBy: user!.id,
        },
      })
    }

    return u
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: plateStoreId,
    newValue: {
      returnToRack: true,
      returnedColourNames,
      firstOrigin,
      omittedToScrap: omittedNames,
      fullyDestroyed: fullyGone,
      returnedAt: nowIso,
    },
  })

  return NextResponse.json({ ok: true, plate: updated })
}
