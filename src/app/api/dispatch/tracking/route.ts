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
    },
    orderBy: { dispatchedAt: 'desc' },
  })

  const data = records.map((d) => ({
    id: d.id,
    status: d.status,
    qtyDispatched: d.qtyDispatched,
    vehicleNumber: d.vehicleNumber,
    driverName: d.driverName,
    ewayBillNumber: d.ewayBillNumber,
    dispatchedAt: d.dispatchedAt,
    podReceivedAt: d.podReceivedAt,
    jobId: d.job.id,
    jobNumber: d.job.jobNumber,
    customerId: d.job.customer.id,
    customerName: d.job.customer.name,
  }))

  return NextResponse.json(data)
}

