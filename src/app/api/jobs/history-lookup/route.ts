import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { parseDesignerCommand, type DesignerCommand } from '@/lib/designer-command'

export const dynamic = 'force-dynamic'

type HistoryPayload = {
  setNumber: string | null
  actualSheetSize: string | null
  numberOfUps: number | null
  previousDesignerCommand: DesignerCommand | null
}

function parseSpec(specOverrides: unknown): {
  actualSheetSize: string | null
  numberOfUps: number | null
} {
  const spec = (specOverrides as Record<string, unknown> | null) || {}
  const actualSheetSize =
    typeof spec.actualSheetSize === 'string' && spec.actualSheetSize.trim()
      ? spec.actualSheetSize.trim()
      : null
  let numberOfUps: number | null = null
  if (typeof spec.ups === 'number' && Number.isFinite(spec.ups)) numberOfUps = spec.ups
  else if (typeof spec.numberOfUps === 'number' && Number.isFinite(spec.numberOfUps))
    numberOfUps = spec.numberOfUps
  return { actualSheetSize, numberOfUps }
}

function previousDesignerFromSpec(specOverrides: unknown): DesignerCommand | null {
  const spec = (specOverrides as Record<string, unknown> | null) || {}
  const raw = spec.designerCommand
  if (!raw || typeof raw !== 'object') return null
  return parseDesignerCommand(raw)
}

function rowToPayload(row: {
  setNumber: string | null
  specOverrides: unknown
}): HistoryPayload {
  const sn = row.setNumber?.trim()
  const { actualSheetSize, numberOfUps } = parseSpec(row.specOverrides)
  return {
    setNumber: sn || null,
    actualSheetSize,
    numberOfUps,
    previousDesignerCommand: previousDesignerFromSpec(row.specOverrides),
  }
}

async function resolveArtworkId(
  explicit: string | null,
  awCode: string | null,
): Promise<string | null> {
  if (explicit?.trim()) return explicit.trim()
  const code = awCode?.trim()
  if (!code) return null
  const a = await db.artwork.findFirst({
    where: { filename: { equals: code, mode: 'insensitive' } },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  })
  return a?.id ?? null
}

/**
 * Pre-press history: latest plate store row for carton + artwork, then line spec from linked job card.
 * Falls back to another PO line on the same carton when no plate row exists.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const cartonId = (req.nextUrl.searchParams.get('cartonId') || '').trim()
  const awCode = (req.nextUrl.searchParams.get('awCode') || '').trim()
  const artworkIdParam = (req.nextUrl.searchParams.get('artworkId') || '').trim()
  const excludeLineId = (req.nextUrl.searchParams.get('excludeLineId') || '').trim()

  if (!cartonId) {
    return NextResponse.json({ error: 'cartonId is required' }, { status: 400 })
  }

  const baseLineWhere: Prisma.PoLineItemWhereInput = {
    cartonId,
    ...(excludeLineId ? { id: { not: excludeLineId } } : {}),
  }

  const artworkId = await resolveArtworkId(artworkIdParam || null, awCode || null)

  const plateWhere: Prisma.PlateStoreWhereInput = {
    cartonId,
    status: { in: ['ready', 'returned'] },
  }
  if (artworkId) {
    plateWhere.artworkId = artworkId
  }

  let plate = await db.plateStore.findFirst({
    where: plateWhere,
    orderBy: { createdAt: 'desc' },
    include: { createdForJobCard: true },
  })

  if (!plate && artworkId) {
    plate = await db.plateStore.findFirst({
      where: {
        cartonId,
        status: { in: ['ready', 'returned'] },
      },
      orderBy: { createdAt: 'desc' },
      include: { createdForJobCard: true },
    })
  }

  if (plate?.createdForJobCard?.jobCardNumber != null) {
    const line = await db.poLineItem.findFirst({
      where: {
        jobCardNumber: plate.createdForJobCard.jobCardNumber,
        ...(excludeLineId ? { id: { not: excludeLineId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { setNumber: true, specOverrides: true },
    })
    if (line) {
      return NextResponse.json(rowToPayload(line))
    }
    const jc = plate.createdForJobCard
    return NextResponse.json({
      setNumber: jc.setNumber?.trim() || null,
      actualSheetSize: null,
      numberOfUps: null,
      previousDesignerCommand: null,
    } satisfies HistoryPayload)
  }

  const fallbackLine = await db.poLineItem.findFirst({
    where: baseLineWhere,
    orderBy: { createdAt: 'desc' },
    select: { setNumber: true, specOverrides: true },
  })

  if (!fallbackLine) {
    return NextResponse.json({ error: 'NO_HISTORY' }, { status: 404 })
  }

  return NextResponse.json(rowToPayload(fallbackLine))
}
