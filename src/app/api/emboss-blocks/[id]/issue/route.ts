import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { issueEmbossBlock } from '@/lib/emboss-engine'

export const dynamic = 'force-dynamic'

const schema = z.object({
  jobCardId: z.string().min(1),
  jobCardNumber: z.number().int().min(1),
  machineCode: z.string().min(1),
  issuedTo: z.string().min(1),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse({
    ...body,
    jobCardNumber: body.jobCardNumber != null ? Number(body.jobCardNumber) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const rec = await issueEmbossBlock(
    id,
    parsed.data.jobCardId,
    parsed.data.jobCardNumber,
    parsed.data.machineCode,
    parsed.data.issuedTo,
    user?.id ?? 'system',
  )
  return NextResponse.json(rec)
}

