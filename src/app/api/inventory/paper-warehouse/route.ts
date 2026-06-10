import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { computeAvgDailyConsumption } from '@/lib/material-readiness-service'
import { materialSizeDisplay } from '@/lib/material-display'
import {
  clampListLimit,
  isExportRequest,
  listSkip,
  logListPerformance,
  parseListPage,
  shouldReturnPagedEnvelope,
} from '@/lib/api-list-params'

export const dynamic = 'force-dynamic'
const PAPER_WAREHOUSE_DEFAULT_LIMIT = 50
const PAPER_WAREHOUSE_MAX_LIMIT = 500

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim().toLowerCase()
  const rowsOnly = searchParams.get('rowsOnly') === '1' || searchParams.get('compact') === '1'
  const exportRequested = isExportRequest(searchParams)
  const paged = shouldReturnPagedEnvelope(searchParams) || rowsOnly
  const page = parseListPage(searchParams.get('page'))
  const limit = exportRequested
    ? clampListLimit(searchParams.get('limit'), { defaultLimit: PAPER_WAREHOUSE_MAX_LIMIT, max: 5000 })
    : clampListLimit(searchParams.get('limit'), { defaultLimit: PAPER_WAREHOUSE_DEFAULT_LIMIT, max: PAPER_WAREHOUSE_MAX_LIMIT })

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
      packetWeight: true,
      createdAt: true,
    },
  })

  if (rowsOnly) {
    const compactRowsUnpaged = rows
      .map((r) => {
        const length = r.sheetLength != null ? Number(r.sheetLength) : null
        const width = r.sheetWidth != null ? Number(r.sheetWidth) : null
        const available = Math.max(0, num(r.qtyAvailable))
        const reserved = Math.max(0, num(r.qtyReserved))
        const incoming = Math.max(0, num(r.qtyQuarantine))
        const shortage = Math.max(0, num(r.shortageSheets))
        const reorder = Math.max(0, num(r.reorderPoint))
        const free = Math.max(0, available - reserved)
        const estValue = available * num(r.weightedAvgCost)
        const ageDays = Math.max(0, Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000))
        const ageingRisk = ageDays > 60 ? 'high' : ageDays > 30 ? 'medium' : 'low'
        return {
          material_id: r.id,
          material_code: r.materialCode,
          board_type_id: r.boardType,
          board_classification_id: r.boardClassification,
          length,
          width,
          gsm: r.gsm,
          size_display: materialSizeDisplay(length, width),
          available_sheets: available,
          reserved_sheets: reserved,
          incoming_sheets: incoming,
          shortage_sheets: shortage,
          reorder_level: reorder,
          packet_weight: num(r.packetWeight),
          status: shortage > 0 ? 'Shortage' : free <= reorder ? 'Watch' : 'Covered',
          est_value_inr: estValue,
          age_days: ageDays,
          ageing_risk: ageingRisk,
          open_pr_id: null,
          open_pr_status: null,
          hasOpenPo: false,
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

    const compactRows = exportRequested
      ? compactRowsUnpaged
      : compactRowsUnpaged.slice(listSkip(page, limit), listSkip(page, limit) + limit)

    logListPerformance({
      route: '/api/inventory/paper-warehouse',
      startedAt,
      rowCount: compactRows.length,
      limit: exportRequested ? null : limit,
      mode: 'compact',
      exportRequested,
    })

    return NextResponse.json({
      rows: compactRows,
      ...(paged
        ? {
            meta: {
              page,
              limit: exportRequested ? compactRows.length : limit,
              total: compactRowsUnpaged.length,
              hasMore: !exportRequested && page * limit < compactRowsUnpaged.length,
              mode: 'compact',
            },
          }
        : {}),
    })
  }

  const mappedUnpaged = rows
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
      const free = Math.max(0, available - reserved)
      const status =
        shortage > 0
          ? 'Shortage'
          : incoming > 0
            ? 'Incoming'
            : free <= reorder
              ? 'Watch'
              : 'Covered'
      return {
        material_id: r.id,
        material_code: r.materialCode,
        board_type_id: r.boardType,
        board_classification_id: r.boardClassification,
        length,
        width,
        gsm: r.gsm,
        size_display: materialSizeDisplay(length, width),
        available_sheets: available,
        reserved_sheets: reserved,
        incoming_sheets: incoming,
        shortage_sheets: shortage,
        reorder_level: reorder,
        packet_weight: num(r.packetWeight),
        status,
        est_value_inr: estValue,
        age_days: ageDays,
        ageing_risk: ageingRisk,
        open_pr_id: null,
        open_pr_status: null,
        hasOpenPo: false,
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

  const kpi = mappedUnpaged.reduce(
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

  const freeStock = kpi.available
  const incomingRequiredMismatch = Math.max(0, kpi.shortage - kpi.incoming)

  const pageRows = exportRequested
    ? mappedUnpaged
    : mappedUnpaged.slice(listSkip(page, limit), listSkip(page, limit) + limit)
  const materialIds = pageRows.map((r) => r.material_id).filter(Boolean) as string[]
  const consumption = await computeAvgDailyConsumption(materialIds)
  const rowsWithDoC = pageRows.map((r) => {
    const avg = consumption.get(r.material_id) ?? 0
    const freeStockRow = Math.max(0, r.available_sheets)
    return {
      ...r,
      daysOfCover: avg > 0 ? Math.floor(freeStockRow / avg) : null,
    }
  })

  logListPerformance({
    route: '/api/inventory/paper-warehouse',
    startedAt,
    rowCount: rowsWithDoC.length,
    limit: exportRequested ? null : limit,
    mode: 'full',
    exportRequested,
  })

  return NextResponse.json({
    rows: rowsWithDoC,
    kpi: { ...kpi, freeStock, incomingRequiredMismatch },
    ...(paged
      ? {
          meta: {
            page,
            limit: exportRequested ? rowsWithDoC.length : limit,
            total: mappedUnpaged.length,
            hasMore: !exportRequested && page * limit < mappedUnpaged.length,
            mode: 'full',
          },
        }
      : {}),
  })
}
