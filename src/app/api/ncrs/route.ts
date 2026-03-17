import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  jobId: z.string().uuid(),
  qcRecordId: z.string().uuid().optional().nullable(),
  trigger: z.string().min(1),
  severity: z.enum(['critical', 'major', 'minor']),
  description: z.string().min(1),
  quantityAffected: z.number().int().min(0).optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
  dueDate: z.string().optional().nullable(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const jobId = searchParams.get('jobId')
  const status = searchParams.get('status')

  const where: { jobId?: string; status?: string } = {}
  if (jobId) where.jobId = jobId
  if (status) where.status = status

  const list = await db.ncr.findMany({
    where,
    orderBy: { raisedAt: 'desc' },
    include: {
      job: { select: { id: true, jobNumber: true, productName: true } },
      qcRecord: { select: { id: true, checkType: true, result: true } },
      raiser: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true } },
    },
  })

  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    quantityAffected: body.quantityAffected != null ? Number(body.quantityAffected) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const job = await db.job.findUnique({ where: { id: parsed.data.jobId } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const dueDate = parsed.data.dueDate
    ? new Date(parsed.data.dueDate)
    : new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)

  const ncr = await db.ncr.create({
    data: {
      jobId: parsed.data.jobId,
      qcRecordId: parsed.data.qcRecordId ?? undefined,
      trigger: parsed.data.trigger,
      severity: parsed.data.severity,
      description: parsed.data.description,
      quantityAffected: parsed.data.quantityAffected ?? undefined,
      raisedBy: user!.id,
      assignedTo: parsed.data.assignedTo ?? undefined,
      dueDate,
      status: 'open',
    },
    include: {
      job: { select: { jobNumber: true } },
      raiser: { select: { name: true } },
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'ncrs',
    recordId: ncr.id,
    newValue: { jobId: ncr.jobId, severity: ncr.severity },
  })

  return NextResponse.json(ncr, { status: 201 })
}
