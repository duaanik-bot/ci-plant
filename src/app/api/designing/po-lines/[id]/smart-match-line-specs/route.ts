import { NextRequest, NextResponse } from 'next/server'
import type { PlateSize } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { formatDimsLwhFromDb } from '@/lib/die-hub-dimensions'

export const dynamic = 'force-dynamic'

function plateSizeLabel(p: PlateSize | null | undefined): string | null {
  if (!p) return null
  if (p === 'SIZE_560_670') return '560 × 670'
  if (p === 'SIZE_630_700') return '630 × 700'
  return null
}

function fmtMasterLwh(carton: {
  finishedLength: unknown
  finishedWidth: unknown
  finishedHeight: unknown
}): string | null {
  const fmt = (v: unknown) => {
    if (v == null || v === '') return ''
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : String(v)
  }
  const L = fmt(carton.finishedLength)
  const W = fmt(carton.finishedWidth)
  const H = fmt(carton.finishedHeight)
  return L && W && H ? `${L}×${W}×${H}` : null
}

/**
 * GET — Merge Product Master + Job History (same customer, carton, set #) for AW Queue Smart Match.
 * Query: setNumber (required).
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params
  const setTrim = (req.nextUrl.searchParams.get('setNumber') || '').trim()
  if (!setTrim) {
    return NextResponse.json({ error: 'setNumber is required' }, { status: 400 })
  }

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: {
      cartonId: true,
      po: { select: { customerId: true } },
    },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  if (!line.cartonId) {
    return NextResponse.json({
      awCode: null,
      actualSheetSize: null,
      numberOfUps: null,
      cartonLwh: null,
      revisionDate: null,
      hasProductDie: false,
      hasProductEmboss: false,
      sources: {},
    })
  }

  const hist = await db.poLineItem.findFirst({
    where: {
      id: { not: lineId },
      cartonId: line.cartonId,
      po: { customerId: line.po.customerId },
      setNumber: setTrim,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      artworkCode: true,
      cartonSize: true,
      specOverrides: true,
      dimLengthMm: true,
      dimWidthMm: true,
      dimHeightMm: true,
      createdAt: true,
    },
  })

  const specHist = (hist?.specOverrides || {}) as Record<string, unknown>
  const histSheet =
    typeof specHist.actualSheetSize === 'string' ? specHist.actualSheetSize.trim() : ''
  const histUpsRaw = specHist.ups ?? specHist.numberOfUps
  const histUps =
    typeof histUpsRaw === 'number' && Number.isFinite(histUpsRaw) && histUpsRaw > 0
      ? histUpsRaw
      : null

  const histLwhFromDb =
    hist &&
    hist.dimLengthMm != null &&
    hist.dimWidthMm != null &&
    hist.dimHeightMm != null
      ? formatDimsLwhFromDb({
          dimLengthMm: hist.dimLengthMm as { toString(): string },
          dimWidthMm: hist.dimWidthMm as { toString(): string },
          dimHeightMm: hist.dimHeightMm as { toString(): string },
        })
      : null
  const histCarton =
    (hist?.cartonSize?.trim() || histLwhFromDb || '').trim() || null

  const carton = await db.carton.findUnique({
    where: { id: line.cartonId },
    select: {
      artworkCode: true,
      plateSize: true,
      finishedLength: true,
      finishedWidth: true,
      finishedHeight: true,
      updatedAt: true,
      dieMasterId: true,
      embossBlockId: true,
      dieMaster: {
        select: {
          sheetSize: true,
          ups: true,
        },
      },
    },
  })

  if (!carton) {
    return NextResponse.json({
      awCode: null,
      actualSheetSize: null,
      numberOfUps: null,
      cartonLwh: null,
      revisionDate: null,
      hasProductDie: false,
      hasProductEmboss: false,
      sources: {},
    })
  }

  const masterAw = carton.artworkCode?.trim() || null
  const sheetFromMaster = carton.dieMaster?.sheetSize?.trim() || null
  const sheetFromPlate = plateSizeLabel(carton.plateSize)
  const masterSheet = sheetFromMaster || sheetFromPlate
  const masterUps = carton.dieMaster?.ups ?? null
  const masterLwh = fmtMasterLwh(carton)

  const histAw = hist?.artworkCode?.trim() || null

  const awCode = histAw || masterAw
  const actualSheetSize = (histSheet || masterSheet || null)?.trim() || null
  const numberOfUps = histUps ?? masterUps
  const cartonLwh = histCarton || masterLwh

  const cleanSources: Record<string, 'history' | 'master'> = {}
  if (histAw) cleanSources.awCode = 'history'
  else if (masterAw) cleanSources.awCode = 'master'
  if (histSheet) cleanSources.actualSheetSize = 'history'
  else if (masterSheet) cleanSources.actualSheetSize = 'master'
  if (histUps != null) cleanSources.numberOfUps = 'history'
  else if (masterUps != null) cleanSources.numberOfUps = 'master'
  if (histCarton) cleanSources.cartonLwh = 'history'
  else if (masterLwh) cleanSources.cartonLwh = 'master'

  const revisionDates = [carton.updatedAt.toISOString()]
  if (hist?.createdAt) revisionDates.push(hist.createdAt.toISOString())
  revisionDates.sort()
  const revisionDate = revisionDates[revisionDates.length - 1] ?? carton.updatedAt.toISOString()

  return NextResponse.json({
    awCode,
    actualSheetSize: actualSheetSize?.trim() || null,
    numberOfUps,
    cartonLwh,
    revisionDate,
    hasProductDie: !!carton.dieMasterId?.trim(),
    hasProductEmboss: !!carton.embossBlockId?.trim(),
    sources: cleanSources,
  })
}
