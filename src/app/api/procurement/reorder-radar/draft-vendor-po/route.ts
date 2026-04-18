import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { aggregateFromStoredRequirements, PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'
import { computeVendorReliabilityScores } from '@/lib/vendor-reliability-scorecard'
import {
  aggregateAllocatedSheetsByBoardGsm,
  aggregatePhysicalPaperByBoardGsm,
  computeReorderRadarForRow,
  pickEliteBoardSupplier,
  resolveBenchmarkRatePerKg,
} from '@/lib/reorder-radar'

export const dynamic = 'force-dynamic'

const ACTIVE_LINE_PROC_STATUSES = [
  'pending',
  'on_order',
  'dispatched',
  'paper_ordered',
  'received',
] as const

const bodySchema = z.object({
  requirementKey: z.string().min(1).max(256),
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

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'requirementKey required' }, { status: 400 })
  }
  const { requirementKey } = parsed.data

  const [suppliers, rows, policyRows, lastPo] = await Promise.all([
    db.supplier.findMany({ where: { active: true } }),
    db.materialQueue.findMany({
      where: {
        lineItem: {
          materialProcurementStatus: { in: [...ACTIVE_LINE_PROC_STATUSES] },
          po: { status: 'confirmed' },
        },
      },
      include: {
        lineItem: true,
        purchaseOrder: {
          include: { customer: { select: { name: true } } },
        },
      },
      orderBy: { calculatedAt: 'desc' },
    }),
    db.paperSpecReorderPolicy.findMany(),
    db.vendorMaterialPurchaseOrder.findFirst({
      orderBy: { poNumber: 'desc' },
      select: { poNumber: true },
    }),
  ])

  const flat = rows.map((mr) => ({
    mr,
    line: mr.lineItem,
    po: mr.purchaseOrder,
  }))

  const aggregatedCore = aggregateFromStoredRequirements(flat, suppliers)
  const r = aggregatedCore.find((x) => x.key === requirementKey)
  if (!r) {
    return NextResponse.json({ error: 'No active material queue row for this radar key' }, { status: 404 })
  }

  const [physicalByBg, vendorScores] = await Promise.all([
    aggregatePhysicalPaperByBoardGsm(db),
    computeVendorReliabilityScores(db),
  ])
  const policyByKey = new Map(policyRows.map((p) => [p.radarKey, p]))
  const allocatedByBg = aggregateAllocatedSheetsByBoardGsm(aggregatedCore)
  const pol = policyByKey.get(r.key)

  const reorderRadar = computeReorderRadarForRow({
    boardType: r.boardType,
    gsm: r.gsm,
    radarKey: r.key,
    totalSheetsDemand: r.totalSheets,
    physicalByBoardGsm: physicalByBg,
    allocatedByBoardGsm: allocatedByBg,
    minimumThreshold: pol?.minimumThreshold ?? 0,
    maximumBuffer: pol?.maximumBuffer ?? 0,
  })

  let totalSheets = reorderRadar.recommendedReorderSheets
  if (totalSheets < 1) {
    totalSheets = reorderRadar.isProcurementRisk
      ? Math.max(1, Math.ceil(r.totalSheets * 0.05) || 500)
      : Math.max(1, Math.ceil(r.totalSheets * 0.1))
  }

  const ratio = r.totalSheets > 0 ? totalSheets / r.totalSheets : 1
  const totalWeightKg = r.totalWeightKg * ratio

  const elite = pickEliteBoardSupplier(suppliers, vendorScores)
  const supplierId = elite?.id ?? r.suggestedSupplierId
  if (!supplierId) {
    return NextResponse.json({ error: 'No elite or suggested board supplier available' }, { status: 422 })
  }

  const supplier = await db.supplier.findFirst({ where: { id: supplierId, active: true } })
  if (!supplier) {
    return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
  }

  const ratePerKg = await resolveBenchmarkRatePerKg(db, r.boardType, r.gsm)

  const vendorDates = r.contributions.map((c) => c.vendorRequiredDeliveryYmd || '')
  const requiredDeliveryDate = earliestYmd(vendorDates) ? new Date(earliestYmd(vendorDates)!) : null

  const poNumber = buildVendorPoNumber(lastPo?.poNumber ?? null)
  const linkedIds = r.contributions.map((c) => c.poLineItemId)

  const created = await db.vendorMaterialPurchaseOrder.create({
    data: {
      poNumber,
      supplierId: supplier.id,
      status: 'draft',
      requiredDeliveryDate,
      signatoryName: PROCUREMENT_DEFAULT_SIGNATORY,
      createdBy: user!.id,
      remarks: `Dynamic reorder radar draft · net ${reorderRadar.netAvailable} sh · recommended ${totalSheets} sh · physical ${reorderRadar.physicalSheets} · allocated ${reorderRadar.allocatedSheets}`,
      lines: {
        create: [
          {
            boardGrade: r.boardType,
            gsm: r.gsm,
            grainDirection: r.grainDirection,
            totalSheets,
            totalWeightKg,
            ratePerKg: ratePerKg ?? undefined,
            linkedPoLineIds: linkedIds,
          },
        ],
      },
    },
    include: { supplier: true, lines: true },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'vendor_material_purchase_orders',
    recordId: created.id,
    newValue: {
      reorderRadarDraft: true,
      requirementKey,
      supplierId: supplier.id,
      eliteSupplier: elite?.id === supplier.id,
      recommendedSheets: totalSheets,
      benchmarkRatePerKg: ratePerKg,
    },
  })

  return NextResponse.json({ id: created.id, poNumber: created.poNumber }, { status: 201 })
}
