import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function DELETE(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const pr = await db.purchaseRequisition.findUnique({ where: { id } })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })

  await db.$transaction(async (tx) => {
    if (pr.status === 'converted_to_po') {
      const inv = await tx.inventory.findUnique({
        where: { id: pr.materialId },
        select: { qtyQuarantine: true },
      })
      if (inv) {
        const nextIncoming = Math.max(0, Number(inv.qtyQuarantine) - Number(pr.qtyRequired))
        await tx.inventory.update({
          where: { id: pr.materialId },
          data: { qtyQuarantine: nextIncoming },
        })
      }
    }

    await tx.materialShortage.updateMany({
      where: { purchaseReqId: pr.id },
      data: { purchaseReqId: null },
    })

    await tx.purchaseRequisition.delete({ where: { id: pr.id } })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'purchase_requisitions',
    recordId: pr.id,
    oldValue: {
      status: pr.status,
      materialId: pr.materialId,
      qtyRequired: Number(pr.qtyRequired),
    },
    newValue: { deleted: true },
  })

  return NextResponse.json({ success: true })
}

