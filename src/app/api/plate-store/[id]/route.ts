import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  rackLocation: z.string().optional().nullable(),
  slotNumber: z.string().optional().nullable(),
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
    include: {
      customer: { select: { id: true, name: true } },
    },
  })
  if (!plate) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [issueLogCandidates, auditLog] = await Promise.all([
    db.auditLog.findMany({
      where: { tableName: 'plate_store_issue' },
      orderBy: { timestamp: 'desc' },
      take: 120,
    }),
    db.auditLog.findMany({
      where: { tableName: 'plate_store', recordId: id },
      orderBy: { timestamp: 'desc' },
      take: 50,
    }),
  ])
  const issueRecords = issueLogCandidates.filter((row) => {
    const v = row.newValue as Record<string, unknown> | null | undefined
    return v != null && String(v.plateStoreId ?? '') === id
  })

  return NextResponse.json({ ...plate, issueRecords, auditLog })
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
      ...(parsed.data.rackLocation !== undefined
        ? { rackLocation: parsed.data.rackLocation }
        : {}),
      ...(parsed.data.slotNumber !== undefined
        ? { slotNumber: parsed.data.slotNumber }
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
      rackLocation: existing.rackLocation,
      status: existing.status,
    },
    newValue: {
      rackLocation: updated.rackLocation,
      status: updated.status,
    },
  })

  return NextResponse.json(updated)
}
