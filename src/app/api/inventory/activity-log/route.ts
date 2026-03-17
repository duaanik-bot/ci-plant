import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const limit = Math.min(Number(searchParams.get('limit')) || 20, 100)

  const movements = await db.stockMovement.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      material: { select: { materialCode: true, description: true, unit: true } },
    },
  })

  const list = movements.map((m) => ({
    id: m.id,
    materialCode: m.material.materialCode,
    materialDescription: m.material.description,
    unit: m.material.unit,
    movementType: m.movementType,
    qty: Number(m.qty),
    refType: m.refType,
    refId: m.refId,
    userId: m.userId,
    createdAt: m.createdAt.toISOString(),
  }))

  return NextResponse.json(list)
}
