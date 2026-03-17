import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const lineItemUpdateSchema = z.object({
  id: z.string().uuid().optional(),
  cartonId: z.string().uuid().optional().nullable(),
  cartonName: z.string().min(1),
  cartonSize: z.string().optional(),
  quantity: z.number().int().positive(),
  rate: z.number().min(0).optional(),
  gsm: z.number().int().optional(),
  gstPct: z.number().int().min(0).max(28).default(12),
  coatingType: z.string().optional(),
  otherCoating: z.string().optional(),
  embossingLeafing: z.string().optional(),
  paperType: z.string().optional(),
  dyeId: z.string().uuid().optional().nullable(),
  remarks: z.string().optional(),
  setNumber: z.string().optional(),
  planningStatus: z.string().optional(),
})

const updateSchema = z.object({
  customerId: z.string().uuid().optional(),
  poDate: z.string().optional(),
  remarks: z.string().optional(),
  status: z.string().optional(),
  lineItems: z.array(lineItemUpdateSchema).optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true } },
      lineItems: true,
    },
  })

  if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 })

  return NextResponse.json(po)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const existing = await db.purchaseOrder.findUnique({
    where: { id },
    include: { lineItems: true },
  })
  if (!existing) return NextResponse.json({ error: 'PO not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    lineItems: Array.isArray(body.lineItems)
      ? body.lineItems.map((li: any) => ({
          ...li,
          quantity: li.quantity != null ? Number(li.quantity) : undefined,
          rate: li.rate != null ? Number(li.rate) : undefined,
          gsm: li.gsm != null ? Number(li.gsm) : undefined,
          gstPct: li.gstPct != null ? Number(li.gstPct) : undefined,
        }))
      : undefined,
  })

  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data

  const updated = await db.$transaction(async (tx) => {
    const header = await tx.purchaseOrder.update({
      where: { id },
      data: {
        ...(data.customerId ? { customerId: data.customerId } : {}),
        ...(data.poDate ? { poDate: new Date(data.poDate) } : {}),
        ...(data.remarks !== undefined ? { remarks: data.remarks || null } : {}),
        ...(data.status ? { status: data.status } : {}),
      },
    })

    if (data.lineItems) {
      // Simple approach: delete existing and recreate from payload
      await tx.poLineItem.deleteMany({ where: { poId: id } })
      await Promise.all(
        data.lineItems.map((li) =>
          tx.poLineItem.create({
            data: {
              poId: id,
              cartonId: li.cartonId || null,
              cartonName: li.cartonName,
              cartonSize: li.cartonSize || null,
              quantity: li.quantity,
              artworkCode: null,
              backPrint: 'No',
              rate: li.rate != null ? li.rate : null,
              gsm: li.gsm ?? null,
              gstPct: li.gstPct,
              coatingType: li.coatingType || null,
              otherCoating: li.otherCoating || null,
              embossingLeafing: li.embossingLeafing || null,
              paperType: li.paperType || null,
              dyeId: li.dyeId || null,
              remarks: li.remarks || null,
              setNumber: li.setNumber || null,
              planningStatus: li.planningStatus || 'pending',
            },
          })
        )
      )
    }

    return header
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_orders',
    recordId: id,
    newValue: data,
  })

  return NextResponse.json(updated)
}

