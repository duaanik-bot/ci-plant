import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'
import { logCommunication } from '@/lib/communication-log'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  lineItemIds: z.array(z.string().uuid()).min(1),
  actorLabel: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const actor = parsed.data.actorLabel?.trim() || PROCUREMENT_DEFAULT_SIGNATORY

  const result = await db.poLineItem.updateMany({
    where: {
      id: { in: parsed.data.lineItemIds },
      materialProcurementStatus: { in: ['on_order', 'dispatched', 'paper_ordered'] },
    },
    data: { materialProcurementStatus: 'received' },
  })

  await logCommunication({
    channel: 'system',
    subject: 'Material marked received (factory)',
    bodyPreview: `Lines received: ${parsed.data.lineItemIds.join(', ').slice(0, 500)}`,
    status: 'sent',
    metadata: { lineItemIds: parsed.data.lineItemIds, count: result.count },
    relatedTable: 'po_line_items',
    actorLabel: actor,
    userId: user!.id,
  })

  return NextResponse.json({ updated: result.count })
}
