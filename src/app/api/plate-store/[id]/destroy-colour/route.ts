import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'
import { destroyColour } from '@/lib/plate-engine'

export const dynamic = 'force-dynamic'

const destroySchema = z.object({
  colourName: z.string().min(1),
  reason: z.string().min(1),
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

  await destroyColour(id, parsed.data.colourName, parsed.data.reason, parsed.data.destroyedBy)
  const updated = await db.plateStore.findUnique({ where: { id } })
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: id,
    oldValue: { colours: existing.colours },
    newValue: { colours: updated.colours, status: updated.status },
  })

  return NextResponse.json(updated)
}
