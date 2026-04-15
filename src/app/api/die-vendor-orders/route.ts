import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { triggerVendorOrder } from '@/lib/die-engine'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  orderType: z.string().optional(),
  cartonName: z.string().optional().nullable(),
  cartonSize: z.string().min(1),
  dieType: z.string().min(1),
  ups: z.number().int().min(1),
  sheetSize: z.string().min(1),
  priority: z.string().optional(),
  jobCardId: z.string().optional().nullable(),
})

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error
  const list = await db.dieVendorOrder.findMany({ orderBy: { orderedAt: 'desc' } })
  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    ups: body.ups != null ? Number(body.ups) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const created = await triggerVendorOrder({
    cartonName: parsed.data.cartonName ?? undefined,
    cartonSize: parsed.data.cartonSize,
    dieType: parsed.data.dieType,
    ups: parsed.data.ups,
    sheetSize: parsed.data.sheetSize,
    priority: parsed.data.priority,
    jobCardId: parsed.data.jobCardId ?? undefined,
    userId: user?.id ?? 'system',
  })
  return NextResponse.json(created, { status: 201 })
}
