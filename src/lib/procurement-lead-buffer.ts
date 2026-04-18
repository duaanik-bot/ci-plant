import type { PrismaClient, PurchaseOrder } from '@prisma/client'
import { addCalendarDaysYmd, parseDeliveryYmdFromRemarks } from '@/lib/po-delivery-parse'
import { effectiveLogisticsLane } from '@/lib/procurement-logistics-hud'

/** Factory / vendor schedule reference — all buffer math uses IST calendar boundaries. */
export const FACTORY_TIMEZONE = 'Asia/Kolkata' as const

/** Industrial audit label for delay warning sends. */
export const DELAY_WARNING_ACTIONED_BY = 'Actioned by Anik Dua'

export type LeadBufferLevel = 'ok' | 'at_risk' | 'critical'

export type LeadBufferSnapshot = {
  bufferHours: number
  level: LeadBufferLevel
  badgeLabel: string
  vendorPoId: string
  vendorPoNumber: string
  vendorEtaYmd: string
  productionTargetYmd: string
  primaryCustomerName: string
  supplierId: string
}

/** Format a Date in IST as YYYY-MM-DD (for comparison with planning dates). */
export function ymdInFactoryTZ(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: FACTORY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(d)
}

function customerDeliveryYmd(po: Pick<PurchaseOrder, 'deliveryRequiredBy' | 'remarks'>): string | null {
  if (po.deliveryRequiredBy) {
    return ymdInFactoryTZ(po.deliveryRequiredBy)
  }
  return parseDeliveryYmdFromRemarks(po.remarks)
}

/** Production material need-by: customer delivery minus 5 days (aligned with MRP vendor gate). */
export function productionTargetYmdForPo(
  po: Pick<PurchaseOrder, 'deliveryRequiredBy' | 'remarks'>,
): string | null {
  const cust = customerDeliveryYmd(po)
  if (!cust) return null
  return addCalendarDaysYmd(cust, -5) ?? cust
}

/** Buffer in hours: Vendor_ETA (start of IST day) − Production_Target (start of IST day). */
export function bufferHoursIst(vendorEtaYmd: string, productionTargetYmd: string): number {
  const v = Date.parse(`${vendorEtaYmd}T00:00:00+05:30`)
  const p = Date.parse(`${productionTargetYmd}T00:00:00+05:30`)
  if (!Number.isFinite(v) || !Number.isFinite(p)) return NaN
  return (v - p) / 3_600_000
}

export function levelFromBufferHours(bufferHours: number): LeadBufferLevel {
  if (!Number.isFinite(bufferHours)) return 'ok'
  if (bufferHours <= 0) return 'critical'
  if (bufferHours < 48) return 'at_risk'
  return 'ok'
}

/** High-contrast label e.g. "+3 Days", "-6 Hours". */
export function formatBufferBadge(bufferHours: number): string {
  if (!Number.isFinite(bufferHours)) return '—'
  if (bufferHours >= 24 || bufferHours <= -24) {
    const days = bufferHours / 24
    const rounded = Math.round(days * 10) / 10
    const sign = rounded > 0 ? '+' : ''
    return `${sign}${rounded} Days`
  }
  const h = Math.round(bufferHours)
  const sign = h > 0 ? '+' : ''
  return `${sign}${h} Hours`
}

export type VendorPoForLeadBuffer = {
  id: string
  poNumber: string
  status: string
  isShortClosed: boolean
  requiredDeliveryDate: Date | null
  dispatchedAt: Date | null
  logisticsStatus: string | null
  lrNumber: string | null
  vehicleNumber: string | null
  estimatedArrivalAt: Date | null
  supplier: { id: string; name: string }
  lines: { linkedPoLineIds: unknown }[]
}

