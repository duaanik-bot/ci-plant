import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  fields: z.array(z.string().min(1)).min(1),
})

/** POST — Compliance: log when user overrides Smart Match auto-filled values. */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'fields (non-empty array) required' }, { status: 400 })
  }

  const actor = user?.name?.trim() || 'Operator'
  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: lineId,
    newValue: {
      smartMatchOverride: true,
      message: `Manual Data Entry by ${actor}`,
      fields: parsed.data.fields,
    },
  })

  return NextResponse.json({ ok: true })
}
