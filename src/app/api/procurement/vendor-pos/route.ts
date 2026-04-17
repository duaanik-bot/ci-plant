import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { aggregateContributions, PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'

export const dynamic = 'force-dynamic'

const postSchema = z.object({
  requirementKeys: z.array(z.string().min(1)).min(1),
  supplierId: z.string().uuid(),
})

function buildVendorPoNumber(existingMax: string | null): string {
  const year = new Date().getFullYear()
  const prefix = `CI-VPO-${year}-`
  if (!existingMax || !existingMax.startsWith(prefix)) {
    return `${prefix}0001`
  }
  const lastSeq = parseInt(existingMax.replace(prefix, ''), 10) || 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

function earliestYmd(dates: string[]): string | null {
  const ok = dates.filter(Boolean).sort()
  return ok[0] ?? null
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = postSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { requirementKeys, supplierId } = parsed.data
  const keySet = new Set(requirementKeys)

  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, active: true },
  })
  if (!supplier) {
    return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
  }

  const suppliers = await db.supplier.findMany({ where: { active: true } })

  const pos = await db.purchaseOrder.findMany({
    where: { status: 'confirmed' },
    include: {
      customer: { select: { name: true } },
      lineItems: {
        where: { materialProcurementStatus: 'pending' },
        include: {
          dieMaster: { select: { sheetSize: true, ups: true } },
        },
      },
    },
  })

  type Flat = Parameters<typeof aggregateContributions>[0][number]
  const flat: Flat[] = []
  for (const po of pos) {
    const { lineItems, ...poHead } = po
    for (const line of lineItems) {
      flat.push({ line, po: poHead, die: line.dieMaster })
    }
  }

  const allReqs = aggregateContributions(flat, suppliers)
  const selected = allReqs.filter((r) => keySet.has(r.key))
  if (selected.length === 0) {
    return NextResponse.json(
      { error: 'No matching pending requirements for the selected keys' },
      { status: 400 },
    )
  }

  const poLineIds = selected.flatMap((r) => r.contributions.map((c) => c.poLineItemId))
  const locked = await db.poLineItem.findMany({
    where: {
      id: { in: poLineIds },
      materialProcurementStatus: { not: 'pending' },
    },
    select: { id: true },
  })
  if (locked.length > 0) {
    return NextResponse.json(
      { error: 'Some lines are no longer pending for procurement', ids: locked.map((x) => x.id) },
      { status: 409 },
    )
  }

  const vendorDates = selected.flatMap((r) => r.contributions.map((c) => c.vendorRequiredDeliveryYmd || ''))
  const requiredDeliveryDate = earliestYmd(vendorDates)
    ? new Date(earliestYmd(vendorDates)!)
    : null

  const last = await db.vendorMaterialPurchaseOrder.findFirst({
    orderBy: { poNumber: 'desc' },
    select: { poNumber: true },
  })
  const poNumber = buildVendorPoNumber(last?.poNumber ?? null)

  const created = await db.vendorMaterialPurchaseOrder.create({
    data: {
      poNumber,
      supplierId,
      status: 'draft',
      requiredDeliveryDate,
      signatoryName: PROCUREMENT_DEFAULT_SIGNATORY,
      createdBy: user!.id,
      lines: {
        create: selected.map((r) => ({
          boardGrade: r.boardType,
          gsm: r.gsm,
          grainDirection: r.grainDirection,
          totalSheets: r.totalSheets,
          totalWeightKg: r.totalWeightKg,
          linkedPoLineIds: r.contributions.map((c) => c.poLineItemId),
        })),
      },
    },
    include: { supplier: true, lines: true },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'vendor_material_purchase_orders',
    recordId: created.id,
    newValue: { poNumber: created.poNumber, supplierId, lineCount: created.lines.length },
  })

  return NextResponse.json(created, { status: 201 })
}
