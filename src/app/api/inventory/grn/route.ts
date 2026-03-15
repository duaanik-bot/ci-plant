import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

const bodySchema = z.object({
  materialId: z.string().uuid(),
  qty: z.number().positive(),
  lotNumber: z.string().optional(),
  costPerUnit: z.number().min(0).optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole(
    'stores',
    'production_manager',
    'operations_head',
    'md'
  )
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { materialId, qty, lotNumber, costPerUnit } = parsed.data

  const inv = await db.inventory.findUnique({ where: { id: materialId } })
  if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  await db.inventory.update({
    where: { id: materialId },
    data: {
      qtyQuarantine: { increment: qty },
      ...(costPerUnit != null && costPerUnit > 0
        ? {
            weightedAvgCost: inv.weightedAvgCost
              ? (Number(inv.weightedAvgCost) * Number(inv.qtyQuarantine) + costPerUnit * qty) /
                (Number(inv.qtyQuarantine) + qty)
              : costPerUnit,
          }
        : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'inventory',
    recordId: materialId,
    newValue: { grn: true, qty, lotNumber },
  })

  return NextResponse.json({
    success: true,
    message: `${qty} ${inv.unit} received into quarantine for ${inv.materialCode}.`,
  })
}
