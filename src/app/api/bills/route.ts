import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const lineItemSchema = z.object({
  jobCardId: z.string().uuid().optional().nullable(),
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  rate: z.number().min(0),
  gstPct: z.number().int().min(0).max(28).default(12),
})

const createSchema = z.object({
  customerId: z.string().uuid(),
  billDate: z.string().optional(),
  status: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1),
})

function nextBillNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `CI-BILL-${year}-`
  return db.bill
    .findFirst({
      where: { billNumber: { startsWith: prefix } },
      orderBy: { billNumber: 'desc' },
      select: { billNumber: true },
    })
    .then((last) => {
      const lastSeq = last ? parseInt(last.billNumber.replace(prefix, ''), 10) || 0 : 0
      return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
    })
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')
  const status = searchParams.get('status')

  const list = await db.bill.findMany({
    where: {
      ...(customerId ? { customerId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { billDate: 'desc' },
    include: {
      customer: { select: { id: true, name: true } },
      lineItems: true,
    },
  })

  return NextResponse.json(
    list.map((b) => ({
      ...b,
      subtotal: Number(b.subtotal),
      gstAmount: Number(b.gstAmount),
      totalAmount: Number(b.totalAmount),
      lineItems: b.lineItems.map((li) => ({
        ...li,
        rate: Number(li.rate),
        amount: Number(li.amount),
      })),
    }))
  )
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
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

  const customer = await db.customer.findUnique({
    where: { id: parsed.data.customerId },
  })
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })

  const billNumber = await nextBillNumber()
  const billDate = parsed.data.billDate ? new Date(parsed.data.billDate) : new Date()

  let subtotal = 0
  const lineData = parsed.data.lineItems.map((li) => {
    const amount = li.quantity * li.rate
    subtotal += amount
    return {
      jobCardId: li.jobCardId ?? undefined,
      description: li.description,
      quantity: li.quantity,
      rate: li.rate,
      gstPct: li.gstPct,
      amount,
    }
  })
  const gstAmount = lineData.reduce((sum, li) => sum + li.amount * (li.gstPct / 100), 0)
  const totalAmount = subtotal + gstAmount

  const bill = await db.$transaction(async (tx) => {
    const b = await tx.bill.create({
      data: {
        billNumber,
        customerId: parsed.data.customerId,
        billDate,
        subtotal,
        gstAmount,
        totalAmount,
        status: parsed.data.status || 'draft',
        createdBy: user!.id,
      },
    })
    await tx.billLineItem.createMany({
      data: lineData.map((li) => ({
        billId: b.id,
        jobCardId: li.jobCardId || undefined,
        description: li.description,
        quantity: li.quantity,
        rate: li.rate,
        gstPct: li.gstPct,
        amount: li.amount,
      })),
    })
    return b
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'bills',
    recordId: bill.id,
    newValue: { billNumber, customerId: bill.customerId },
  })

  return NextResponse.json(bill, { status: 201 })
}
