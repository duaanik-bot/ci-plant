import { NextResponse } from 'next/server'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { db } from '@/lib/db'
import { buildEmbossAssetTimeline } from '@/lib/emboss-asset-timeline'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const block = await db.embossBlock.findUnique({
    where: { id },
    select: {
      id: true,
      blockCode: true,
      cartonId: true,
      cartonName: true,
      assetVersionId: true,
      impressionCount: true,
      cumulativeStrikes: true,
      materialType: true,
      blockMaterial: true,
      reliefDepthMm: true,
      embossDepth: true,
      issuedMachine: { select: { id: true, machineCode: true, name: true } },
      issuedMachineId: true,
      issuedAt: true,
      cartons: { take: 4, select: { id: true, cartonName: true } },
    },
  })
  if (!block) {
    return NextResponse.json({ error: 'Block not found' }, { status: 404 })
  }

  const linkedProductId = block.cartonId ?? block.cartons[0]?.id ?? null
  const productName =
    (linkedProductId ? block.cartons.find((c) => c.id === linkedProductId)?.cartonName : null)?.trim() ||
    block.cartons[0]?.cartonName?.trim() ||
    block.cartonName?.trim() ||
    block.blockCode

  const [strikeHistoryRaw, hubEvents, maintenanceLogs] = await Promise.all([
    db.embossBlockUsageLog.findMany({
      where: { blockId: id },
      orderBy: { usedOn: 'desc' },
      take: 40,
      select: {
        id: true,
        impressions: true,
        usedOn: true,
        operatorName: true,
        conditionAfter: true,
        notes: true,
        jobCardId: true,
      },
    }),
    db.embossHubEvent.findMany({
      where: { blockId: id },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { id: true, actionType: true, createdAt: true, details: true },
    }),
    db.embossBlockMaintenanceLog.findMany({
      where: { blockId: id },
      orderBy: { performedAt: 'desc' },
      take: 25,
      select: {
        id: true,
        actionType: true,
        performedAt: true,
        performedBy: true,
        notes: true,
      },
    }),
  ])

  const jobIds = Array.from(
    new Set(strikeHistoryRaw.map((l) => l.jobCardId).filter((x): x is string => Boolean(x))),
  )
  const jobRows =
    jobIds.length > 0
      ? await db.productionJobCard.findMany({
          where: { id: { in: jobIds } },
          select: { id: true, jobCardNumber: true },
        })
      : []
  const jobNumberById = new Map(jobRows.map((j) => [j.id, j.jobCardNumber]))

  const strikes = Math.max(block.cumulativeStrikes ?? 0, block.impressionCount ?? 0)
  const reliefMm =
    block.reliefDepthMm != null
      ? Number(block.reliefDepthMm)
      : block.embossDepth != null
        ? Number(block.embossDepth)
        : null
  const materialSpec = block.materialType?.trim() || block.blockMaterial?.trim() || '—'
  const versionDisplay =
    block.assetVersionId?.trim() ||
    block.id
      .replace(/-/g, '')
      .slice(0, 8)
      .toUpperCase()

  const timeline = buildEmbossAssetTimeline({
    hubEvents,
    maintenanceLogs,
    usageLogs: strikeHistoryRaw.map((l) => ({
      ...l,
      usedOn: new Date(l.usedOn),
    })),
    jobNumberById,
  })

  await createAuditLog({
    userId: user!.id,
    action: 'VIEW',
    tableName: 'emboss_blocks',
    recordId: id,
    newValue: {
      embossSpotlight: true,
      message: `Asset History Synchronized for Product: ${productName}.`,
    },
  })

  return NextResponse.json({
    block: {
      id: block.id,
      blockCode: block.blockCode,
      productName,
      linkedProductId,
      versionDisplay,
      materialSpec,
      reliefDepthMm: reliefMm,
      cumulativeStrikes: strikes,
      currentMachine: block.issuedMachine
        ? {
            id: block.issuedMachine.id,
            code: block.issuedMachine.machineCode,
            name: block.issuedMachine.name,
          }
        : null,
      issuedAt: block.issuedAt?.toISOString() ?? null,
    },
    timeline,
    strikeHistory: strikeHistoryRaw.map((h) => ({
      id: h.id,
      impressions: h.impressions,
      usedOn: h.usedOn.toISOString().slice(0, 10),
      operatorName: h.operatorName,
      conditionAfter: h.conditionAfter,
      notes: h.notes,
      jobCardId: h.jobCardId,
      jobCardNumber: h.jobCardId ? jobNumberById.get(h.jobCardId) ?? null : null,
    })),
  })
}
