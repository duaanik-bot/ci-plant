import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const TERMINAL_STATUSES = ['cancelled', 'completed', 'on_hold', 'archived']

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: materialId } = await context.params
  const url = new URL(request.url)
  const includeReleased = url.searchParams.get('includeReleased') === 'true'

  const material = await db.inventory.findUnique({
    where: { id: materialId },
    select: {
      id: true,
      materialCode: true,
      boardType: true,
      gsm: true,
      sheetLength: true,
      sheetWidth: true,
    },
  })
  if (!material) {
    return NextResponse.json({ error: 'Material not found' }, { status: 404 })
  }

  const reservations = await db.materialReservation.findMany({
    where: {
      materialId,
      ...(includeReleased ? {} : { isReleased: false }),
    },
    include: {
      jobCard: {
        select: {
          id: true,
          jobCardNumber: true,
          status: true,
          customer: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const rows = reservations.map((r) => {
    const isManual = r.jobCardId === null || !r.jobCard
    const isGhost = !r.isReleased && !!r.jobCard && TERMINAL_STATUSES.includes(r.jobCard.status)
    return {
      id: r.id,
      jobCardId: r.jobCardId,
      jobCardNumber: r.jobCard?.jobCardNumber ?? null,
      customerName: r.jobCard?.customer.name ?? 'Manual reservation',
      jobStatus: r.jobCard?.status ?? 'manual',
      requiredSheets: Number(r.requiredSheets),
      reservedSheets: Number(r.reservedSheets),
      confirmedQty: r.confirmedQty,
      isReleased: r.isReleased,
      releasedAt: r.releasedAt?.toISOString() ?? null,
      releasedReason: r.releasedReason,
      isManual,
      isGhost,
      createdAt: r.createdAt.toISOString(),
    }
  })

  // Ghosts first (oldest first), then active (newest first)
  rows.sort((a, b) => {
    if (a.isGhost !== b.isGhost) return a.isGhost ? -1 : 1
    if (a.isGhost) return a.createdAt.localeCompare(b.createdAt)
    return b.createdAt.localeCompare(a.createdAt)
  })

  const ghostCount = rows.filter((r) => r.isGhost).length
  const totalReserved = rows.reduce((s, r) => s + r.reservedSheets, 0)

  const sheetLength = material.sheetLength ? Number(material.sheetLength) : null
  const sheetWidth = material.sheetWidth ? Number(material.sheetWidth) : null
  const sizeLabel =
    sheetLength && sheetWidth ? `${sheetLength} x ${sheetWidth}` : null

  return NextResponse.json({
    materialId: material.id,
    materialCode: material.materialCode,
    materialSpec: {
      boardType: material.boardType,
      gsm: material.gsm,
      sizeLabel,
      sheetLength,
      sheetWidth,
    },
    totalReserved,
    ghostCount,
    reservations: rows,
  })
}
