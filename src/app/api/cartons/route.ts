import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { formatDimsLwhFromDb, parseCartonSizeToDims, formatDimsLwhFromParsed } from '@/lib/die-hub-dimensions'
import { masterDieTypeLabel } from '@/lib/master-die-type'

export const dynamic = 'force-dynamic'

function cartonSizeFromFinished(c: {
  finishedLength: unknown
  finishedWidth: unknown
  finishedHeight: unknown
}): string {
  const l = c.finishedLength != null ? Number(c.finishedLength) : null
  const w = c.finishedWidth != null ? Number(c.finishedWidth) : null
  const h = c.finishedHeight != null ? Number(c.finishedHeight) : null
  if (l != null && w != null && h != null) return `${l}×${w}×${h}`
  if (l != null && w != null) return `${l}×${w}`
  return ''
}

function toolingDimsLabel(
  die:
    | {
        dimLengthMm: unknown
        dimWidthMm: unknown
        dimHeightMm: unknown
        cartonSize: string
      }
    | null
    | undefined,
): string {
  if (!die) return ''
  const formatted =
    formatDimsLwhFromDb({
      dimLengthMm: die.dimLengthMm as { toString(): string } | null,
      dimWidthMm: die.dimWidthMm as { toString(): string } | null,
      dimHeightMm: die.dimHeightMm as { toString(): string } | null,
    }) ??
    (parseCartonSizeToDims(die.cartonSize)
      ? formatDimsLwhFromParsed(parseCartonSizeToDims(die.cartonSize)!)
      : null)
  return formatted?.trim() || ''
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')
  const q = (searchParams.get('q') ?? '').trim().toLowerCase()
  const limitRaw = parseInt(searchParams.get('limit') ?? '4000', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 8000) : 4000

  const list = await db.carton.findMany({
    where: {
      active: true,
      ...(customerId ? { customerId } : {}),
    },
    orderBy: { cartonName: 'asc' },
    take: limit,
    include: {
      customer: { select: { id: true, name: true } },
      dieMaster: {
        select: {
          id: true,
          dyeNumber: true,
          dyeType: true,
          pastingStyle: true,
          dimLengthMm: true,
          dimWidthMm: true,
          dimHeightMm: true,
          cartonSize: true,
        },
      },
      dye: {
        select: {
          id: true,
          dyeNumber: true,
          dyeType: true,
          pastingStyle: true,
          dimLengthMm: true,
          dimWidthMm: true,
          dimHeightMm: true,
          cartonSize: true,
        },
      },
    },
  })

  let mapped = list.map((c) => {
    const sizeText = cartonSizeFromFinished(c)
    const dm = c.dieMaster
    const legacyDye = c.dye
    const effectiveMaster = dm ?? legacyDye
    const masterDieType = effectiveMaster
      ? masterDieTypeLabel({
          dyeType: effectiveMaster.dyeType,
          pastingStyle: effectiveMaster.pastingStyle,
        })
      : ''
    return {
      id: c.id,
      cartonName: c.cartonName,
      customerId: c.customerId,
      customer: { id: c.customer.id, name: c.customer.name },
      productType: c.productType,
      cartonSize: sizeText,
      boardGrade: c.boardGrade,
      gsm: c.gsm,
      paperType: c.paperType,
      rate: c.rate != null ? Number(c.rate) : null,
      gstPct: c.gstPct ?? 5,
      coatingType: c.coatingType,
      embossingLeafing: c.embossingLeafing,
      foilType: c.foilType,
      artworkCode: c.artworkCode,
      backPrint: c.backPrint,
      finishedLength: c.finishedLength != null ? Number(c.finishedLength) : null,
      finishedWidth: c.finishedWidth != null ? Number(c.finishedWidth) : null,
      finishedHeight: c.finishedHeight != null ? Number(c.finishedHeight) : null,
      pastingStyle: c.pastingStyle,
      drugSchedule: c.drugSchedule,
      regulatoryText: c.regulatoryText,
      specialInstructions: c.specialInstructions,
      dyeId: c.dyeId,
      dieMasterId: c.dieMasterId,
      masterDieType,
      toolingDimsLabel: toolingDimsLabel(effectiveMaster),
      toolingUnlinked: !c.dieMasterId,
    }
  })

  if (q) {
    mapped = mapped.filter(
      (c) =>
        c.cartonName.toLowerCase().includes(q) ||
        (c.artworkCode ?? '').toLowerCase().includes(q),
    )
  }

  return NextResponse.json(mapped)
}
