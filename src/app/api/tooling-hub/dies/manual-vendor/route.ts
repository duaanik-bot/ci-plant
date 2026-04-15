import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { CUSTODY_AT_VENDOR } from '@/lib/inventory-hub-custody'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  dyeNumber: z.coerce.number().int().min(1),
  cartonSize: z.string().min(1).max(120),
  sheetSize: z.string().max(80).optional(),
  ups: z.coerce.number().int().min(1).max(64).optional(),
  dieMaterial: z.string().max(80).optional(),
  dyeType: z.string().max(80).optional(),
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

    const { dyeNumber, cartonSize, sheetSize, ups, dieMaterial, dyeType } = parsed.data
    const existing = await db.dye.findUnique({ where: { dyeNumber } })
    if (existing) {
      return NextResponse.json(
        { error: `Dye number ${dyeNumber} already exists — use inventory to manage it.` },
        { status: 409 },
      )
    }

    const row = await db.dye.create({
      data: {
        dyeNumber,
        dyeType: dyeType?.trim() || dieMaterial?.trim() || 'Laser',
        ups: ups ?? 1,
        sheetSize: sheetSize?.trim() || 'Standard',
        cartonSize: cartonSize.trim(),
        dieMaterial: dieMaterial?.trim() || null,
        custodyStatus: CUSTODY_AT_VENDOR,
      },
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
