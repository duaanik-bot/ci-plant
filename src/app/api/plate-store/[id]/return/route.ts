import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { z } from 'zod'
import { returnPlates } from '@/lib/plate-engine'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  issueRecordId: z.string().min(1),
  returnedBy: z.string().min(1),
  colourConditions: z.array(
    z.object({
      name: z.string().min(1),
      condition: z.string().min(1),
      action: z.enum(['store', 'destroy']),
    }),
  ).min(1),
  returnNotes: z.string().optional().default(''),
  rackLocation: z.string().min(1),
})

export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  await returnPlates(
    parsed.data.issueRecordId,
    parsed.data.returnedBy,
    parsed.data.colourConditions.map((c) => ({
      name: c.name,
      condition: c.condition,
      action: c.action,
    })),
    parsed.data.returnNotes,
    parsed.data.rackLocation,
  )

  return NextResponse.json({ ok: true })
}
