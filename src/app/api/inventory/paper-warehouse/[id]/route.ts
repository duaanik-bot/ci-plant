import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function DELETE(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireRole('admin', 'plant_head', 'accounts')
  if (error) return error

  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Material id is required' }, { status: 400 })

  const material = await db.inventory.findUnique({
    where: { id },
    select: { id: true, materialCode: true, description: true, active: true },
  })
  if (!material) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const [activeReservations, openShortages, openPrs, movementLogs] = await Promise.all([
    db.materialReservation.count({
      where: { materialId: id, reservedSheets: { gt: 0 } },
    }),
    db.materialShortage.count({
      where: { materialId: id, status: 'open', remainingQty: { gt: 0 } },
    }),
    db.purchaseRequisition.count({
      where: { materialId: id, status: { in: ['pending', 'approved', 'converted_to_po'] } },
    }),
    db.stockMovement.count({
      where: { materialId: id },
    }),
  ])

  if (activeReservations > 0 || openShortages > 0 || openPrs > 0 || movementLogs > 0) {
    return NextResponse.json(
      {
        error:
          'Cannot delete row because it is linked to active records/logs. Clear links first or keep it for audit.',
        links: {
          activeReservations,
          openShortages,
          openPurchaseRequests: openPrs,
          movementLogs,
        },
      },
      { status: 409 },
    )
  }

  await db.inventory.delete({ where: { id } })

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'inventory',
    recordId: material.id,
    oldValue: {
      materialCode: material.materialCode,
      description: material.description,
      active: material.active,
    },
    newValue: { deleted: true },
  })

  return NextResponse.json({ ok: true })
}

