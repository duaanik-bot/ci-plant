import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'
import { plateNamesFromColoursNeededJson } from '@/lib/plate-triage-display'

export const dynamic = 'force-dynamic'

/**
 * Single payload for Plate Hub wireframe: triage + CTP + outside vendor + inventory + custody.
 */
export async function GET() {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const [triageRows, ctpRows, vendorRows, inventoryRows, custodyRows] = await Promise.all([
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
      db.plateStore.findMany({
        where: { status: 'issued' },
        orderBy: { issuedAt: 'desc' },
        include: { customer: { select: { id: true, name: true } } },
      }),
    ])

    const triage = triageRows.map((r) => ({
      id: r.id,
      poLineId: r.poLineId,
      requirementCode: r.requirementCode,
      cartonName: r.cartonName,
      artworkCode: r.artworkCode,
      artworkVersion: r.artworkVersion,
      newPlatesNeeded: r.newPlatesNeeded,
      status: r.status,
      plateColours: plateNamesFromColoursNeededJson(r.coloursNeeded),
    }))

    const ctpQueue = ctpRows.map((r) => ({
      id: r.id,
      poLineId: r.poLineId,
      requirementCode: r.requirementCode,
      jobCardId: r.jobCardId,
      cartonName: r.cartonName,
      artworkCode: r.artworkCode,
      artworkVersion: r.artworkVersion,
      plateColours: plateNamesFromColoursNeededJson(r.coloursNeeded),
      status: r.status,
    }))

    const vendorQueue = vendorRows.map((r) => ({
      id: r.id,
      poLineId: r.poLineId,
      requirementCode: r.requirementCode,
      jobCardId: r.jobCardId,
      cartonName: r.cartonName,
      artworkCode: r.artworkCode,
      artworkVersion: r.artworkVersion,
      plateColours: plateNamesFromColoursNeededJson(r.coloursNeeded),
      status: r.status,
    }))

    const mapPlate = (p: (typeof inventoryRows)[0]) => ({
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
    })

    return new NextResponse(
      safeJsonStringify({
        triage,
        ctpQueue,
        vendorQueue,
        inventory: inventoryRows.map(mapPlate),
        custody: custodyRows.map(mapPlate),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[plate-hub/dashboard]', e)
    return NextResponse.json({ error: 'Failed to load plate hub dashboard' }, { status: 500 })
  }
}
