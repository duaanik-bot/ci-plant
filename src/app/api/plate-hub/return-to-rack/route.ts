import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { PlateSize, type Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { plateColourCanonicalKey } from '@/lib/hub-plate-card-ui'
import { plateScrapReasonLabel } from '@/lib/plate-scrap-reasons'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'
import {
  incrementCycleDataForReturns,
  initialCycleDataForChannelNames,
  mergeEffectiveCycleData,
} from '@/lib/plate-cycle-ledger'
export const dynamic = 'force-dynamic'

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

const firstOriginSchema = z.enum(['inhouse_ctp', 'outside_vendor', 'legacy_unknown'])

const sizeModificationReasonSchema = z.enum([
  'alternate_machine',
  'edge_damage',
  'prepress_error',
])

export const SIZE_MODIFICATION_REASON_LABELS: Record<
  z.infer<typeof sizeModificationReasonSchema>,
  string
> = {
  alternate_machine: 'Resized for alternate machine assignment',
  edge_damage: 'Trimmed due to edge damage / wear',
  prepress_error: 'Pre-press layout error / Manual correction',
}

const bodySchema = z
  .object({
    /** Physical plate set on custody floor (Source: Rack, or plate row from vendor/CTP path). */
    plateStoreId: z.string().uuid().optional(),
    /** CTP/vendor requirement row on custody floor (`READY_ON_FLOOR`) — materializes inventory. */
    requirementId: z.string().uuid().optional(),
    /** When empty, server treats as “all active / needed channels” for the plate or requirement. */
    returnedColourNames: z.array(z.string().min(1)).default([]),
    firstOrigin: firstOriginSchema,
    /** If omitted, existing DB plate size is kept. */
    targetPlateSize: z.nativeEnum(PlateSize).optional(),
    sizeModificationReason: sizeModificationReasonSchema.optional(),
    sizeModificationRemarks: z.string().max(500).optional(),
  })
  .refine((d) => Boolean(d.plateStoreId) !== Boolean(d.requirementId), {
    message: 'Provide exactly one of plateStoreId or requirementId',
  })

type ColourRow = {
  name?: string
  type?: string
  status?: string
  scrapReasonCode?: string
  scrappedAt?: string
  reuseCount?: number
  firstOrigin?: string
  lastReturnAt?: string
  destroyReason?: string
  destroyedAt?: string
  hubShopfloorActive?: boolean
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

/** Custody → rack: reuse increment + origin on returned channels; scrap omitted channels (single transaction). */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.flatten().formErrors[0] ??
          'Invalid request — send exactly one of plateStoreId or requirementId, plus returnedColourNames.',
      },
      { status: 400 },
    )
  }

  let {
    plateStoreId,
    requirementId,
    returnedColourNames,
    firstOrigin,
    targetPlateSize,
    sizeModificationReason,
    sizeModificationRemarks,
  } = parsed.data

  const nowIso = new Date().toISOString()
  const remarksTrimmed = sizeModificationRemarks?.trim() || ''

  // ── Custody requirement (vendor / in-house CTP) → new live inventory plate set ──
  if (requirementId) {
    const reqRow = await db.plateRequirement.findUnique({ where: { id: requirementId } })
    if (!reqRow) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })
    if (reqRow.status !== 'READY_ON_FLOOR') {
      return NextResponse.json(
        { error: 'Only custody floor requirements can return to rack' },
        { status: 409 },
      )
    }

    const needed = Array.isArray(reqRow.coloursNeeded)
      ? (reqRow.coloursNeeded as {
          name: string
          isNew?: boolean
          hubShopfloorActive?: boolean
        }[])
      : []

    if (!returnedColourNames.length) {
      returnedColourNames = needed
        .filter((row) => {
          if (!row || typeof row !== 'object') return false
          const st = String((row as ColourRow).status ?? '').toLowerCase()
          if (st === 'destroyed') return false
          if (row.hubShopfloorActive === false) return false
          return true
        })
        .map((row) => String(row.name ?? '').trim())
        .filter(Boolean)
    }

    returnedColourNames = returnedColourNames.filter((n) => {
      const canon = plateColourCanonicalKey(n)
      const row = needed.find((x) => plateColourCanonicalKey(x.name) === canon)
      if (!row) return false
      return row.hubShopfloorActive !== false
    })

    if (!returnedColourNames.length) {
      return NextResponse.json(
        { error: 'No channels to return — requirement has no active colours.' },
        { status: 400 },
      )
    }
    const wantedCanon = new Set(
      returnedColourNames.map((n) => plateColourCanonicalKey(n)).filter(Boolean),
    )
    const neededCanonSet = new Set(needed.map((r) => plateColourCanonicalKey(r.name)))

    for (const w of Array.from(wantedCanon)) {
      if (!neededCanonSet.has(w)) {
        console.log('[plate-hub/return-to-rack] Requirement colour mismatch', {
          returnedColourNames,
          wantedCanon: Array.from(wantedCanon),
          jobColours: needed.map((x) => x.name),
          jobCanon: Array.from(neededCanonSet),
        })
        const display =
          returnedColourNames.find((n) => plateColourCanonicalKey(n) === w) ?? w
        return NextResponse.json(
          { error: `Colour is not part of this requirement: ${display}` },
          { status: 400 },
        )
      }
    }

    const rowsForRack = needed.filter((row) =>
      wantedCanon.has(plateColourCanonicalKey(row.name)),
    )
    const rowsRemain = needed.filter(
      (row) => !wantedCanon.has(plateColourCanonicalKey(row.name)),
    )
    if (!rowsForRack.length) {
      return NextResponse.json({ error: 'No matching channels to move to inventory' }, { status: 400 })
    }

    const baselineSize = reqRow.plateSize ?? PlateSize.SIZE_560_670
    const resolvedTargetSize = targetPlateSize ?? reqRow.plateSize ?? PlateSize.SIZE_560_670
    const plateSizeChanged = resolvedTargetSize !== baselineSize
    if (plateSizeChanged && !sizeModificationReason) {
      return NextResponse.json(
        { error: 'Reason for size modification is required when plate dimensions are changed.' },
        { status: 400 },
      )
    }

    const reasonLabel = sizeModificationReason
      ? SIZE_MODIFICATION_REASON_LABELS[sizeModificationReason]
      : null
    let storageNotes: string | null = null
    if (plateSizeChanged && reasonLabel) {
      const line = `[${nowIso}] Plate size (custody requirement ${reqRow.requirementCode}): ${baselineSize} → ${resolvedTargetSize}: ${reasonLabel}${
        remarksTrimmed ? `. Remarks: ${remarksTrimmed}` : ''
      }`
      storageNotes = line
    }

    const newColourJson: ColourRow[] = rowsForRack.map((r) => ({
      name: r.name,
      type: 'process',
      status: r.isNew ? 'new' : 'returned',
      firstOrigin,
      lastReturnAt: nowIso,
    }))
    const { numberOfColours, totalPlates, newPlates, oldPlates } = recountPlateMetrics(newColourJson)
    const initialCycleData = initialCycleDataForChannelNames(rowsForRack.map((r) => String(r.name)))

    const created = await db.$transaction(async (tx) => {
      const plateSetCode = await nextPlateSetCode(tx)
      const serialNumber = await nextPlateSerial(tx)

      const plate = await tx.plateStore.create({
        data: {
          plateSetCode,
          serialNumber,
          cartonName: reqRow.cartonName,
          artworkCode: reqRow.artworkCode,
          artworkVersion: reqRow.artworkVersion,
          customerId: reqRow.customerId,
          jobCardId: reqRow.jobCardId,
          numberOfColours,
          totalPlates,
          newPlates,
          oldPlates,
          colours: newColourJson as object[],
          cycleData: initialCycleData as object,
          status: 'in_stock',
          plateSize: resolvedTargetSize,
          storageNotes,
          lastStatusUpdatedAt: new Date(),
        },
      })

      const fullyDone = rowsRemain.length === 0
      await tx.plateRequirement.update({
        where: { id: requirementId },
        data: {
          coloursNeeded: rowsRemain as object[],
          numberOfColours: rowsRemain.length,
          newPlatesNeeded: rowsRemain.length,
          lastStatusUpdatedAt: new Date(),
          ...(fullyDone
            ? { status: 'fulfilled_from_rack', triageChannel: null }
            : {}),
        },
      })

      await createPlateHubEvent(tx, {
        plateRequirementId: requirementId,
        actionType: PLATE_HUB_ACTION.RETURNED,
        fromZone: HUB_ZONE.CUSTODY_FLOOR,
        toZone: fullyDone ? HUB_ZONE.FULFILLED : HUB_ZONE.CUSTODY_FLOOR,
        details: {
          returnedColourNames,
          firstOrigin,
          materializedPlateStoreId: plate.id,
          plateSetCode: plate.plateSetCode,
          channelsToRack: rowsForRack.map((r) => r.name),
          remainingChannels: rowsRemain.length,
          fulfilled: fullyDone,
          plateSizeChanged,
          previousPlateSize: baselineSize,
          targetPlateSize: resolvedTargetSize,
          sizeModificationReason: sizeModificationReason ?? undefined,
          sizeModificationRemarks: remarksTrimmed || undefined,
        },
      })

      await createPlateHubEvent(tx, {
        plateStoreId: plate.id,
        actionType: PLATE_HUB_ACTION.MATERIALIZED_TO_INVENTORY,
        fromZone: HUB_ZONE.CUSTODY_FLOOR,
        toZone: HUB_ZONE.LIVE_INVENTORY,
        details: {
          requirementId,
          requirementCode: reqRow.requirementCode,
          channels: rowsForRack.map((r) => r.name),
          plateSizeChanged,
          oldSize: String(baselineSize),
          newSize: String(resolvedTargetSize),
          firstOrigin,
        },
      })

      return plate
    })

    await createAuditLog({
      userId: user!.id,
      action: 'INSERT',
      tableName: 'plate_store',
      recordId: created.id,
      newValue: {
        custodyRequirementReturn: true,
        requirementId,
        requirementCode: reqRow.requirementCode,
        plateSetCode: created.plateSetCode,
        returnedColourNames,
        firstOrigin,
        plateSizeChanged,
        targetPlateSize: resolvedTargetSize,
        sizeModificationReason: sizeModificationReason ?? undefined,
        sizeModificationRemarks: remarksTrimmed || undefined,
      } as Record<string, unknown>,
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'plate_requirements',
      recordId: requirementId,
      newValue: {
        custodyReturnToRack: true,
        channelsToInventory: rowsForRack.map((r) => r.name),
        remainingChannels: rowsRemain.length,
        fulfilled: rowsRemain.length === 0,
      } as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true, plate: created, fromRequirement: true })
  }

  // ── Physical plate set on custody ──
  if (!plateStoreId) {
    return NextResponse.json({ error: 'plateStoreId required' }, { status: 400 })
  }

  const plate = await db.plateStore.findUnique({ where: { id: plateStoreId } })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })
  if (plate.status !== 'READY_ON_FLOOR') {
    return NextResponse.json({ error: 'Only custody floor plates can return to rack' }, { status: 409 })
  }

  const colours = (Array.isArray(plate.colours) ? plate.colours : []) as ColourRow[]
  const activeRows = colours.filter((c) => String(c?.status ?? '').toLowerCase() !== 'destroyed')
  const activeNames = activeRows
    .map((c) => String(c?.name ?? '').trim())
    .filter(Boolean)

  if (!returnedColourNames.length) {
    returnedColourNames = [...activeNames]
  }
  if (!returnedColourNames.length) {
    return NextResponse.json(
      { error: 'No channels to return — plate set has no active colours.' },
      { status: 400 },
    )
  }

  const returnedSet = new Set(returnedColourNames.map((n) => n.trim().toLowerCase()).filter(Boolean))
  const activeLower = new Set(activeNames.map((n) => n.toLowerCase()))

  for (const r of Array.from(returnedSet)) {
    if (!activeLower.has(r)) {
      return NextResponse.json(
        { error: `Not an active channel on this set: ${returnedColourNames.find((n) => n.trim().toLowerCase() === r) ?? r}` },
        { status: 400 },
      )
    }
  }

  const resolvedTargetSize = targetPlateSize ?? plate.plateSize
  const plateSizeChanged = resolvedTargetSize !== plate.plateSize
  if (plateSizeChanged && !sizeModificationReason) {
    return NextResponse.json(
      { error: 'Reason for size modification is required when plate dimensions are changed.' },
      { status: 400 },
    )
  }

  const reasonLabel = sizeModificationReason
    ? SIZE_MODIFICATION_REASON_LABELS[sizeModificationReason]
    : null
  let nextStorageNotes = plate.storageNotes?.trim() ?? ''
  if (plateSizeChanged && reasonLabel) {
    const line = `[${nowIso}] Plate size ${plate.plateSize} → ${resolvedTargetSize}: ${reasonLabel}${
      remarksTrimmed ? `. Remarks: ${remarksTrimmed}` : ''
    }`
    nextStorageNotes = nextStorageNotes ? `${nextStorageNotes}\n${line}` : line
    if (nextStorageNotes.length > 8000) {
      nextStorageNotes = nextStorageNotes.slice(-8000)
    }
  }

  const scrapReasonCode = 'custody_not_returned' as const
  const scrapReasonLabel = plateScrapReasonLabel(scrapReasonCode)
  const omittedNames: string[] = []

  const effectiveCycle = mergeEffectiveCycleData({
    cycleData: plate.cycleData,
    colours: plate.colours,
  })
  const nextCycleData = incrementCycleDataForReturns(
    effectiveCycle,
    activeNames,
    returnedColourNames,
  )

  const nextColours = colours.map((row) => {
    const name = String(row?.name ?? '').trim()
    const st = String(row?.status ?? '').toLowerCase()
    if (!name || st === 'destroyed') return row

    if (!returnedSet.has(name.toLowerCase())) {
      omittedNames.push(name)
      return {
        ...row,
        status: 'destroyed',
        scrapReasonCode,
        scrappedAt: nowIso,
      }
    }

    return {
      ...row,
      firstOrigin,
      lastReturnAt: nowIso,
    }
  })

  const { numberOfColours, totalPlates, newPlates, oldPlates } = recountPlateMetrics(nextColours)
  const fullyGone = numberOfColours === 0
  const prevStatus =
    String(plate.hubPreviousStatus ?? '').trim() && ['ready', 'returned', 'in_stock'].includes(String(plate.hubPreviousStatus))
      ? String(plate.hubPreviousStatus)
      : 'ready'

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateStore.update({
      where: { id: plateStoreId },
      data: {
        plateSize: resolvedTargetSize,
        ...(plateSizeChanged ? { storageNotes: nextStorageNotes || null } : {}),
        colours: nextColours as object[],
        cycleData: nextCycleData as object,
        numberOfColours,
        totalPlates,
        newPlates,
        oldPlates,
        status: fullyGone ? 'destroyed' : prevStatus,
        ...(fullyGone
          ? {
              destroyedAt: new Date(),
              destroyedBy: user!.id,
              destroyedReason: `Custody return — all channels removed (${omittedNames.join(', ')})`,
              hubCustodySource: null,
              hubPreviousStatus: null,
            }
          : {
              hubCustodySource: null,
              hubPreviousStatus: null,
              issuedTo: null,
              issuedAt: null,
            }),
        lastStatusUpdatedAt: new Date(),
        ...(fullyGone
          ? {}
          : {
              destroyedAt: null,
              destroyedBy: null,
              destroyedReason: null,
            }),
      },
    })

    if (omittedNames.length > 0) {
      await tx.plateStoreScrapEvent.create({
        data: {
          plateStoreId,
          scrappedNames: omittedNames,
          reasonCode: scrapReasonCode,
          reasonLabel: scrapReasonLabel,
          performedBy: user!.id,
        },
      })
    }

    await createPlateHubEvent(tx, {
      plateStoreId,
      actionType: PLATE_HUB_ACTION.RETURNED,
      fromZone: HUB_ZONE.CUSTODY_FLOOR,
      toZone: fullyGone ? HUB_ZONE.OTHER : HUB_ZONE.LIVE_INVENTORY,
      details: {
        returnedColourNames,
        firstOrigin,
        omittedToScrap: omittedNames,
        fullyDestroyed: fullyGone,
        plateSizeChanged,
        previousPlateSize: plateSizeChanged ? plate.plateSize : undefined,
        targetPlateSize: plateSizeChanged ? resolvedTargetSize : undefined,
        sizeModificationReason: sizeModificationReason ?? undefined,
        sizeModificationRemarks: remarksTrimmed || undefined,
        scrapReasonCode: omittedNames.length ? scrapReasonCode : undefined,
        scrapReasonLabel: omittedNames.length ? scrapReasonLabel : undefined,
      },
    })

    return u
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: plateStoreId,
    newValue: {
      returnToRack: true,
      returnedColourNames,
      firstOrigin,
      omittedToScrap: omittedNames,
      fullyDestroyed: fullyGone,
      returnedAt: nowIso,
      plateSizeChanged,
      previousPlateSize: plateSizeChanged ? plate.plateSize : undefined,
      targetPlateSize: plateSizeChanged ? resolvedTargetSize : undefined,
      sizeModificationReason: sizeModificationReason ?? undefined,
      sizeModificationRemarks: remarksTrimmed || undefined,
    } as Record<string, unknown>,
  })

  return NextResponse.json({ ok: true, plate: updated })
}
