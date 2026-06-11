import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  qty: z.coerce.number().positive('Qty must be greater than 0'),
  note: z.string().trim().max(200).optional(),
})

function formatSheetDim(value: unknown): string | null {
  if (value == null) return null
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return String(num)
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Material id is required' }, { status: 400 })

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const qty = parsed.data.qty

  try {
    const material = await db.inventory.findUnique({
      where: { id },
      select: {
        id: true,
        materialCode: true,
        boardType: true,
        gsm: true,
        sheetLength: true,
        sheetWidth: true,
        supplierId: true,
      },
    })
    if (!material) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

    // Reuse any open PR for this material instead of creating duplicates.
    const existingOpenPr = await db.purchaseRequisition.findFirst({
      where: {
        materialId: id,
        status: { in: ['pending', 'approved', 'converted_to_po'] },
      },
      orderBy: { raisedAt: 'desc' },
      select: { id: true, status: true },
    })
    if (existingOpenPr) {
      return NextResponse.json({
        success: true,
        purchaseRequestId: existingOpenPr.id,
        reused: true,
        message: 'PR already exists',
      })
    }

    const length = formatSheetDim(material.sheetLength)
    const width = formatSheetDim(material.sheetWidth)
    const sizeLabel = length && width ? `${length}x${width}` : null

    const pr = await db.purchaseRequisition.create({
      data: {
        materialId: id,
        qtyRequired: qty,
        estimatedValue: 0,
        triggerReason: [
          'manual_reorder',
          parsed.data.note ? `note:${parsed.data.note}` : null,
        ]
          .filter(Boolean)
          .join(';'),
        status: 'pending',
        raisedBy: user!.id,
        supplierId: material.supplierId ?? undefined,
        boardType: normalizeBoardTypeForStorage(material.boardType) ?? undefined,
        sizeLabel: sizeLabel ?? undefined,
        gsm: material.gsm ?? undefined,
      },
      select: { id: true },
    })

    return NextResponse.json({
      success: true,
      purchaseRequestId: pr.id,
      reused: false,
      message: 'PR created',
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to create manual PR' },
      { status: 400 },
    )
  }
}
