import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const records = await db.dispatch.findMany({
    include: {
      job: {
        select: {
          id: true,
          jobNumber: true,
          customer: { select: { id: true, name: true } },
        },
      },
      jobCard: {
        select: {
          id: true,
          jobCardNumber: true,
          customer: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { dispatchedAt: 'desc' },
  })

  const data = records.map((d) => {
    // Prefer the production-flow jobCard when present; fall back to legacy Job.
    const jc = d.jobCard
    const job = d.job
    const id = jc?.id ?? job?.id ?? ''
    const number = jc ? `JC-${jc.jobCardNumber}` : job?.jobNumber ?? '—'
    const customer = jc?.customer ?? job?.customer ?? { id: '', name: '—' }
    return {
      id: d.id,
      status: d.status,
      qtyDispatched: d.qtyDispatched,
      vehicleNumber: d.vehicleNumber,
      driverName: d.driverName,
      ewayBillNumber: d.ewayBillNumber,
      dispatchedAt: d.dispatchedAt,
      podReceivedAt: d.podReceivedAt,
      jobId: id,
      jobNumber: number,
      customerId: customer.id,
      customerName: customer.name,
    }
  })

  return NextResponse.json(data)
}
