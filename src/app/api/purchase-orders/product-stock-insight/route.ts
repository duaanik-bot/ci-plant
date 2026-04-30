import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

function norm(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function ageDays(dt: Date | null | undefined): number | null {
  if (!dt) return null
  return Math.max(0, Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24)))
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const sp = req.nextUrl.searchParams
  const customerId = sp.get('customerId')?.trim() ?? ''
  const cartonId = sp.get('cartonId')?.trim() ?? ''
  const cartonName = sp.get('cartonName')?.trim() ?? ''
  const artworkCode = sp.get('artworkCode')?.trim() ?? ''
  const q = sp.get('q')?.trim() ?? ''

  const lookup = norm(`${q} ${cartonName} ${artworkCode}`)
  if (!lookup && !cartonId) return NextResponse.json({ matches: [] })

  const fgRows = await db.inventory.findMany({
    where: { qtyFg: { gt: 0 } },
    select: {
      id: true,
      materialCode: true,
      description: true,
      unit: true,
      qtyFg: true,
      weightedAvgCost: true,
      updatedAt: true,
    },
    orderBy: [{ qtyFg: 'desc' }, { updatedAt: 'desc' }],
    take: 220,
  })

  const customerLines = customerId
    ? await db.poLineItem.findMany({
        where: { po: { customerId } },
        select: {
          id: true,
          cartonId: true,
          cartonName: true,
          artworkCode: true,
          quantity: true,
          po: { select: { poNumber: true, poDate: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 220,
      })
    : []

  const matches = fgRows
    .map((row) => {
      const code = norm(row.materialCode)
      const desc = norm(row.description)
      let score = 0
      if (lookup) {
        if (desc.includes(lookup) || lookup.includes(desc)) score += 3
        if (code.includes(lookup) || lookup.includes(code)) score += 2
      }
      if (artworkCode) {
        const aw = norm(artworkCode)
        if (aw && (code.includes(aw) || desc.includes(aw))) score += 2
      }
      if (cartonName) {
        const cn = norm(cartonName)
        if (cn && (desc.includes(cn) || cn.includes(desc))) score += 3
      }
      if (score <= 0) return null
      const qtyFg = Number(row.qtyFg)
      return {
        materialId: row.id,
        materialCode: row.materialCode,
        description: row.description,
        qtyFg,
        unit: row.unit,
        estimatedBoxes: Math.max(1, Math.ceil(qtyFg / 100)),
        boxNumber: `FG-${row.materialCode}-${String(Math.max(1, Math.ceil(qtyFg / 100))).padStart(3, '0')}`,
        boxAgeDays: ageDays(row.updatedAt),
        approxValueInr: Number(row.weightedAvgCost) * qtyFg,
        score,
      }
    })
    .filter((m): m is NonNullable<typeof m> => !!m)
    .sort((a, b) => b.score - a.score || b.qtyFg - a.qtyFg)
    .slice(0, 6)

  const linkedHistory = customerLines
    .filter((li) => {
      if (cartonId && li.cartonId === cartonId) return true
      const target = norm(`${li.cartonName} ${li.artworkCode ?? ''}`)
      return lookup && (target.includes(lookup) || lookup.includes(target))
    })
    .slice(0, 8)
    .map((li) => ({
      poNumber: li.po.poNumber,
      poDate: li.po.poDate.toISOString(),
      cartonName: li.cartonName,
      artworkCode: li.artworkCode,
      quantity: li.quantity,
    }))

  return NextResponse.json({ matches, linkedHistory })
}
