import { NextRequest, NextResponse } from 'next/server'
import { unstable_cache, revalidateTag } from 'next/cache'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const DISPATCH_TAG = 'dispatch-queue'
const JOB_CARDS_TAG = 'job-cards'

const createDispatchSchema = z.object({
  // Either jobCardId (production flow, new) or legacy jobId must be supplied.
  jobCardId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  qtyDispatched: z.number().int().positive(),
  vehicleNumber: z.string().max(30).optional(),
  driverName: z.string().max(80).optional(),
  ewayBillNumber: z.string().max(30).optional(),
  ewayBillExpiry: z.string().optional(), // ISO date
  createDraftBill: z.boolean().optional(),
})

function nextBillNumber(lastBill: { billNumber: string } | null): string {
  const year = new Date().getFullYear()
  const prefix = `CI-BILL-${year}-`
  const lastSeq = lastBill ? parseInt(lastBill.billNumber.replace(prefix, ''), 10) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

async function fetchDispatchQueue() {
  // Dispatch queue = ProductionJobCards whose terminal Pasting stage is completed.
  // Dispatched and POD-received rows stay in the list (sorted to the end on the client)
  // so they remain trackable; the row's existingDispatch.status drives the UI state.
  const jobCards = await db.productionJobCard.findMany({
    where: {
      stages: {
        some: { stageName: 'Pasting', status: 'completed' },
      },
    },
    include: {
      customer: { select: { id: true, name: true } },
      stages: {
        where: { stageName: 'Pasting' },
        select: { id: true, status: true, counter: true, completedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      dispatches: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { jobDate: 'asc' },
  })

  const ready = jobCards.map((jc) => {
    const pasting = jc.stages[0]
    const qtyProducedGood = pasting?.counter ?? 0
    const latestDispatch = jc.dispatches[0] ?? null
    return {
      jobCardId: jc.id,
      jobNumber: `JC-${jc.jobCardNumber}`,
      customerId: jc.customer.id,
      customerName: jc.customer.name,
      // ProductionJobCard does not carry a productName; surface the set number as a label.
      productName: jc.setNumber ?? `Job Card ${jc.jobCardNumber}`,
      qtyOrdered: jc.totalSheets,
      qtyProducedGood,
      status: jc.status,
      dueDate: jc.jobDate.toISOString(),
      existingDispatch: latestDispatch
        ? {
            id: latestDispatch.id,
            status: latestDispatch.status,
            qtyDispatched: latestDispatch.qtyDispatched,
            vehicleNumber: latestDispatch.vehicleNumber,
            driverName: latestDispatch.driverName,
            ewayBillNumber: latestDispatch.ewayBillNumber,
            ewayBillExpiry: latestDispatch.ewayBillExpiry?.toISOString() ?? null,
            dispatchedAt: latestDispatch.dispatchedAt?.toISOString() ?? null,
            podReceivedAt: latestDispatch.podReceivedAt?.toISOString() ?? null,
          }
        : null,
    }
  })

  return ready
}

const fetchDispatchQueueCached = unstable_cache(
  fetchDispatchQueue,
  ['dispatch-queue-v1'],
  { revalidate: 10, tags: [DISPATCH_TAG] },
)

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error
  const ready = await fetchDispatchQueueCached()
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

  const { jobCardId, jobId, qtyDispatched, vehicleNumber, driverName, ewayBillNumber, ewayBillExpiry, createDraftBill } =
    parsed.data

  if (!jobCardId && !jobId) {
    return NextResponse.json(
      { error: 'jobCardId or jobId is required' },
      { status: 400 },
    )
  }

  // Resolve customer + descriptor for an optional draft bill alongside dispatch.
  let billSource:
    | { customerId: string; label: string; product: string }
    | null = null

  if (jobCardId) {
    const jc = await db.productionJobCard.findUnique({
      where: { id: jobCardId },
      select: { id: true, customerId: true, jobCardNumber: true, setNumber: true },
    })
    if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })
    billSource = {
      customerId: jc.customerId,
      label: `JC-${jc.jobCardNumber}`,
      product: jc.setNumber ?? 'Dispatch',
    }
  } else if (jobId) {
    const job = await db.job.findUnique({
      where: { id: jobId },
      select: { id: true, customerId: true, jobNumber: true, productName: true },
    })
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    billSource = {
      customerId: job.customerId,
      label: job.jobNumber,
      product: job.productName ?? 'Dispatch',
    }
  }

  const dispatchedAt = new Date()

  let draftBill: { id: string; billNumber: string } | null = null

  const dispatch = await db.$transaction(async (tx) => {
    const d = await tx.dispatch.create({
      data: {
        jobId: jobId ?? null,
        productionJobCardId: jobCardId ?? null,
        qtyDispatched,
        vehicleNumber: vehicleNumber ?? null,
        driverName: driverName ?? null,
        ewayBillNumber: ewayBillNumber ?? null,
        ewayBillExpiry: ewayBillExpiry ? new Date(ewayBillExpiry) : null,
        status: 'dispatched',
        dispatchedAt,
      },
    })

    if (jobCardId) {
      await tx.productionJobCard.update({
        where: { id: jobCardId },
        data: { status: 'dispatched' },
      })
    } else if (jobId) {
      await tx.job.update({
        where: { id: jobId },
        data: { status: 'dispatched' },
      })
    }

    if (createDraftBill && billSource) {
      const lastBill = await tx.bill.findFirst({
        where: { billNumber: { startsWith: `CI-BILL-${new Date().getFullYear()}-` } },
        orderBy: { billNumber: 'desc' },
        select: { billNumber: true },
      })
      const billNumber = nextBillNumber(lastBill)
      const b = await tx.bill.create({
        data: {
          billNumber,
          customerId: billSource.customerId,
          billDate: new Date(),
          subtotal: 0,
          gstAmount: 0,
          totalAmount: 0,
          status: 'draft',
          createdBy: user!.id,
        },
      })
      await tx.billLineItem.create({
        data: {
          billId: b.id,
          jobCardId: jobCardId ?? undefined,
          description: `${billSource.label} – ${billSource.product}`,
          quantity: qtyDispatched,
          rate: 0,
          gstPct: 12,
          amount: 0,
        },
      })
      draftBill = { id: b.id, billNumber: b.billNumber }
    }

    return d
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'dispatches',
    recordId: dispatch.id,
    newValue: { jobCardId: jobCardId ?? null, jobId: jobId ?? null, qtyDispatched, status: dispatch.status, draftBillId: draftBill?.id ?? null },
  })

  revalidateTag(DISPATCH_TAG)
  revalidateTag(JOB_CARDS_TAG)
  return NextResponse.json(
    {
      ...dispatch,
      draftBillId: draftBill?.id ?? null,
      draftBillNumber: draftBill?.billNumber ?? null,
    },
    { status: 201 },
  )
}
