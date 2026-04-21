import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { get_allocated_stock_dims, applyAllocatedStockToJobCard } from '@/lib/allocated-stock-dims'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  jobCardId: z.string().uuid(),
})

/** Apply FIFO warehouse dimensions + batch pointer to a job card (material handshake). */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'jobCardId (uuid) required' }, { status: 400 })
  }

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: { specOverrides: true },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const target =
    typeof spec.actualSheetSize === 'string' ? spec.actualSheetSize.trim() || null : null

  const stock = await get_allocated_stock_dims(db, { poLineItemId: lineId })
  if (!stock) {
    return NextResponse.json(
      { error: 'No matched warehouse batch for this line (material queue / GSM).' },
      { status: 409 },
    )
  }

  await applyAllocatedStockToJobCard(db, parsed.data.jobCardId, stock, target)

  return NextResponse.json({ ok: true, paperWarehouseId: stock.paperWarehouseId })
}
