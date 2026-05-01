import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

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
      const status = shortage > 0 ? 'shortage' : available > 0 ? 'available' : incoming > 0 ? 'incoming' : 'reserved'
      return {
        material_id: r.id,
        material_code: r.materialCode,
        board_type_id: r.boardType,
        board_classification_id: r.boardClassification,
        length,
        width,
        gsm: r.gsm,
        size_display: length && width ? `${Math.round(length)} x ${Math.round(width)}` : '-',
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
      return acc
    },
    { totalPhysical: 0, available: 0, reserved: 0, incoming: 0, shortage: 0, value: 0, ageingRisk: 0 },
  )

  return NextResponse.json({ rows: mapped, kpi })
}
