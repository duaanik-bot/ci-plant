import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { CUSTODY_AT_VENDOR } from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { dieHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'
import {
  normalizeDieMake,
  parseCartonSizeToDims,
  prismaDimsFromParsed,
} from '@/lib/die-hub-dimensions'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  dyeNumber: z.coerce.number().int().min(1),
  cartonSize: z.string().min(1).max(120),
  sheetSize: z.string().max(80).optional(),
  ups: z.coerce.number().int().min(1).max(64).optional(),
  dieMaterial: z.string().max(80).optional(),
  dyeType: z.string().max(80).optional(),
  pastingType: z.string().max(64).optional().nullable(),
  dieMake: z.enum(['local', 'laser']).optional(),
})

/** Create / upsert die row and place in Outside Vendor lane for Die Hub. */
export async function POST(req: NextRequest) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const { dyeNumber, cartonSize, sheetSize, ups, dieMaterial, dyeType, pastingType, dieMake } =
      parsed.data
    const existing = await db.dye.findUnique({ where: { dyeNumber } })
    if (existing) {
      return NextResponse.json(
        { error: `Dye number ${dyeNumber} already exists — use inventory to manage it.` },
        { status: 409 },
      )
    }

    const dims = prismaDimsFromParsed(parseCartonSizeToDims(cartonSize))
    const row = await db.$transaction(async (tx) => {
      const created = await tx.dye.create({
        data: {
          dyeNumber,
          dyeType: dyeType?.trim() || dieMaterial?.trim() || 'Laser',
          ups: ups ?? 1,
          sheetSize: sheetSize?.trim() || 'Standard',
          cartonSize: cartonSize.trim(),
          dieMaterial: dieMaterial?.trim() || null,
          custodyStatus: CUSTODY_AT_VENDOR,
          pastingType: pastingType?.trim() || null,
          dieMake: normalizeDieMake(dieMake),
          ...(dims ?? {}),
        },
      })
      await createDieHubEvent(tx, {
        dyeId: created.id,
        actionType: DIE_HUB_ACTION.MANUAL_VENDOR_CREATE,
        fromZone: 'Manual entry',
        toZone: dieHubZoneLabelFromCustody(CUSTODY_AT_VENDOR),
        details: {
          displayCode: `DYE-${created.dyeNumber}`,
          dyeNumber: created.dyeNumber,
        },
      })
      return created
    })

    await createAuditLog({
      userId: user!.id,
      action: 'INSERT',
      tableName: 'dyes',
      recordId: row.id,
      newValue: { manualVendorHub: true, dyeNumber },
    })

    return NextResponse.json({ ok: true, id: row.id })
  } catch (e) {
    console.error('[tooling-hub/dies/manual-vendor]', e)
    return NextResponse.json({ error: 'Create failed' }, { status: 500 })
  }
}
