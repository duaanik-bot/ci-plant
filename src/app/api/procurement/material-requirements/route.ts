import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  aggregateFromStoredRequirements,
  pickSuggestedBoardSupplier,
  type AggregatedMaterialRequirement,
} from '@/lib/procurement-mrp-service'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const suppliers = await db.supplier.findMany({ where: { active: true } })
  const suggested = pickSuggestedBoardSupplier(suppliers)

  const rows = await db.materialQueue.findMany({
    where: {
      lineItem: {
        materialProcurementStatus: 'pending',
        po: { status: 'confirmed' },
      },
    },
    include: {
      lineItem: true,
      purchaseOrder: { include: { customer: { select: { name: true } } } },
    },
    orderBy: { calculatedAt: 'desc' },
  })

  const flat = rows.map((mr) => ({
    mr,
    line: mr.lineItem,
    po: mr.purchaseOrder,
  }))

  const requirements: AggregatedMaterialRequirement[] = aggregateFromStoredRequirements(flat, suppliers)

  return NextResponse.json({
    requirements,
    suggestedSupplier: suggested ? { id: suggested.id, name: suggested.name } : null,
  })
}
