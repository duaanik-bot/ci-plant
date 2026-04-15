import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { triggerEmbossVendorOrder } from '@/lib/emboss-engine'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  cartonName: z.string().optional().nullable(),
  blockType: z.string().optional().nullable(),
  embossArea: z.string().optional().nullable(),
  priority: z.string().optional(),
  jobCardId: z.string().optional().nullable(),
})

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error
  const list = await db.embossVendorOrder.findMany({ orderBy: { orderedAt: 'desc' } })
  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const created = await triggerEmbossVendorOrder({
    cartonName: parsed.data.cartonName ?? undefined,
    blockType: parsed.data.blockType ?? undefined,
    embossArea: parsed.data.embossArea ?? undefined,
    priority: parsed.data.priority,
    jobCardId: parsed.data.jobCardId ?? undefined,
    userId: user?.id ?? 'system',
  })
  return NextResponse.json(created, { status: 201 })
}

