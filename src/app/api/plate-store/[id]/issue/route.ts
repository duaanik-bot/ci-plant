import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { z } from 'zod'
import { issuePlates } from '@/lib/plate-engine'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  jobCardId: z.string().min(1),
  issuedTo: z.string().min(1),
  coloursToIssue: z.array(z.string().min(1)).min(1),
  purpose: z.enum(['production', 'reprint', 'sample', 'proof']).optional(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const jc = await db.productionJobCard.findUnique({ where: { id: parsed.data.jobCardId } })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const issueRecord = await issuePlates(
    id,
    parsed.data.jobCardId,
    jc.jobCardNumber,
    parsed.data.issuedTo,
    user!.id,
    parsed.data.coloursToIssue,
    { purpose: parsed.data.purpose },
  )

  const plate = await db.plateStore.findUnique({ where: { id } })
  return NextResponse.json({ plate, issueRecord })
}
