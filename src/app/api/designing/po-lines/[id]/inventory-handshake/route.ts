import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { get_allocated_stock_dims, computePaperRowGrainFit } from '@/lib/allocated-stock-dims'

export const dynamic = 'force-dynamic'

/**
 * Compare AW target sheet size with FIFO paper warehouse match for this line’s material queue.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: { specOverrides: true },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const target =
    typeof spec.actualSheetSize === 'string' && spec.actualSheetSize.trim()
      ? spec.actualSheetSize.trim()
      : null

  const stock = await get_allocated_stock_dims(db, { poLineItemId: lineId })
  const grainFit = stock ? computePaperRowGrainFit(stock.sheetSizeLabel, target) : null

  return NextResponse.json({
    targetSheetSize: target,
    inStockSheetSize: stock?.sheetSizeLabel ?? null,
    grainDirection: stock?.grainDirection ?? null,
    paperWarehouseId: stock?.paperWarehouseId ?? null,
    lotNumber: stock?.lotNumber ?? null,
    grainFitStatus: grainFit,
    matchHint:
      stock && target
        ? grainFit === 'ok' || grainFit === 'pre_trim_required'
          ? 'Inventory row matches target closely enough for issue (or pre-trim path).'
          : 'Review grain / sheet size vs target before issue.'
        : stock
          ? 'Target sheet not set on line — set Actual sheet size for handshake.'
          : 'No FIFO warehouse batch matched for this line’s material queue (GSM/board).',
  })
}
