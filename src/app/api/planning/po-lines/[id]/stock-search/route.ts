import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { stockRowMatchesTerm, type StockSearchRow } from '@/lib/stock-search-match'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, _context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const q = (new URL(req.url).searchParams.get('q') || '').trim()
  if (q.length < 2) return NextResponse.json({ results: [] })

  const select = {
    id: true, materialCode: true, boardType: true, gsm: true,
    sheetLength: true, sheetWidth: true, storageLocation: true,
    attributes: true, qtyAvailable: true, qtyReserved: true,
    supplier: { select: { name: true } },
  } as const

  const rows = await db.inventory.findMany({
    where: {
      active: true,
      sheetLength: { gt: 0 },
      sheetWidth: { gt: 0 },
      OR: [
        { materialCode: { contains: q, mode: 'insensitive' } },
        { boardType: { contains: q, mode: 'insensitive' } },
        { storageLocation: { contains: q, mode: 'insensitive' } },
        { attributes: { contains: q } },
        { supplier: { name: { contains: q, mode: 'insensitive' } } },
      ],
    },
    select,
    take: 50,
  })

  // The indexed OR above covers every text field (incl. lot, via `attributes`). Only numeric
  // size-string / gsm terms can't be expressed there, so they alone justify the wider JS-side
  // refine scan. Gating on /\d/ avoids a 200-row scan on every pure-text no-match keystroke.
  const pool =
    rows.length > 0
      ? rows
      : /\d/.test(q)
        ? await db.inventory.findMany({
            where: { active: true, sheetLength: { gt: 0 }, sheetWidth: { gt: 0 } },
            select,
            take: 200,
          })
        : []

  const lotOf = (attributes: string | null): string | null => {
    if (!attributes) return null
    try {
      const p = JSON.parse(attributes) as Record<string, unknown>
      const v = p.lot ?? p.lotNumber ?? p.traceability
      return typeof v === 'string' ? v : null
    } catch {
      return null
    }
  }

  const results = pool
    .map((m) => {
      const free = Math.max(0, Number(m.qtyAvailable) - Number(m.qtyReserved))
      const searchRow: StockSearchRow = {
        materialCode: m.materialCode,
        boardType: m.boardType,
        gsm: m.gsm,
        sheetLength: m.sheetLength == null ? null : Number(m.sheetLength),
        sheetWidth: m.sheetWidth == null ? null : Number(m.sheetWidth),
        storageLocation: m.storageLocation,
        supplierName: m.supplier?.name ?? null,
        lot: lotOf(m.attributes),
      }
      return { m, free, searchRow }
    })
    .filter(({ searchRow }) => stockRowMatchesTerm(searchRow, q))
    .slice(0, 20)
    .map(({ m, free, searchRow }) => ({
      materialId: m.id,
      materialCode: m.materialCode,
      boardType: m.boardType,
      gsm: m.gsm,
      size: m.sheetLength && m.sheetWidth ? `${Number(m.sheetLength)} x ${Number(m.sheetWidth)}` : null,
      availableSheets: Number(m.qtyAvailable),
      reservedSheets: Number(m.qtyReserved),
      freeSheets: free,
      storageLocation: m.storageLocation,
      supplierName: searchRow.supplierName,
      lot: searchRow.lot,
    }))

  return NextResponse.json({ results })
}
