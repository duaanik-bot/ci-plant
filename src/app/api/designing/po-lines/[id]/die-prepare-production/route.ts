import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { CUSTODY_IN_STOCK, CUSTODY_PREPARING_FOR_PRODUCTION } from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { dieHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  dyeId: z.string().uuid(),
})

/**
 * POST — Mark a rack die as preparing for production (designing queue → Die Hub),
 * after Smart Match link. Idempotent if already in preparing_for_production.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params
  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'dyeId (uuid) required' }, { status: 400 })
  }
  const { dyeId } = parsed.data

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: { dieMasterId: true, jobCardNumber: true },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  if (line.dieMasterId !== dyeId) {
    return NextResponse.json(
      { error: 'Die is not linked to this PO line — link via Smart Match first.' },
      { status: 409 },
    )
  }

  const dye = await db.dye.findFirst({
    where: { id: dyeId, active: true },
    select: { id: true, dyeNumber: true, custodyStatus: true },
  })
  if (!dye) return NextResponse.json({ error: 'Die not found' }, { status: 404 })

  if (dye.custodyStatus === CUSTODY_PREPARING_FOR_PRODUCTION) {
    return NextResponse.json({ ok: true, custodyStatus: dye.custodyStatus, already: true })
  }

  if (dye.custodyStatus !== CUSTODY_IN_STOCK) {
    return NextResponse.json(
      {
        error: `Only in-stock dies can be pushed from Designing (current: ${dye.custodyStatus}).`,
      },
      { status: 409 },
    )
  }

  const jc = line.jobCardNumber
    ? await db.productionJobCard.findFirst({
        where: { jobCardNumber: line.jobCardNumber },
        select: { id: true, jobCardNumber: true },
      })
    : null

  const actor = user?.name?.trim() || 'Operator'
  const jobRef = jc?.jobCardNumber != null ? String(jc.jobCardNumber) : lineId

  await db.$transaction(async (tx) => {
    await tx.dye.update({
      where: { id: dyeId },
      data: {
        custodyStatus: CUSTODY_PREPARING_FOR_PRODUCTION,
        hubPreviousCustody: CUSTODY_IN_STOCK,
      },
    })
    await createDieHubEvent(tx, {
      dyeId,
      actionType: DIE_HUB_ACTION.PUSH_TO_TRIAGE,
      fromZone: dieHubZoneLabelFromCustody(CUSTODY_IN_STOCK),
      toZone: dieHubZoneLabelFromCustody(CUSTODY_PREPARING_FOR_PRODUCTION),
      actorName: actor,
      details: {
        message: `Die #${dye.dyeNumber} reserved for Job ${jobRef} by ${actor}.`,
        status: 'RESERVED_FOR_JOB',
        poLineId: lineId,
        jobCardId: jc?.id ?? null,
        jobCardNumber: jc?.jobCardNumber ?? null,
        dyeNumber: dye.dyeNumber,
      },
    })
  })

  return NextResponse.json({ ok: true, custodyStatus: CUSTODY_PREPARING_FOR_PRODUCTION })
}
