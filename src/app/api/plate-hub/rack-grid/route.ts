import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { parseSlotNumber, RACK_COLS, RACK_ROWS, slotKey } from '@/lib/plate-rack'

export const dynamic = 'force-dynamic'

type CellPlate = {
  id: string
  plateSetCode: string
  cartonName: string
  artworkCode: string | null
  status: string
  lastRunDate: string | null
  /** empty | available | issued | damaged */
  rackVisual: 'available' | 'issued' | 'damaged'
}

function rackVisualForPlate(p: {
  status: string
  colours: unknown
  storageNotes: string | null
}): CellPlate['rackVisual'] {
  if (p.status === 'issued') return 'issued'
  if (p.status === 'destroyed' || p.status === 'partially_destroyed') return 'damaged'
  const notes = (p.storageNotes || '').toLowerCase()
  if (notes.includes('damaged')) return 'damaged'
  const arr = Array.isArray(p.colours) ? p.colours : []
  for (const c of arr) {
    const cond = String((c as { condition?: string }).condition || '').toLowerCase()
    if (cond.includes('damage')) return 'damaged'
    if ((c as { status?: string }).status === 'destroyed') return 'damaged'
  }
  return 'available'
}

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const plates = await db.plateStore.findMany({
    where: {
      hubSoftDeletedAt: null,
      status: { in: ['ready', 'returned', 'issued', 'pending'] },
    },
    select: {
      id: true,
      plateSetCode: true,
      cartonName: true,
      artworkCode: true,
      status: true,
      slotNumber: true,
      printedOn: true,
      lastUsedDate: true,
      colours: true,
      storageNotes: true,
    },
    orderBy: { updatedAt: 'desc' },
  })

  const cells: Record<string, CellPlate | null> = {}
  for (let r = 0; r < RACK_ROWS; r++) {
    for (let c = 0; c < RACK_COLS; c++) {
      cells[slotKey(r, c)] = null
    }
  }

  const unassigned: CellPlate[] = []

  for (const p of plates) {
    const last =
      p.lastUsedDate?.toISOString?.().slice(0, 10) ??
      p.printedOn?.toISOString?.().slice(0, 10) ??
      null
    const item: CellPlate = {
      id: p.id,
      plateSetCode: p.plateSetCode,
      cartonName: p.cartonName,
      artworkCode: p.artworkCode,
      status: p.status,
      lastRunDate: last,
      rackVisual: rackVisualForPlate(p),
    }
    const pos = parseSlotNumber(p.slotNumber)
    if (pos) {
      const k = slotKey(pos.row, pos.col)
      if (cells[k] === null) cells[k] = item
      else unassigned.push(item)
    } else {
      unassigned.push(item)
    }
  }

  return NextResponse.json({
    rows: RACK_ROWS,
    cols: RACK_COLS,
    cells,
    unassigned,
  })
}
