import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createDispatchSchema = z.object({
  jobId: z.string().uuid(),
  qtyDispatched: z.number().int().positive(),
  vehicleNumber: z.string().max(30).optional(),
  driverName: z.string().max(80).optional(),
  ewayBillNumber: z.string().max(30).optional(),
  ewayBillExpiry: z.string().optional(), // ISO date
})

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  // Jobs that are ready for dispatch — proxy for "completed + QA released"
  // We currently treat jobs in packing/final_qc with no completed dispatch as ready.
  const jobs = await db.job.findMany({
    where: {
      status: { in: ['final_qc', 'packing'] },
      dispatches: {
        none: { status: { in: ['dispatched', 'pod_received'] } },
      },
    },
    include: {
      customer: { select: { id: true, name: true } },
      dispatches: true,
    },
    orderBy: { dueDate: 'asc' },
  })

  const ready = jobs.map((job) => ({
    jobId: job.id,
    jobNumber: job.jobNumber,
    customerId: job.customer.id,
    customerName: job.customer.name,
    status: job.status,
    dueDate: job.dueDate,
    existingDispatch: job.dispatches[0] ?? null,
  }))

  return NextResponse.json(ready)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createDispatchSchema.safeParse({
    ...body,
    qtyDispatched:
      body.qtyDispatched != null ? Number(body.qtyDispatched) : undefined,
  })

  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((issue) => {
      const key = issue.path[0]
      if (typeof key === 'string' && !fields[key]) {
        fields[key] = issue.message
      }
    })
    return NextResponse.json(
      { error: 'Validation failed', fields },
      { status: 400 },
    )
  }

  const { jobId, qtyDispatched, vehicleNumber, driverName, ewayBillNumber, ewayBillExpiry } =
    parsed.data

  const job = await db.job.findUnique({ where: { id: jobId } })
  if (!job) {
    return NextResponse.json(
      { error: 'Job not found' },
      { status: 404 },
    )
  }

  const dispatchedAt = new Date()

  const dispatch = await db.dispatch.create({
    data: {
      jobId,
      qtyDispatched,
      vehicleNumber: vehicleNumber ?? null,
      driverName: driverName ?? null,
      ewayBillNumber: ewayBillNumber ?? null,
      ewayBillExpiry: ewayBillExpiry ? new Date(ewayBillExpiry) : null,
      status: 'dispatched',
      dispatchedAt,
    },
  })

  await db.job.update({
    where: { id: jobId },
    data: { status: 'dispatched' },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'dispatches',
    recordId: dispatch.id,
    newValue: { jobId, qtyDispatched, status: dispatch.status },
  })

  return NextResponse.json(dispatch, { status: 201 })
}

