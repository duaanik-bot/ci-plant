import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { plateColourCanonicalKey } from '@/lib/hub-plate-card-ui'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'
import {
  activeColourNamesInOrder,
  mergeEffectiveCycleData,
  pruneCycleDataForActiveLabels,
} from '@/lib/plate-cycle-ledger'

export const dynamic = 'force-dynamic'

const RACK_STATUSES = ['ready', 'returned', 'in_stock'] as const

const bodySchema = z.object({
  requirementId: z.string().uuid(),
  selections: z
    .array(
      z.object({
        plateStoreId: z.string().uuid(),
        colourNames: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
})

type ColourRow = {
  name?: string
  status?: string
  type?: string
  rackLocation?: string | null
  slotNumber?: string | null
  condition?: string | null
}

function normHubKey(s: string | null | undefined): string {
  return String(s ?? '').trim().toLowerCase()
}

function recountPlateMetrics(colours: ColourRow[]) {
  const active = colours.filter((c) => String(c?.status ?? '').toLowerCase() !== 'destroyed')
  const numberOfColours = active.length
  const totalPlates = active.length
  const newPlates = active.filter((c) => String(c?.status ?? '').toLowerCase() === 'new').length
  const oldPlates = active.filter((c) => {
    const s = String(c?.status ?? '').toLowerCase()
    return s === 'old' || s === 'returned'
  }).length
  return { numberOfColours, totalPlates, newPlates, oldPlates }
}

async function nextPlateSetCode(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PS-${year}-`
  const last = await tx.plateStore.findFirst({
    where: { plateSetCode: { startsWith: prefix } },
    orderBy: { plateSetCode: 'desc' },
    select: { plateSetCode: true },
  })
  const lastSeq = last ? parseInt(last.plateSetCode.replace(prefix, ''), 10) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

async function nextPlateSerial(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PL-SN-${year}-`
  const last = await tx.plateStore.findFirst({
    where: { serialNumber: { startsWith: prefix } },
    orderBy: { serialNumber: 'desc' },
    select: { serialNumber: true },
  })
  const lastSeq = last?.serialNumber ? parseInt(last.serialNumber.replace(prefix, ''), 10) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

class TakeStockHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'TakeStockHttpError'
  }
}

/** Merge duplicate plate IDs; dedupe colour names per plate by canonical key. */
function mergeSelections(selections: z.infer<typeof bodySchema>['selections']) {
  const acc = new Map<string, string[]>()
  for (const s of selections) {
    const cur = acc.get(s.plateStoreId) ?? []
    acc.set(s.plateStoreId, [...cur, ...s.colourNames])
  }
  const out = new Map<string, string[]>()
  for (const [plateStoreId, raw] of Array.from(acc.entries())) {
    const seen = new Set<string>()
    const names: string[] = []
    for (const n of raw) {
      const t = String(n ?? '').trim()
      if (!t) continue
      const k = plateColourCanonicalKey(t)
      if (!k || seen.has(k)) continue
      seen.add(k)
      names.push(t)
    }
    if (names.length) out.set(plateStoreId, names)
  }
  return out
}

function rackSlotLabel(plate: {
  rackLocation: string | null
  rackNumber: string | null
  slotNumber: string | null
  plateSetCode: string
}): string {
  const loc = plate.rackLocation?.trim()
  if (loc) return loc
  const parts = [plate.rackNumber?.trim(), plate.slotNumber?.trim()].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  return plate.plateSetCode
}

/**
 * Batch-pull colour channels from multiple rack rows into custody plate rows (one new row per source),
 * shrink triage requirement in one transaction. Optimistic locks on each `plate_store` and
 * `plate_requirements` row prevent double-allocation if two operators confirm concurrently.
 */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'Invalid request: requirement id and a non-empty selections array (plateStoreId + colourNames each) are required.',
      },
      { status: 400 },
    )
  }

  const { requirementId, selections } = parsed.data

  try {
    const result = await db.$transaction(async (tx) => {
      const reqRow = await tx.plateRequirement.findUnique({ where: { id: requirementId } })
      if (!reqRow) throw new TakeStockHttpError('Requirement not found', 404)

      if (reqRow.triageChannel != null) {
        throw new TakeStockHttpError(
          'This job is not in incoming triage (clear lane dispatch first).',
          409,
        )
      }

      const triageStatuses = new Set(['pending', 'ctp_notified', 'plates_ready'])
      if (!triageStatuses.has(reqRow.status)) {
        throw new TakeStockHttpError('This requirement cannot take stock in its current status.', 409)
      }

      const needed = Array.isArray(reqRow.coloursNeeded)
        ? (reqRow.coloursNeeded as { name: string; isNew?: boolean }[])
        : []
      const initialNeededCanon = new Set(needed.map((x) => plateColourCanonicalKey(x.name)))

      const merged = mergeSelections(selections)
      if (merged.size === 0) {
        throw new TakeStockHttpError('No valid colour selections after merge.', 400)
      }

      const batchUnion = new Set<string>()
      for (const names of Array.from(merged.values())) {
        for (const n of names) {
          const k = plateColourCanonicalKey(n)
          if (batchUnion.has(k)) {
            throw new TakeStockHttpError(
              'Duplicate channel in batch — each required colour can only be pulled once.',
              400,
            )
          }
          batchUnion.add(k)
        }
      }

      for (const k of Array.from(batchUnion)) {
        if (!initialNeededCanon.has(k)) {
          throw new TakeStockHttpError(
            `Colour is not part of this job's requirement: ${k}`,
            400,
          )
        }
      }

      const reqSnap = reqRow.updatedAt

      const jobAw = normHubKey(reqRow.artworkCode)
      const jobCarton = normHubKey(reqRow.cartonName)

      const custodyPlateIds: string[] = []
      const custodyPlateCodes: string[] = []
      const slotLabels: string[] = []
      let totalChannelMoves = 0

      const sortedPlateIds = Array.from(merged.keys()).sort()

      for (const plateStoreId of sortedPlateIds) {
        const colourNames = merged.get(plateStoreId)!
        const wantedCanon = new Set(colourNames.map((n) => plateColourCanonicalKey(n)).filter(Boolean))

        const plate = await tx.plateStore.findUnique({ where: { id: plateStoreId } })
        if (!plate) throw new TakeStockHttpError('Plate set not found', 404)

        if (!RACK_STATUSES.includes(plate.status as (typeof RACK_STATUSES)[number])) {
          throw new TakeStockHttpError(
            'One or more plate sets are no longer in live inventory — refresh and try again.',
            409,
          )
        }

        if (jobAw) {
          if (normHubKey(plate.artworkCode) !== jobAw) {
            throw new TakeStockHttpError('Plate set AW code does not match this triage job.', 409)
          }
        } else if (normHubKey(plate.cartonName) !== jobCarton) {
          throw new TakeStockHttpError('Plate set carton does not match this triage job.', 409)
        }

        const sourceColours = (Array.isArray(plate.colours) ? plate.colours : []) as ColourRow[]

        const pulledForCustody: ColourRow[] = []
        for (const row of sourceColours) {
          const name = String(row?.name ?? '').trim()
          const st = String(row?.status ?? '').toLowerCase()
          if (!name || st === 'destroyed') continue
          if (!wantedCanon.has(plateColourCanonicalKey(name))) continue
          pulledForCustody.push({
            ...row,
            rackLocation: null,
            slotNumber: null,
          })
        }

        const pulledCanon = new Set(
          pulledForCustody.map((r) => plateColourCanonicalKey(String(r.name))),
        )
        for (const wCanon of Array.from(wantedCanon)) {
          if (!pulledCanon.has(wCanon)) {
            throw new TakeStockHttpError(
              'One or more colours are not available on a selected plate set (check rack / partial scrap).',
              400,
            )
          }
        }

        slotLabels.push(rackSlotLabel(plate))

        const nowIso = new Date().toISOString()
        const nextSource = sourceColours.map((row) => {
          const name = String(row?.name ?? '').trim()
          const st = String(row?.status ?? '').toLowerCase()
          if (!name || st === 'destroyed') return row
          if (wantedCanon.has(plateColourCanonicalKey(name))) {
            return {
              ...row,
              status: 'destroyed',
              destroyedAt: nowIso,
              destroyReason: 'issued_from_rack_to_custody',
            }
          }
          return row
        })

        const srcMetrics = recountPlateMetrics(nextSource)
        const fullyGone = srcMetrics.numberOfColours === 0

        const plateSetCode = await nextPlateSetCode(tx)
        const serialNumber = await nextPlateSerial(tx)
        const custodyMetrics = recountPlateMetrics(pulledForCustody)

        const effectiveCycle = mergeEffectiveCycleData({
          cycleData: plate.cycleData,
          colours: plate.colours,
        })
        const parentActiveAfter = activeColourNamesInOrder(nextSource)
        const childCycle = pruneCycleDataForActiveLabels(effectiveCycle, colourNames)
        const parentCycle = pruneCycleDataForActiveLabels(effectiveCycle, parentActiveAfter)

        const snapPlateUpdatedAt = plate.updatedAt

        const updSrc = await tx.plateStore.updateMany({
          where: {
            id: plateStoreId,
            updatedAt: snapPlateUpdatedAt,
            status: { in: [...RACK_STATUSES] },
          },
          data: {
            colours: nextSource as object[],
            cycleData: parentCycle as object,
            numberOfColours: srcMetrics.numberOfColours,
            totalPlates: srcMetrics.totalPlates,
            newPlates: srcMetrics.newPlates,
            oldPlates: srcMetrics.oldPlates,
            ...(fullyGone
              ? {
                  status: 'destroyed',
                  destroyedAt: new Date(),
                  destroyedBy: user!.id,
                  destroyedReason: 'All channels moved to custody floor from rack',
                  hubCustodySource: null,
                  hubPreviousStatus: null,
                }
              : {
                  lastStatusUpdatedAt: new Date(),
                }),
          },
        })

        if (updSrc.count !== 1) {
          throw new TakeStockHttpError(
            'Another operator updated this inventory row — refresh and try again.',
            409,
          )
        }

        const custodyPlate = await tx.plateStore.create({
          data: {
            plateSetCode,
            serialNumber,
            cartonName: plate.cartonName,
            artworkCode: plate.artworkCode,
            artworkVersion: plate.artworkVersion,
            cartonId: plate.cartonId,
            artworkId: plate.artworkId,
            customerId: plate.customerId,
            plateSize: plate.plateSize,
            numberOfColours: custodyMetrics.numberOfColours,
            totalPlates: custodyMetrics.totalPlates,
            newPlates: custodyMetrics.newPlates,
            oldPlates: custodyMetrics.oldPlates,
            colours: pulledForCustody as object[],
            cycleData: childCycle as object,
            status: 'READY_ON_FLOOR',
            hubCustodySource: 'rack',
            hubPreviousStatus: plate.status,
            jobCardId: reqRow.jobCardId ?? null,
            rackLocation: null,
            slotNumber: null,
            rackNumber: null,
            ups: plate.ups,
            lastStatusUpdatedAt: new Date(),
          },
        })

        custodyPlateIds.push(custodyPlate.id)
        custodyPlateCodes.push(custodyPlate.plateSetCode)
        totalChannelMoves += pulledForCustody.length
      }

      const finalNeeded = needed.filter(
        (item) => !batchUnion.has(plateColourCanonicalKey(item.name)),
      )
      const fullyFulfilled = finalNeeded.length === 0

      const updReq = await tx.plateRequirement.updateMany({
        where: {
          id: requirementId,
          updatedAt: reqSnap,
        },
        data: {
          coloursNeeded: finalNeeded as object[],
          numberOfColours: finalNeeded.length,
          newPlatesNeeded: finalNeeded.length,
          lastStatusUpdatedAt: new Date(),
          ...(fullyFulfilled
            ? {
                status: 'fulfilled_from_rack',
                triageChannel: null,
              }
            : {}),
        },
      })

      if (updReq.count !== 1) {
        throw new TakeStockHttpError(
          'Triage requirement changed while saving — refresh and try again.',
          409,
        )
      }

      const uniqueSlots = Array.from(new Set(slotLabels))
      const batchMsg = `Batch inventory pull: ${totalChannelMoves} channel(s) moved to custody floor from ${custodyPlateIds.length} set(s) (${custodyPlateCodes.join(', ')}). Slots: ${uniqueSlots.join('; ')}.`

      await createPlateHubEvent(tx, {
        plateRequirementId: requirementId,
        actionType: PLATE_HUB_ACTION.BATCH_INVENTORY_PULL,
        fromZone: HUB_ZONE.INCOMING_TRIAGE,
        toZone: fullyFulfilled ? HUB_ZONE.FULFILLED : HUB_ZONE.INCOMING_TRIAGE,
        details: {
          message: batchMsg,
          totalChannelMoves,
          setCount: custodyPlateIds.length,
          custodyPlateIds,
          custodyPlateCodes,
          slotLabels: uniqueSlots,
          selections,
          fulfilled: fullyFulfilled,
        },
      })

      return {
        custodyPlateIds,
        custodyPlateCodes,
        fulfilled: fullyFulfilled,
        totalChannelMoves,
      }
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'plate_requirements',
      recordId: requirementId,
      newValue: {
        batchTakeFromStock: true,
        selections,
        ...result,
      } as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error('[plate-hub/take-from-stock]', e)
    if (e instanceof TakeStockHttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (/Unique constraint|unique constraint/i.test(msg)) {
      return NextResponse.json(
        { error: 'Failed to move inventory: duplicate plate code — retry in a moment.' },
        { status: 409 },
      )
    }
    if (/database is locked|SQLITE_BUSY/i.test(msg)) {
      return NextResponse.json({ error: 'Failed to move inventory: database busy — try again.' }, { status: 503 })
    }
    return NextResponse.json(
      { error: msg || 'Failed to move inventory. Try again or contact support.' },
      { status: 500 },
    )
  }
}
