import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'
import {
  CUSTODY_AT_VENDOR,
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_HUB_ENGRAVING_QUEUE,
  CUSTODY_HUB_TRIAGE,
  CUSTODY_IN_STOCK,
} from '@/lib/inventory-hub-custody'
import { hubJobCardHubStatus } from '@/lib/hub-job-card-status'

export const dynamic = 'force-dynamic'

function mapDie(d: {
  id: string
  dyeNumber: number
  dyeType: string
  ups: number
  sheetSize: string
  cartonSize: string
  location: string | null
  dieMaterial: string | null
  creaseDepthMm: { toString(): string } | null
  impressionCount: number
  reuseCount: number
  custodyStatus: string
  hubPreviousCustody: string | null
  updatedAt: Date
  createdAt: Date
  cartons: { cartonName: string }[]
}) {
  return {
    id: d.id,
    kind: 'die' as const,
    displayCode: `DYE-${d.dyeNumber}`,
    dyeNumber: d.dyeNumber,
    title: d.cartons[0]?.cartonName ?? `Die #${d.dyeNumber}`,
    ups: d.ups,
    dimensionsLabel: d.cartonSize?.trim() || '—',
    sheetSize: d.sheetSize?.trim() || null,
    materialLabel: d.dieMaterial?.trim() || d.dyeType || '—',
    location: d.location,
    knifeHeightMm: d.creaseDepthMm != null ? Number(d.creaseDepthMm) : null,
    impressionCount: d.impressionCount,
    reuseCount: d.reuseCount,
    custodyStatus: d.custodyStatus,
    hubPreviousCustody: d.hubPreviousCustody,
    lastStatusUpdatedAt: d.updatedAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    jobCardHub: null as ReturnType<typeof hubJobCardHubStatus> | null,
  }
}

function mapEmboss(
  b: {
    id: string
    blockCode: string
    blockType: string
    blockMaterial: string
    blockSize: string | null
    cartonName: string | null
    storageLocation: string | null
    impressionCount: number
    reuseCount: number
    custodyStatus: string
    hubPreviousCustody: string | null
    updatedAt: Date
    createdAt: Date
  },
  jobCardHub: ReturnType<typeof hubJobCardHubStatus> | null,
) {
  return {
    id: b.id,
    kind: 'emboss' as const,
    displayCode: b.blockCode,
    title: b.cartonName?.trim() || b.blockCode,
    typeLabel: b.blockType?.trim() || '—',
    materialLabel: b.blockMaterial?.trim() || '—',
    blockSize: b.blockSize?.trim() || null,
    storageLocation: b.storageLocation,
    impressionCount: b.impressionCount,
    reuseCount: b.reuseCount,
    custodyStatus: b.custodyStatus,
    hubPreviousCustody: b.hubPreviousCustody,
    lastStatusUpdatedAt: b.updatedAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
    jobCardHub,
  }
}

/** GET /api/tooling-hub/dashboard?tool=dies|blocks */
export async function GET(req: NextRequest) {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const tool = req.nextUrl.searchParams.get('tool')
    if (tool !== 'dies' && tool !== 'blocks') {
      return NextResponse.json({ error: 'tool=dies|blocks required' }, { status: 400 })
    }

    if (tool === 'dies') {
      const rows = await db.dye.findMany({
        where: { active: true },
        orderBy: { dyeNumber: 'asc' },
        include: { cartons: { take: 1, select: { cartonName: true } } },
      })
      const mapped = rows.map(mapDie)
      const triage = mapped.filter((r) => r.custodyStatus === CUSTODY_HUB_TRIAGE)
      const prep = mapped.filter((r) => r.custodyStatus === CUSTODY_AT_VENDOR)
      const inventory = mapped.filter((r) => r.custodyStatus === CUSTODY_IN_STOCK)
      const custody = mapped.filter((r) => r.custodyStatus === CUSTODY_HUB_CUSTODY_READY)
      return new NextResponse(
        safeJsonStringify({ tool, triage, prep, inventory, custody }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const rows = await db.embossBlock.findMany({
      where: { active: true },
      orderBy: { blockCode: 'asc' },
    })
    const custodyRows = rows.filter((r) => r.custodyStatus === CUSTODY_HUB_CUSTODY_READY)
    const custodyIds = custodyRows.map((r) => r.id)
    const jcs =
      custodyIds.length > 0
        ? await db.productionJobCard.findMany({
            where: { embossBlockId: { in: custodyIds } },
            select: {
              embossBlockId: true,
              status: true,
              finalQcPass: true,
              qaReleased: true,
              updatedAt: true,
            },
            orderBy: { updatedAt: 'desc' },
          })
        : []
    const jcHubByEmboss = new Map<string, ReturnType<typeof hubJobCardHubStatus>>()
    for (const jc of jcs) {
      if (!jc.embossBlockId || jcHubByEmboss.has(jc.embossBlockId)) continue
      jcHubByEmboss.set(jc.embossBlockId, hubJobCardHubStatus(jc))
    }

    const mapped = rows.map((b) =>
      mapEmboss(
        b,
        b.custodyStatus === CUSTODY_HUB_CUSTODY_READY ? jcHubByEmboss.get(b.id) ?? null : null,
      ),
    )
    const triage = mapped.filter((r) => r.custodyStatus === CUSTODY_HUB_TRIAGE)
    const prep = mapped.filter((r) => r.custodyStatus === CUSTODY_HUB_ENGRAVING_QUEUE)
    const inventory = mapped.filter((r) => r.custodyStatus === CUSTODY_IN_STOCK)
    const custody = mapped.filter((r) => r.custodyStatus === CUSTODY_HUB_CUSTODY_READY)

    return new NextResponse(
      safeJsonStringify({ tool, triage, prep, inventory, custody }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[tooling-hub/dashboard]', e)
    return NextResponse.json({ error: 'Failed to load tooling hub' }, { status: 500 })
  }
}
