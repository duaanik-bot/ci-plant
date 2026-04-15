import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { parseDesignerCommand, type DesignerCommand } from '@/lib/designer-command'
import { resolvePlateLineItems } from '@/lib/plate-triage-display'

export const dynamic = 'force-dynamic'

function parseSpecLayout(spec: Record<string, unknown>): {
  sheetSizeLabel: string | null
  numberOfUps: number | null
} {
  const actualSheetSize =
    typeof spec.actualSheetSize === 'string' && spec.actualSheetSize.trim()
      ? spec.actualSheetSize.trim()
      : null
  let numberOfUps: number | null = null
  if (typeof spec.ups === 'number' && Number.isFinite(spec.ups)) numberOfUps = Math.floor(spec.ups)
  else if (typeof spec.numberOfUps === 'number' && Number.isFinite(spec.numberOfUps))
    numberOfUps = Math.floor(spec.numberOfUps)
  return { sheetSizeLabel: actualSheetSize, numberOfUps }
}

function designerFromSpec(spec: Record<string, unknown>): DesignerCommand | null {
  const raw = spec.designerCommand
  if (!raw || typeof raw !== 'object') return null
  try {
    return parseDesignerCommand(raw)
  } catch {
    return null
  }
}

/** Jobs from designers awaiting Plate Hub triage (CTP production path). */
export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const list = await db.plateRequirement.findMany({
    where: {
      triageChannel: null,
      status: { in: ['pending', 'ctp_notified', 'plates_ready'] },
    },
    orderBy: { createdAt: 'asc' },
  })

  const customerIds = Array.from(
    new Set(list.map((r) => r.customerId).filter(Boolean) as string[]),
  )
  const customers =
    customerIds.length > 0
      ? await db.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, name: true },
        })
      : []
  const custById = Object.fromEntries(customers.map((c) => [c.id, c.name]))

  const poLineIds = Array.from(
    new Set(list.map((r) => r.poLineId).filter(Boolean) as string[]),
  )
  const poLines =
    poLineIds.length > 0
      ? await db.poLineItem.findMany({
          where: { id: { in: poLineIds } },
          select: {
            id: true,
            setNumber: true,
            cartonSize: true,
            cartonId: true,
            specOverrides: true,
          },
        })
      : []

  const cartonIds = Array.from(
    new Set(poLines.map((l) => l.cartonId).filter(Boolean) as string[]),
  )
  const cartons =
    cartonIds.length > 0
      ? await db.carton.findMany({
          where: { id: { in: cartonIds } },
          select: {
            id: true,
            blankLength: true,
            blankWidth: true,
          },
        })
      : []
  const cartonById = Object.fromEntries(cartons.map((c) => [c.id, c]))

  const lineById = Object.fromEntries(poLines.map((l) => [l.id, l]))

  const enriched = list.map((r) => {
    const customerName = r.customerId ? custById[r.customerId] ?? null : null
    const line = r.poLineId ? lineById[r.poLineId] : undefined
    const spec = (line?.specOverrides as Record<string, unknown> | null) || {}
    const dc = designerFromSpec(spec)
    const { sheetSizeLabel: specSheet, numberOfUps: specUps } = parseSpecLayout(spec)
    const carton = line?.cartonId ? cartonById[line.cartonId] : null
    let sheetSizeLabel = specSheet
    if (!sheetSizeLabel && carton?.blankLength != null && carton?.blankWidth != null) {
      sheetSizeLabel = `${String(carton.blankLength)} × ${String(carton.blankWidth)} mm (blank)`
    }
    if (!sheetSizeLabel && line?.cartonSize?.trim()) {
      sheetSizeLabel = line.cartonSize.trim()
    }
    const setNumber =
      line?.setNumber?.trim() ||
      r.artworkVersion?.replace(/^R/i, '') ||
      '—'
    const plateLineItems = resolvePlateLineItems(dc, r.coloursNeeded)

    return {
      ...r,
      customerName,
      /** Display job id (same as requirement code). */
      jobId: r.requirementCode,
      totalPlatesRequired: r.newPlatesNeeded,
      plateLineItems,
      setNumberDisplay: setNumber,
      sheetSizeLabel: sheetSizeLabel ?? null,
      numberOfUps: specUps,
    }
  })

  return NextResponse.json(enriched)
}
