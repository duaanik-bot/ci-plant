import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_IN_STOCK,
} from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { createEmbossHubEvent, EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import {
  dieHubZoneLabelFromCustody,
  embossHubZoneLabelFromCustody,
} from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

const sizeReasonSchema = z.enum(['alternate_machine', 'edge_damage', 'prepress_error'])

const bodySchema = z.object({
  tool: z.enum(['die', 'emboss']),
  id: z.string().uuid(),
  targetCartonSize: z.string().max(120).optional(),
  targetSheetSize: z.string().max(80).optional(),
  targetBlockSize: z.string().max(120).optional(),
  sizeModificationReason: sizeReasonSchema.optional(),
  sizeModificationRemarks: z.string().max(500).optional(),
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
      if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY) {
        return NextResponse.json({ error: 'Not on custody staging' }, { status: 409 })
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
            updatedAt: now,
          },
        })
        await tx.dyeMaintenanceLog.create({
          data: {
            dyeId: body.id,
            actionType: 'hub_return_to_rack',
            performedBy: user?.id ?? 'system',
            notes: sizeChanged
              ? `Hub return — dimensions updated (${body.sizeModificationReason ?? 'n/a'})`
              : 'Tooling hub — return to live inventory (reuse cycle)',
          },
        })
        await createDieHubEvent(tx, {
          dyeId: body.id,
          actionType: DIE_HUB_ACTION.RETURN_TO_RACK,
          fromZone,
          toZone,
          details: {
            displayCode: `DYE-${row.dyeNumber}`,
            sizeChanged,
            previousCartonSize: row.cartonSize,
            previousSheetSize: row.sheetSize,
            targetCartonSize: nextCarton,
            targetSheetSize: nextSheet,
            sizeModificationReason: body.sizeModificationReason,
            sizeModificationRemarks: body.sizeModificationRemarks?.trim() || undefined,
          },
        })
        if (sizeChanged) {
          await createDieHubEvent(tx, {
            dyeId: body.id,
            actionType: DIE_HUB_ACTION.SIZE_CHANGED_ON_RETURN,
            fromZone,
            toZone,
            details: {
              previousCartonSize: row.cartonSize,
              previousSheetSize: row.sheetSize,
              targetCartonSize: nextCarton,
              targetSheetSize: nextSheet,
              sizeModificationReason: body.sizeModificationReason,
              sizeModificationRemarks: body.sizeModificationRemarks?.trim() || undefined,
            },
          })
        }
      })
    } else {
      const row = await db.embossBlock.findUnique({ where: { id: body.id } })
      if (!row?.active) return NextResponse.json({ error: 'Block not found' }, { status: 404 })
      if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY) {
        return NextResponse.json({ error: 'Not on custody staging' }, { status: 409 })
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
            updatedAt: now,
          },
        })
        await tx.embossBlockMaintenanceLog.create({
          data: {
            blockId: body.id,
            actionType: 'hub_return_to_rack',
            performedBy: user?.id ?? 'system',
            notes: sizeChanged
              ? `Hub return — size updated (${body.sizeModificationReason ?? 'n/a'})`
              : 'Tooling hub — return to live inventory (reuse cycle)',
          },
        })
        await createEmbossHubEvent(tx, {
          blockId: body.id,
          actionType: EMBOSS_HUB_ACTION.RETURN_TO_RACK,
          fromZone,
          toZone,
          details: {
            displayCode: row.blockCode,
            sizeChanged,
            previousBlockSize: row.blockSize,
            targetBlockSize: nextSize || null,
            sizeModificationReason: body.sizeModificationReason,
            sizeModificationRemarks: body.sizeModificationRemarks?.trim() || undefined,
          },
        })
        if (sizeChanged) {
          await createEmbossHubEvent(tx, {
            blockId: body.id,
            actionType: EMBOSS_HUB_ACTION.SIZE_CHANGED_ON_RETURN,
            fromZone,
            toZone,
            details: {
              previousBlockSize: row.blockSize,
              targetBlockSize: nextSize || null,
              sizeModificationReason: body.sizeModificationReason,
              sizeModificationRemarks: body.sizeModificationRemarks?.trim() || undefined,
            },
          })
        }
      })
    }

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: body.tool === 'die' ? 'dyes' : 'emboss_blocks',
      recordId: body.id,
      newValue: { toolingHubReturnToRack: true, ...body } as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[tooling-hub/return-to-rack]', e)
    return NextResponse.json({ error: 'Return failed' }, { status: 500 })
  }
}
