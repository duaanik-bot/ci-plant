import { NextResponse } from 'next/server'
import { unstable_cache } from 'next/cache'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { normalizePackingConfig } from '@/lib/dispatch-packing'

export const dynamic = 'force-dynamic'

const BILLING_QUEUE_TAG = 'billing-queue'

type QueueLine = {
  dispatchId: string
  jobCardId: string | null
  jobNumber: string
  productName: string
  poLineId: string | null
  poNumber: string | null
  qtyDispatched: number
  packingConfigCount: number
  rate: number | null
  gstPct: number | null
  hsnCode: string | null
  excessQty: number
  dispatchedAt: string | null
}

type QueueGroup = {
  customerId: string
  customerName: string
  customerStateCode: string | null
  customerGstNumber: string | null
  customerBillingAddress: string | null
  customerShippingAddress: string | null
  dispatches: QueueLine[]
  totalQty: number
  estimatedSubtotal: number
}

async function fetchQueueGroups(): Promise<QueueGroup[]> {
  const rows = await db.dispatch.findMany({
    where: { billingStatus: 'sent_to_billing' },
    orderBy: { dispatchedAt: 'asc' },
    include: {
      jobCard: {
        select: {
          id: true,
          jobCardNumber: true,
          setNumber: true,
          customerId: true,
          customer: {
            select: {
              id: true,
              name: true,
              stateCode: true,
              gstNumber: true,
              billingAddress: true,
              shippingAddress: true,
              address: true,
            },
          },
        },
      },
      poLineItem: {
        select: {
          id: true,
          cartonName: true,
          rate: true,
          gstPct: true,
          hsnCode: true,
          po: { select: { poNumber: true } },
        },
      },
    },
  })

  const groups = new Map<string, QueueGroup>()
  for (const d of rows) {
    const customer = d.jobCard?.customer
    if (!customer) continue
    const g =
      groups.get(customer.id) ?? {
        customerId: customer.id,
        customerName: customer.name,
        customerStateCode: customer.stateCode,
        customerGstNumber: customer.gstNumber,
        customerBillingAddress: customer.billingAddress ?? customer.address ?? null,
        customerShippingAddress:
          customer.shippingAddress ?? customer.billingAddress ?? customer.address ?? null,
        dispatches: [],
        totalQty: 0,
        estimatedSubtotal: 0,
      }
    const rate = d.poLineItem?.rate != null ? Number(d.poLineItem.rate) : null
    const line: QueueLine = {
      dispatchId: d.id,
      jobCardId: d.jobCard?.id ?? null,
      jobNumber: d.jobCard ? `JC-${d.jobCard.jobCardNumber}` : `D-${d.id.slice(0, 6)}`,
      productName: d.poLineItem?.cartonName ?? d.jobCard?.setNumber ?? '—',
      poLineId: d.poLineItem?.id ?? null,
      poNumber: d.poLineItem?.po?.poNumber ?? null,
      qtyDispatched: d.qtyDispatched,
      packingConfigCount: normalizePackingConfig(d.packingConfig).length,
      rate,
      gstPct: d.poLineItem?.gstPct ?? null,
      hsnCode: d.poLineItem?.hsnCode ?? null,
      excessQty: d.excessQty,
      dispatchedAt: d.dispatchedAt?.toISOString() ?? null,
    }
    g.dispatches.push(line)
    g.totalQty += d.qtyDispatched
    if (rate != null) g.estimatedSubtotal += d.qtyDispatched * rate
    groups.set(customer.id, g)
  }

  return Array.from(groups.values()).sort((a, b) => b.totalQty - a.totalQty)
}

const fetchQueueGroupsCached = unstable_cache(fetchQueueGroups, ['billing-queue-v1'], {
  revalidate: 10,
  tags: [BILLING_QUEUE_TAG],
})

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error
  const groups = await fetchQueueGroupsCached()
  return NextResponse.json(groups)
}
