import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'
import { plateNamesFromColoursNeededJson } from '@/lib/plate-triage-display'
import {
  activeColourRowsFromJson,
  countPlatesInRack,
  hubReuseCyclesFromColoursJson,
} from '@/lib/hub-plate-card-ui'
import { hubJobCardHubStatus } from '@/lib/hub-job-card-status'

export const dynamic = 'force-dynamic'

function channelNamesFromActiveJson(activeJson: unknown[]): string[] {
  return activeJson
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      return String((item as { name?: string }).name ?? '').trim()
    })
    .filter(Boolean) as string[]
}

/**
 * Single payload for Plate Hub wireframe: triage + CTP + outside vendor + inventory + custody.
 */
export async function GET() {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const [triageRows, ctpRows, vendorRows, inventoryRows, stagingReqRows, stagingPlateRows] =
      await Promise.all([
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

    const triagePoLineIds = Array.from(
      new Set(
        triageRows
          .map((r) => r.poLineId)
          .filter((id): id is string => Boolean(id && String(id).trim())),
      ),
    )
    const triageLinesForMaster =
      triagePoLineIds.length > 0
        ? await db.poLineItem.findMany({
            where: { id: { in: triagePoLineIds } },
            select: { id: true, cartonId: true },
          })
        : []
    const triageCartonIds = Array.from(
      new Set(
        triageLinesForMaster
          .map((l) => l.cartonId)
          .filter((id): id is string => Boolean(id)),
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
    for (const line of triageLinesForMaster) {
      if (!line.cartonId) {
        cartonMasterPlateByPoLineId.set(line.id, null)
        continue
      }
      cartonMasterPlateByPoLineId.set(line.id, cartonPlateById.get(line.cartonId) ?? null)
    }

    const triage = triageRows.map((r) => {
      const activeNeeded = activeColourRowsFromJson(r.coloursNeeded)
      const poKey = r.poLineId?.trim()
      return {
        id: r.id,
        poLineId: r.poLineId,
        requirementCode: r.requirementCode,
        cartonName: r.cartonName,
        artworkCode: r.artworkCode,
        artworkVersion: r.artworkVersion,
        newPlatesNeeded: r.newPlatesNeeded,
        status: r.status,
        plateColours: plateNamesFromColoursNeededJson(activeNeeded),
        lastStatusUpdatedAt: r.lastStatusUpdatedAt.toISOString(),
        plateSize: r.plateSize,
        cartonMasterPlateSize: poKey ? cartonMasterPlateByPoLineId.get(poKey) ?? null : null,
      }
    })

    const ctpQueue = ctpRows.map((r) => {
      const activeNeeded = activeColourRowsFromJson(r.coloursNeeded)
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
        plateSize: r.plateSize,
      }
    })

    const vendorQueue = vendorRows.map((r) => {
      const activeNeeded = activeColourRowsFromJson(r.coloursNeeded)
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
        plateSize: r.plateSize,
      }
    })

    const mapPlate = (p: (typeof inventoryRows)[0]) => {
      const activeJson = activeColourRowsFromJson(p.colours)
      const plateColours = plateNamesFromColoursNeededJson(activeJson)
      const colourChannelNames = channelNamesFromActiveJson(activeJson)
      const { max: reuseCyclesMax } = hubReuseCyclesFromColoursJson(p.colours)
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
        reuseCyclesMax,
        plateSize: p.plateSize,
      }
    }

    const custodyFromReqs = stagingReqRows.map((r) => {
      const activeNeeded = activeColourRowsFromJson(r.coloursNeeded)
      const jobCardHub =
        r.jobCardId && jcHubById.has(r.jobCardId) ? jcHubById.get(r.jobCardId)! : null
      return {
        kind: 'requirement' as const,
        id: r.id,
        displayCode: r.requirementCode,
        cartonName: r.cartonName,
        artworkCode: r.artworkCode,
        artworkVersion: r.artworkVersion,
        plateColours: plateNamesFromColoursNeededJson(activeNeeded),
        custodySource:
          r.triageChannel === 'outside_vendor' ? ('vendor' as const) : ('ctp' as const),
        numberOfColours: r.numberOfColours,
        newPlatesNeeded: r.newPlatesNeeded,
        partialRemake: r.partialRemake,
        lastStatusUpdatedAt: r.lastStatusUpdatedAt.toISOString(),
        jobCardId: r.jobCardId,
        jobCardHub,
        plateSize: r.plateSize,
      }
    })

    const custodyFromPlates = stagingPlateRows.map((p) => {
      const src = p.hubCustodySource
      const custodySource =
        src === 'vendor' || src === 'ctp' ? src : ('rack' as const)
      const activeJson = activeColourRowsFromJson(p.colours)
      const plateColours = plateNamesFromColoursNeededJson(activeJson)
      const colourChannelNames = channelNamesFromActiveJson(activeJson)
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
        jobCardHub,
        plateSize: p.plateSize,
      }
    })

    const custody = [...custodyFromReqs, ...custodyFromPlates]

    return new NextResponse(
      safeJsonStringify({
        triage,
        ctpQueue,
        vendorQueue,
        inventory: inventoryRows.map(mapPlate),
        custody,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[plate-hub/dashboard]', e)
    return NextResponse.json({ error: 'Failed to load plate hub dashboard' }, { status: 500 })
  }
}
