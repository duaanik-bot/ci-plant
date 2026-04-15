import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const TOLERANCE_PCT = 3

function generateLotNumber(materialCode: string): string {
  const d = new Date()
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const short = materialCode.replace(/[^A-Z0-9]/gi, '').slice(0, 8)
  return `GRN-${date}-${short}`
}

const bodySchema = z.object({
  materialId: z.string().uuid(),
  qty: z.number().positive(),
  entryUnit: z.enum(['sheets', 'kg']).default('sheets'),
  lotNumber: z.string().optional(),
  millDate: z.string().optional().nullable(),
  palletCount: z.number().int().min(0).optional().nullable(),
  pricePerKg: z.number().min(0).optional().nullable(),
  costPerUnit: z.number().min(0).optional(),
  poReference: z.string().optional().nullable(),
  poQty: z.number().optional().nullable(),
  approvalOverride: z.boolean().default(false),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole(
    'stores',
    'production_manager',
    'operations_head',
    'md',
  )
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse({
    ...body,
    qty: body.qty != null ? Number(body.qty) : undefined,
    palletCount: body.palletCount != null ? Number(body.palletCount) : undefined,
    pricePerKg: body.pricePerKg != null ? Number(body.pricePerKg) : undefined,
    costPerUnit: body.costPerUnit != null ? Number(body.costPerUnit) : undefined,
    poQty: body.poQty != null ? Number(body.poQty) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const data = parsed.data
  const inv = await db.inventory.findUnique({ where: { id: data.materialId } })
  if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const isBoardType = false
  const sheetWeightG = 0

  let totalSheets: number
  let totalWeightKg: number

  if (isBoardType && sheetWeightG > 0) {
    if (data.entryUnit === 'kg') {
      totalWeightKg = data.qty
      totalSheets = Math.round((data.qty * 1000) / sheetWeightG)
    } else {
      totalSheets = data.qty
      totalWeightKg = parseFloat(((data.qty * sheetWeightG) / 1000).toFixed(3))
    }
  } else {
    totalSheets = data.qty
    totalWeightKg = 0
  }

  const quarantineQty = totalSheets

  if (data.poQty && data.poQty > 0 && !data.approvalOverride) {
    const receivedQty = data.entryUnit === 'kg' ? totalWeightKg : totalSheets
    const diff = ((receivedQty - data.poQty) / data.poQty) * 100
    if (diff > TOLERANCE_PCT) {
      return NextResponse.json(
        {
          error: 'tolerance_exceeded',
          message: `Received qty exceeds PO qty by ${diff.toFixed(1)}% (threshold: ${TOLERANCE_PCT}%). Manager approval required.`,
          receivedQty,
          poQty: data.poQty,
          diffPct: parseFloat(diff.toFixed(1)),
        },
        { status: 422 },
      )
    }
  }

  const lot = data.lotNumber?.trim() || generateLotNumber(inv.materialCode)

  let newWac = Number(inv.weightedAvgCost)
  const pricePerKg = data.pricePerKg ?? null

  if (isBoardType && pricePerKg != null && pricePerKg > 0 && totalWeightKg > 0) {
    const currentTotalKg = Number(inv.qtyAvailable) > 0 && sheetWeightG > 0
      ? (Number(inv.qtyAvailable) * sheetWeightG) / 1000
      : 0
    const currentWac = Number(inv.weightedAvgCost)
    newWac = currentTotalKg + totalWeightKg > 0
      ? (currentWac * currentTotalKg + pricePerKg * totalWeightKg) / (currentTotalKg + totalWeightKg)
      : pricePerKg
  } else if (data.costPerUnit != null && data.costPerUnit > 0) {
    const currentQty = Number(inv.qtyQuarantine) + Number(inv.qtyAvailable)
    const currentWac = Number(inv.weightedAvgCost)
    newWac = currentQty + quarantineQty > 0
      ? (currentWac * currentQty + data.costPerUnit * quarantineQty) / (currentQty + quarantineQty)
      : data.costPerUnit
  }

  const totalCost = isBoardType && pricePerKg
    ? parseFloat((totalWeightKg * pricePerKg).toFixed(2))
    : data.costPerUnit
      ? parseFloat((quarantineQty * data.costPerUnit).toFixed(2))
      : 0

  await db.$transaction(async (tx) => {
    await tx.inventory.update({
      where: { id: data.materialId },
      data: {
        qtyQuarantine: { increment: quarantineQty },
        weightedAvgCost: newWac,
      },
    })

    await tx.stockMovement.create({
      data: {
        materialId: data.materialId,
        movementType: 'grn_quarantine',
        qty: quarantineQty,
        refType: 'grn',
        refId: data.poReference?.trim() || lot,
        userId: user!.id,
      },
    })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'inventory',
    recordId: data.materialId,
    newValue: { grn: true, totalSheets, totalWeightKg, lotNumber: lot, totalCost },
  })

  const { checkReorderPoints } = await import('@/lib/reorder')
  try {
    await checkReorderPoints(data.materialId)
  } catch (_) {}

  return NextResponse.json({
    success: true,
    message: `${totalSheets} sheets (${totalWeightKg > 0 ? totalWeightKg.toFixed(2) + ' kg' : inv.unit}) received into quarantine for ${inv.materialCode}.`,
    lotNumber: lot,
    totalSheets,
    totalWeightKg,
    totalCost,
    newWac: parseFloat(newWac.toFixed(4)),
  })
}
