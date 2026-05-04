import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createPurchaseRequestFromShortage } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Shortage id is required' }, { status: 400 })

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

    const existingOpenPr = await db.purchaseRequisition.findFirst({
      where: {
        materialId: shortage.materialId,
        status: { in: ['pending', 'approved', 'converted_to_po'] },
      },
      orderBy: { raisedAt: 'desc' },
      select: { id: true, status: true },
    })
    if (existingOpenPr) {
      if (shortage.purchaseReqId !== existingOpenPr.id) {
        await db.materialShortage.update({
          where: { id },
          data: { purchaseReqId: existingOpenPr.id },
        })
      }
      return NextResponse.json({
        success: true,
        shortageId: id,
        purchaseRequestId: existingOpenPr.id,
        reused: true,
        message: 'PR already exists',
      })
    }

    const pr = await createPurchaseRequestFromShortage(id)
    return NextResponse.json({
      success: true,
      shortageId: id,
      purchaseRequestId: pr.id,
      reused: false,
      message: 'PR created',
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to create PR for shortage' },
      { status: 400 },
    )
  }
}
