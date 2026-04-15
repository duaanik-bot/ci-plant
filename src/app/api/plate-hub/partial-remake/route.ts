import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { generateRequirementCode } from '@/lib/plate-engine'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  plateStoreId: z.string().uuid(),
  lane: z.enum(['inhouse_ctp', 'outside_vendor']),
  missingColourNames: z.array(z.string().min(1)).min(1),
})

/** Spawn a partial plate requirement for damaged/missing channels; original set stays on rack. */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { plateStoreId, lane, missingColourNames } = parsed.data

  const plate = await db.plateStore.findUnique({ where: { id: plateStoreId } })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })

  const rackOk = ['ready', 'returned', 'in_stock'].includes(plate.status)
  if (!rackOk) {
    return NextResponse.json({ error: 'Plate must be in live inventory' }, { status: 409 })
  }

  const colours = Array.isArray(plate.colours) ? (plate.colours as { name?: string }[]) : []
  const names = new Set(
    colours.map((c) => String(c?.name ?? '').trim().toLowerCase()).filter(Boolean),
  )
  for (const m of missingColourNames) {
    if (!names.has(m.trim().toLowerCase())) {
      return NextResponse.json(
        { error: `Unknown colour on this set: ${m}` },
        { status: 400 },
      )
    }
  }

  const n = missingColourNames.length
  const coloursNeeded = missingColourNames.map((name) => ({ name: name.trim(), isNew: true }))
  const requirementCode = await generateRequirementCode(db)
  const isVendor = lane === 'outside_vendor'

  const created = await db.plateRequirement.create({
    data: {
      requirementCode,
      jobCardId: plate.jobCardId,
      cartonName: plate.cartonName,
      artworkCode: plate.artworkCode,
      artworkVersion: plate.artworkVersion,
      customerId: plate.customerId,
      numberOfColours: n,
      coloursNeeded,
      newPlatesNeeded: n,
      oldPlatesAvailable: 0,
      status: isVendor ? 'awaiting_vendor_delivery' : 'ctp_internal_queue',
      triageChannel: lane,
      poLineId: null,
      partialRemake: true,
      createdBy: user!.id,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'plate_requirements',
    recordId: created.id,
    newValue: { requirementCode, partialRemake: true, sourcePlateStoreId: plateStoreId },
  })

  return NextResponse.json({ ok: true, requirement: created })
}
