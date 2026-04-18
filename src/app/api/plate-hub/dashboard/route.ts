import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'
import { plateNamesFromColoursNeededJson } from '@/lib/plate-triage-display'
import { activeColourRowsFromJson, countPlatesInRack } from '@/lib/hub-plate-card-ui'
import { mergeEffectiveCycleData } from '@/lib/plate-cycle-ledger'
import { hubJobCardHubStatus } from '@/lib/hub-job-card-status'
import type { HubPlateSize } from '@/lib/plate-size'
import {
  ledgerZoneBadgeClass,
  ledgerZoneLabel,
  type LedgerZoneKey,
  type PlateHubLedgerRowJson,
} from '@/lib/plate-hub-ledger'
import {
  countActiveShopfloorColours,
  shopfloorInactiveCanonicalKeysFromJson,
} from '@/lib/plate-shopfloor-spec'
import { extractPoLineIdFromCartonLabel } from '@/lib/plate-requirement-po-link'

export const dynamic = 'force-dynamic'

function channelNamesFromActiveJson(activeJson: unknown[]): string[] {
  return activeJson
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      return String((item as { name?: string }).name ?? '').trim()
    })
    .filter(Boolean) as string[]
}

function ledgerRequirementRow(
  r: {
    id: string
    requirementCode: string
    poLineId?: string | null
    jobCardId?: string | null
    cartonName: string
    artworkCode: string | null
    artworkVersion: string | null
    plateColours: string[]
    newPlatesNeeded: number
    numberOfColours?: number
    lastStatusUpdatedAt: string
    ledgerEntryAt: string
    status: string
    plateSize?: HubPlateSize | null
    partialRemake?: boolean
    linkedCustomerNames?: string[]
    poNumber?: string | null
    industrialPriority?: boolean
  },
  zoneKey: LedgerZoneKey,
): PlateHubLedgerRowJson {
  return {
    entity: 'requirement',
    id: r.id,
    jobId: r.requirementCode,
    displayCode: r.requirementCode,
    cartonName: r.cartonName,
    artworkCode: r.artworkCode,
    artworkVersion: r.artworkVersion,
    poLineId: r.poLineId ?? null,
    linkedCustomerNames: r.linkedCustomerNames,
    poNumber: r.poNumber ?? null,
    industrialPriority: r.industrialPriority,
    zoneKey,
    zoneLabel: ledgerZoneLabel(zoneKey),
    zoneBadgeClass: ledgerZoneBadgeClass(zoneKey),
    plateSize: r.plateSize ?? null,
    plateColours: r.plateColours,
    coloursRequired:
      zoneKey === 'ctp_queue' || zoneKey === 'outside_vendor'
        ? Math.max(0, r.newPlatesNeeded ?? r.numberOfColours ?? 0)
        : Math.max(
            r.plateColours.length,
            r.newPlatesNeeded ?? r.numberOfColours ?? 0,
          ),
    platesInRackCount: null,
    lastStatusUpdatedAt: r.lastStatusUpdatedAt,
    ledgerEntryAt: r.ledgerEntryAt,
    statusLabel: r.status.replace(/_/g, ' '),
    partialRemake: r.partialRemake,
    custodySource: undefined,
    jobCardId: r.jobCardId ?? null,
  }
}

