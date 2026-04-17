import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_HUB_TRIAGE,
  CUSTODY_IN_STOCK,
} from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { dieHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  triageDyeId: z.string().uuid(),
  inventoryDyeId: z.string().uuid(),
  actorName: z.string().min(1).max(120).optional(),
})

class HttpErr extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HttpErr'
  }
}

function rackSlotLabel(location: string | null | undefined): string {
  const s = location?.trim()
  return s && s.length > 0 ? s : '—'
}

/** Force-link triage job to any in-stock die (dimension check skipped). */
export async function POST(req: NextRequest) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'triageDyeId and inventoryDyeId required' }, { status: 400 })
    }

    const { triageDyeId, inventoryDyeId, actorName: actorRaw } = parsed.data
    if (triageDyeId === inventoryDyeId) {
      return NextResponse.json({ error: 'Cannot link triage record to itself' }, { status: 400 })
    }

    const actor = actorRaw?.trim() || user?.name?.trim() || 'Operator'
    const now = new Date()

    await db.$transaction(async (tx) => {
      const triage = await tx.dye.findFirst({
        where: { id: triageDyeId, active: true, custodyStatus: CUSTODY_HUB_TRIAGE },
      })
      const inventory = await tx.dye.findFirst({
        where: { id: inventoryDyeId, active: true, custodyStatus: CUSTODY_IN_STOCK },
      })
      if (!triage) throw new HttpErr('Triage die not found or not in triage', 404)
      if (!inventory) throw new HttpErr('Inventory die not found or not in live inventory', 404)
      if (triage.hubTriageHoldReason?.trim()) {
        throw new HttpErr('Release on-hold before linking', 409)
      }

      const triageSnap = triage.updatedAt
      const invSnap = inventory.updatedAt

      const slot = rackSlotLabel(inventory.location)
      const triageCode = `DYE-${triage.dyeNumber}`
      const invCode = `DYE-${inventory.dyeNumber}`
      const msg = `Manual link: ${invCode} pulled from [${slot}] to fulfill ${triageCode} (dimensions not auto-matched).`

      const arch = await tx.dye.updateMany({
        where: {
          id: triageDyeId,
          updatedAt: triageSnap,
          custodyStatus: CUSTODY_HUB_TRIAGE,
          active: true,
        },
        data: {
          active: false,
          scrapReason: 'Triage fulfilled — manual link to rack die',
          scrappedBy: user!.id,
          scrappedAt: now,
          updatedAt: now,
        },
      })
      if (arch.count !== 1) {
        throw new HttpErr('Triage die changed — refresh and try again', 409)
      }

      const pull = await tx.dye.updateMany({
        where: {
          id: inventoryDyeId,
          updatedAt: invSnap,
          custodyStatus: CUSTODY_IN_STOCK,
          active: true,
        },
        data: {
          custodyStatus: CUSTODY_HUB_CUSTODY_READY,
          hubPreviousCustody: CUSTODY_IN_STOCK,
          hubCustodySource: 'rack',
          issuedMachineId: null,
          issuedOperator: null,
          issuedAt: null,
          updatedAt: now,
        },
      })
      if (pull.count !== 1) {
        throw new HttpErr('Inventory die changed — refresh and try again', 409)
      }

      await createDieHubEvent(tx, {
        dyeId: inventoryDyeId,
        actionType: DIE_HUB_ACTION.MANUAL_LINK_STOCK_FULFILL,
        fromZone: dieHubZoneLabelFromCustody(CUSTODY_IN_STOCK),
        toZone: dieHubZoneLabelFromCustody(CUSTODY_HUB_CUSTODY_READY),
        actorName: actor,
        details: {
          message: msg,
          triageDyeId,
          triageDisplayCode: triageCode,
          inventoryDisplayCode: invCode,
          slot,
          manualLink: true,
        },
      })

      await createDieHubEvent(tx, {
        dyeId: triageDyeId,
        actionType: DIE_HUB_ACTION.TRIAGE_ARCHIVED_STOCK_FULFILL,
        fromZone: dieHubZoneLabelFromCustody(CUSTODY_HUB_TRIAGE),
        toZone: 'Archived',
        actorName: actor,
        details: {
          message: `Triage ${triageCode} closed — manual link to ${invCode}.`,
          inventoryDyeId,
          inventoryDisplayCode: invCode,
          manualLink: true,
        },
      })
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'dyes',
      recordId: inventoryDyeId,
      newValue: {
        dieHubManualLink: true,
        triageDyeId,
        inventoryDyeId,
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[tooling-hub/dies/manual-link]', e)
    if (e instanceof HttpErr) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'Manual link failed' }, { status: 500 })
  }
}
