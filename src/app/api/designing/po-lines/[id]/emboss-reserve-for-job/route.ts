import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { CUSTODY_IN_STOCK, CUSTODY_PREPARING_FOR_PRODUCTION } from '@/lib/inventory-hub-custody'
import { createEmbossHubEvent, EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import { embossHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  blockId: z.string().uuid(),
})

/**
 * POST — Reserve in-stock emboss block for this PO line (Reserved for Job).
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'blockId (uuid) required' }, { status: 400 })
  }
  const { blockId } = parsed.data

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: { jobCardNumber: true, cartonId: true },
  })
  if (!line?.cartonId) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const carton = await db.carton.findUnique({
    where: { id: line.cartonId },
    select: { embossBlockId: true },
  })
  if (carton?.embossBlockId !== blockId) {
    return NextResponse.json(
      { error: 'Emboss block is not linked to this line’s product master.' },
      { status: 409 },
    )
  }

  const block = await db.embossBlock.findFirst({
    where: { id: blockId, active: true },
    select: { id: true, blockCode: true, custodyStatus: true },
  })
  if (!block) return NextResponse.json({ error: 'Emboss block not found' }, { status: 404 })

  if (block.custodyStatus === CUSTODY_PREPARING_FOR_PRODUCTION) {
    return NextResponse.json({ ok: true, custodyStatus: block.custodyStatus, already: true })
  }

  if (block.custodyStatus !== CUSTODY_IN_STOCK) {
    return NextResponse.json(
      {
        error: `Only in-stock blocks can be reserved from Designing (current: ${block.custodyStatus}).`,
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
    await tx.embossBlock.update({
      where: { id: blockId },
      data: {
        custodyStatus: CUSTODY_PREPARING_FOR_PRODUCTION,
        hubPreviousCustody: CUSTODY_IN_STOCK,
      },
    })
    await createEmbossHubEvent(tx, {
      blockId,
      actionType: EMBOSS_HUB_ACTION.PUSH_TO_TRIAGE,
      fromZone: embossHubZoneLabelFromCustody(CUSTODY_IN_STOCK),
      toZone: embossHubZoneLabelFromCustody(CUSTODY_PREPARING_FOR_PRODUCTION),
      details: {
        message: `Emboss block ${block.blockCode} reserved for Job ${jobRef} by ${actor}.`,
        status: 'RESERVED_FOR_JOB',
        poLineId: lineId,
        jobCardId: jc?.id ?? null,
        jobCardNumber: jc?.jobCardNumber ?? null,
      },
    })
  })

  return NextResponse.json({ ok: true, custodyStatus: CUSTODY_PREPARING_FOR_PRODUCTION })
}
