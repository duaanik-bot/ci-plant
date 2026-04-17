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
import { dimTriplesEqual, normalizeDieMake, tripleFromDyeRow } from '@/lib/die-hub-dimensions'

export const dynamic = 'force-dynamic'

const postSchema = z.object({
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

/** GET — list live dies matching triage L×W×H. */
export async function GET(req: NextRequest) {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const triageDyeId = req.nextUrl.searchParams.get('triageDyeId')?.trim()
    if (!triageDyeId) {
      return NextResponse.json({ error: 'triageDyeId required' }, { status: 400 })
    }

    const triage = await db.dye.findFirst({
      where: { id: triageDyeId, active: true, custodyStatus: CUSTODY_HUB_TRIAGE },
    })
    if (!triage) {
      return NextResponse.json({ error: 'Triage die not found' }, { status: 404 })
    }

    const triageTriple = tripleFromDyeRow(triage)
    if (!triageTriple) {
      return NextResponse.json({
        triageDisplayCode: `DYE-${triage.dyeNumber}`,
        candidates: [] as unknown[],
        hint: 'Add parsed dimensions (L×W×H) on the triage die to match rack inventory.',
      })
    }

    const rack = await db.dye.findMany({
      where: {
        active: true,
        custodyStatus: CUSTODY_IN_STOCK,
        NOT: { id: triage.id },
      },
      orderBy: { dyeNumber: 'asc' },
      select: {
        id: true,
        dyeNumber: true,
        pastingStyle: true,
        dieMake: true,
        location: true,
        reuseCount: true,
        impressionCount: true,
        dimLengthMm: true,
        dimWidthMm: true,
        dimHeightMm: true,
        cartonSize: true,
      },
    })

    const candidates = rack
      .filter((row) => dimTriplesEqual(triageTriple, tripleFromDyeRow(row)))
      .map((row) => ({
        id: row.id,
        serialLabel: `#DYE-${row.dyeNumber}`,
        displayCode: `DYE-${row.dyeNumber}`,
        pastingStyle: row.pastingStyle ?? null,
        dieMake: normalizeDieMake(row.dieMake),
        location: row.location,
        reuseCount: row.reuseCount,
        impressionCount: row.impressionCount,
      }))

    return NextResponse.json({
      triageDisplayCode: `DYE-${triage.dyeNumber}`,
      candidates,
    })
  } catch (e) {
    console.error('[tooling-hub/dies/take-from-stock GET]', e)
    return NextResponse.json({ error: 'Failed to load candidates' }, { status: 500 })
  }
}

/** POST — archive triage placeholder; move rack die to custody staging (Source: Rack). */
export async function POST(req: NextRequest) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const parsed = postSchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'triageDyeId and inventoryDyeId required' }, { status: 400 })
    }

    const { triageDyeId, inventoryDyeId, actorName: actorRaw } = parsed.data
    if (triageDyeId === inventoryDyeId) {
      return NextResponse.json({ error: 'Cannot select the triage record as inventory' }, { status: 400 })
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

      const tTrip = tripleFromDyeRow(triage)
      const iTrip = tripleFromDyeRow(inventory)
      if (!tTrip || !iTrip || !dimTriplesEqual(tTrip, iTrip)) {
        throw new HttpErr('Dimensions do not match exactly (L × W × H)', 409)
      }

      const triageSnap = triage.updatedAt
      const invSnap = inventory.updatedAt

      const slot = rackSlotLabel(inventory.location)
      const triageCode = `DYE-${triage.dyeNumber}`
      const invCode = `DYE-${inventory.dyeNumber}`
      const msg = `Die ${invCode} pulled from Slot [${slot}] to fulfill Job [${triageCode}]. Source: Rack.`

      const arch = await tx.dye.updateMany({
        where: {
          id: triageDyeId,
          updatedAt: triageSnap,
          custodyStatus: CUSTODY_HUB_TRIAGE,
          active: true,
        },
        data: {
          active: false,
          scrapReason: 'Triage fulfilled — existing die pulled from rack stock',
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
        actionType: DIE_HUB_ACTION.TAKE_FROM_STOCK_TO_CUSTODY,
        fromZone: dieHubZoneLabelFromCustody(CUSTODY_IN_STOCK),
        toZone: dieHubZoneLabelFromCustody(CUSTODY_HUB_CUSTODY_READY),
        actorName: actor,
        details: {
          message: msg,
          triageDyeId,
          triageDisplayCode: triageCode,
          inventoryDisplayCode: invCode,
          slot,
          source: 'rack',
        },
      })

      await createDieHubEvent(tx, {
        dyeId: triageDyeId,
        actionType: DIE_HUB_ACTION.TRIAGE_ARCHIVED_STOCK_FULFILL,
        fromZone: dieHubZoneLabelFromCustody(CUSTODY_HUB_TRIAGE),
        toZone: 'Archived',
        actorName: actor,
        details: {
          message: `Triage ${triageCode} closed — fulfilled from rack die ${invCode} (${slot}).`,
          inventoryDyeId,
          inventoryDisplayCode: invCode,
        },
      })
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'dyes',
      recordId: inventoryDyeId,
      newValue: {
        dieHubTakeFromStock: true,
        triageDyeId,
        inventoryDyeId,
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[tooling-hub/dies/take-from-stock POST]', e)
    if (e instanceof HttpErr) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'Take from stock failed' }, { status: 500 })
  }
}
