import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import type { HubIncomingUnified, HubToolType, VendorPipelineStage } from '@/lib/hub-types'
import { mapStatusToVendorStage } from '@/lib/hub-types'

export const dynamic = 'force-dynamic'

function mapPlateRows(
  list: Array<
    Awaited<ReturnType<typeof db.plateRequirement.findMany>>[number] & { customerName?: string | null }
  >,
): HubIncomingUnified[] {
  return list.map((r) => ({
    id: r.id,
    toolType: 'plates' as const,
    code: r.requirementCode,
    title: r.cartonName,
    subtitle: r.artworkCode,
    newLabel: r.newPlatesNeeded != null ? `${r.newPlatesNeeded} new` : null,
    vendorStage: mapStatusToVendorStage(r.status, r.triageChannel) as VendorPipelineStage,
    raw: r as unknown as Record<string, unknown>,
  }))
}

async function loadPlates() {
  const list = await db.plateRequirement.findMany({
    where: {
      triageChannel: null,
      status: { in: ['pending', 'ctp_notified', 'plates_ready'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  const customerIds = Array.from(new Set(list.map((r) => r.customerId).filter(Boolean) as string[]))
  const customers =
    customerIds.length > 0
      ? await db.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, name: true },
        })
      : []
  const custById = Object.fromEntries(customers.map((c) => [c.id, c.name]))
  return list.map((r) => ({
    ...r,
    customerName: r.customerId ? custById[r.customerId] ?? null : null,
  }))
}

/** GET /api/hub/incoming?toolType=plates|dies|blocks|shade_cards */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const toolType = req.nextUrl.searchParams.get('toolType') as HubToolType | null
  if (!toolType || !['plates', 'dies', 'blocks', 'shade_cards'].includes(toolType)) {
    return NextResponse.json({ error: 'toolType required' }, { status: 400 })
  }

  if (toolType === 'plates') {
    const list = await loadPlates()
    return NextResponse.json(mapPlateRows(list))
  }

  if (toolType === 'dies' || toolType === 'blocks') {
    return NextResponse.json([] as HubIncomingUnified[])
  }

  const { getShadeIncomingRows } = await import('@/lib/hub-shade-incoming')
  return NextResponse.json(getShadeIncomingRows())
}
