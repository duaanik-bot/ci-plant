import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const destroySchema = z.object({
  colourName: z.string().min(1),
  reason: z.enum(['cannot_clean', 'damaged', 'wrong_version', 'obsolete', 'other']),
  reasonDetail: z.string().optional().nullable(),
  destroyedBy: z.string().min(1),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.plateStore.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = destroySchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const colours = { ...(existing.colours as Record<string, string>) }
  if (!(parsed.data.colourName in colours)) {
    return NextResponse.json(
      { error: `Colour "${parsed.data.colourName}" not found in plate set` },
      { status: 400 }
    )
  }
  colours[parsed.data.colourName] = 'destroyed'

  const allDestroyed = Object.values(colours).every((v) => v === 'destroyed')
  const now = new Date()

  const updated = await db.plateStore.update({
    where: { id },
    data: {
      colours: colours as object,
      ...(allDestroyed
        ? {
            status: 'destroyed',
            destroyedReason: parsed.data.reasonDetail ?? parsed.data.reason,
            destroyedBy: parsed.data.destroyedBy,
            destroyedAt: now,
          }
        : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: id,
    oldValue: { colours: existing.colours },
    newValue: { colours: updated.colours, ...(allDestroyed ? { status: 'destroyed' } : {}) },
  })

  return NextResponse.json(updated)
}
