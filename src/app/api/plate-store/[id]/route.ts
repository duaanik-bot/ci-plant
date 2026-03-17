import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  storageLocation: z.string().optional().nullable(),
  storageNotes: z.string().optional().nullable(),
  status: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const plate = await db.plateStore.findUnique({
    where: { id },
    include: { customer: { select: { id: true, name: true } } },
  })
  if (!plate) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(plate)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.plateStore.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const updated = await db.plateStore.update({
    where: { id },
    data: {
      ...(parsed.data.storageLocation !== undefined
        ? { storageLocation: parsed.data.storageLocation }
        : {}),
      ...(parsed.data.storageNotes !== undefined
        ? { storageNotes: parsed.data.storageNotes }
        : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: id,
    oldValue: {
      storageLocation: existing.storageLocation,
      status: existing.status,
    },
    newValue: {
      storageLocation: updated.storageLocation,
      status: updated.status,
    },
  })

  return NextResponse.json(updated)
}
