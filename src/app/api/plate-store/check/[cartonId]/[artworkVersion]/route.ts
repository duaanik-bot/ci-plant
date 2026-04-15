import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  context: { params: Promise<{ cartonId: string; artworkVersion: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { cartonId, artworkVersion } = await context.params
  const decodedVersion = decodeURIComponent(artworkVersion)

  const plates = await db.plateStore.findMany({
    where: {
      cartonId,
      artworkVersion: decodedVersion,
    },
    orderBy: { createdAt: 'desc' },
    include: { customer: { select: { id: true, name: true } } },
  })

  const available = plates.map((p) => {
    const colourList = Array.isArray(p.colours)
      ? (p.colours as Array<{ name?: string; status?: string }>).map((c) => ({
          name: c.name ?? 'Unknown',
          status: c.status ?? 'new',
          available: (c.status ?? 'new') !== 'destroyed',
        }))
      : []
    const allAvailable = colourList.every((c) => c.available)
    const oldCount = colourList.filter((c) => c.status === 'old').length
    const newCount = colourList.filter((c) => c.status === 'new').length
    return {
      id: p.id,
      plateSetCode: p.plateSetCode,
      cartonName: p.cartonName,
      customer: p.customer,
      numberOfColours: p.numberOfColours,
      colours: colourList,
      newPlates: p.newPlates,
      oldPlates: p.oldPlates,
      totalPlates: p.totalPlates,
      storageLocation: p.rackLocation,
      status: p.status,
      ctpDate: p.ctpDate?.toISOString().slice(0, 10) ?? null,
      collectedAt: p.returnedAt?.toISOString() ?? null,
      allAvailable,
      oldCount,
      newCount,
    }
  })

  return NextResponse.json({
    cartonId,
    artworkVersion: decodedVersion,
    plates: available,
    hasPlates: available.length > 0,
  })
}
