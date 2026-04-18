import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAuditLog, requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  query: z.string().min(2).max(200),
})

const DEEP_AUDIT_SIGNATURE = 'Deep Audit Performed by Anik Dua.'

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_orders_deep_filter',
    recordId: undefined,
    newValue: {
      signature: DEEP_AUDIT_SIGNATURE,
      message: DEEP_AUDIT_SIGNATURE,
      query: parsed.data.query.trim(),
      source: 'customer_po_spotlight_filter',
    },
  })

  return NextResponse.json({ ok: true })
}
