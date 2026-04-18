import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { computeProductionKitForPo } from '@/lib/production-kit-status'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    select: { id: true, poNumber: true },
  })
  if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 })

  const kit = await computeProductionKitForPo(db, id)
  return NextResponse.json({ poId: po.id, poNumber: po.poNumber, ...kit })
}
