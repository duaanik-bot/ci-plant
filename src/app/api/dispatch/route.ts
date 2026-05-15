import { NextRequest, NextResponse } from 'next/server'
import { unstable_cache, revalidateTag } from 'next/cache'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'
import {
  computeAllowedQty,
  computeExcessQty,
  normalizePackingConfig,
  packingTotal,
  readPackingFromJobCard,
  type PackingConfig,
} from '@/lib/dispatch-packing'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

const DISPATCH_TAG = 'dispatch-queue'
const JOB_CARDS_TAG = 'job-cards'
const SHORT_EXCESS_TAG = 'short-excess'

const packingRowSchema = z.object({
  boxes: z.number().int().positive(),
  qtyPerBox: z.number().int().positive(),
})

const createDispatchSchema = z.object({
  // Either jobCardId (production flow, new) or legacy jobId must be supplied.
  jobCardId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  qtyDispatched: z.number().int().positive(),
  vehicleNumber: z.string().max(30).optional(),
  driverName: z.string().max(80).optional(),
  transportMode: z.enum(['Road', 'Air', 'Sea', 'Rail']).optional(),
  transporterName: z.string().max(120).optional(),
  distanceKm: z.number().nonnegative().optional(),
  ewayBillNumber: z.string().max(30).optional(),
  ewayBillExpiry: z.string().optional(), // ISO date
  packingConfig: z.array(packingRowSchema).optional(),
  /// When true the operator has acknowledged dispatching beyond the tolerance band.
  acceptExcessOverride: z.boolean().optional(),
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
        include: {
          poLineItem: {
            select: {
              id: true,
              cartonName: true,
              quantity: true,
              tolerancePct: true,
              rate: true,
              gstPct: true,
              hsnCode: true,
              po: { select: { poNumber: true } },
            },
          },
        },
      },
    },
    orderBy: { jobDate: 'asc' },
  })

  // Resolve a PoLineItem for each job card via jobCardNumber (the legacy join).
  const jcNumbers = Array.from(
    new Set(jobCards.map((jc) => jc.jobCardNumber).filter((n): n is number => n != null)),
  )
  const poLines = jcNumbers.length
    ? await db.poLineItem.findMany({
        where: { jobCardNumber: { in: jcNumbers } },
        select: {
          id: true,
          jobCardNumber: true,
          cartonName: true,
          quantity: true,
          tolerancePct: true,
          rate: true,
          gstPct: true,
          hsnCode: true,
          po: { select: { poNumber: true } },
        },
      })
    : []
  const poLineByJcNum = new Map<number, (typeof poLines)[number]>()
  for (const ln of poLines) {
    if (ln.jobCardNumber != null && !poLineByJcNum.has(ln.jobCardNumber)) {
      poLineByJcNum.set(ln.jobCardNumber, ln)
    }
  }

  const ready = jobCards.map((jc) => {
    const pasting = jc.stages[0]
    const qtyProducedGood = pasting?.counter ?? 0
    const latestDispatch = jc.dispatches[0] ?? null
    const packingFromJc = readPackingFromJobCard(jc.postPressRouting)
    const poLine =
      latestDispatch?.poLineItem ??
      (jc.jobCardNumber != null ? poLineByJcNum.get(jc.jobCardNumber) ?? null : null)

    const poQty = poLine ? Number(poLine.quantity ?? 0) : 0
    const tolerancePct = poLine ? Number(poLine.tolerancePct ?? 2) : 2
    const allowedQty = poQty > 0 ? computeAllowedQty(poQty, tolerancePct) : 0
    const dispatchedSoFar = latestDispatch?.qtyDispatched ?? 0
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
      poLine: poLine
        ? {
            id: poLine.id,
            cartonName: poLine.cartonName,
            poNumber: poLine.po.poNumber,
            poQty,
            tolerancePct,
            allowedQty,
            rate: poLine.rate != null ? Number(poLine.rate) : null,
            gstPct: poLine.gstPct,
            hsnCode: poLine.hsnCode,
          }
        : null,
      // Surface the packing config the pasting operator filled in (if any) so the
      // dispatch drawer can pre-fill its packing editor.
      pastingPackingConfig: packingFromJc,
      // Excess relative to the customer PO line (not the existing dispatch). Drives
      // the tolerance-breach badge on the row.
      breachQty: poQty > 0 ? Math.max(0, qtyProducedGood - allowedQty) : 0,
      dispatchedQty: dispatchedSoFar,
      existingDispatch: latestDispatch
        ? {
            id: latestDispatch.id,
            status: latestDispatch.status,
            qtyDispatched: latestDispatch.qtyDispatched,
            poQtySnapshot: latestDispatch.poQtySnapshot,
            allowedQty: latestDispatch.allowedQty,
            excessQty: latestDispatch.excessQty,
            packingConfig: normalizePackingConfig(latestDispatch.packingConfig),
            totalPackedQty: latestDispatch.totalPackedQty,
            vehicleNumber: latestDispatch.vehicleNumber,
            driverName: latestDispatch.driverName,
            transportMode: latestDispatch.transportMode,
            transporterName: latestDispatch.transporterName,
            distanceKm: latestDispatch.distanceKm != null ? Number(latestDispatch.distanceKm) : null,
            ewayBillNumber: latestDispatch.ewayBillNumber,
            ewayBillExpiry: latestDispatch.ewayBillExpiry?.toISOString() ?? null,
            dispatchedAt: latestDispatch.dispatchedAt?.toISOString() ?? null,
            podReceivedAt: latestDispatch.podReceivedAt?.toISOString() ?? null,
            billingStatus: latestDispatch.billingStatus,
            billId: latestDispatch.billId,
            shortExcessRecordId: latestDispatch.shortExcessRecordId,
          }
        : null,
    }
  })

  return ready
}

