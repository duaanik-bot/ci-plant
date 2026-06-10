import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { n, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const format = req.nextUrl.searchParams.get('export')
  const supplier = await db.supplier.findUnique({
    where: { id },
    include: { vendorMaterialPos: { orderBy: { orderDate: 'desc' }, include: { lines: true, receipts: true } } },
  })
  if (!supplier) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rows = supplier.vendorMaterialPos.flatMap((po) => po.lines.map((line) => ({
    poNumber: po.poNumber,
    date: ymd(po.orderDate),
    item: line.boardGrade,
    qtyKg: n(line.totalWeightKg),
    rate: n(line.ratePerKg),
    value: n(line.totalWeightKg) * n(line.ratePerKg),
    receivedKg: n(po.totalUsableReceivedKg),
    status: po.status,
  })))
  if (format === 'csv') {
    const headers = Object.keys(rows[0] ?? { poNumber: '', date: '', item: '', qtyKg: '', rate: '', value: '', receivedKg: '', status: '' })
    const body = [headers.join(','), ...rows.map((r) => headers.map((h) => JSON.stringify((r as Record<string, unknown>)[h] ?? '')).join(','))].join('\n')
    return new NextResponse(body, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${supplier.name.replace(/[^a-z0-9-_]/gi, '_')}-purchase-history.csv"` } })
  }
  return NextResponse.json({ supplier: { id: supplier.id, name: supplier.name }, rows })
}
