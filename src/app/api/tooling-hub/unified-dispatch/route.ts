import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonParse } from '@/lib/safe-json'
import { unifiedToolingDispatchBodySchema } from '@/lib/unified-tooling-dispatch-schema'
import { HUB_TECHNICAL_DATA_MISSING_TOAST } from '@/lib/validate-hub-payload'

export const dynamic = 'force-dynamic'

/**
 * Bundles die / emboss / plate tooling IDs into one audit transaction.
 * Does not partially commit: single $transaction for all writes.
 */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  try {
    const text = await req.text()
    const raw = safeJsonParse<unknown>(text, {})
    const parsed = unifiedToolingDispatchBodySchema.safeParse(raw)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return NextResponse.json(
        {
          error: first
            ? `Missing or invalid field: ${first.path.join('.') || 'body'}`
            : 'Validation failed',
          details: parsed.error.flatten(),
        },
        { status: 400 },
      )
    }

    const d = parsed.data

    if (d.dispatchDie && d.dieSource === 'OLD' && !String(d.dieId || '').trim()) {
      return NextResponse.json(
        { error: HUB_TECHNICAL_DATA_MISSING_TOAST, field: 'dieId' },
        { status: 400 },
      )
    }
    if (d.dispatchEmboss && d.embossSource === 'OLD' && !String(d.embossBlockId || '').trim()) {
      return NextResponse.json(
        { error: HUB_TECHNICAL_DATA_MISSING_TOAST, field: 'embossBlockId' },
        { status: 400 },
      )
    }

    const reference = `UTH-${Date.now()}`
    const newValue = {
      reference,
      poLineId: d.poLineId,
      jobCardId: d.jobCardId,
      artworkId: d.artworkId,
      setNumber: d.setNumber,
      dieId: d.dieId ?? null,
      embossBlockId: d.embossBlockId ?? null,
      plateSetId: d.plateSetId ?? null,
      dispatchDie: d.dispatchDie,
      dispatchEmboss: d.dispatchEmboss,
      dieSource: d.dieSource ?? null,
      embossSource: d.embossSource ?? null,
    }

    await db.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          userId: user!.id,
          action: 'INSERT',
          tableName: 'unified_tooling_hub_dispatch',
          recordId: d.poLineId,
          newValue: newValue as object,
        },
      })

      const jc = await tx.productionJobCard.findUnique({
        where: { id: d.jobCardId },
        select: { id: true },
      })
      if (jc) {
        const patch: { plateSetId?: string; embossBlockId?: string } = {}
        if (d.plateSetId) patch.plateSetId = d.plateSetId
        if (d.embossBlockId) patch.embossBlockId = d.embossBlockId
        if (Object.keys(patch).length > 0) {
          await tx.productionJobCard.update({
            where: { id: d.jobCardId },
            data: patch,
          })
        }
      }
    })

    return NextResponse.json({ ok: true, reference, ...newValue })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
