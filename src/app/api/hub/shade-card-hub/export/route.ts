import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { queryShadeCardHubRows } from '@/lib/shade-card-hub-rows'
import { shadeCardKanbanColumn, type ShadeKanbanColumnId } from '@/lib/shade-card-kanban'
import { SHADE_MASTER_RACK_LOCATION } from '@/lib/inventory-hub-custody'
import { SHADE_CARD_ACTION } from '@/lib/shade-card-events'

export const dynamic = 'force-dynamic'

type HubRow = Awaited<ReturnType<typeof queryShadeCardHubRows>>[number]

const LANES = new Set<string>(['all', 'in_stock', 'on_floor', 'reverify', 'expired'])

function csvEscape(cell: string): string {
  if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`
  return cell
}

function productIdentity(row: HubRow): string {
  const client = row.product?.customer?.name?.trim() || row.customer?.name?.trim() || ''
  const prod = row.product?.cartonName?.trim() || row.productMaster?.trim() || ''
  if (client && prod) return `${client} — ${prod}`
  return client || prod || ''
}

function currentCustodian(row: HubRow): string {
  if (row.custodyStatus === 'on_floor') {
    const op = row.issuedOperator?.trim() || ''
    const mc = row.currentHolder?.trim() || ''
    if (op && mc) return `${op} @ ${mc}`
    return [op, mc].filter(Boolean).join(' ') || ''
  }
  return (row.currentHolder ?? '').trim() || SHADE_MASTER_RACK_LOCATION
}

function avgPerformance(row: HubRow): string {
  const log = row.spectroScanLog ?? []
  const nums = log.map((e) => e.deltaE).filter((x): x is number => typeof x === 'number' && !Number.isNaN(x))
  if (nums.length > 0) {
    const s = nums.reduce((a, b) => a + b, 0)
    return (s / nums.length).toFixed(3)
  }
  if (row.deltaEReading != null) return String(row.deltaEReading)
  return ''
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const laneRaw = req.nextUrl.searchParams.get('lane')?.trim() ?? 'all'
  const lane: 'all' | ShadeKanbanColumnId = LANES.has(laneRaw) ? (laneRaw as 'all' | ShadeKanbanColumnId) : 'all'

  let rows = await queryShadeCardHubRows(q)
  if (lane !== 'all') {
    rows = rows.filter((r) => shadeCardKanbanColumn(r) === lane)
  }

  const ids = rows.map((r) => r.id)
  const issueAgg =
    ids.length === 0
      ? []
      : await db.shadeCardEvent.groupBy({
          by: ['shadeCardId'],
          where: { shadeCardId: { in: ids }, actionType: SHADE_CARD_ACTION.ISSUED },
          _count: { id: true },
        })
  const countMap = new Map(issueAgg.map((g) => [g.shadeCardId, g._count.id]))

  const headers = [
    'Product_Identity',
    'Card_ID',
    'Current_Age',
    'Total_Uses',
    'Avg_Performance',
    'Current_Custodian',
  ]
  const lines = [headers.join(',')]
  for (const r of rows) {
    const identity = productIdentity(r)
    const cardId = r.id
    const totalUses = countMap.get(r.id) ?? 0
    const age = r.currentAgeMonths != null ? String(r.currentAgeMonths) : ''
    const custodian = currentCustodian(r)
    lines.push(
      [
        csvEscape(identity),
        csvEscape(cardId),
        csvEscape(age),
        csvEscape(String(totalUses)),
        csvEscape(avgPerformance(r)),
        csvEscape(custodian),
      ].join(','),
    )
  }

  const bom = '\uFEFF'
  const csv = bom + lines.join('\r\n')
  const stamp = new Date().toISOString().slice(0, 10)

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="shade-card-high-intensity-export-${stamp}.csv"`,
    },
  })
}
