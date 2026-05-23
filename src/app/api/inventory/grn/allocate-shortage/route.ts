import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/helpers'
import { allocateGRNToShortage } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  grnId: z.string().uuid(),
  shortageId: z.string().uuid(),
})

export async function POST(req: NextRequest) {
  const { error } = await requireRole('admin', 'plant_head', 'accounts')
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const out = await allocateGRNToShortage(parsed.data.grnId, parsed.data.shortageId)
    return NextResponse.json({ success: true, ...out })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Allocation failed' },
      { status: 400 },
    )
  }
}
