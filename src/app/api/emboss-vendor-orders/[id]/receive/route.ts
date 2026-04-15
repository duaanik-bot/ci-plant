// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const schema = z.object({
  finalCost: z.number().optional().nullable(),
  blockNumber: z.number().int().optional().nullable(),
  condition: z.string().default('New'),
  storageLocation: z.string().optional().nullable(),
  compartment: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

async function nextBlockCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `EB-${year}-`
  const last = await db.embossBlock.findFirst({
    where: { blockCode: { startsWith: prefix } },
    orderBy: { blockCode: 'desc' },
    select: { blockCode: true },
  })
  const seq = last ? Number(last.blockCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const order = await db.embossVendorOrder.findUnique({ where: { id } })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse({
    ...body,
    finalCost: body.finalCost != null ? Number(body.finalCost) : undefined,
    blockNumber: body.blockNumber != null ? Number(body.blockNumber) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const blockCode = await nextBlockCode()
  const block = await db.embossBlock.create({
    data: {
      blockCode,
      blockNumber: parsed.data.blockNumber ?? null,
      blockType: order.blockType ?? 'Blind Emboss',
      blockMaterial: order.blockMaterial ?? 'Magnesium',
      embossDepth: order.embossDepth ?? null,
      embossArea: order.embossArea ?? null,
      cartonName: order.cartonName ?? null,
      condition: parsed.data.condition,
      storageLocation: parsed.data.storageLocation ?? null,
      compartment: parsed.data.compartment ?? null,
      status: 'in_stock',
      vendorName: order.vendorName,
      vendorOrderRef: order.orderCode,
      manufacturingCost: parsed.data.finalCost ?? order.finalCost ?? order.quotedCost ?? null,
      createdBy: user?.id ?? 'system',
      receivedDate: new Date(),
    },
  })
  await db.embossVendorOrder.update({
    where: { id },
    data: {
      embossBlockId: block.id,
      finalCost: parsed.data.finalCost ?? order.finalCost,
      receivedAt: new Date(),
      status: 'received',
    },
  })
  await db.embossAuditLog.create({
    data: {
      embossBlockId: block.id,
      blockCode: block.blockCode,
      action: 'received_from_vendor',
      performedBy: user?.id ?? 'system',
      details: { orderCode: order.orderCode, notes: parsed.data.notes ?? null },
    },
  })
  return NextResponse.json(block)
}
