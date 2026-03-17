import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [supplierCount, grnCount, invAgg, dispatchAgg, fgAgg] = await Promise.all([
    db.supplier.count({ where: { active: true } }),
    db.stockMovement.aggregate({
      where: { movementType: 'grn_quarantine', createdAt: { gte: startOfMonth } },
      _count: true,
      _sum: { qty: true },
    }),
    db.inventory.aggregate({
      where: { active: true },
      _sum: {
        qtyQuarantine: true,
        qtyAvailable: true,
        qtyReserved: true,
        qtyFg: true,
        weightedAvgCost: true,
      },
    }),
    db.dispatch.aggregate({
      where: { dispatchedAt: { gte: startOfMonth }, status: 'dispatched' },
      _sum: { qtyDispatched: true },
    }),
    db.inventory.aggregate({
      where: { active: true },
      _sum: { qtyFg: true },
    }),
  ])

  const inv = await db.inventory.findMany({
    where: { active: true },
    select: { qtyQuarantine: true, qtyAvailable: true, qtyReserved: true, weightedAvgCost: true },
  })
  const valueQuarantine = inv.reduce((s, i) => s + Number(i.qtyQuarantine) * Number(i.weightedAvgCost), 0)
  const valueAvailable = inv.reduce((s, i) => s + Number(i.qtyAvailable) * Number(i.weightedAvgCost), 0)
  const valueReserved = inv.reduce((s, i) => s + Number(i.qtyReserved) * Number(i.weightedAvgCost), 0)

  const grnValue = 0

  return NextResponse.json({
    approvedSuppliers: supplierCount,
    grnThisMonth: grnCount._count,
    grnValueReceived: grnValue,
    quarantineLots: grnCount._count,
    quarantineTotal: Number(grnCount._sum.qty ?? 0),
    availableMaterials: inv.length,
    availableValue: valueAvailable,
    reservedValue: valueReserved,
    fgCartons: Number(fgAgg._sum.qtyFg ?? 0),
    wasteLedgerPct: 0,
    fgPallets: Math.ceil(Number(fgAgg._sum.qtyFg ?? 0) / 1000),
    fgAvailable: 0,
    fgOnHold: 0,
    fgBlocked: 0,
    dispatchedThisMonth: Number(dispatchAgg._sum.qtyDispatched ?? 0),
    dispatchedValue: 0,
  })
}
