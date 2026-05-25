import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import {
  buildCartonSpecPack,
  readCartonSpecPack,
  type CartonForPack,
  type SpecPackV1,
} from '@/lib/carton-spec-pack'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { error } = await requireAuth()
  if (error) return error

  const c = await db.carton.findUnique({ where: { id: params.id } })
  if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Backfill source: the carton's most recent PO line snapshot, scoped to the
  // same customer. Editing an existing PO passes excludePoId so a line never
  // backfills from its own PO.
  const excludePoId = req.nextUrl.searchParams.get('excludePoId')?.trim() || undefined
  const customerId = req.nextUrl.searchParams.get('customerId')?.trim() || undefined
  const recentLines = customerId
    ? await db.poLineItem.findMany({
        where: {
          cartonId: params.id,
          po: { customerId },
          ...(excludePoId ? { poId: { not: excludePoId } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { specPack: true, specOverrides: true },
      })
    : []
  let lastPoPack: SpecPackV1 | null = null
  for (const ln of recentLines) {
    if (!ln.specPack) continue
    const { pack, legacy } = readCartonSpecPack({
      specPack: ln.specPack,
      specOverrides: ln.specOverrides,
    })
    if (!legacy) {
      lastPoPack = pack
      break
    }
  }

  return NextResponse.json({
    pack: buildCartonSpecPack(c as unknown as CartonForPack),
    lastPoPack,
  })
}
