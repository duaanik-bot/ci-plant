import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const items = await db.inventory.findMany({
    where: { active: true },
    orderBy: { materialCode: 'asc' },
    select: {
      id: true,
      materialCode: true,
      description: true,
      unit: true,
      qtyQuarantine: true,
      qtyAvailable: true,
      qtyReserved: true,
      qtyFg: true,
      weightedAvgCost: true,
      reorderPoint: true,
    },
  })

  const withValue = items.map((i) => {
    const qq = Number(i.qtyQuarantine)
    const qa = Number(i.qtyAvailable)
    const qr = Number(i.qtyReserved)
    const qf = Number(i.qtyFg)
    const cost = Number(i.weightedAvgCost)
    return {
      id: i.id,
      materialCode: i.materialCode,
      description: i.description,
      unit: i.unit,
      qtyQuarantine: qq,
      qtyAvailable: qa,
      qtyReserved: qr,
      qtyFg: qf,
      reorderPoint: Number(i.reorderPoint),
      valueQuarantine: qq * cost,
      valueAvailable: qa * cost,
      valueReserved: qr * cost,
      valueFg: qf * cost,
    }
  })

  return NextResponse.json(withValue)
}
