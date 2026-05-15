import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { computeAvgDailyConsumption } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim().toLowerCase()

  const rows = await db.inventory.findMany({
    where: {
      active: true,
      boardType: { not: null },
      gsm: { not: null },
    },
    orderBy: [{ boardType: 'asc' }, { gsm: 'asc' }, { materialCode: 'asc' }],
    select: {
      id: true,
      materialCode: true,
      boardType: true,
      boardClassification: true,
      sheetLength: true,
      sheetWidth: true,
      gsm: true,
      qtyAvailable: true,
      qtyReserved: true,
      qtyQuarantine: true,
      shortageSheets: true,
      reorderPoint: true,
      active: true,
      weightedAvgCost: true,
      maxDailyUsage: true,
      createdAt: true,
    },
  })

  const openPrs = await db.purchaseRequisition.findMany({
    where: {
      status: { in: ['pending', 'approved', 'converted_to_po'] },
    },
    orderBy: { raisedAt: 'desc' },
    select: {
      id: true,
      materialId: true,
      status: true,
    },
  })
  const prByMaterial = new Map<string, { id: string; status: string }>()
  for (const pr of openPrs) {
    if (!prByMaterial.has(pr.materialId)) {
      prByMaterial.set(pr.materialId, { id: pr.id, status: pr.status })
    }
  }

  const mapped = rows
    .map((r) => {
      const length = r.sheetLength != null ? Number(r.sheetLength) : null
      const width = r.sheetWidth != null ? Number(r.sheetWidth) : null
      const available = Math.max(0, num(r.qtyAvailable))
      const reserved = Math.max(0, num(r.qtyReserved))
      const incoming = Math.max(0, num(r.qtyQuarantine))
      const shortage = Math.max(0, num(r.shortageSheets))
      const reorder = Math.max(0, num(r.reorderPoint))
      const estValue = available * num(r.weightedAvgCost)
      const ageDays = Math.max(0, Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000))
      const ageingRisk = ageDays > 60 ? 'high' : ageDays > 30 ? 'medium' : 'low'
      const isLeftover = String(r.materialCode || '').toUpperCase().startsWith('LEFTOVER-')
      const status = isLeftover
        ? 'leftover'
        : shortage > 0
          ? 'shortage'
          : available > 0
            ? 'available'
            : incoming > 0
              ? 'incoming'
              : 'reserved'
      const openPr = prByMaterial.get(r.id) || null
      return {
        material_id: r.id,
        material_code: r.materialCode,
        board_type_id: r.boardType,
        board_classification_id: r.boardClassification,
        length,
        width,
        gsm: r.gsm,
        size_display: length && width ? `${length} x ${width}` : '-',
        available_sheets: available,
        reserved_sheets: reserved,
        incoming_sheets: incoming,
        shortage_sheets: shortage,
        reorder_level: reorder,
        packet_weight: num(r.maxDailyUsage),
        status,
        est_value_inr: estValue,
        age_days: ageDays,
        ageing_risk: ageingRisk,
        open_pr_id: openPr?.id ?? null,
        open_pr_status: openPr?.status ?? null,
      }
    })
    .filter((r) => {
      if (!q) return true
      return [
        r.material_code,
        r.board_type_id || '',
        r.board_classification_id || '',
        r.size_display,
        String(r.gsm || ''),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })

  const kpi = mapped.reduce(
    (acc, r) => {
      acc.totalPhysical += r.available_sheets + r.reserved_sheets + r.incoming_sheets
      acc.available += r.available_sheets
      acc.reserved += r.reserved_sheets
      acc.incoming += r.incoming_sheets
      acc.shortage += r.shortage_sheets
      acc.value += r.est_value_inr
      if (r.ageing_risk === 'high') acc.ageingRisk += r.est_value_inr
      if (r.age_days > 180) acc.staleStock += r.est_value_inr
      if (r.packet_weight > 0) acc.fastMoving += 1
      else acc.slowMoving += 1
      return acc
    },
    {
      totalPhysical: 0,
      available: 0,
      reserved: 0,
      incoming: 0,
      shortage: 0,
      value: 0,
      ageingRisk: 0,
      staleStock: 0,
      fastMoving: 0,
      slowMoving: 0,
    },
  )

  const freeStock = kpi.available - kpi.reserved
  const incomingRequiredMismatch = Math.max(0, kpi.shortage - kpi.incoming)

  const materialIds = mapped.map((r) => r.material_id).filter(Boolean) as string[]
  const consumption = await computeAvgDailyConsumption(materialIds)
  const rowsWithDoC = mapped.map((r) => {
    const avg = consumption.get(r.material_id) ?? 0
    const freeStockRow = Math.max(0, r.available_sheets - r.reserved_sheets)
    return {
      ...r,
      daysOfCover: avg > 0 ? Math.floor(freeStockRow / avg) : null,
    }
  })

  return NextResponse.json({ rows: rowsWithDoC, kpi: { ...kpi, freeStock, incomingRequiredMismatch } })
}
