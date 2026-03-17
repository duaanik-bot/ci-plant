import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const lineItemSchema = z.object({
  id: z.string().uuid().optional(),
  jobCardId: z.string().uuid().optional().nullable(),
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  rate: z.number().min(0),
  gstPct: z.number().int().min(0).max(28).default(12),
})

const updateSchema = z.object({
  billDate: z.string().optional(),
  status: z.string().optional(),
  lineItems: z.array(lineItemSchema).optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const bill = await db.bill.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true } },
      lineItems: true,
    },
  })
  if (!bill) return NextResponse.json({ error: 'Bill not found' }, { status: 404 })

  return NextResponse.json({
    ...bill,
    subtotal: Number(bill.subtotal),
    gstAmount: Number(bill.gstAmount),
    totalAmount: Number(bill.totalAmount),
    lineItems: bill.lineItems.map((li) => ({
      ...li,
      rate: Number(li.rate),
      amount: Number(li.amount),
    })),
  })
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.bill.findUnique({
    where: { id },
    include: { lineItems: true },
  })
  if (!existing) return NextResponse.json({ error: 'Bill not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    lineItems: Array.isArray(body.lineItems)
      ? body.lineItems.map((li: any) => ({
          ...li,
          quantity: li.quantity != null ? Number(li.quantity) : undefined,
          rate: li.rate != null ? Number(li.rate) : undefined,
          gstPct: li.gstPct != null ? Number(li.gstPct) : 12,
        }))
      : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data

  const updated = await db.$transaction(async (tx) => {
    await tx.bill.update({
      where: { id },
      data: {
        ...(data.billDate ? { billDate: new Date(data.billDate) } : {}),
        ...(data.status ? { status: data.status } : {}),
      },
    })

    if (data.lineItems) {
      await tx.billLineItem.deleteMany({ where: { billId: id } })
      const newSub = data.lineItems.reduce((s, li) => s + li.quantity * li.rate, 0)
      const newGst = data.lineItems.reduce(
        (s, li) => s + li.quantity * li.rate * (li.gstPct / 100),
        0
      )
      await tx.billLineItem.createMany({
        data: data.lineItems.map((li) => ({
          billId: id,
          jobCardId: li.jobCardId || undefined,
          description: li.description,
          quantity: li.quantity,
          rate: li.rate,
          gstPct: li.gstPct,
          amount: li.quantity * li.rate,
        })),
      })
      await tx.bill.update({
        where: { id },
        data: {
          subtotal: newSub,
          gstAmount: newGst,
          totalAmount: newSub + newGst,
        },
      })
    }

    return db.bill.findUnique({
      where: { id },
      include: { customer: true, lineItems: true },
    })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'bills',
    recordId: id,
    newValue: data,
  })

  return NextResponse.json(updated)
}
