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
  CUSTODY_ON_FLOOR,
} from '@/lib/inventory-hub-custody'
import { hubJobCardHubStatus } from '@/lib/hub-job-card-status'
import {
  dieLedgerZoneKeyFromCustody,
  embossLedgerZoneKeyFromCustody,
  toolingLedgerZoneBadge,
  toolingLedgerZoneLabel,
  type ToolingLedgerZoneKey,
} from '@/lib/tooling-hub-zones'
import { EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import {
  buildDieDimensionOnlyBuckets,
  buildDieSimilarityBuckets,
  formatDimsLwhFromDb,
  formatDimsLwhFromParsed,
  normalizeDieMake,
  parseCartonSizeToDims,
  similarDiesForRow,
  typeMismatchDiesForRow,
} from '@/lib/die-hub-dimensions'
import { masterDieTypeLabel } from '@/lib/master-die-type'
import type { PastingStyle } from '@prisma/client'
import { pastingNeedsMasterReview, pastingStyleLabel } from '@/lib/pasting-style'
import {
  effectiveStrikeLimit,
  strikeCountExceedsLimit,
} from '@/lib/emboss-block-material'
import {
  loadPriorityPoLineContext,
  poLineMatchesEmbossBlock,
} from '@/lib/hub-po-tooling-priority'
import { embossOperationalStatus } from '@/lib/emboss-hub-operational-status'

type EmbossTriageCardMeta = {
  triageManualEntry: boolean
  triageAwReference: string | null
  triageBlockDimensions: string | null
}

export const dynamic = 'force-dynamic'

export type DieSimilarMatchJson = {
  id: string
  displayCode: string
  location: string | null
  impressionCount: number
  reuseCount: number
  /** Present for type-mismatch rows: the other die’s master type label. */
  dieTypeLabel?: string
}

export type ToolingHubLedgerRowJson = {
  kind: 'die' | 'emboss'
  id: string
  displayCode: string
  title: string
  zoneKey: ToolingLedgerZoneKey
  zoneLabel: string
  zoneBadgeClass: string
  specSummary: string
  units: number
  lastStatusUpdatedAt: string
  /** Tooling master record `createdAt` — Excel lead time only. */
  ledgerEntryAt: string
  /** Die Hub — stable row # by dye number order. */
  ledgerRank?: number
  dimensionsLwh?: string
  ups?: number
  pastingStyle?: PastingStyle | null
  hubPastingNeedsMasterUpdate?: boolean
  masterType?: string | null
  hubConditionPoor?: boolean
  dieMake?: 'local' | 'laser'
  dateOfManufacturing?: string | null
  similarMatches?: DieSimilarMatchJson[]
  /** Same L×W×H as this die, but a different master die type — not interchangeable. */
  typeMismatchMatches?: DieSimilarMatchJson[]
  industrialPriority?: boolean
  linkedCustomerNames?: string[]
  /** Emboss — carton master id (primary filter key). */
  linkedProductId?: string | null
  versionDisplay?: string | null
}

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
  currentStock: number
  custodyStatus: string
  hubPreviousCustody: string | null
  updatedAt: Date
  createdAt: Date
  dimLengthMm: unknown
  dimWidthMm: unknown
  dimHeightMm: unknown
  pastingStyle: PastingStyle | null
  dieMake: string
  dateOfManufacturing: Date | null
  hubCustodySource: string | null
  hubTriageHoldReason: string | null
  issuedOperator: string | null
  condition: string
  conditionRating: string | null
  hubStatusFlag: string | null
  hubPoorReportedBy: string | null
  cartonsWork: { cartonName: string; customer: { name: string } | null }[]
}) {
  const physicalPoor =
    d.condition?.trim() === 'Poor' || (d.conditionRating?.trim() ?? '') === 'Poor'
  const hubDieHubPoorFlag = d.hubStatusFlag?.trim() === 'POOR_CONDITION'
  const parsedDims = parseCartonSizeToDims(d.cartonSize)
  const dimensionsLwh =
    (formatDimsLwhFromDb({
      dimLengthMm: d.dimLengthMm as { toString(): string } | null,
      dimWidthMm: d.dimWidthMm as { toString(): string } | null,
      dimHeightMm: d.dimHeightMm as { toString(): string } | null,
    }) ??
      (parsedDims ? formatDimsLwhFromParsed(parsedDims) : null) ??
      d.cartonSize?.trim()) ||
    '—'
  const linkedCustomerNames = Array.from(
    new Set(
      d.cartonsWork
        .map((c) => c.customer?.name?.trim())
        .filter((n): n is string => Boolean(n)),
    ),
  )
  return {
    id: d.id,
    kind: 'die' as const,
    displayCode: `DYE-${d.dyeNumber}`,
    dyeNumber: d.dyeNumber,
    title: d.cartonsWork[0]?.cartonName ?? `Die #${d.dyeNumber}`,
    linkedCustomerNames,
    ups: d.ups,
    dimensionsLabel: dimensionsLwh,
    dimensionsLwh,
    sheetSize: d.sheetSize?.trim() || null,
    materialLabel: d.dieMaterial?.trim() || d.dyeType || '—',
    location: d.location,
    knifeHeightMm: d.creaseDepthMm != null ? Number(d.creaseDepthMm) : null,
    impressionCount: d.impressionCount,
    reuseCount: d.reuseCount,
    currentStock: d.currentStock,
    custodyStatus: d.custodyStatus,
    hubPreviousCustody: d.hubPreviousCustody,
    lastStatusUpdatedAt: d.updatedAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    pastingStyle: d.pastingStyle ?? null,
    masterType: masterDieTypeLabel({
      dyeType: d.dyeType,
      pastingStyle: d.pastingStyle,
    }),
    dieMake: normalizeDieMake(d.dieMake),
    dateOfManufacturing: d.dateOfManufacturing ? d.dateOfManufacturing.toISOString() : null,
    hubCustodySource: d.hubCustodySource?.trim() || null,
    hubTriageHoldReason: d.hubTriageHoldReason?.trim() || null,
    issuedOperator: d.issuedOperator?.trim() || null,
    hubDieHubPoorFlag,
    hubPoorReportedBy: d.hubPoorReportedBy?.trim() || null,
    hubConditionPoor: physicalPoor || hubDieHubPoorFlag,
    hubPastingNeedsMasterUpdate:
      d.custodyStatus === CUSTODY_HUB_TRIAGE && pastingNeedsMasterReview(d.pastingStyle),
    jobCardHub: null as ReturnType<typeof hubJobCardHubStatus> | null,
  }
}