function ledgerPlateRow(
  p: {
    id: string
    plateSetCode: string
    cartonName: string
    artworkCode: string | null
    artworkVersion: string | null
    jobCardId: string | null
    plateColours: string[]
    numberOfColours?: number
    totalPlates?: number
    platesInRackCount?: number
    lastStatusUpdatedAt: string
    ledgerEntryAt: string
    status: string
    plateSize?: HubPlateSize | null
    customer?: { name: string } | null
    industrialPriority?: boolean
  },
  zoneKey: LedgerZoneKey,
): PlateHubLedgerRowJson {
  const cust = p.customer?.name?.trim()
  return {
    entity: 'plate',
    id: p.id,
    jobId: p.plateSetCode,
    displayCode: p.plateSetCode,
    cartonName: p.cartonName,
    artworkCode: p.artworkCode,
    artworkVersion: p.artworkVersion,
    poLineId: null,
    linkedCustomerNames: cust ? [cust] : [],
    poNumber: null,
    industrialPriority: p.industrialPriority,
    zoneKey,
    zoneLabel: ledgerZoneLabel(zoneKey),
    zoneBadgeClass: ledgerZoneBadgeClass(zoneKey),
    plateSize: p.plateSize ?? null,
    plateColours: p.plateColours,
    coloursRequired: Math.max(
      p.plateColours.length,
      p.numberOfColours ?? p.totalPlates ?? 0,
    ),
    platesInRackCount: p.platesInRackCount ?? null,
    lastStatusUpdatedAt: p.lastStatusUpdatedAt,
    ledgerEntryAt: p.ledgerEntryAt,
    statusLabel: p.status.replace(/_/g, ' '),
    partialRemake: undefined,
    custodySource: undefined,
    jobCardId: p.jobCardId,
  }
}

function ledgerCustodyRow(c: {
  kind: 'requirement' | 'plate'
  id: string
  displayCode: string
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  plateColours: string[]
  custodySource: 'ctp' | 'vendor' | 'rack'
  numberOfColours?: number
  newPlatesNeeded?: number
  totalPlates?: number
  platesInRackCount?: number
  partialRemake?: boolean
  lastStatusUpdatedAt: string
  ledgerEntryAt: string
  plateSize?: HubPlateSize | null
  jobCardId: string | null
  customer?: { name: string } | null
  industrialPriority?: boolean
  poLineId?: string | null
  linkedCustomerNames?: string[]
  poNumber?: string | null
}): PlateHubLedgerRowJson {
  const zoneKey: LedgerZoneKey = 'custody_floor'
  const src =
    c.custodySource === 'vendor' ? 'Vendor' : c.custodySource === 'ctp' ? 'CTP' : 'Rack'
  const cn = c.customer?.name?.trim()
  const names =
    c.linkedCustomerNames && c.linkedCustomerNames.length > 0
      ? c.linkedCustomerNames
      : cn
        ? [cn]
        : []
  return {
    entity: c.kind === 'requirement' ? 'requirement' : 'plate',
    id: c.id,
    jobId: c.displayCode,
    displayCode: c.displayCode,
    cartonName: c.cartonName,
    artworkCode: c.artworkCode,
    artworkVersion: c.artworkVersion,
    poLineId: c.poLineId ?? null,
    linkedCustomerNames: names,
    poNumber: c.poNumber ?? null,
    industrialPriority: c.industrialPriority,
    zoneKey,
    zoneLabel: ledgerZoneLabel(zoneKey),
    zoneBadgeClass: ledgerZoneBadgeClass(zoneKey),
    plateSize: c.plateSize ?? null,
    plateColours: c.plateColours,
    coloursRequired: Math.max(
      c.plateColours.length,
      c.kind === 'requirement'
        ? (c.newPlatesNeeded ?? c.numberOfColours ?? 0)
        : (c.numberOfColours ?? c.totalPlates ?? 0),
    ),
    platesInRackCount: c.platesInRackCount ?? null,
    lastStatusUpdatedAt: c.lastStatusUpdatedAt,
    ledgerEntryAt: c.ledgerEntryAt,
    statusLabel: `Staging · ${src}`,
    partialRemake: c.partialRemake,
    custodySource: c.custodySource,
    jobCardId: c.jobCardId,
  }
}

/**
 * Single payload for Plate Hub wireframe: triage + CTP + outside vendor + inventory + custody.
 */
