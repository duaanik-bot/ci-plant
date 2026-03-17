import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const specOverridesSchema = z
  .object({
    ups: z.number().int().min(1).optional(),
    wastagePct: z.number().min(0).optional(),
    requiredSheets: z.number().int().min(0).optional(),
    totalSheets: z.number().int().min(0).optional(),
    boardGrade: z.string().optional(),
    foilType: z.string().optional(),
  })
  .optional()

const lineItemSchema = z.object({
  cartonId: z.string().uuid().optional().nullable(),
  cartonName: z.string().min(1, 'Carton name is required'),
  cartonSize: z.string().optional(),
  quantity: z.number().int().positive('Quantity must be positive'),
  artworkCode: z.string().optional(),
  backPrint: z.string().optional(),
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
  specOverrides: specOverridesSchema,
})

const createSchema = z.object({
  customerId: z.string().uuid('Customer is required'),
  poDate: z.string().min(1, 'PO date is required'),
  remarks: z.string().optional(),
  status: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item is required'),
})

function buildPoNumber(existingMax: string | null): string {
  const year = new Date().getFullYear()
  const prefix = `CI-PO-${year}-`
  if (!existingMax || !existingMax.startsWith(prefix)) {
    return `${prefix}0001`
  }
  const lastSeq = parseInt(existingMax.replace(prefix, ''), 10) || 0
  const nextSeq = String(lastSeq + 1).padStart(4, '0')
  return `${prefix}${nextSeq}`
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const customerId = searchParams.get('customerId')

  const where: { status?: string; customerId?: string } = {}
  if (status) where.status = status
  if (customerId) where.customerId = customerId

  const list = await db.purchaseOrder.findMany({
    where,
    orderBy: { poDate: 'desc' },
    include: {
      customer: { select: { id: true, name: true } },
      lineItems: true,
    },
  })

  const mapped = list.map((po) => {
    const value = po.lineItems.reduce((sum, li) => {
      const rate = li.rate ? Number(li.rate) : 0
      return sum + rate * li.quantity
    }, 0)
    return {
      ...po,
      value,
    }
  })

  return NextResponse.json(mapped)
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
          gsm: li.gsm != null ? Number(li.gsm) : undefined,
          gstPct: li.gstPct != null ? Number(li.gstPct) : undefined,
          specOverrides:
            li.specOverrides && typeof li.specOverrides === 'object'
              ? {
                  ...li.specOverrides,
                  ups: li.specOverrides.ups != null ? Number(li.specOverrides.ups) : undefined,
                  wastagePct:
                    li.specOverrides.wastagePct != null
                      ? Number(li.specOverrides.wastagePct)
                      : undefined,
                  requiredSheets:
                    li.specOverrides.requiredSheets != null
                      ? Number(li.specOverrides.requiredSheets)
                      : undefined,
                  totalSheets:
                    li.specOverrides.totalSheets != null
                      ? Number(li.specOverrides.totalSheets)
                      : undefined,
                }
              : undefined,
        }))
      : [],
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

  const lastPo = await db.purchaseOrder.findFirst({
    orderBy: { poNumber: 'desc' },
    select: { poNumber: true },
  })
  const poNumber = buildPoNumber(lastPo?.poNumber ?? null)

  const created = await db.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.create({
      data: {
        poNumber,
        customerId: data.customerId,
        poDate: new Date(data.poDate),
        remarks: data.remarks || null,
        status: data.status || 'draft',
        createdBy: user!.id,
      },
    })

    await Promise.all(
      data.lineItems.map((li) =>
        tx.poLineItem.create({
          data: {
            poId: po.id,
            cartonId: li.cartonId || null,
            cartonName: li.cartonName,
            cartonSize: li.cartonSize || null,
            quantity: li.quantity,
            artworkCode: li.artworkCode || null,
            backPrint: li.backPrint || 'No',
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
            specOverrides:
              li.specOverrides && Object.keys(li.specOverrides).length > 0
                ? (li.specOverrides as object)
                : null,
          },
        })
      )
    )

    return po
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'purchase_orders',
    recordId: created.id,
    newValue: { poNumber, customerId: created.customerId },
  })

  return NextResponse.json(created, { status: 201 })
}

