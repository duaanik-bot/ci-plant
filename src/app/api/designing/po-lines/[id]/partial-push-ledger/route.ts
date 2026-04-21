import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  currentRunBatches,
  readPartialLedger,
  remainingBatchBalance,
  totalContractBatches,
  type AwPartialPushLedgerEntry,
} from '@/lib/aw-queue-spec'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  addBatches: z.number().int().positive(),
  jobCardId: z.string().uuid().optional().nullable(),
})

/**
 * Append a partial batch push to the ledger and increment currentRunBatches.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'addBatches (positive int) required' }, { status: 400 })
  }

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: { id: true, specOverrides: true, jobCardNumber: true },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const total = totalContractBatches(spec)
  if (total <= 0) {
    return NextResponse.json(
      { error: 'Set total contract batches before logging partial pushes.' },
      { status: 409 },
    )
  }

  const prev = currentRunBatches(spec)
  const nextRun = prev + parsed.data.addBatches
  if (nextRun > total) {
    return NextResponse.json(
      { error: `Run batches (${nextRun}) would exceed contract total (${total}).` },
      { status: 409 },
    )
  }

  let jobCardNumber: number | null = line.jobCardNumber
  let jcId: string | null = parsed.data.jobCardId ?? null
  if (jcId) {
    const jc = await db.productionJobCard.findUnique({
      where: { id: jcId },
      select: { jobCardNumber: true },
    })
    jobCardNumber = jc?.jobCardNumber ?? jobCardNumber
  }

  const entry: AwPartialPushLedgerEntry = {
    at: new Date().toISOString(),
    batchCount: parsed.data.addBatches,
    jobCardId: jcId,
    jobCardNumber,
    operatorName: user!.name?.trim() || null,
  }

  const ledger = [...readPartialLedger(spec), entry]
  const balance = total - nextRun
  const nextSpec: Record<string, unknown> = {
    ...spec,
    currentRunBatches: nextRun,
    awPartialPushLedger: ledger,
    awPartialShipmentStatus: balance > 0 ? 'partially_sent' : 'complete',
  }

  await db.poLineItem.update({
    where: { id: lineId },
    data: { specOverrides: nextSpec as object },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: lineId,
    newValue: { partialPushLedger: entry } as Record<string, unknown>,
  })

  return NextResponse.json({
    ok: true,
    currentRunBatches: nextRun,
    remainingBalance: remainingBatchBalance(nextSpec),
    ledger,
  })
}
