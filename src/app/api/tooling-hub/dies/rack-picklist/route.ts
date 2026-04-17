import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { CUSTODY_IN_STOCK } from '@/lib/inventory-hub-custody'

export const dynamic = 'force-dynamic'

/** Searchable list of live-inventory dies for Manual Link (any dimensions). */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim().toLowerCase() ?? ''
  const take = Math.min(80, Math.max(5, parseInt(req.nextUrl.searchParams.get('limit') ?? '40', 10) || 40))

  const nExact = q && /^\d+$/.test(q) ? parseInt(q, 10) : NaN
  const rows = await db.dye.findMany({
    where: {
      active: true,
      custodyStatus: CUSTODY_IN_STOCK,
      ...(q
        ? {
            OR: [
              { cartonSize: { contains: q, mode: 'insensitive' as const } },
              { dyeType: { contains: q, mode: 'insensitive' as const } },
              { pastingType: { contains: q, mode: 'insensitive' as const } },
              ...(Number.isFinite(nExact) ? [{ dyeNumber: nExact }] : []),
            ],
          }
        : {}),
    },
    orderBy: { dyeNumber: 'asc' },
    take,
    select: {
      id: true,
      dyeNumber: true,
      cartonSize: true,
      sheetSize: true,
      ups: true,
      location: true,
      pastingType: true,
    },
  })

  return NextResponse.json({
    items: rows.map((r) => ({
      id: r.id,
      displayCode: `DYE-${r.dyeNumber}`,
      subtitle: `${r.cartonSize?.trim() || '—'} · UPS ${r.ups}${r.location?.trim() ? ` · ${r.location.trim()}` : ''}`,
    })),
  })
}
