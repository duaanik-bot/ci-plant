import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

function norm(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function daysSince(dt: Date | null | undefined): number | null {
  if (!dt) return null
  const ms = Date.now() - dt.getTime()
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim().toLowerCase() ?? ''

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
    orderBy: { updatedAt: 'desc' },
    take: 250,
  })

  const recentLines = await db.poLineItem.findMany({
    select: {
      id: true,
      cartonName: true,
      quantity: true,
      artworkCode: true,
      po: {
        select: {
          id: true,
          poNumber: true,
          poDate: true,
          customer: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 1200,
  })

  const out = await Promise.all(
    fgRows
      .filter((row) => {
        if (!q) return true
        return (
          row.materialCode.toLowerCase().includes(q) ||
          row.description.toLowerCase().includes(q)
        )
      })
      .map(async (row) => {
        const codeN = norm(row.materialCode)
        const descN = norm(row.description)

        const matchedLines = recentLines.filter((li) => {
          const cartonN = norm(li.cartonName)
          const awN = norm(li.artworkCode ?? '')
          if (!cartonN && !awN) return false
          return (
            (cartonN.length > 4 && (descN.includes(cartonN) || cartonN.includes(descN))) ||
            (awN.length > 2 && (codeN.includes(awN) || descN.includes(awN)))
          )
        })

        const customerMap = new Map<
          string,
          { customerId: string; customerName: string; poNumber: string; poDate: string; qtyOrdered: number }
        >()
        for (const li of matchedLines) {
          const key = li.po.customer.id
          const prev = customerMap.get(key)
          if (!prev) {
            customerMap.set(key, {
              customerId: li.po.customer.id,
              customerName: li.po.customer.name,
              poNumber: li.po.poNumber,
              poDate: li.po.poDate.toISOString(),
              qtyOrdered: li.quantity,
            })
          } else {
            prev.qtyOrdered += li.quantity
            if (new Date(li.po.poDate).getTime() > new Date(prev.poDate).getTime()) {
              prev.poNumber = li.po.poNumber
              prev.poDate = li.po.poDate.toISOString()
            }
          }
        }

        const movementLogs = await db.stockMovement.findMany({
          where: { materialId: row.id },
          orderBy: { createdAt: 'desc' },
          take: 15,
          select: {
            id: true,
            movementType: true,
            qty: true,
            refType: true,
            refId: true,
            createdAt: true,
          },
        })

        const lastFgReceipt =
          movementLogs.find((m) => m.movementType === 'fg_receipt')?.createdAt ?? row.updatedAt
        const boxAgeDays = daysSince(lastFgReceipt)
        const qtyFg = Number(row.qtyFg)
        const boxes = Math.max(1, Math.ceil(qtyFg / 100))

        return {
          id: row.id,
          materialCode: row.materialCode,
          description: row.description,
          unit: row.unit,
          qtyFg,
          fgValueInr: Number(row.weightedAvgCost) * qtyFg,
          boxNumber: `FG-${row.materialCode}-${String(boxes).padStart(3, '0')}`,
          boxAgeDays,
          estimatedBoxes: boxes,
          customerHints: Array.from(customerMap.values())
            .sort((a, b) => b.qtyOrdered - a.qtyOrdered)
            .slice(0, 4),
          logs: movementLogs.map((m) => ({
            id: m.id,
            movementType: m.movementType,
            qty: Number(m.qty),
            refType: m.refType,
            refId: m.refId,
            at: m.createdAt.toISOString(),
          })),
        }
      }),
  )

  return NextResponse.json(out.sort((a, b) => b.qtyFg - a.qtyFg))
}
