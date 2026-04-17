import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_IN_STOCK,
  CUSTODY_ON_FLOOR,
} from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { createEmbossHubEvent, EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import {
  dieHubZoneLabelFromCustody,
  embossHubZoneLabelFromCustody,
} from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

const sizeReasonSchema = z.enum(['alternate_machine', 'edge_damage', 'prepress_error'])

const returnConditionSchema = z.enum(['Good', 'Fair', 'Poor'])

const bodySchema = z.object({
  tool: z.enum(['die', 'emboss']),
  id: z.string().uuid(),
  targetCartonSize: z.string().max(120).optional(),
  targetSheetSize: z.string().max(80).optional(),
  targetBlockSize: z.string().max(120).optional(),
  sizeModificationReason: sizeReasonSchema.optional(),
  sizeModificationRemarks: z.string().max(500).optional(),
  returnOperatorName: z.string().min(1).max(120),
  returnCondition: returnConditionSchema,
})

/** Custody staging → live inventory with optional dimension corrections (mirrors plate hub semantics). */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const body = parsed.data
  const now = new Date()

  try {
    if (body.tool === 'die') {
      const row = await db.dye.findUnique({ where: { id: body.id } })
      if (!row?.active) return NextResponse.json({ error: 'Die not found' }, { status: 404 })
      if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY && row.custodyStatus !== CUSTODY_ON_FLOOR) {
        return NextResponse.json({ error: 'Return requires custody staging or on-machine state' }, { status: 409 })
      }

      const nextCarton =
        body.targetCartonSize !== undefined ? body.targetCartonSize.trim() : row.cartonSize.trim()
      const nextSheet =
        body.targetSheetSize !== undefined ? body.targetSheetSize.trim() : row.sheetSize.trim()
      if (!nextCarton) {
        return NextResponse.json({ error: 'Die dimensions label is required' }, { status: 400 })
      }
      const sizeChanged = nextCarton !== row.cartonSize.trim() || nextSheet !== row.sheetSize.trim()
      if (sizeChanged && !body.sizeModificationReason) {
        return NextResponse.json(
          { error: 'Select a reason when changing die dimensions on return' },
          { status: 400 },
        )
      }

      const fromZone = dieHubZoneLabelFromCustody(row.custodyStatus)
      const toZone = dieHubZoneLabelFromCustody(CUSTODY_IN_STOCK)

      await db.$transaction(async (tx) => {
        const hubPoor = body.returnCondition === 'Poor'
        const opName = body.returnOperatorName.trim()
        await tx.dye.update({
          where: { id: body.id },
          data: {
            custodyStatus: CUSTODY_IN_STOCK,
            hubPreviousCustody: null,
            hubCustodySource: null,
            cartonSize: nextCarton,
            sheetSize: nextSheet,
            reuseCount: { increment: 1 },
            issuedMachineId: null,
            issuedOperator: null,
            issuedAt: null,
            condition: body.returnCondition,
            conditionRating: body.returnCondition,
            hubStatusFlag: hubPoor ? 'POOR_CONDITION' : null,
            hubPoorReportedBy: hubPoor ? opName : null,
            updatedAt: now,
          },
        })
        await tx.dyeMaintenanceLog.create({
          data: {
            dyeId: body.id,
            actionType: 'hub_return_to_rack',
            performedBy: body.returnOperatorName.trim(),
            notes: sizeChanged
              ? `Hub return — dimensions updated (${body.sizeModificationReason ?? 'n/a'}) · ${body.returnCondition} · op ${body.returnOperatorName.trim()}`
              : `Tooling hub — return to live inventory · ${body.returnCondition} · op ${body.returnOperatorName.trim()}`,
          },
        })
        await createDieHubEvent(tx, {
          dyeId: body.id,
          actionType: DIE_HUB_ACTION.RETURN_TO_RACK,
          fromZone,
          toZone,
          operatorName: body.returnOperatorName.trim(),
          actorName: body.returnOperatorName.trim(),
          eventCondition: body.returnCondition,
          metadata: {
            condition: body.returnCondition,
            remarks: body.sizeModificationRemarks?.trim() || undefined,
          },
          details: {
            displayCode: `DYE-${row.dyeNumber}`,
            returnOperatorName: body.returnOperatorName.trim(),
            returnCondition: body.returnCondition,
            sizeChanged,
            previousCartonSize: row.cartonSize,
            previousSheetSize: row.sheetSize,
            targetCartonSize: nextCarton,
            targetSheetSize: nextSheet,
            sizeModificationReason: body.sizeModificationReason,
            sizeModificationRemarks: body.sizeModificationRemarks?.trim() || undefined,
          },
        })
      })
    } else {
      const row = await db.embossBlock.findUnique({ where: { id: body.id } })
      if (!row?.active) return NextResponse.json({ error: 'Block not found' }, { status: 404 })
      if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY && row.custodyStatus !== CUSTODY_ON_FLOOR) {
        return NextResponse.json({ error: 'Return requires custody staging or on-machine state' }, { status: 409 })
      }

      const prevSize = (row.blockSize ?? '').trim()
      const nextSize =
        body.targetBlockSize !== undefined
          ? body.targetBlockSize.trim()
          : prevSize
      const sizeChanged = nextSize !== prevSize
      if (sizeChanged && !body.sizeModificationReason) {
        return NextResponse.json(
          { error: 'Select a reason when changing block size on return' },
          { status: 400 },
        )
      }

      const fromZone = embossHubZoneLabelFromCustody(row.custodyStatus)
      const toZone = embossHubZoneLabelFromCustody(CUSTODY_IN_STOCK)

      await db.$transaction(async (tx) => {
        await tx.embossBlock.update({
          where: { id: body.id },
          data: {
            custodyStatus: CUSTODY_IN_STOCK,
            hubPreviousCustody: null,
            blockSize: nextSize || null,
            reuseCount: { increment: 1 },
            issuedMachineId: null,
            issuedOperator: null,
            issuedAt: null,
            condition: body.returnCondition,
            updatedAt: now,
          },
        })
        await tx.embossBlockMaintenanceLog.create({
          data: {
            blockId: body.id,
            actionType: 'hub_return_to_rack',
            performedBy: body.returnOperatorName.trim(),
            notes: sizeChanged
              ? `Hub return — size updated (${body.sizeModificationReason ?? 'n/a'}) · ${body.returnCondition} · op ${body.returnOperatorName.trim()}`
              : `Tooling hub — return to live inventory · ${body.returnCondition} · op ${body.returnOperatorName.trim()}`,
          },
        })
        await createEmbossHubEvent(tx, {
          blockId: body.id,
          actionType: EMBOSS_HUB_ACTION.RETURN_TO_RACK,
          fromZone,
          toZone,
          details: {
            displayCode: row.blockCode,
            returnOperatorName: body.returnOperatorName.trim(),
            returnCondition: body.returnCondition,
            sizeChanged,
            previousBlockSize: row.blockSize,
            targetBlockSize: nextSize || null,
            sizeModificationReason: body.sizeModificationReason,
            sizeModificationRemarks: body.sizeModificationRemarks?.trim() || undefined,
          },
        })
      })
    }

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: body.tool === 'die' ? 'dyes' : 'emboss_blocks',
      recordId: body.id,
      newValue: { toolingHubReturnToRack: true, ...body } as Record<string, unknown>,
    })

    let poorConditionMeta: { displayCode: string; operatorName: string } | null = null
    if (body.returnCondition === 'Poor') {
      if (body.tool === 'die') {
        const d = await db.dye.findUnique({
          where: { id: body.id },
          select: { dyeNumber: true },
        })
        if (d) poorConditionMeta = { displayCode: `DYE-${d.dyeNumber}`, operatorName: body.returnOperatorName.trim() }
      } else {
        const b = await db.embossBlock.findUnique({
          where: { id: body.id },
          select: { blockCode: true },
        })
        if (b) poorConditionMeta = { displayCode: b.blockCode, operatorName: body.returnOperatorName.trim() }
      }
    }

    return NextResponse.json({
      ok: true,
      poorConditionAlert: body.returnCondition === 'Poor',
      poorConditionMeta,
    })
  } catch (e) {
    console.error('[tooling-hub/return-to-rack]', e)
    return NextResponse.json({ error: 'Return failed' }, { status: 500 })
  }
}
