import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { returnEmbossBlock } from '@/lib/emboss-engine'

export const dynamic = 'force-dynamic'

const schema = z.object({
  issueRecordId: z.string().min(1),
  returnedBy: z.string().min(1),
  impressionsThisRun: z.number().int().min(0),
  returnCondition: z.string().min(1),
  actionTaken: z.string().min(1),
  returnNotes: z.string().optional().default(''),
  storageLocation: z.string().min(1),
})

export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse({
    ...body,
    impressionsThisRun: body.impressionsThisRun != null ? Number(body.impressionsThisRun) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  await returnEmbossBlock(
    parsed.data.issueRecordId,
    parsed.data.returnedBy,
    parsed.data.impressionsThisRun,
    parsed.data.returnCondition,
    parsed.data.actionTaken,
    parsed.data.returnNotes,
    parsed.data.storageLocation,
  )
  return NextResponse.json({ ok: true })
}

