import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { calculateOEE } from '@/lib/helpers'
import {
  deriveDirectorStageKey,
  toolingSnapshotFromRow,
} from '@/lib/director-command-center-lifecycle'
import { dyeMapFromRows } from '@/lib/po-tooling-critical'

export const dynamic = 'force-dynamic'

const MS_DAY = 86_400_000

function lineValue(rate: unknown, qty: number): number {
  return (rate ? Number(rate) : 0) * qty
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0)
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const now = new Date()
  const monthStart = startOfMonth(now)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_DAY)
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const sevenDays = new Date(todayMid.getTime() + 7 * MS_DAY)

  const [
    activePos,
    closedMtd,
    vendorPosOpen,
    dispatchesMtd,
    inventoryRows,
    lateCustomerPos,
    linesForStages,
    presses,
  ] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { status: { in: ['draft', 'confirmed'] } },
      include: { lineItems: true },
    }),
    db.purchaseOrder.findMany({
      where: {
        status: 'closed',
        updatedAt: { gte: monthStart },
      },
      include: { lineItems: true },
    }),
    db.vendorMaterialPurchaseOrder.findMany({
      where: { status: { in: ['draft', 'confirmed'] } },
      include: { lines: true, supplier: { select: { id: true, name: true } } },
    }),
    db.dispatch.findMany({
      where: {
        dispatchedAt: { gte: monthStart },
        status: { in: ['dispatched', 'pod_received'] },
      },
      select: { id: true, qtyDispatched: true, dispatchedAt: true },
    }),
    db.inventory.findMany({
      where: { active: true },
      select: {
        id: true,
        materialCode: true,
        description: true,
        qtyAvailable: true,
        safetyStock: true,
        unit: true,
      },
      take: 500,
    }),
    db.purchaseOrder.findMany({
      where: {
        status: { in: ['draft', 'confirmed'] },
        deliveryRequiredBy: { lt: todayMid },
      },
      select: { id: true, poNumber: true, deliveryRequiredBy: true },
    }),
    db.poLineItem.findMany({
      where: { po: { status: { in: ['draft', 'confirmed'] } } },
      include: { po: true },
      take: 500,
    }),
    db.machine.findMany({
      where: { machineCode: { in: ['CI-01', 'CI-02', 'CI-03'] } },
      select: { id: true },
    }),
  ])

  const liveOrderBook = activePos.reduce(
    (s, po) => s + po.lineItems.reduce((ls, li) => ls + lineValue(li.rate, li.quantity), 0),
    0,
  )

  /** ₹ recognized MTD from customer POs closed this month (proxy until dispatch ↔ ₹ is linked). */
  const revenueClosedPoMtd = closedMtd.reduce(
    (s, po) => s + po.lineItems.reduce((ls, li) => ls + lineValue(li.rate, li.quantity), 0),
    0,
  )

  const gatePassUnitsMtd = dispatchesMtd.reduce((s, d) => s + d.qtyDispatched, 0)

  const openMaterialSpend = vendorPosOpen.reduce((sum, vpo) => {
    const lineSum = vpo.lines.reduce((ls, li) => {
      const kg = Number(li.totalWeightKg)
      const rate = li.ratePerKg != null ? Number(li.ratePerKg) : 0
      return ls + kg * rate
    }, 0)
    return sum + lineSum
  }, 0)

  let incomingBoardKg7d = 0
  for (const vpo of vendorPosOpen) {
    const rd = vpo.requiredDeliveryDate
    if (!rd) continue
    const r = new Date(rd.getFullYear(), rd.getMonth(), rd.getDate())
    if (r >= todayMid && r <= sevenDays) {
      for (const li of vpo.lines) {
        incomingBoardKg7d += Number(li.totalWeightKg)
      }
    }
  }

  let oeeSum = 0
  for (const p of presses) {
    const o = await calculateOEE(p.id, now)
    oeeSum += o.oee
  }
  const factoryOeePct = presses.length ? Math.round((oeeSum / presses.length) * 10) / 10 : 0

  const closedPerDay = await db.purchaseOrder.findMany({
    where: {
      status: 'closed',
      updatedAt: { gte: thirtyDaysAgo },
    },
    select: { updatedAt: true, id: true },
  })
  const poIdsByDay = new Map<string, Set<string>>()
  for (const p of closedPerDay) {
    const k = dayKey(p.updatedAt)
    if (!poIdsByDay.has(k)) poIdsByDay.set(k, new Set())
    poIdsByDay.get(k)!.add(p.id)
  }

  const closedLinesByPo = await db.purchaseOrder.findMany({
    where: { id: { in: Array.from(new Set(closedPerDay.map((x) => x.id))) } },
    include: { lineItems: true },
  })
  const valueByPo = new Map(
    closedLinesByPo.map((po) => [
      po.id,
      po.lineItems.reduce((s, li) => s + lineValue(li.rate, li.quantity), 0),
    ]),
  )

  const revenueTrend30d: { day: string; value: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayMid.getTime() - i * MS_DAY)
    const k = dayKey(d)
    const ids = poIdsByDay.get(k)
    let value = 0
    if (ids) {
      for (const pid of Array.from(ids)) {
        value += valueByPo.get(pid) ?? 0
      }
    }
    revenueTrend30d.push({ day: k, value })
  }

  const dieIds = Array.from(
    new Set(linesForStages.map((l) => l.dieMasterId).filter((id): id is string => Boolean(id))),
  )
  const dyeRows =
    dieIds.length > 0
      ? await db.dye.findMany({
          where: { id: { in: dieIds }, active: true },
          select: {
            id: true,
            custodyStatus: true,
            condition: true,
            dyeNumber: true,
            location: true,
            hubStatusFlag: true,
          },
        })
      : []
  const dyeById = dyeMapFromRows(dyeRows)

  const jcNums = Array.from(
    new Set(linesForStages.map((l) => l.jobCardNumber).filter((n): n is number => n != null)),
  )
  const jcByNum = new Map<number, Awaited<ReturnType<typeof db.productionJobCard.findFirst>>>()
  for (const n of jcNums) {
    if (!jcByNum.has(n)) {
      const jc = await db.productionJobCard.findFirst({ where: { jobCardNumber: n } })
      jcByNum.set(n, jc)
    }
  }

  const stageDistribution = {
    artworks: 0,
    tooling: 0,
    material: 0,
    production: 0,
    dispatch: 0,
  }
  for (const li of linesForStages) {
    const jc = li.jobCardNumber ? jcByNum.get(li.jobCardNumber) ?? null : null
    const d = li.dieMasterId ? dyeById.get(li.dieMasterId) : undefined
    const snap = d ? toolingSnapshotFromRow(d) : null
    const key = deriveDirectorStageKey(li, li.po, jc, snap)
    if (key === 'artwork') stageDistribution.artworks++
    else if (key === 'tooling') stageDistribution.tooling++
    else if (key === 'material') stageDistribution.material++
    else if (key === 'production') stageDistribution.production++
    else stageDistribution.dispatch++
  }

  const alerts: {
    id: string
    severity: 'critical' | 'warning' | 'info'
    title: string
    detail: string
  }[] = []

  for (const inv of inventoryRows) {
    const safe = Number(inv.safetyStock)
    const avail = Number(inv.qtyAvailable)
    if (safe > 0 && avail < safe) {
      const desc = inv.description.toLowerCase()
      const isFbb300 =
        desc.includes('fbb') && (desc.includes('300') || inv.materialCode.toLowerCase().includes('300'))
      alerts.push({
        id: `stock-${inv.id}`,
        severity: avail < safe * 0.5 ? 'critical' : 'warning',
        title: isFbb300
          ? 'Low stock alert: 300 GSM FBB running below safety level.'
          : `Low stock: ${inv.materialCode}`,
        detail: `${inv.description} — available ${avail} ${inv.unit} vs safety ${safe} ${inv.unit}.`,
      })
    }
  }

  const lateVendors = vendorPosOpen.filter((v) => {
    if (!v.requiredDeliveryDate) return false
    const r = new Date(v.requiredDeliveryDate.getFullYear(), v.requiredDeliveryDate.getMonth(), v.requiredDeliveryDate.getDate())
    return r < todayMid
  })
  for (const v of lateVendors.slice(0, 8)) {
    const daysLate = Math.ceil(
      (todayMid.getTime() -
        new Date(
          v.requiredDeliveryDate!.getFullYear(),
          v.requiredDeliveryDate!.getMonth(),
          v.requiredDeliveryDate!.getDate(),
        ).getTime()) /
        MS_DAY,
    )
    alerts.push({
      id: `vendor-${v.id}`,
      severity: 'warning',
      title: `Vendor delay: ${v.supplier.name} is ${daysLate} day(s) late on ${v.poNumber}.`,
      detail: `Required delivery was ${v.requiredDeliveryDate?.toISOString().slice(0, 10)}.`,
    })
  }

  const priorityLines = linesForStages.filter((l) => l.directorPriority)
  const machineCounts = new Map<string, number>()
  for (const li of priorityLines) {
    const spec =
      li.specOverrides && typeof li.specOverrides === 'object'
        ? (li.specOverrides as Record<string, unknown>)
        : {}
    const mid = String(spec.machineId ?? '').trim()
    if (!mid) continue
    machineCounts.set(mid, (machineCounts.get(mid) ?? 0) + 1)
  }
  for (const [mid, c] of Array.from(machineCounts.entries())) {
    if (c >= 2) {
      alerts.push({
        id: `priority-machine-${mid}`,
        severity: 'warning',
        title: `Priority conflict: ${c} starred jobs targeting the same machine slot (${mid.slice(0, 8)}…).`,
        detail: 'Review Director Command Center and Planning queue for sequencing.',
      })
    }
  }

  if (lateCustomerPos.length > 0) {
    alerts.push({
      id: 'late-po-summary',
      severity: 'critical',
      title: `${lateCustomerPos.length} customer PO(s) past delivery-required date.`,
      detail: lateCustomerPos
        .slice(0, 5)
        .map((p) => p.poNumber)
        .join(', '),
    })
  }

  alerts.sort((a, b) => {
    const rank = { critical: 0, warning: 1, info: 2 }
    return rank[a.severity] - rank[b.severity]
  })

  return NextResponse.json({
    sales: {
      liveOrderBookValue: liveOrderBook,
      revenueDispatchedMtdValue: revenueClosedPoMtd,
      gatePassDispatchesMtd: dispatchesMtd.length,
      gatePassUnitsMtd,
      revenueTrend30d,
    },
    procurement: {
      openMaterialSpend,
      incomingBoardKg7d,
    },
    production: {
      factoryOeePct,
      lateOrdersPastDue: lateCustomerPos.length,
    },
    stageDistribution,
    alerts: alerts.slice(0, 25),
  })
}
