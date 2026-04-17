import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  formatDimsLwhFromDb,
  parseCartonSizeToDims,
} from '@/lib/die-hub-dimensions'

export const dynamic = 'force-dynamic'

const TOL_MM = 1
const MAX_SCAN = 800

function ageLabel(from: Date): string {
  const days = Math.floor((Date.now() - from.getTime()) / 86_400_000)
  if (days < 0) return '—'
  if (days < 120) return `${days}d`
  const y = days / 365
  return `${y.toFixed(1)}y`
}

function conditionBadgeClass(condition: string): string {
  const c = condition.toLowerCase()
  if (c.includes('poor')) return 'poor'
  if (c.includes('fair')) return 'fair'
  if (c.includes('good')) return 'good'
  return 'unknown'
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: {
      cartonSize: true,
      cartonId: true,
      dimLengthMm: true,
      dimWidthMm: true,
      dimHeightMm: true,
      carton: {
        select: {
          finishedLength: true,
          finishedWidth: true,
          finishedHeight: true,
        },
      },
    },
  })

  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  let lwh: string | null = line.cartonSize?.trim() || null
  if (!lwh && line.dimLengthMm != null && line.dimWidthMm != null && line.dimHeightMm != null) {
    lwh =
      formatDimsLwhFromDb({
        dimLengthMm: line.dimLengthMm as { toString(): string },
        dimWidthMm: line.dimWidthMm as { toString(): string },
        dimHeightMm: line.dimHeightMm as { toString(): string },
      }) ?? null
  }
  if (!lwh && line.carton) {
    const fmt = (v: unknown) => {
      if (v == null || v === '') return ''
      const n = Number(v)
      return Number.isFinite(n) ? String(n) : String(v)
    }
    const L = fmt(line.carton.finishedLength)
    const W = fmt(line.carton.finishedWidth)
    const H = fmt(line.carton.finishedHeight)
    if (L && W && H) lwh = `${L}×${W}×${H}`
  }

  const target = parseCartonSizeToDims(lwh)
  if (!target) {
    return NextResponse.json(
      { error: 'NO_DIMS', message: 'Enter or link carton L×W×H before Smart Match.' },
      { status: 400 },
    )
  }

  const dyes = await db.dye.findMany({
    where: {
      active: true,
      dimLengthMm: { not: null },
      dimWidthMm: { not: null },
      dimHeightMm: { not: null },
    },
    take: MAX_SCAN,
    orderBy: { dyeNumber: 'desc' },
    select: {
      id: true,
      dyeNumber: true,
      dyeType: true,
      condition: true,
      location: true,
      dateOfManufacturing: true,
      createdAt: true,
      dimLengthMm: true,
      dimWidthMm: true,
      dimHeightMm: true,
    },
  })

  const matches = dyes.filter((d) => {
    const l = Number(d.dimLengthMm)
    const w = Number(d.dimWidthMm)
    const h = Number(d.dimHeightMm)
    if (![l, w, h].every((n) => Number.isFinite(n))) return false
    return (
      Math.abs(l - target.l) <= TOL_MM &&
      Math.abs(w - target.w) <= TOL_MM &&
      Math.abs(h - target.h) <= TOL_MM
    )
  })

  const payload = matches.slice(0, 60).map((d) => {
    const dom = d.dateOfManufacturing ?? d.createdAt
    return {
      id: d.id,
      serialNumber: d.dyeNumber,
      type: d.dyeType,
      condition: d.condition,
      conditionBadge: conditionBadgeClass(d.condition),
      age: ageLabel(dom),
      location: d.location ?? '—',
      dimsMm: `${d.dimLengthMm}×${d.dimWidthMm}×${d.dimHeightMm}`,
    }
  })

  return NextResponse.json({
    targetDims: `${target.l}×${target.w}×${target.h}`,
    toleranceMm: TOL_MM,
    count: payload.length,
    matches: payload,
  })
}
