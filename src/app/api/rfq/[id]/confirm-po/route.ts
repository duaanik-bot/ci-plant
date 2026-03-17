import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const schema = z.object({
  poNumber: z.string().min(1),
  poValue: z.number().min(0).optional(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse({
    ...body,
    poValue: body.poValue != null ? Number(body.poValue) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const key = i.path[0]
      if (typeof key === 'string') fields[key] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const rfq = await db.rfq.findUnique({
    where: { id },
    include: { customer: true },
  })
  if (!rfq) return NextResponse.json({ error: 'RFQ not found' }, { status: 404 })

  const fd = rfq.feasibilityData as any
  const cartonName = `${rfq.productName} — ${rfq.packType}`.slice(0, 190)

  const sizeL = fd?.specs?.sizeL
  const sizeW = fd?.specs?.sizeW
  const sizeH = fd?.specs?.sizeH
  const cartonSize =
    sizeL != null && sizeW != null && sizeH != null
      ? `${sizeL}×${sizeW}×${sizeH} mm`
      : null

  const gsm = typeof fd?.specs?.gsm === 'number' ? fd.specs.gsm : null
  const coatingType = typeof fd?.specs?.coatingType === 'string' ? fd.specs.coatingType : null
  const embossingLeafing = typeof fd?.specs?.embossing === 'string' ? fd.specs.embossing : null
  const boardGrade = typeof fd?.specs?.boardGrade === 'string' ? fd.specs.boardGrade : null
  const drugSchedule = typeof fd?.product?.drugSchedule === 'string' ? fd.product.drugSchedule : null
  const whoGmp = !!fd?.compliance?.whoGmp
  const scheduleM = !!fd?.compliance?.scheduleM
  const fssai = !!fd?.compliance?.fssai
  const regulatoryText = typeof fd?.compliance?.regulatoryText === 'string' ? fd.compliance.regulatoryText : null

  const quantity = typeof fd?.product?.annualVolume === 'number' ? Math.max(1, Math.floor(fd.product.annualVolume)) : 1

  const created = await db.$transaction(async (tx) => {
    // Create carton master if missing (per customer + cartonName)
    const existingCarton = await tx.carton.findFirst({
      where: {
        customerId: rfq.customerId,
        cartonName: { equals: cartonName, mode: 'insensitive' },
      },
    })

    const carton =
      existingCarton ??
      (await tx.carton.create({
        data: {
          customerId: rfq.customerId,
          cartonName,
          productType: rfq.packType,
          boardGrade,
          gsm: gsm ?? undefined,
          coatingType: coatingType ?? undefined,
          embossingLeafing: embossingLeafing ?? undefined,
          finishedLength: sizeL != null ? Number(sizeL) : undefined,
          finishedWidth: sizeW != null ? Number(sizeW) : undefined,
          finishedHeight: sizeH != null ? Number(sizeH) : undefined,
          drugSchedule: drugSchedule ?? undefined,
          whoGmpRequired: whoGmp,
          scheduleMRequired: scheduleM,
          fssaiRequired: fssai,
          regulatoryText: regulatoryText ?? undefined,
        },
      }))

    // Create PurchaseOrder + single PoLineItem
    const po = await tx.purchaseOrder.create({
      data: {
        poNumber: parsed.data.poNumber,
        customerId: rfq.customerId,
        poDate: new Date(),
        remarks: `Auto-created from ${rfq.rfqNumber}`,
        status: 'draft',
        createdBy: user!.id,
      },
    })

    const li = await tx.poLineItem.create({
      data: {
        poId: po.id,
        cartonId: carton.id,
        cartonName: carton.cartonName,
        cartonSize: cartonSize ?? undefined,
        quantity,
        artworkCode: null,
        backPrint: 'No',
        rate: null,
        gsm: gsm ?? undefined,
        gstPct: carton.gstPct,
        coatingType: coatingType ?? undefined,
        embossingLeafing: embossingLeafing ?? undefined,
        paperType: null,
        dyeId: null,
        remarks: `Auto from ${rfq.rfqNumber}`,
        setNumber: null,
        planningStatus: 'pending',
        specOverrides: rfq.feasibilityData ?? undefined,
      },
    })

    const updatedRfq = await tx.rfq.update({
      where: { id: rfq.id },
      data: {
        status: 'po_received',
        poNumber: parsed.data.poNumber,
        poValue: parsed.data.poValue ?? undefined,
      },
    })

    return { po, li, carton, rfq: updatedRfq }
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'purchase_orders',
    recordId: created.po.id,
    newValue: { poNumber: created.po.poNumber, customerId: created.po.customerId },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'rfqs',
    recordId: rfq.id,
    newValue: { status: 'po_received', poNumber: parsed.data.poNumber },
  })

  return NextResponse.json({
    rfq: created.rfq,
    purchaseOrderId: created.po.id,
    poLineItemId: created.li.id,
    cartonId: created.carton.id,
  })
}

