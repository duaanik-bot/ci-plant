import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ query: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { query } = await context.params
  const q = decodeURIComponent(query).trim()
  if (!q) return NextResponse.json({ error: 'Query required' }, { status: 400 })

  const trace: { stage: string; detail: string }[] = []

  const jobByNumber = await db.job.findFirst({
    where: { jobNumber: { contains: q, mode: 'insensitive' } },
    include: { customer: { select: { name: true } } },
  })
  if (jobByNumber) {
    trace.push({ stage: 'Job', detail: `${jobByNumber.jobNumber} — ${jobByNumber.productName}` })
    trace.push({ stage: 'Customer', detail: jobByNumber.customer.name })
    const dispatch = await db.dispatch.findFirst({
      where: { jobId: jobByNumber.id },
      orderBy: { createdAt: 'desc' },
    })
    if (dispatch) {
      trace.push({
        stage: 'Dispatch',
        detail: `Qty: ${dispatch.qtyDispatched}, Status: ${dispatch.status}`,
      })
    }
  }

  const materialByCode = await db.inventory.findFirst({
    where: { materialCode: { contains: q, mode: 'insensitive' } },
    include: { supplier: { select: { name: true } } },
  })
  if (materialByCode) {
    trace.push({ stage: 'Material', detail: `${materialByCode.materialCode} — ${materialByCode.description}` })
    if (materialByCode.supplier) {
      trace.push({ stage: 'Supplier', detail: materialByCode.supplier.name })
    }
  }

  const movements = await db.stockMovement.findMany({
    where: {
      OR: [
        { refId: q },
        { material: { materialCode: { contains: q, mode: 'insensitive' } } },
      ],
    },
    take: 20,
    orderBy: { createdAt: 'desc' },
    include: { material: { select: { materialCode: true } } },
  })
  if (movements.length > 0) {
    trace.push({
      stage: 'Movements',
      detail: movements.map((m) => `${m.movementType} ${m.qty} ${m.material.materialCode} @ ${m.createdAt.toISOString()}`).join('; '),
    })
  }

  if (trace.length === 0) {
    trace.push({ stage: 'Result', detail: 'No trace found for this batch, job number, or material.' })
  }

  return NextResponse.json({ query: q, trace })
}