function mapEmboss(
  b: {
    id: string
    blockCode: string
    cartonId: string | null
    assetVersionId: string | null
    blockType: string
    blockMaterial: string
    materialType: string | null
    blockSize: string | null
    cartonName: string | null
    customerId: string | null
    storageLocation: string | null
    artworkRefLink: string | null
    linkedDieId: string | null
    linkedDie: { id: string; dyeNumber: number } | null
    impressionCount: number
    cumulativeStrikes: number
    maxImpressions: number
    embossDepth: { toString(): string } | null
    reliefDepthMm: { toString(): string } | null
    reuseCount: number
    custodyStatus: string
    hubPreviousCustody: string | null
    issuedOperator: string | null
    issuedMachineId: string | null
    issuedMachine: { machineCode: string; name: string } | null
    updatedAt: Date
    createdAt: Date
    condition: string
    active: boolean
    scrappedAt: Date | null
    cartons: { id: string; cartonName: string; customer: { name: string } | null }[]
  },
  jobCardHub: ReturnType<typeof hubJobCardHubStatus> | null,
  triageMeta: EmbossTriageCardMeta | null | undefined,
  industrialPriority: boolean,
) {
  const strikes = Math.max(b.cumulativeStrikes ?? 0, b.impressionCount ?? 0)
  const reliefFromCol =
    b.reliefDepthMm != null ? Number(b.reliefDepthMm) : b.embossDepth != null ? Number(b.embossDepth) : null
  const strikeLimit = effectiveStrikeLimit({
    maxImpressions: b.maxImpressions,
    blockMaterial: b.materialType?.trim() || b.blockMaterial,
  })
  const strikeOverLimit = strikeCountExceedsLimit({
    impressionCount: strikes,
    maxImpressions: b.maxImpressions,
    blockMaterial: b.materialType?.trim() || b.blockMaterial,
  })
  const linkedCustomerNames = Array.from(
    new Set(
      b.cartons
        .map((c) => c.customer?.name?.trim())
        .filter((n): n is string => Boolean(n)),
    ),
  )
  const issuedMachineLabel = b.issuedMachine
    ? `${b.issuedMachine.machineCode} · ${b.issuedMachine.name}`
    : null
  const linkedProductId = b.cartonId ?? b.cartons[0]?.id ?? null
  const fromCarton = linkedProductId
    ? b.cartons.find((c) => c.id === linkedProductId)
    : undefined
  const productName =
    fromCarton?.cartonName?.trim() ||
    b.cartons[0]?.cartonName?.trim() ||
    b.cartonName?.trim() ||
    b.blockCode
  const versionDisplay =
    b.assetVersionId?.trim() ||
    b.id
      .replace(/-/g, '')
      .slice(0, 8)
      .toUpperCase()
  const materialLabel = (b.materialType?.trim() || b.blockMaterial?.trim() || '—') as string
  const operationalStatus = embossOperationalStatus({
    active: b.active,
    scrappedAt: b.scrappedAt,
    condition: b.condition,
    custodyStatus: b.custodyStatus,
    issuedMachineId: b.issuedMachineId,
  })

  return {
    id: b.id,
    kind: 'emboss' as const,
    displayCode: b.blockCode,
    /** Product / carton master name — primary hub label. */
    title: productName,
    productName,
    linkedProductId,
    versionDisplay,
    typeLabel: b.blockType?.trim() || '—',
    materialLabel,
    blockSize: b.blockSize?.trim() || null,
    storageLocation: b.storageLocation,
    artworkRefLink: b.artworkRefLink?.trim() || null,
    linkedDieId: b.linkedDieId,
    linkedDieCode: b.linkedDie ? `DYE-${b.linkedDie.dyeNumber}` : null,
    impressionCount: b.impressionCount,
    cumulativeStrikes: strikes,
    operationalStatus,
    strikeLimit,
    strikeOverLimit,
    reliefDepthMm: reliefFromCol,
    maxImpressions: b.maxImpressions,
    reuseCount: b.reuseCount,
    custodyStatus: b.custodyStatus,
    hubPreviousCustody: b.hubPreviousCustody,
    lastStatusUpdatedAt: b.updatedAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
    jobCardHub,
    triageManualEntry: triageMeta?.triageManualEntry ?? false,
    triageAwReference: triageMeta?.triageAwReference ?? null,
    triageBlockDimensions: triageMeta?.triageBlockDimensions ?? null,
    hubConditionPoor: b.condition?.trim() === 'Poor',
    issuedOperator: b.issuedOperator?.trim() || null,
    issuedMachineId: b.issuedMachineId,
    issuedMachineLabel,
    linkedCustomerNames,
    industrialPriority,
    ledgerRank: 0,
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
        include: {
          cartonsWork: {
            take: 12,
            select: { cartonName: true, customer: { select: { name: true } } },
          },
        },
      })
      const mapped = rows.map(mapDie)
      const dieIds = mapped.map((r) => r.id)
      const priorityLines =
        dieIds.length > 0
          ? await db.poLineItem.findMany({
              where: {
                dieMasterId: { in: dieIds },
                OR: [{ directorPriority: true }, { po: { isPriority: true } }],
              },
              select: { dieMasterId: true },
              distinct: ['dieMasterId'],
            })
          : []
      const priorityDieIds = new Set(
        priorityLines.map((l) => l.dieMasterId).filter((id): id is string => Boolean(id)),
      )
      const similarBuckets = buildDieSimilarityBuckets(rows)
      const dimOnlyBuckets = buildDieDimensionOnlyBuckets(rows)
      const rankById = new Map(
        [...mapped].sort((a, b) => a.dyeNumber - b.dyeNumber).map((r, idx) => [r.id, idx + 1]),
      )
      const withSimilar = mapped.map((r, i) => {
        const raw = rows[i]!
        const industrialPriority = priorityDieIds.has(r.id)
        const sim = similarDiesForRow(
          raw.id,
          raw.dimLengthMm,
          raw.dimWidthMm,
          raw.dimHeightMm,
          raw.dyeType,
          raw.pastingStyle,
          similarBuckets,
        )
        const mismatch = typeMismatchDiesForRow(
          raw.id,
          raw.dimLengthMm,
          raw.dimWidthMm,
          raw.dimHeightMm,
          raw.dyeType,
          raw.pastingStyle,
          dimOnlyBuckets,
        )
        return {
          ...r,
          industrialPriority,
          ledgerRank: rankById.get(r.id) ?? 0,
          similarMatches: sim.map((e) => ({
            id: e.id,
            displayCode: `DYE-${e.dyeNumber}`,
            location: e.location,
            impressionCount: e.impressionCount,
            reuseCount: e.reuseCount,
          })),
          typeMismatchMatches: mismatch.map((e) => ({
            id: e.id,
            displayCode: `DYE-${e.dyeNumber}`,
            location: e.location,
            impressionCount: e.impressionCount,
            reuseCount: e.reuseCount,
            dieTypeLabel: e.typeLabel,
          })),
        }
      })
      const triage = withSimilar.filter((r) => r.custodyStatus === CUSTODY_HUB_TRIAGE)
      const prep = withSimilar.filter((r) => r.custodyStatus === CUSTODY_AT_VENDOR)
      const inventory = withSimilar.filter((r) => r.custodyStatus === CUSTODY_IN_STOCK)
      const custody = withSimilar.filter(
        (r) =>
          r.custodyStatus === CUSTODY_HUB_CUSTODY_READY || r.custodyStatus === CUSTODY_ON_FLOOR,
      )
      const ledgerRows: ToolingHubLedgerRowJson[] = withSimilar.map((r) => {
        const zoneKey = dieLedgerZoneKeyFromCustody(r.custodyStatus)
        const units = Math.max(1, r.currentStock ?? 1)
        return {
          kind: 'die',
          id: r.id,
          displayCode: r.displayCode,
          title: r.title,
          zoneKey,
          zoneLabel: toolingLedgerZoneLabel('dies', zoneKey),
          zoneBadgeClass: toolingLedgerZoneBadge(zoneKey),
          specSummary: `${(() => {
            const ps = r.pastingStyle
            const typeLead =
              ps != null ? `Type: ${pastingStyleLabel(ps)} · ` : ''
            return `${typeLead}UPS ${r.ups} · ${r.dimensionsLwh} · ${r.materialLabel}`
          })()}`,
          units,
          lastStatusUpdatedAt: r.lastStatusUpdatedAt,
          ledgerEntryAt: r.createdAt,
          ledgerRank: r.ledgerRank,
          dimensionsLwh: r.dimensionsLwh,
          ups: r.ups,
          pastingStyle: r.pastingStyle,
          hubPastingNeedsMasterUpdate: r.hubPastingNeedsMasterUpdate,
          masterType: r.masterType,
          dieMake: r.dieMake,
          dateOfManufacturing: r.dateOfManufacturing,
          similarMatches: r.similarMatches,
          typeMismatchMatches: r.typeMismatchMatches,
          hubConditionPoor: r.hubConditionPoor,
          industrialPriority: r.industrialPriority,
          linkedCustomerNames: r.linkedCustomerNames,
        }
      })
      return new NextResponse(
        safeJsonStringify({ tool, triage, prep, inventory, custody, ledgerRows }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const priorityLines = await loadPriorityPoLineContext(db)

    const rows = await db.embossBlock.findMany({
      where: { active: true },
      orderBy: { blockCode: 'asc' },
      include: {
        cartons: {
          take: 24,
          select: { id: true, cartonName: true, customer: { select: { name: true } } },
        },
        issuedMachine: { select: { machineCode: true, name: true } },
        linkedDie: { select: { id: true, dyeNumber: true } },
      },
    })
    const custodyRows = rows.filter(
      (r) =>
        r.custodyStatus === CUSTODY_HUB_CUSTODY_READY || r.custodyStatus === CUSTODY_ON_FLOOR,
    )
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

    const triageEmbossIds = rows
      .filter((r) => r.custodyStatus === CUSTODY_HUB_TRIAGE)
      .map((r) => r.id)
    const triagePushEvents =
      triageEmbossIds.length > 0
        ? await db.embossHubEvent.findMany({
            where: {
              blockId: { in: triageEmbossIds },
              actionType: EMBOSS_HUB_ACTION.PUSH_TO_TRIAGE,
            },
            orderBy: { createdAt: 'desc' },
          })
        : []
    const triageMetaByBlock = new Map<string, EmbossTriageCardMeta>()
    for (const ev of triagePushEvents) {
      if (triageMetaByBlock.has(ev.blockId)) continue
      const d = (ev.details || {}) as Record<string, unknown>
      triageMetaByBlock.set(ev.blockId, {
        triageManualEntry: d.manualEntry === true,
        triageAwReference: typeof d.awReference === 'string' ? d.awReference : null,
        triageBlockDimensions:
          typeof d.BlockDimensions === 'string' ? d.BlockDimensions : null,
      })
    }

    const mapped = rows.map((b) => {
      const industrialPriority = poLineMatchesEmbossBlock(priorityLines, {
        id: b.id,
        customerId: b.customerId,
        cartonName: b.cartonName,
        cartonIds: b.cartons.map((c) => c.id),
        cartonNames: b.cartons.map((c) => c.cartonName),
      })
      return mapEmboss(
        b,
        b.custodyStatus === CUSTODY_HUB_CUSTODY_READY || b.custodyStatus === CUSTODY_ON_FLOOR
          ? jcHubByEmboss.get(b.id) ?? null
          : null,
        b.custodyStatus === CUSTODY_HUB_TRIAGE ? triageMetaByBlock.get(b.id) ?? null : null,
        industrialPriority,
      )
    })
    const embossRankById = new Map(
      [...mapped]
        .sort((a, b) => {
          const na = (a.productName ?? a.title ?? '').localeCompare(b.productName ?? b.title ?? '', undefined, {
            sensitivity: 'base',
          })
          if (na !== 0) return na
          return a.displayCode.localeCompare(b.displayCode)
        })
        .map((r, idx) => [r.id, idx + 1]),
    )

    const ranked = mapped.map((r) => ({
      ...r,
      ledgerRank: embossRankById.get(r.id) ?? 0,
    }))

    const triage = ranked.filter((r) => r.custodyStatus === CUSTODY_HUB_TRIAGE)
    const prep = ranked.filter((r) => r.custodyStatus === CUSTODY_HUB_ENGRAVING_QUEUE)
    const inventory = ranked.filter((r) => r.custodyStatus === CUSTODY_IN_STOCK)
    const custody = ranked.filter(
      (r) =>
        r.custodyStatus === CUSTODY_HUB_CUSTODY_READY || r.custodyStatus === CUSTODY_ON_FLOOR,
    )

    const ledgerRows: ToolingHubLedgerRowJson[] = ranked.map((r) => {
      const zoneKey = embossLedgerZoneKeyFromCustody(r.custodyStatus)
      return {
        kind: 'emboss',
        id: r.id,
        displayCode: r.displayCode,
        title: r.title,
        zoneKey,
        zoneLabel: toolingLedgerZoneLabel('blocks', zoneKey),
        zoneBadgeClass: toolingLedgerZoneBadge(zoneKey),
        specSummary: `${r.typeLabel} · ${r.materialLabel}${r.blockSize ? ` · ${r.blockSize}` : ''}${
          r.kind === 'emboss' && r.triageAwReference ? ` · AW ${r.triageAwReference}` : ''
        }`,
        units: 1,
        lastStatusUpdatedAt: r.lastStatusUpdatedAt,
        ledgerEntryAt: r.createdAt,
        ledgerRank: embossRankById.get(r.id) ?? 0,
        hubConditionPoor: r.kind === 'emboss' ? r.hubConditionPoor : undefined,
        industrialPriority: r.kind === 'emboss' ? r.industrialPriority : undefined,
        linkedCustomerNames: r.kind === 'emboss' ? r.linkedCustomerNames : undefined,
        linkedProductId: r.kind === 'emboss' ? r.linkedProductId : undefined,
        versionDisplay: r.kind === 'emboss' ? r.versionDisplay : undefined,
      }
    })

    return new NextResponse(
      safeJsonStringify({ tool, triage, prep, inventory, custody, ledgerRows }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[tooling-hub/dashboard]', e)
    return NextResponse.json({ error: 'Failed to load tooling hub' }, { status: 500 })
  }
}
