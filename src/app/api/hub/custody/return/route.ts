import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { hubCustodyReturnBodySchema } from '@/lib/hub-zod-schemas'
import { safeJsonParse } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

/** Central audit for die/block return-to-rack with impression wear tracking. All writes in one transaction. */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const text = await req.text()
  const raw = safeJsonParse<unknown>(text, {})
  const parsed = hubCustodyReturnBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const flat = parsed.error.flatten()
    return NextResponse.json(
      {
        error: first
          ? `Missing or invalid field: ${first.path.join('.') || 'body'}`
          : 'Validation failed',
        details: flat.fieldErrors,
        formErrors: flat.formErrors,
      },
      { status: 400 },
    )
  }

  const data = parsed.data
  await db.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'INSERT',
        tableName: 'hub_custody_return',
        recordId: data.recordId,
        newValue: {
          toolType: data.toolType,
          impressions: data.impressions,
          rackSlot: data.rackSlot,
          condition: data.condition ?? null,
          setNumber: data.setNumber,
          jobCardId: data.jobCardId,
          artworkId: data.artworkId,
        } as object,
      },
    })
  })

  return NextResponse.json({ ok: true })
}
