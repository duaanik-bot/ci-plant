import type { PrismaClient } from '@prisma/client'

/** Strategic sourcing / director insights accent (Tailwind-friendly). */
export const STRATEGIC_SOURCING_GOLD = 'text-amber-400'
export const STRATEGIC_SOURCING_GOLD_BORDER = 'border-amber-500/55'
export const STRATEGIC_SOURCING_GOLD_SOFT = 'bg-amber-500/10'

export type ReliabilityGrade = 'A' | 'B' | 'C'

export type VendorReliabilitySnapshot = {
  supplierId: string
  supplierName: string
  deliveryScore: number
  weightScore: number
  compositeScore: number
  grade: ReliabilityGrade
  otifCount: number
  totalDeliveryOrders: number
  avgAbsVariancePct: number | null
}

const MS_DAY = 86_400_000

function startOfDayUtc(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** On-time dispatch: gate comms by required calendar day (vendor PO). */
export function isOtifDispatch(requiredDelivery: Date | null, dispatchedAt: Date | null): boolean {
  if (!dispatchedAt) return false
  if (!requiredDelivery) return true
  return startOfDayUtc(dispatchedAt) <= startOfDayUtc(requiredDelivery)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function neutralScore(missing: 'delivery' | 'weight'): number {
  return missing === 'delivery' ? 72 : 74
}

function compositeGrade(score: number): ReliabilityGrade {
  if (score >= 83) return 'A'
  if (score >= 68) return 'B'
  return 'C'
}

/**
 * Live scorecard from gate dispatch + weight reconciliation (recalculates on read — reflects new GRN / recon daily).
 */
export async function computeVendorReliabilityScores(db: PrismaClient): Promise<Map<string, VendorReliabilitySnapshot>> {
  const since = new Date(Date.now() - 540 * MS_DAY)

  const [dispatchedPos, recons, suppliers] = await Promise.all([
    db.vendorMaterialPurchaseOrder.findMany({
      where: {
        status: { in: ['dispatched', 'closed'] },
        dispatchedAt: { not: null, gte: since },
      },
      select: {
        id: true,
        supplierId: true,
        requiredDeliveryDate: true,
        dispatchedAt: true,
        supplier: { select: { id: true, name: true } },
      },
    }),
    db.materialWeightReconciliation.findMany({
      where: {
        vendorMaterialPoLineId: { not: null },
        variancePercent: { not: null },
        createdAt: { gte: since },
      },
      select: {
        variancePercent: true,
        vendorMaterialPoLineId: true,
      },
    }),
    db.supplier.findMany({
      where: { active: true },
      select: { id: true, name: true },
    }),
  ])

  const lineIds = Array.from(
    new Set(
      recons
        .map((r) => r.vendorMaterialPoLineId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  )
  const vmLines =
    lineIds.length > 0
      ? await db.vendorMaterialPurchaseOrderLine.findMany({
          where: { id: { in: lineIds } },
          select: {
            id: true,
            vendorPo: { select: { supplierId: true, isShortClosed: true } },
          },
        })
      : []
  const supplierByVmLine = new Map(vmLines.map((l) => [l.id, l.vendorPo.supplierId]))
  const shortClosedVmLineIds = new Set(
    vmLines.filter((l) => l.vendorPo.isShortClosed).map((l) => l.id),
  )

  const deliveryBySupplier = new Map<
    string,
    { name: string; otif: number; total: number }
  >()
  for (const vpo of dispatchedPos) {
    const sid = vpo.supplierId
    if (!deliveryBySupplier.has(sid)) {
      deliveryBySupplier.set(sid, { name: vpo.supplier.name, otif: 0, total: 0 })
    }
    const b = deliveryBySupplier.get(sid)!
    b.total += 1
    if (isOtifDispatch(vpo.requiredDeliveryDate, vpo.dispatchedAt)) b.otif += 1
  }

  const varianceSum = new Map<string, { sum: number; n: number }>()
  for (const r of recons) {
    const vid = r.vendorMaterialPoLineId
    if (!vid) continue
    const sid = supplierByVmLine.get(vid)
    if (!sid) continue
    let pct = Math.abs(Number(r.variancePercent))
    if (shortClosedVmLineIds.has(vid)) pct = 0
    if (!Number.isFinite(pct)) continue
    if (!varianceSum.has(sid)) varianceSum.set(sid, { sum: 0, n: 0 })
    const vs = varianceSum.get(sid)!
    vs.sum += pct
    vs.n += 1
  }

  const supplierIds = new Set<string>()
  for (const s of suppliers) supplierIds.add(s.id)
  for (const sid of Array.from(deliveryBySupplier.keys())) supplierIds.add(sid)
  for (const sid of Array.from(varianceSum.keys())) supplierIds.add(sid)

  const nameById = new Map(suppliers.map((s) => [s.id, s.name]))
  const out = new Map<string, VendorReliabilitySnapshot>()

  for (const sid of Array.from(supplierIds)) {
    const d = deliveryBySupplier.get(sid)
    const deliveryScore =
      d && d.total > 0 ? (d.otif / d.total) * 100 : neutralScore('delivery')

    const vs = varianceSum.get(sid)
    const avgAbs = vs && vs.n > 0 ? vs.sum / vs.n : null
    const weightScore =
      avgAbs != null ? clamp((1 - avgAbs / 100) * 100, 0, 100) : neutralScore('weight')

    let composite = 0.6 * deliveryScore + 0.4 * weightScore
    if (d && d.total === 0 && avgAbs == null) composite = 75
    composite = clamp(composite, 0, 100)

    const name = nameById.get(sid) ?? d?.name ?? 'Supplier'
    out.set(sid, {
      supplierId: sid,
      supplierName: name,
      deliveryScore: Math.round(deliveryScore * 10) / 10,
      weightScore: Math.round(weightScore * 10) / 10,
      compositeScore: Math.round(composite * 10) / 10,
      grade: compositeGrade(composite),
      otifCount: d?.otif ?? 0,
      totalDeliveryOrders: d?.total ?? 0,
      avgAbsVariancePct: avgAbs != null ? Math.round(avgAbs * 100) / 100 : null,
    })
  }

  return out
}

export type MonthlyDeliveryAccuracy = { monthKey: string; label: string; accuracyPct: number; orders: number }

export type SupplierScorecardDetail = {
  supplierId: string
  supplierName: string
  snapshot: VendorReliabilitySnapshot
  monthlyDeliveryAccuracy: MonthlyDeliveryAccuracy[]
  cumulativeWeightLossKg: number
  avgLeadTimeDays: number | null
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const dt = new Date(y!, (m ?? 1) - 1, 1)
  return dt.toLocaleString('en-IN', { month: 'short', year: 'numeric' })
}

/** Director audit: last 6 months OTIF%, cumulative short kg, mean dispatch→recon lead. */
export async function getSupplierScorecardDetail(
  db: PrismaClient,
  supplierId: string,
): Promise<SupplierScorecardDetail | null> {
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, active: true },
  })
  if (!supplier) return null

  const scores = await computeVendorReliabilityScores(db)
  const snapshot =
    scores.get(supplierId) ??
    ({
      supplierId,
      supplierName: supplier.name,
      deliveryScore: 75,
      weightScore: 75,
      compositeScore: 75,
      grade: 'B',
      otifCount: 0,
      totalDeliveryOrders: 0,
      avgAbsVariancePct: null,
    } satisfies VendorReliabilitySnapshot)

  const now = new Date()
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 5, 1)
  const dispatchedWindow = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      supplierId,
      status: { in: ['dispatched', 'closed'] },
      dispatchedAt: { gte: windowStart },
    },
    select: { requiredDeliveryDate: true, dispatchedAt: true },
  })

  const byMonth = new Map<string, { otif: number; total: number }>()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const mk = monthKey(d)
    byMonth.set(mk, { otif: 0, total: 0 })
  }
  for (const p of dispatchedWindow) {
    const disp = p.dispatchedAt
    if (!disp) continue
    const mk = monthKey(disp)
    if (!byMonth.has(mk)) continue
    const b = byMonth.get(mk)!
    b.total += 1
    if (isOtifDispatch(p.requiredDeliveryDate, disp)) b.otif += 1
  }

  const months: MonthlyDeliveryAccuracy[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const mk = monthKey(d)
    const b = byMonth.get(mk) ?? { otif: 0, total: 0 }
    const accuracyPct = b.total > 0 ? Math.round((b.otif / b.total) * 1000) / 10 : 0
    months.push({ monthKey: mk, label: monthLabel(mk), accuracyPct, orders: b.total })
  }

  const vmLineIds = (
    await db.vendorMaterialPurchaseOrderLine.findMany({
      where: { vendorPo: { supplierId } },
      select: { id: true },
    })
  ).map((x) => x.id)

  let cumulativeWeightLossKg = 0
  const leadSamples: number[] = []
  if (vmLineIds.length > 0) {
    const recons = await db.materialWeightReconciliation.findMany({
      where: { vendorMaterialPoLineId: { in: vmLineIds } },
      select: {
        varianceKg: true,
        vendorMaterialPoLineId: true,
        createdAt: true,
      },
    })
    for (const r of recons) {
      const vk = Number(r.varianceKg)
      if (Number.isFinite(vk) && vk > 0) cumulativeWeightLossKg += vk
    }

    const linesWithPo = await db.vendorMaterialPurchaseOrderLine.findMany({
      where: { id: { in: vmLineIds } },
      select: {
        id: true,
        vendorPo: { select: { dispatchedAt: true } },
      },
    })
    const dispByLine = new Map(linesWithPo.map((l) => [l.id, l.vendorPo.dispatchedAt]))
    for (const r of recons) {
      const vid = r.vendorMaterialPoLineId
      if (!vid) continue
      const disp = dispByLine.get(vid)
      if (!disp) continue
      const days = (r.createdAt.getTime() - disp.getTime()) / MS_DAY
      if (Number.isFinite(days) && days >= 0 && days < 365) leadSamples.push(days)
    }
  }

  const avgLeadTimeDays =
    leadSamples.length > 0
      ? Math.round((leadSamples.reduce((a, b) => a + b, 0) / leadSamples.length) * 10) / 10
      : null

  return {
    supplierId,
    supplierName: supplier.name,
    snapshot,
    monthlyDeliveryAccuracy: months,
    cumulativeWeightLossKg: Math.round(cumulativeWeightLossKg * 1000) / 1000,
    avgLeadTimeDays,
  }
}
