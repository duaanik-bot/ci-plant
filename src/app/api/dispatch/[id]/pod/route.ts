import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const podSchema = z.object({
  podUrl: z.string().url().optional(),
  receivedAt: z.string().optional(), // ISO string
  createDraftBill: z.boolean().optional(),
})

function nextBillNumber(lastBill: { billNumber: string } | null): string {
  const year = new Date().getFullYear()
  const prefix = `CI-BILL-${year}-`
  const lastSeq = lastBill ? parseInt(lastBill.billNumber.replace(prefix, ''), 10) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = params

  const existing = await db.dispatch.findUnique({
    where: { id },
    include: { job: { select: { jobNumber: true, productName: true, customerId: true } } },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Dispatch not found' }, { status: 404 })
  }

  const body = await req.json().catch(() => ({}))
  const parsed = podSchema.safeParse(body)
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

  const { podUrl, receivedAt, createDraftBill } = parsed.data

  let draftBill: { id: string; billNumber: string } | null = null

  const updated = await db.$transaction(async (tx) => {
    const d = await tx.dispatch.update({
      where: { id },
      data: {
        status: 'pod_received',
        podUrl: podUrl ?? existing.podUrl,
        podReceivedAt: receivedAt ? new Date(receivedAt) : new Date(),
      },
    })

    if (createDraftBill && existing.job?.customerId) {
      const lastBill = await tx.bill.findFirst({
        where: { billNumber: { startsWith: `CI-BILL-${new Date().getFullYear()}-` } },
        orderBy: { billNumber: 'desc' },
        select: { billNumber: true },
      })
      const billNumber = nextBillNumber(lastBill)
      const description = `${existing.job.jobNumber} – ${existing.job.productName ?? 'Dispatch'}`
      const quantity = existing.qtyDispatched
      const rate = 0
      const gstPct = 12
      const amount = 0
      const b = await tx.bill.create({
        data: {
          billNumber,
          customerId: existing.job.customerId,
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
          description,
          quantity,
          rate,
          gstPct,
          amount,
        },
      })
      draftBill = { id: b.id, billNumber: b.billNumber }
    }

    return d
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'dispatches',
    recordId: id,
    oldValue: { status: existing.status, podUrl: existing.podUrl },
    newValue: { status: updated.status, podUrl: updated.podUrl },
  })

  return NextResponse.json({
    ...updated,
    draftBillId: draftBill?.id ?? null,
    draftBillNumber: draftBill?.billNumber ?? null,
  })
}

