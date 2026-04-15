import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  toolType: z.enum(['DIE', 'BLOCK', 'PLATE']),
  jobId: z.string().min(1),
  artworkId: z.string().optional(),
  source: z.enum(['NEW', 'OLD']),
  requirementCode: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'procurement_requests',
    recordId: parsed.data.jobId,
    newValue: parsed.data as Record<string, unknown>,
  })

  return NextResponse.json({
    ok: true,
    reference: `PR-${Date.now()}`,
    ...parsed.data,
  })
}