const fetchDispatchQueueCached = unstable_cache(
  fetchDispatchQueue,
  ['dispatch-queue-v2'],
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
    distanceKm: body.distanceKm != null ? Number(body.distanceKm) : undefined,
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

  const {
    jobCardId,
    jobId,
    qtyDispatched,
    vehicleNumber,
    driverName,
    transportMode,
    transporterName,
    distanceKm,
    ewayBillNumber,
    ewayBillExpiry,
    packingConfig: packingFromClient,
    acceptExcessOverride,
    createDraftBill,
  } = parsed.data

  if (!jobCardId && !jobId) {
    return NextResponse.json(
      { error: 'jobCardId or jobId is required' },
      { status: 400 },
    )
  }

  // Resolve customer + descriptor for an optional draft bill alongside dispatch,
  // and resolve the PoLineItem so allowed-qty / tolerance / S&E maths can happen.
  let billSource:
    | { customerId: string; label: string; product: string }
    | null = null
  let poLineId: string | null = null
  let poQty: number | null = null
  let tolerancePct: number | null = null
  let allowedQty: number | null = null
  let packingFromJc: PackingConfig = []
  let jcPostPressRouting: unknown = null
  let jcId: string | null = null
  let jcNumber: number | null = null

  if (jobCardId) {
    const jc = await db.productionJobCard.findUnique({
      where: { id: jobCardId },
      select: {
        id: true,
        customerId: true,
        jobCardNumber: true,
        setNumber: true,
        postPressRouting: true,
      },
    })
    if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })
    billSource = {
      customerId: jc.customerId,
      label: `JC-${jc.jobCardNumber}`,
      product: jc.setNumber ?? 'Dispatch',
    }
    jcId = jc.id
    jcNumber = jc.jobCardNumber
    jcPostPressRouting = jc.postPressRouting
    packingFromJc = readPackingFromJobCard(jc.postPressRouting)

    if (jc.jobCardNumber != null) {
      const poLine = await db.poLineItem.findFirst({
        where: { jobCardNumber: jc.jobCardNumber },
        select: { id: true, quantity: true, tolerancePct: true },
      })
      if (poLine) {
        poLineId = poLine.id
        poQty = Number(poLine.quantity)
        tolerancePct = Number(poLine.tolerancePct ?? 2)
        allowedQty = computeAllowedQty(poQty, tolerancePct)
      }
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

  // Resolve packing config: client-provided overrides anything saved by pasting.
  const packing: PackingConfig =
    packingFromClient != null
      ? normalizePackingConfig(packingFromClient)
      : packingFromJc
  const totalPackedQty = packing.length ? packingTotal(packing) : null

  // Tolerance check — block by default, but allow operator override (warn but don't block)
  // per product spec. When over allowed, an S&E record is auto-written.
  const excessQty =
    poQty != null && allowedQty != null ? computeExcessQty(qtyDispatched, allowedQty) : 0
  if (excessQty > 0 && acceptExcessOverride !== true) {
    return NextResponse.json(
      {
        error: 'Dispatch qty exceeds tolerance band',
        breach: {
          poQty,
          tolerancePct,
          allowedQty,
          qtyDispatched,
          excessQty,
        },
      },
      { status: 409 },
    )
  }

  const dispatchedAt = new Date()
  let draftBill: { id: string; billNumber: string } | null = null
  let shortExcessId: string | null = null

  const dispatch = await db.$transaction(async (tx) => {
    const d = await tx.dispatch.create({
      data: {
        jobId: jobId ?? null,
        productionJobCardId: jobCardId ?? null,
        poLineItemId: poLineId,
        qtyDispatched,
        poQtySnapshot: poQty,
        tolerancePctSnapshot: tolerancePct != null ? new Prisma.Decimal(tolerancePct) : null,
        allowedQty,
        excessQty,
        packingConfig: packing as unknown as Prisma.InputJsonValue,
        totalPackedQty,
        vehicleNumber: vehicleNumber ?? null,
        driverName: driverName ?? null,
        transportMode: transportMode ?? null,
        transporterName: transporterName ?? null,
        distanceKm: distanceKm != null ? new Prisma.Decimal(distanceKm) : null,
        ewayBillNumber: ewayBillNumber ?? null,
        ewayBillExpiry: ewayBillExpiry ? new Date(ewayBillExpiry) : null,
        status: 'dispatched',
        dispatchedAt,
      },
    })

    // Auto-write S&E when dispatch exceeded the tolerance band.
    if (poLineId && excessQty > 0) {
      const se = await tx.shortExcessRecord.create({
        data: {
          poLineItemId: poLineId,
          jobCardId: jobCardId ?? null,
          poQty: poQty ?? 0,
          actualQty: qtyDispatched,
          tolerancePct: tolerancePct != null ? new Prisma.Decimal(tolerancePct) : new Prisma.Decimal(2),
          varianceQty: excessQty,
          status: 'open',
          notes: 'Auto-opened by Dispatch (override-with-warning).',
        },
      })
      shortExcessId = se.id
      await tx.dispatch.update({
        where: { id: d.id },
        data: { shortExcessRecordId: se.id },
      })
    }

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
          dispatchId: d.id,
          description: `${billSource.label} – ${billSource.product}`,
          quantity: qtyDispatched,
          rate: 0,
          gstPct: 12,
          taxableAmount: 0,
          amount: 0,
        },
      })
      draftBill = { id: b.id, billNumber: b.billNumber }
      await tx.dispatch.update({
        where: { id: d.id },
        data: { billId: b.id, billingStatus: 'billed' },
      })
    }

    return d
  })

  // Acknowledge to ourselves we used these (silences unused-var TS for the closure capture).
  void jcPostPressRouting
  void jcId
  void jcNumber

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'dispatches',
    recordId: dispatch.id,
    newValue: {
      jobCardId: jobCardId ?? null,
      jobId: jobId ?? null,
      poLineItemId: poLineId,
      qtyDispatched,
      poQtySnapshot: poQty,
      allowedQty,
      excessQty,
      acceptExcessOverride: acceptExcessOverride === true,
      packingRows: packing.length,
      totalPackedQty,
      status: dispatch.status,
      draftBillId: draftBill?.id ?? null,
      shortExcessRecordId: shortExcessId,
    },
  })

  revalidateTag(DISPATCH_TAG)
  revalidateTag(JOB_CARDS_TAG)
  if (shortExcessId) revalidateTag(SHORT_EXCESS_TAG)
  return NextResponse.json(
    {
      ...dispatch,
      draftBillId: draftBill?.id ?? null,
      draftBillNumber: draftBill?.billNumber ?? null,
      shortExcessRecordId: shortExcessId,
    },
    { status: 201 },
  )
}
