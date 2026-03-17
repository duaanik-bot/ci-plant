import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  materialId: z.string().uuid(),
  qtyRequired: z.number().positive(),
  estimatedValue: z.number().min(0).optional(),
  triggerReason: z.string().min(1),
  supplierId: z.string().uuid().optional(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const materialId = searchParams.get('materialId')

  const where: { status?: string; materialId?: string } = {}
  if (status) where.status = status
  if (materialId) where.materialId = materialId

  const list = await db.purchaseRequisition.findMany({
    where,
    orderBy: { raisedAt: 'desc' },
    include: {
      material: { select: { materialCode: true, description: true, unit: true } },
    },
  })

  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = createSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { materialId, qtyRequired, triggerReason, supplierId } = parsed.data
  const estimatedValue = parsed.data.estimatedValue ?? 0

  const inv = await db.inventory.findUnique({ where: { id: materialId } })
  if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const pr = await db.purchaseRequisition.create({
    data: {
      materialId,
      qtyRequired,
      estimatedValue,
      triggerReason,
      raisedBy: user!.id,
      supplierId: supplierId ?? inv.supplierId ?? undefined,
    },
    include: {
      material: { select: { materialCode: true, description: true, unit: true } },
    },
  })

  return NextResponse.json(pr)
}
