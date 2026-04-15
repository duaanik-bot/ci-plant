import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { PlateSize } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { generateRequirementCode } from '@/lib/plate-engine'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  cartonId: z.string().uuid(),
  plateSize: z.nativeEnum(PlateSize),
  stdC: z.boolean(),
  stdM: z.boolean(),
  stdY: z.boolean(),
  stdK: z.boolean(),
  pantoneOn: z.boolean(),
  pantoneCount: z.coerce.number().int().min(1).max(12).optional(),
})

function buildColours(
  stdC: boolean,
  stdM: boolean,
  stdY: boolean,
  stdK: boolean,
  pantoneOn: boolean,
  pantoneCount: number,
): { name: string; isNew: boolean }[] {
  const out: { name: string; isNew: boolean }[] = []
  if (stdC) out.push({ name: 'Cyan', isNew: true })
  if (stdM) out.push({ name: 'Magenta', isNew: true })
  if (stdY) out.push({ name: 'Yellow', isNew: true })
  if (stdK) out.push({ name: 'Black', isNew: true })
  if (pantoneOn) {
    const n = Math.min(12, Math.max(1, pantoneCount))
    for (let i = 1; i <= n; i += 1) out.push({ name: `Pantone ${i}`, isNew: true })
  }
  return out
}

/** Bypass triage: create a CTP-internal queue requirement from carton + colour picks. */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { cartonId, plateSize, stdC, stdM, stdY, stdK, pantoneOn, pantoneCount } = parsed.data
  const coloursNeeded = buildColours(
    stdC,
    stdM,
    stdY,
    stdK,
    pantoneOn,
    pantoneCount ?? 1,
  )
  if (coloursNeeded.length === 0) {
    return NextResponse.json({ error: 'Select at least one colour' }, { status: 400 })
  }

  const carton = await db.carton.findUnique({
    where: { id: cartonId },
    select: {
      cartonName: true,
      artworkCode: true,
      customerId: true,
    },
  })
  if (!carton) return NextResponse.json({ error: 'Carton not found' }, { status: 404 })

  const requirementCode = await generateRequirementCode(db)
  const n = coloursNeeded.length

  const created = await db.plateRequirement.create({
    data: {
      requirementCode,
      jobCardId: null,
      cartonName: carton.cartonName,
      artworkCode: carton.artworkCode?.trim() || null,
      artworkVersion: null,
      customerId: carton.customerId,
      numberOfColours: n,
      coloursNeeded,
      newPlatesNeeded: n,
      oldPlatesAvailable: 0,
      status: 'ctp_internal_queue',
      triageChannel: 'inhouse_ctp',
      poLineId: null,
      partialRemake: false,
      createdBy: user!.id,
      plateSize,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'plate_requirements',
    recordId: created.id,
    newValue: { requirementCode, manualCtp: true },
  })

  return NextResponse.json({ ok: true, requirement: created })
}
