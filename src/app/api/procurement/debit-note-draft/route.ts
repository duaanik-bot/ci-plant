import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import {
  DEBIT_NOTE_DRAFT_SIGNATURE,
  WEIGHT_VARIANCE_DEBIT_TOLERANCE_PCT,
  formatDebitNoteBody,
} from '@/lib/weight-reconciliation'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  poLineItemId: z.string().uuid(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { poLineItemId } = parsed.data

  const rec = await db.materialWeightReconciliation.findUnique({
    where: { poLineItemId },
  })
  if (!rec) {
    return NextResponse.json({ error: 'Save scale weights before drafting a debit note' }, { status: 404 })
  }

  const pctAbs =
    rec.variancePercent != null && Number.isFinite(Number(rec.variancePercent))
      ? Math.abs(Number(rec.variancePercent))
      : 0
  if (pctAbs <= WEIGHT_VARIANCE_DEBIT_TOLERANCE_PCT) {
    return NextResponse.json(
      { error: `Variance must exceed ${WEIGHT_VARIANCE_DEBIT_TOLERANCE_PCT}% (absolute) for debit draft` },
      { status: 400 },
    )
  }

  const varianceKg = Number(rec.varianceKg)
  if (!Number.isFinite(varianceKg) || varianceKg <= 0) {
    return NextResponse.json(
      { error: 'Debit draft applies when invoice weight exceeds net received (short supply)' },
      { status: 400 },
    )
  }

  const rate = rec.ratePerKgInr != null ? Number(rec.ratePerKgInr) : 0
  if (!Number.isFinite(rate) || rate <= 0) {
    return NextResponse.json({ error: 'Vendor rate / kg missing — cannot value the variance' }, { status: 400 })
  }

  const invoiceNumber = rec.invoiceNumber?.trim() || '—'
  const draftText = formatDebitNoteBody({
    varianceKg,
    invoiceNumber,
    ratePerKg: rate,
  })

  const updated = await db.materialWeightReconciliation.update({
    where: { poLineItemId },
    data: {
      debitNoteDraftText: draftText,
      debitNoteDraftedAt: new Date(),
      reconciliationStatus: 'reconciliation_pending',
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id ?? '',
    action: 'procurement_debit_note_drafted',
    module: 'MaterialWeightReconciliation',
    recordId: updated.id,
    operatorLabel: DEBIT_NOTE_DRAFT_SIGNATURE,
    payload: {
      poLineItemId,
      varianceKg,
      variancePercent: rec.variancePercent != null ? Number(rec.variancePercent) : null,
      invoiceNumber,
    },
  })

  return NextResponse.json({
    debitNoteDraftText: draftText,
    reconciliationStatus: updated.reconciliationStatus,
    signature: DEBIT_NOTE_DRAFT_SIGNATURE,
  })
}
