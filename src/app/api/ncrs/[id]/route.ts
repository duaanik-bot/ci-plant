import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  rootCause: z.string().optional().nullable(),
  correctiveAction: z.string().optional().nullable(),
  preventiveAction: z.string().optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  status: z.enum(['open', 'in_progress', 'closed', 'overdue']).optional(),
  closedBy: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const ncr = await db.ncr.findUnique({
    where: { id },
    include: {
      job: { select: { id: true, jobNumber: true, productName: true, customerId: true } },
      qcRecord: true,
      raiser: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true } },
      closer: { select: { id: true, name: true } },
    },
  })
  if (!ncr) return NextResponse.json({ error: 'NCR not found' }, { status: 404 })
  return NextResponse.json(ncr)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.ncr.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'NCR not found' }, { status: 404 })

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

  const data = parsed.data
  const update: Record<string, unknown> = {
    ...(data.rootCause !== undefined ? { rootCause: data.rootCause } : {}),
    ...(data.correctiveAction !== undefined ? { correctiveAction: data.correctiveAction } : {}),
    ...(data.preventiveAction !== undefined ? { preventiveAction: data.preventiveAction } : {}),
    ...(data.assignedTo !== undefined ? { assignedTo: data.assignedTo } : {}),
    ...(data.dueDate !== undefined ? { dueDate: data.dueDate ? new Date(data.dueDate) : null } : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
  }
  if (data.status === 'closed' && user?.id) {
    update.closedBy = user.id
    update.closedAt = new Date()
  }

  const updated = await db.ncr.update({
    where: { id },
    data: update as any,
    include: {
      job: { select: { jobNumber: true } },
      assignee: { select: { name: true } },
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'ncrs',
    recordId: id,
    newValue: data,
  })

  return NextResponse.json(updated)
}
