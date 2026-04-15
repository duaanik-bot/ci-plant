import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { CUSTODY_HUB_ENGRAVING_QUEUE } from '@/lib/inventory-hub-custody'
import { createEmbossHubEvent, EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import { embossHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  blockCode: z.string().min(1).max(64),
  blockType: z.string().min(1).max(120),
  blockMaterial: z.string().max(80).optional(),
  blockSize: z.string().max(120).optional(),
})

/** Create emboss block in in-house engraving queue. */
export async function POST(req: NextRequest) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const { blockCode, blockType, blockMaterial, blockSize } = parsed.data
    const code = blockCode.trim().toUpperCase()
    const clash = await db.embossBlock.findUnique({ where: { blockCode: code } })
    if (clash) {
      return NextResponse.json({ error: `Block code ${code} already exists` }, { status: 409 })
    }

    const row = await db.$transaction(async (tx) => {
      const created = await tx.embossBlock.create({
        data: {
          blockCode: code,
          blockType: blockType.trim(),
          blockMaterial: blockMaterial?.trim() || 'Magnesium',
          blockSize: blockSize?.trim() || null,
          custodyStatus: CUSTODY_HUB_ENGRAVING_QUEUE,
        },
      })
      await createEmbossHubEvent(tx, {
        blockId: created.id,
        actionType: EMBOSS_HUB_ACTION.MANUAL_ENGRAVING_CREATE,
        fromZone: 'Manual entry',
        toZone: embossHubZoneLabelFromCustody(CUSTODY_HUB_ENGRAVING_QUEUE),
        details: { displayCode: created.blockCode },
      })
      return created
    })

    await createAuditLog({
      userId: user!.id,
      action: 'INSERT',
      tableName: 'emboss_blocks',
      recordId: row.id,
      newValue: { manualEngravingHub: true, blockCode: code },
    })

    return NextResponse.json({ ok: true, id: row.id })
  } catch (e) {
    console.error('[tooling-hub/emboss/manual-queue]', e)
    return NextResponse.json({ error: 'Create failed' }, { status: 500 })
  }
}
