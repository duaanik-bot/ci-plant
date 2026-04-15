import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const schema = z.object({
  finalCost: z.number().optional().nullable(),
  dieNumber: z.number().int().optional().nullable(),
  condition: z.string().default('New'),
  storageLocation: z.string().optional().nullable(),
  compartment: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

async function nextDieCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `DI-${year}-`
  const last = await db.dieStore.findFirst({
    where: { dieCode: { startsWith: prefix } },
    orderBy: { dieCode: 'desc' },
    select: { dieCode: true },
  })
  const seq = last ? Number(last.dieCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const order = await db.dieVendorOrder.findUnique({ where: { id } })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse({
    ...body,
    finalCost: body.finalCost != null ? Number(body.finalCost) : undefined,
    dieNumber: body.dieNumber != null ? Number(body.dieNumber) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const dieCode = await nextDieCode()
  const die = await db.dieStore.create({
    data: {
      dieCode,
      dieNumber: parsed.data.dieNumber ?? null,
      dieType: order.dieType ?? 'straight',
      ups: order.ups ?? 1,
      sheetSize: order.sheetSize,
      cartonSize: order.cartonSize,
      cartonName: order.cartonName,
      condition: parsed.data.condition,
      storageLocation: parsed.data.storageLocation ?? null,
      compartment: parsed.data.compartment ?? null,
      status: 'in_stock',
      vendorName: order.vendorName,
      vendorOrderRef: order.orderCode,
      manufacturingCost: parsed.data.finalCost ?? order.finalCost ?? order.quotedCost,
      createdBy: user?.id ?? 'system',
    },
  })
  await db.dieVendorOrder.update({
    where: { id },
    data: {
      dieStoreId: die.id,
      finalCost: parsed.data.finalCost ?? order.finalCost,
      receivedAt: new Date(),
      status: 'received',
    },
  })
  await db.dieAuditLog.create({
    data: {
      dieStoreId: die.id,
      dieCode: die.dieCode,
      action: 'received_from_vendor',
      performedBy: user?.id ?? 'system',
      details: { orderCode: order.orderCode, notes: parsed.data.notes ?? null },
    },
  })
  return NextResponse.json(die)
}