/** Lead-time buffers vs production targets (IST). Reuses one vendor-PO payload from the workbench. */
export async function computeVendorPoLeadBuffers(
  db: PrismaClient,
  vendorPos: VendorPoForLeadBuffer[],
): Promise<{
  byVendorPoId: Map<string, LeadBufferSnapshot | null>
  lineIdToVendorPoIds: Map<string, string[]>
  atRiskVendorPoCount: number
}> {

  const lineIdToVendorPoIds = new Map<string, string[]>()
  const allLineIds = new Set<string>()
  for (const vpo of vendorPos) {
    for (const ln of vpo.lines) {
      const raw = ln.linkedPoLineIds
      const ids = Array.isArray(raw) ? (raw as string[]) : []
      for (const id of ids) {
        allLineIds.add(id)
        if (!lineIdToVendorPoIds.has(id)) lineIdToVendorPoIds.set(id, [])
        const arr = lineIdToVendorPoIds.get(id)!
        if (!arr.includes(vpo.id)) arr.push(vpo.id)
      }
    }
  }

  const lines =
    allLineIds.size > 0
      ? await db.poLineItem.findMany({
          where: { id: { in: Array.from(allLineIds) } },
          include: {
            po: { select: { deliveryRequiredBy: true, remarks: true, customer: { select: { name: true } } } },
          },
        })
      : []

  const targetByLineId = new Map<string, string>()
  const customerByLineId = new Map<string, string>()
  for (const li of lines) {
    const tgt = productionTargetYmdForPo(li.po)
    if (tgt) targetByLineId.set(li.id, tgt)
    customerByLineId.set(li.id, li.po.customer.name)
  }

  const byVendorPoId = new Map<string, LeadBufferSnapshot | null>()
  let atRiskVendorPoCount = 0

  for (const vpo of vendorPos) {
    if (vpo.status === 'closed') {
      byVendorPoId.set(vpo.id, null)
      continue
    }
    const rd = vpo.requiredDeliveryDate
    const linked = new Set<string>()
    for (const ln of vpo.lines) {
      const raw = ln.linkedPoLineIds
      const ids = Array.isArray(raw) ? (raw as string[]) : []
      for (const id of ids) linked.add(id)
    }
    const targets: string[] = []
    const names: string[] = []
    for (const lid of Array.from(linked)) {
      const t = targetByLineId.get(lid)
      if (t) targets.push(t)
      const n = customerByLineId.get(lid)
      if (n) names.push(n)
    }
    if (targets.length === 0) {
      byVendorPoId.set(vpo.id, null)
      continue
    }
    targets.sort()
    const productionTargetYmd = targets[0]!
    const lane = effectiveLogisticsLane(vpo)
    let bufferHours: number
    let vendorEtaYmd: string

    if (
      (lane === 'in_transit' || lane === 'at_gate') &&
      vpo.estimatedArrivalAt
    ) {
      const p = Date.parse(`${productionTargetYmd}T00:00:00+05:30`)
      if (!Number.isFinite(p)) {
        byVendorPoId.set(vpo.id, null)
        continue
      }
      bufferHours = (vpo.estimatedArrivalAt.getTime() - p) / 3_600_000
      vendorEtaYmd = ymdInFactoryTZ(vpo.estimatedArrivalAt)
    } else if (rd) {
      vendorEtaYmd = ymdInFactoryTZ(rd)
      bufferHours = bufferHoursIst(vendorEtaYmd, productionTargetYmd)
    } else {
      byVendorPoId.set(vpo.id, null)
      continue
    }

    if (!Number.isFinite(bufferHours)) {
      byVendorPoId.set(vpo.id, null)
      continue
    }
    const level = levelFromBufferHours(bufferHours)
    const uniqNames = Array.from(new Set(names))
    const primaryCustomerName = uniqNames.length === 1 ? uniqNames[0]! : uniqNames.join(' / ') || 'Customer'

    const snap: LeadBufferSnapshot = {
      bufferHours,
      level,
      badgeLabel: formatBufferBadge(bufferHours),
      vendorPoId: vpo.id,
      vendorPoNumber: vpo.poNumber,
      vendorEtaYmd,
      productionTargetYmd,
      primaryCustomerName,
      supplierId: vpo.supplier.id,
    }
    byVendorPoId.set(vpo.id, snap)
    if (bufferHours < 48) atRiskVendorPoCount += 1
  }

  return { byVendorPoId, lineIdToVendorPoIds, atRiskVendorPoCount }
}

export function worstLeadBufferForRequirement<RC extends { poLineItemId: string }>(
  contributions: RC[],
  lineIdToVendorPoIds: Map<string, string[]>,
  byVendorPoId: Map<string, LeadBufferSnapshot | null>,
): LeadBufferSnapshot | null {
  const vpoSeen = new Set<string>()
  for (const c of contributions) {
    for (const vid of lineIdToVendorPoIds.get(c.poLineItemId) ?? []) {
      vpoSeen.add(vid)
    }
  }
  let worst: LeadBufferSnapshot | null = null
  for (const vid of Array.from(vpoSeen)) {
    const snap = byVendorPoId.get(vid) ?? null
    if (!snap) continue
    if (!worst || snap.bufferHours < worst.bufferHours) worst = snap
  }
  return worst
}