export async function GET() {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const [
      triageRows,
      ctpRows,
      vendorRows,
      inventoryRows,
      stagingReqRows,
      stagingPlateRows,
    ] = await Promise.all([
      db.plateRequirement.findMany({
        where: {
          triageChannel: null,
          status: { in: ['pending', 'ctp_notified', 'plates_ready'] },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.plateRequirement.findMany({
        where: { status: 'ctp_internal_queue', triageChannel: 'inhouse_ctp' },
        orderBy: { createdAt: 'asc' },
      }),
      db.plateRequirement.findMany({
        where: {
          triageChannel: 'outside_vendor',
          status: 'awaiting_vendor_delivery',
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.plateStore.findMany({
        where: { status: { in: ['ready', 'returned', 'in_stock'] } },
        orderBy: { updatedAt: 'desc' },
        include: { customer: { select: { id: true, name: true } } },
      }),
      db.plateRequirement.findMany({
        where: { status: 'READY_ON_FLOOR' },
        orderBy: { updatedAt: 'desc' },
      }),
      db.plateStore.findMany({
        where: { status: 'READY_ON_FLOOR' },
        orderBy: { updatedAt: 'desc' },
        include: { customer: { select: { id: true, name: true } } },
      }),
    ])

    const custodyJobCardIds = [
      ...stagingReqRows.map((r) => r.jobCardId).filter(Boolean),
      ...stagingPlateRows.map((p) => p.jobCardId).filter(Boolean),
    ] as string[]
    const uniqCustodyJc = Array.from(new Set(custodyJobCardIds))
    const jobCardsForCustody =
      uniqCustodyJc.length > 0
        ? await db.productionJobCard.findMany({
            where: { id: { in: uniqCustodyJc } },
            select: { id: true, status: true, finalQcPass: true, qaReleased: true },
          })
        : []
    const jcHubById = new Map(
      jobCardsForCustody.map((j) => [j.id, hubJobCardHubStatus(j)] as const),
    )

    const triageEffectivePoLineIds = Array.from(
      new Set(
        triageRows.flatMap((r) => {
          const col = r.poLineId?.trim()
          const parsed = extractPoLineIdFromCartonLabel(r.cartonName)
          const out: string[] = []
          if (col) out.push(col)
          if (parsed) out.push(parsed)
          return out
        }),
      ),
    )
    const ctpVendorLineIds = Array.from(
      new Set(
        [...ctpRows, ...vendorRows]
          .map((r) => r.poLineId?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    )
    const allIntelLineIds = Array.from(new Set([...triageEffectivePoLineIds, ...ctpVendorLineIds]))
    const linesForIntel =
      allIntelLineIds.length > 0
        ? await db.poLineItem.findMany({
            where: { id: { in: allIntelLineIds } },
            select: {
              id: true,
              cartonId: true,
              directorPriority: true,
              po: {
                select: {
                  id: true,
                  poNumber: true,
                  isPriority: true,
                  customer: { select: { name: true } },
                },
              },
            },
          })
        : []
    const lineIntelByLineId = new Map<
      string,
      {
        purchaseOrderId: string
        poNumber: string
        linkedCustomerNames: string[]
        industrialPriority: boolean
      }
    >()
    for (const line of linesForIntel) {
      const cust = line.po.customer?.name?.trim()
      lineIntelByLineId.set(line.id, {
        purchaseOrderId: line.po.id,
        poNumber: line.po.poNumber,
        linkedCustomerNames: cust ? [cust] : [],
        industrialPriority: Boolean(line.directorPriority) || Boolean(line.po.isPriority),
      })
    }
    const triagePoMetaByLineId = new Map<
      string,
      { purchaseOrderId: string; poNumber: string }
    >()
    for (const line of linesForIntel) {
      triagePoMetaByLineId.set(line.id, {
        purchaseOrderId: line.po.id,
        poNumber: line.po.poNumber,
      })
    }
    const triageCartonIds = Array.from(
      new Set(
        linesForIntel.map((l) => l.cartonId).filter((id): id is string => Boolean(id)),
      ),
    )
    const triageCartonsMaster =
      triageCartonIds.length > 0
        ? await db.carton.findMany({
            where: { id: { in: triageCartonIds } },
            select: { id: true, plateSize: true },
          })
        : []
    const cartonPlateById = new Map(
      triageCartonsMaster.map((c) => [c.id, c.plateSize] as const),
    )
    const cartonMasterPlateByPoLineId = new Map<
      string,
      (typeof triageCartonsMaster)[0]['plateSize']
    >()
    for (const line of linesForIntel) {
      if (!line.cartonId) {
        cartonMasterPlateByPoLineId.set(line.id, null)
        continue
      }
      cartonMasterPlateByPoLineId.set(line.id, cartonPlateById.get(line.cartonId) ?? null)
    }

    const triage = triageRows.map((r) => {
      const activeNeeded = activeColourRowsFromJson(r.coloursNeeded)
      const poKey = r.poLineId?.trim()
      const extractedLineId = extractPoLineIdFromCartonLabel(r.cartonName)
      const effectivePoLineId = poKey || extractedLineId || null
      const poMeta = effectivePoLineId ? triagePoMetaByLineId.get(effectivePoLineId) : undefined
      const intel = effectivePoLineId ? lineIntelByLineId.get(effectivePoLineId) : undefined
      const poLinkHint: 'linked' | 'missing_row' | 'manual' = poMeta
        ? 'linked'
        : effectivePoLineId
          ? 'missing_row'
          : 'manual'
      return {
        id: r.id,
        poLineId: r.poLineId,
        effectivePoLineId,
        poNumber: poMeta?.poNumber ?? intel?.poNumber ?? null,
        purchaseOrderId: poMeta?.purchaseOrderId ?? intel?.purchaseOrderId ?? null,
        poLinkHint,
        linkedCustomerNames: intel?.linkedCustomerNames ?? [],
        industrialPriority: intel?.industrialPriority ?? false,
        requirementCode: r.requirementCode,
        cartonName: r.cartonName,
        artworkCode: r.artworkCode,
        artworkVersion: r.artworkVersion,
        newPlatesNeeded: r.newPlatesNeeded,
        status: r.status,
        plateColours: plateNamesFromColoursNeededJson(activeNeeded),
        lastStatusUpdatedAt: r.lastStatusUpdatedAt.toISOString(),
        ledgerEntryAt: r.createdAt.toISOString(),
        plateSize: r.plateSize,
        cartonMasterPlateSize: effectivePoLineId
          ? cartonMasterPlateByPoLineId.get(effectivePoLineId) ?? null
          : null,
      }
    })

    const ctpQueue = ctpRows.map((r) => {
      const activeNeeded = activeColourRowsFromJson(r.coloursNeeded)
      const lid = r.poLineId?.trim()
      const intel = lid ? lineIntelByLineId.get(lid) : undefined
      return {
        id: r.id,
        poLineId: r.poLineId,
        requirementCode: r.requirementCode,
        jobCardId: r.jobCardId,
        cartonName: r.cartonName,
        artworkCode: r.artworkCode,
        artworkVersion: r.artworkVersion,
        plateColours: plateNamesFromColoursNeededJson(activeNeeded),
        status: r.status,
        numberOfColours: r.numberOfColours,
        newPlatesNeeded: r.newPlatesNeeded,
        partialRemake: r.partialRemake,
        lastStatusUpdatedAt: r.lastStatusUpdatedAt.toISOString(),
        ledgerEntryAt: r.createdAt.toISOString(),
        plateSize: r.plateSize,
        linkedCustomerNames: intel?.linkedCustomerNames ?? [],
        industrialPriority: intel?.industrialPriority ?? false,
        poNumber: intel?.poNumber ?? null,
        purchaseOrderId: intel?.purchaseOrderId ?? null,
        shopfloorInactiveCanonicalKeys: shopfloorInactiveCanonicalKeysFromJson(r.coloursNeeded),
        shopfloorActiveColourCount: countActiveShopfloorColours(r.coloursNeeded),
      }
    })

    const vendorQueue = vendorRows.map((r) => {
      const activeNeeded = activeColourRowsFromJson(r.coloursNeeded)
      const lid = r.poLineId?.trim()
      const intel = lid ? lineIntelByLineId.get(lid) : undefined
      return {
        id: r.id,
        poLineId: r.poLineId,
        requirementCode: r.requirementCode,
        jobCardId: r.jobCardId,
        cartonName: r.cartonName,
        artworkCode: r.artworkCode,
        artworkVersion: r.artworkVersion,
        plateColours: plateNamesFromColoursNeededJson(activeNeeded),
        status: r.status,
        numberOfColours: r.numberOfColours,
        newPlatesNeeded: r.newPlatesNeeded,
        partialRemake: r.partialRemake,
        lastStatusUpdatedAt: r.lastStatusUpdatedAt.toISOString(),
        ledgerEntryAt: r.createdAt.toISOString(),
        plateSize: r.plateSize,
        linkedCustomerNames: intel?.linkedCustomerNames ?? [],
        industrialPriority: intel?.industrialPriority ?? false,
        poNumber: intel?.poNumber ?? null,
        purchaseOrderId: intel?.purchaseOrderId ?? null,
        shopfloorInactiveCanonicalKeys: shopfloorInactiveCanonicalKeysFromJson(r.coloursNeeded),
        shopfloorActiveColourCount: countActiveShopfloorColours(r.coloursNeeded),
      }
    })

    const mapPlate = (p: (typeof inventoryRows)[0]) => {
      const activeJson = activeColourRowsFromJson(p.colours)
      const plateColours = plateNamesFromColoursNeededJson(activeJson)
      const colourChannelNames = channelNamesFromActiveJson(activeJson)
      const cycleData = mergeEffectiveCycleData({ cycleData: p.cycleData, colours: p.colours })
      return {
        id: p.id,
        plateSetCode: p.plateSetCode,
        serialNumber: p.serialNumber,
        outputNumber: p.outputNumber,
        rackNumber: p.rackNumber,
        ups: p.ups,
        cartonName: p.cartonName,
        artworkCode: p.artworkCode,
        artworkVersion: p.artworkVersion,
        artworkId: p.artworkId,
        jobCardId: p.jobCardId,
        slotNumber: p.slotNumber,
        rackLocation: p.rackLocation,
        status: p.status,
        issuedTo: p.issuedTo,
        issuedAt: p.issuedAt?.toISOString() ?? null,
        totalImpressions: p.totalImpressions,
        customer: p.customer,
        plateColours,
        numberOfColours: p.numberOfColours,
        totalPlates: p.totalPlates,
        platesInRackCount: countPlatesInRack(p.colours),
        colourChannelNames,
        createdAt: p.createdAt.toISOString(),
        lastStatusUpdatedAt: p.lastStatusUpdatedAt.toISOString(),
        cycleData,
        plateSize: p.plateSize,
      }
    }

    const custodyFromReqs = stagingReqRows.map((r) => {
      const activeNeeded = activeColourRowsFromJson(r.coloursNeeded)
      const colourChannelNames = channelNamesFromActiveJson(activeNeeded)
      const jobCardHub =
        r.jobCardId && jcHubById.has(r.jobCardId) ? jcHubById.get(r.jobCardId)! : null
      const lid = r.poLineId?.trim()
      const intel = lid ? lineIntelByLineId.get(lid) : undefined
      const custName = intel?.linkedCustomerNames?.[0]
      return {
        kind: 'requirement' as const,
        id: r.id,
        displayCode: r.requirementCode,
        cartonName: r.cartonName,
        artworkCode: r.artworkCode,
        artworkVersion: r.artworkVersion,
        plateColours: plateNamesFromColoursNeededJson(activeNeeded),
        colourChannelNames,
        custodySource:
          r.triageChannel === 'outside_vendor'
            ? ('vendor' as const)
            : r.triageChannel === 'stock_available'
              ? ('rack' as const)
              : ('ctp' as const),
        numberOfColours: r.numberOfColours,
        newPlatesNeeded: r.newPlatesNeeded,
        partialRemake: r.partialRemake,
        lastStatusUpdatedAt: r.lastStatusUpdatedAt.toISOString(),
        ledgerEntryAt: r.createdAt.toISOString(),
        jobCardId: r.jobCardId,
        jobCardHub,
        plateSize: r.plateSize,
        poLineId: r.poLineId,
        linkedCustomerNames: intel?.linkedCustomerNames ?? [],
        poNumber: intel?.poNumber ?? null,
        industrialPriority: intel?.industrialPriority ?? false,
        customer: custName ? { name: custName } : null,
      }
    })

    const custodyFromPlates = stagingPlateRows.map((p) => {
      const src = p.hubCustodySource
      const custodySource =
        src === 'vendor' || src === 'ctp' ? src : ('rack' as const)
      const activeJson = activeColourRowsFromJson(p.colours)
      const plateColours = plateNamesFromColoursNeededJson(activeJson)
      const colourChannelNames = channelNamesFromActiveJson(activeJson)
      const cycleData = mergeEffectiveCycleData({ cycleData: p.cycleData, colours: p.colours })
      const jobCardHub =
        p.jobCardId && jcHubById.has(p.jobCardId) ? jcHubById.get(p.jobCardId)! : null
      return {
        kind: 'plate' as const,
        id: p.id,
        displayCode: p.plateSetCode,
        cartonName: p.cartonName,
        artworkCode: p.artworkCode,
        artworkVersion: p.artworkVersion,
        plateColours,
        colourChannelNames,
        platesInRackCount: countPlatesInRack(p.colours),
        custodySource,
        serialNumber: p.serialNumber,
        rackNumber: p.rackNumber,
        rackLocation: p.rackLocation,
        ups: p.ups,
        customer: p.customer,
        numberOfColours: p.numberOfColours,
        totalPlates: p.totalPlates,
        artworkId: p.artworkId,
        jobCardId: p.jobCardId,
        slotNumber: p.slotNumber,
        lastStatusUpdatedAt: p.lastStatusUpdatedAt.toISOString(),
        ledgerEntryAt: p.createdAt.toISOString(),
        jobCardHub,
        plateSize: p.plateSize,
        cycleData,
      }
    })

    const custody = [...custodyFromReqs, ...custodyFromPlates]

    const inventory = inventoryRows.map(mapPlate)

    const ledgerRows: PlateHubLedgerRowJson[] = [
      ...triage.map((r) =>
        ledgerRequirementRow(
          {
            id: r.id,
            requirementCode: r.requirementCode,
            poLineId: r.effectivePoLineId ?? r.poLineId,
            jobCardId: null,
            cartonName: r.cartonName,
            artworkCode: r.artworkCode,
            artworkVersion: r.artworkVersion,
            plateColours: r.plateColours,
            newPlatesNeeded: r.newPlatesNeeded,
            lastStatusUpdatedAt: r.lastStatusUpdatedAt ?? new Date().toISOString(),
            ledgerEntryAt: r.ledgerEntryAt,
            status: r.status,
            plateSize: r.plateSize ?? null,
            partialRemake: undefined,
            linkedCustomerNames: r.linkedCustomerNames,
            poNumber: r.poNumber ?? null,
            industrialPriority: r.industrialPriority,
          },
          'incoming_triage',
        ),
      ),
      ...ctpQueue.map((r) =>
        ledgerRequirementRow(
          {
            id: r.id,
            requirementCode: r.requirementCode,
            poLineId: r.poLineId,
            jobCardId: r.jobCardId,
            cartonName: r.cartonName,
            artworkCode: r.artworkCode,
            artworkVersion: r.artworkVersion,
            plateColours: r.plateColours,
            newPlatesNeeded: r.shopfloorActiveColourCount ?? r.newPlatesNeeded ?? 0,
            numberOfColours: r.shopfloorActiveColourCount ?? r.numberOfColours,
            lastStatusUpdatedAt: r.lastStatusUpdatedAt,
            ledgerEntryAt: r.ledgerEntryAt,
            status: r.status,
            plateSize: r.plateSize ?? null,
            partialRemake: r.partialRemake,
            linkedCustomerNames: r.linkedCustomerNames,
            poNumber: r.poNumber ?? null,
            industrialPriority: r.industrialPriority,
          },
          'ctp_queue',
        ),
      ),
      ...vendorQueue.map((r) =>
        ledgerRequirementRow(
          {
            id: r.id,
            requirementCode: r.requirementCode,
            poLineId: r.poLineId,
            jobCardId: r.jobCardId,
            cartonName: r.cartonName,
            artworkCode: r.artworkCode,
            artworkVersion: r.artworkVersion,
            plateColours: r.plateColours,
            newPlatesNeeded: r.shopfloorActiveColourCount ?? r.newPlatesNeeded ?? 0,
            numberOfColours: r.shopfloorActiveColourCount ?? r.numberOfColours,
            lastStatusUpdatedAt: r.lastStatusUpdatedAt,
            ledgerEntryAt: r.ledgerEntryAt,
            status: r.status,
            plateSize: r.plateSize ?? null,
            partialRemake: r.partialRemake,
            linkedCustomerNames: r.linkedCustomerNames,
            poNumber: r.poNumber ?? null,
            industrialPriority: r.industrialPriority,
          },
          'outside_vendor',
        ),
      ),
      ...inventory.map((p) =>
        ledgerPlateRow(
          {
            id: p.id,
            plateSetCode: p.plateSetCode,
            cartonName: p.cartonName,
            artworkCode: p.artworkCode,
            artworkVersion: p.artworkVersion,
            jobCardId: p.jobCardId,
            plateColours: p.plateColours,
            numberOfColours: p.numberOfColours,
            totalPlates: p.totalPlates,
            platesInRackCount: p.platesInRackCount,
            lastStatusUpdatedAt: p.lastStatusUpdatedAt,
            ledgerEntryAt: p.createdAt,
            status: p.status,
            plateSize: p.plateSize ?? null,
            customer: p.customer,
          },
          'live_inventory',
        ),
      ),
      ...custody.map((c) =>
        ledgerCustodyRow({
          ...c,
          custodySource:
            c.custodySource === 'vendor' || c.custodySource === 'ctp' || c.custodySource === 'rack'
              ? c.custodySource
              : 'rack',
        }),
      ),
    ]

    const ledgerPoLineIds = ledgerRows
      .map((row) => row.poLineId)
      .filter((id): id is string => Boolean(id))
    const priorityLineRows =
      ledgerPoLineIds.length > 0
        ? await db.poLineItem.findMany({
            where: {
              id: { in: ledgerPoLineIds },
              OR: [{ directorPriority: true }, { po: { isPriority: true } }],
            },
            select: { id: true },
          })
        : []
    const priorityLineSet = new Set(priorityLineRows.map((l) => l.id))
    const ledgerRowsWithPriority = ledgerRows.map((row) => ({
      ...row,
      industrialPriority:
        row.industrialPriority === true ||
        (row.poLineId ? priorityLineSet.has(row.poLineId) : false),
    }))

    return new NextResponse(
      safeJsonStringify({
        triage,
        ctpQueue,
        vendorQueue,
        inventory,
        custody,
        ledgerRows: ledgerRowsWithPriority,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[plate-hub/dashboard]', e)
    return NextResponse.json({ error: 'Failed to load plate hub dashboard' }, { status: 500 })
  }
}
