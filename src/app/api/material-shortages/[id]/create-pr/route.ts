import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createPurchaseRequestFromShortage } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

type PrOverrideBody = {
  boardType?: string | null
  gsm?: number | null
  sizeLabel?: string | null
  qtyRequired?: number | null
  requiredByDate?: string | null
  remarks?: string | null
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Shortage id is required' }, { status: 400 })
  const body = (await req.json().catch(() => ({}))) as PrOverrideBody

  try {
    const shortage = await db.materialShortage.findUnique({
      where: { id },
      select: { id: true, materialId: true, purchaseReqId: true, remainingQty: true, status: true },
    })
    if (!shortage) {
      return NextResponse.json({ error: 'Shortage not found' }, { status: 404 })
    }
    if (Number(shortage.remainingQty || 0) <= 0 || shortage.status === 'closed') {
      return NextResponse.json({ error: 'No open shortage for this material' }, { status: 400 })
    }

    const pr = await createPurchaseRequestFromShortage(id)
    const updateData: Record<string, unknown> = {}
    if (typeof body.boardType === 'string' || body.boardType === null) updateData.boardType = body.boardType || null
    if (typeof body.gsm === 'number' || body.gsm === null) updateData.gsm = body.gsm || null
    if (typeof body.sizeLabel === 'string' || body.sizeLabel === null) updateData.sizeLabel = body.sizeLabel || null
    if (typeof body.qtyRequired === 'number' && Number.isFinite(body.qtyRequired) && body.qtyRequired > 0) {
      updateData.qtyRequired = Math.floor(body.qtyRequired)
    }
    if (typeof body.requiredByDate === 'string' || body.requiredByDate === null) {
      updateData.requiredByDate = body.requiredByDate ? new Date(body.requiredByDate) : null
    }
    if (typeof body.remarks === 'string' || body.remarks === null) updateData.remarks = body.remarks || null
    const finalPr =
      pr.status === 'pending' && Object.keys(updateData).length > 0
        ? await db.purchaseRequisition.update({ where: { id: pr.id }, data: updateData })
        : pr
    return NextResponse.json({
      success: true,
      shortageId: id,
      purchaseRequestId: finalPr.id,
      reused: shortage.purchaseReqId === finalPr.id,
      message: shortage.purchaseReqId === pr.id ? 'PR already exists' : 'PR created',
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to create PR for shortage' },
      { status: 400 },
    )
  }
}
