import { NextRequest, NextResponse } from 'next/server'
import { unstable_cache } from 'next/cache'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { computeJobYieldMetricsForCard, resolveActualIssuedKgForJobs } from '@/lib/production-yield'
import { computeLiveOeeForJobCard, sumDowntimeMinutesForJobs } from '@/lib/production-oee'
import { loadMachinePmHealthMap } from '@/lib/machine-pm-health'

export const dynamic = 'force-dynamic'

const PRODUCTION_STAGES_TAG = 'production-stages'

const stageLabelByKey: Record<string, string> = {}
PRODUCTION_STAGES.forEach((s) => {
  stageLabelByKey[s.key] = s.label
})
const stageKeyByLabel: Record<string, string> = {}
PRODUCTION_STAGES.forEach((s) => {
  stageKeyByLabel[s.label] = s.key
})

// Stages 3–7 are conditional: only show job cards with matching postPressRouting flag
const postPressRoutingKeyByStageKey: Record<string, string> = {
  chemical_coating: 'chemicalCoating',
  lamination: 'lamination',
  spot_uv: 'spotUv',
  leafing: 'leafing',
  embossing: 'embossing',
}

function asRoutingFlags(postPressRouting: unknown) {
  const o = (postPressRouting && typeof postPressRouting === 'object'
    ? (postPressRouting as Record<string, unknown>)
    : {}) as Record<string, unknown>
  return {
    chemicalCoating: o.chemicalCoating === true,
    lamination: o.lamination === true,
    spotUv: o.spotUv === true,
    leafing: o.leafing === true,
    embossing: o.embossing === true,
  }
}

function requiredStageKeysForJob(postPressRouting: unknown): string[] {
  const r = asRoutingFlags(postPressRouting)
  const out: string[] = ['cutting', 'printing']
  // Spot UV is part of coating execution, not a separate station queue.
  if (r.chemicalCoating || r.spotUv) out.push('chemical_coating')
  if (r.lamination) out.push('lamination')
  // Leafing/Embossing are executed within Dye Cutting. Pasting is terminal → Dispatch → Billing.
  out.push('dye_cutting', 'pasting')
  return out
}

function isQueuedForStage(postPressRouting: unknown, key: string): boolean {
  const o = (postPressRouting && typeof postPressRouting === 'object'
    ? (postPressRouting as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const exec =
    o.executionOrchestration && typeof o.executionOrchestration === 'object'
      ? (o.executionOrchestration as Record<string, unknown>)
      : null
  if (!exec) return false
  const token = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  const field = `${token}QueuedAt`
  return typeof exec[field] === 'string' && String(exec[field]).trim().length > 0
}

function stagePushedQty(postPressRouting: unknown, key: string): number {
  const o = (postPressRouting && typeof postPressRouting === 'object'
    ? (postPressRouting as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const exec =
    o.executionOrchestration && typeof o.executionOrchestration === 'object'
      ? (o.executionOrchestration as Record<string, unknown>)
      : null
  if (!exec) return 0
  const progress =
    exec.stageProgress && typeof exec.stageProgress === 'object'
      ? (exec.stageProgress as Record<string, unknown>)
      : {}
  const stage =
    progress[key] && typeof progress[key] === 'object'
      ? (progress[key] as Record<string, unknown>)
      : {}
  const pushed = Number(stage.pushedQty ?? 0)
  return Number.isFinite(pushed) ? Math.max(0, pushed) : 0
}

function stageProgressStatus(postPressRouting: unknown, key: string): string {
  const o = (postPressRouting && typeof postPressRouting === 'object'
    ? (postPressRouting as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const exec =
    o.executionOrchestration && typeof o.executionOrchestration === 'object'
      ? (o.executionOrchestration as Record<string, unknown>)
      : null
  if (!exec) return 'pending'
  const progress =
    exec.stageProgress && typeof exec.stageProgress === 'object'
      ? (exec.stageProgress as Record<string, unknown>)
      : {}
  const stage =
    progress[key] && typeof progress[key] === 'object'
      ? (progress[key] as Record<string, unknown>)
      : {}
  const status = String(stage.status ?? '').trim().toLowerCase()
  return status || 'pending'
}

function idleHoursForStage(
  status: string,
  stageCreatedAt: Date,
  jobUpdatedAt: Date,
): number | null {
  if (status === 'completed') return null
  if (status === 'pending') {
    return (Date.now() - stageCreatedAt.getTime()) / 3_600_000
  }
  if (status === 'in_progress') {
    return (Date.now() - jobUpdatedAt.getTime()) / 3_600_000
  }
  return (Date.now() - stageCreatedAt.getTime()) / 3_600_000
}

async function fetchStageData(stageKey: string) {
  const stageLabel = stageLabelByKey[stageKey]

  const routingKey = postPressRoutingKeyByStageKey[stageKey]
  const where: {
    stageName: string
    status?: { notIn: string[] }
    jobCard?: {
      postPressRouting?:
        | { path: string[]; equals: boolean }
        | { path: string[]; equals: string }
      AND?: { postPressRouting: { path: string[]; equals: string } }[]
    }
  } = {
    stageName: stageLabel,
    // Hide rows removed via stage delete actions.
    status: { notIn: ['archived', 'deleted'] },
  }
  if (routingKey) {
    if (stageKey === 'chemical_coating') {
      where.jobCard = {
        OR: [
          { postPressRouting: { path: ['chemicalCoating'], equals: true } },
          { postPressRouting: { path: ['spotUv'], equals: true } },
        ],
      }
    } else {
      where.jobCard = {
        postPressRouting: { path: [routingKey], equals: true },
      }
    }
  }
  if (stageKey === 'printing') {
    where.jobCard = {
      ...(where.jobCard ?? {}),
      AND: [
        ...((where.jobCard?.AND as { postPressRouting: { path: string[]; equals: string } }[] | undefined) ?? []),
        { postPressRouting: { path: ['printPlan', 'lane'], equals: 'machine' } },
      ],
    }
  }

  const records = await db.productionStageRecord.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      jobCard: {
        include: {
          customer: { select: { id: true, name: true } },
          shiftOperator: { select: { id: true, name: true } },
          machine: { select: { id: true, machineCode: true, name: true, capacityPerShift: true } },
          stages: {
            select: {
              id: true,
              stageName: true,
              status: true,
              counter: true,
              operator: true,
              completedAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  })

  const gatedRecords = records.filter((rec) => {
    const jc = rec.jobCard
    if (!jc) return false
    const currentKey = stageKeyByLabel[rec.stageName]
    if (!currentKey) return false
    if (currentKey === 'cutting') return true
    if (currentKey === 'printing') {
      const postPress =
        jc.postPressRouting && typeof jc.postPressRouting === 'object'
          ? (jc.postPressRouting as Record<string, unknown>)
          : {}
      const printPlan =
        postPress.printPlan && typeof postPress.printPlan === 'object'
          ? (postPress.printPlan as Record<string, unknown>)
          : {}
      if (printPlan.lane === 'machine') return true
    }
    if (rec.status === 'in_progress' || rec.status === 'completed') return true
    const seq = requiredStageKeysForJob(jc.postPressRouting)
    const idx = seq.indexOf(currentKey)
    if (idx < 0) return false
    if (idx === 0) return true
    const prevKey = seq[idx - 1]
    const prevLabel = stageLabelByKey[prevKey]
    const prevStage = jc.stages.find((s) => s.stageName === prevLabel)
    const prevPushed = stagePushedQty(jc.postPressRouting, prevKey)
    const currentProgressStatus = stageProgressStatus(jc.postPressRouting, currentKey)
    const currentIsMakeReady =
      currentProgressStatus === 'make_ready_alert' ||
      currentProgressStatus === 'make_ready_started' ||
      currentProgressStatus === 'ready_to_receive'

    const prevStarted = prevStage?.status === 'in_progress'
    if ((!prevStage || prevStage.status !== 'completed') && prevPushed <= 0 && !prevStarted) return false
    return isQueuedForStage(jc.postPressRouting, currentKey) || prevPushed > 0 || currentIsMakeReady
  })

  const jcNumbers = gatedRecords
    .map((r) => r.jobCard?.jobCardNumber)
    .filter((n): n is number => n != null)
  const uniqJcNumbers = Array.from(new Set(jcNumbers))
  const poLines =
    uniqJcNumbers.length > 0
      ? await db.poLineItem.findMany({
          where: { jobCardNumber: { in: uniqJcNumbers } },
          select: {
            id: true,
            jobCardNumber: true,
            cartonName: true,
            cartonSize: true,
            quantity: true,
            paperType: true,
            coatingType: true,
            otherCoating: true,
            embossingLeafing: true,
            gsm: true,
            dyeId: true,
            directorPriority: true,
            specOverrides: true,
            materialQueue: { select: { ups: true } },
            dieMaster: { select: { ups: true } },
            carton: {
              select: {
                artworkCode: true,
                coatingType: true,
                laminateType: true,
                foilType: true,
                embossingLeafing: true,
                printingType: true,
                pastingStyle: true,
                colourBreakdown: true,
                dieMaster: { select: { ups: true } },
              },
            },
            po: { select: { isPriority: true, poNumber: true, poDate: true } },
          },
        })
      : []
  const productNameByJc = new Map<number, string>()
  const poMetaByJc = new Map<
    number,
    {
      poLineId: string
      poNumber: string
      poDate: string | null
      cartonName: string
      cartonSize: string | null
      quantity: number
      paperType: string | null
      coatingType: string | null
      otherCoating: string | null
      embossingLeafing: string | null
      gsm: number | null
      dyeId: string | null
      ups: number | null
      specOverrides: Record<string, unknown> | null
      carton: {
        artworkCode: string | null
        coatingType: string | null
        laminateType: string | null
        foilType: string | null
        embossingLeafing: string | null
        printingType: string | null
        pastingStyle: string | null
        colourBreakdown: unknown
      } | null
    }
  >()
  const priorityByJc = new Map<number, boolean>()
  const unifiedBodyKeyByJc = new Map<number, string | null>()
  const unifiedCounts = new Map<string, number>()
  poLines.forEach((l) => {
    if (l.jobCardNumber != null) {
      productNameByJc.set(l.jobCardNumber, l.cartonName)
      poMetaByJc.set(l.jobCardNumber, {
        poLineId: l.id,
        poNumber: l.po.poNumber,
        poDate: l.po.poDate ? l.po.poDate.toISOString() : null,
        cartonName: l.cartonName,
        cartonSize: l.cartonSize,
        quantity: l.quantity,
        paperType: l.paperType,
        coatingType: l.coatingType,
        otherCoating: l.otherCoating ?? null,
        embossingLeafing: l.embossingLeafing,
        gsm: l.gsm,
        dyeId: l.dyeId,
        specOverrides: (l.specOverrides as Record<string, unknown> | null) ?? null,
        ups: null,
        carton: l.carton
          ? {
              artworkCode: l.carton.artworkCode,
              coatingType: l.carton.coatingType,
              laminateType: l.carton.laminateType,
              foilType: l.carton.foilType,
              embossingLeafing: l.carton.embossingLeafing,
              printingType: l.carton.printingType,
              pastingStyle: l.carton.pastingStyle,
              colourBreakdown: l.carton.colourBreakdown,
            }
          : null,
      })
      if (l.directorPriority || l.po.isPriority) {
        priorityByJc.set(l.jobCardNumber, true)
      }
      const spec = (l.specOverrides as Record<string, unknown> | null) || {}
      const planningCore =
        spec.planningCore && typeof spec.planningCore === 'object'
          ? (spec.planningCore as Record<string, unknown>)
          : null
      const planningUps = Number(planningCore?.ups ?? spec.ups ?? 0)
      const resolvedUps =
        (Number.isFinite(planningUps) && planningUps >= 1 ? Math.floor(planningUps) : null) ??
        (typeof l.materialQueue?.ups === 'number' && l.materialQueue.ups >= 1 ? Math.floor(l.materialQueue.ups) : null) ??
        (typeof l.dieMaster?.ups === 'number' && l.dieMaster.ups >= 1 ? Math.floor(l.dieMaster.ups) : null) ??
        (typeof l.carton?.dieMaster?.ups === 'number' && l.carton.dieMaster.ups >= 1 ? Math.floor(l.carton.dieMaster.ups) : null) ??
        null
      const existingMeta = poMetaByJc.get(l.jobCardNumber)
      if (existingMeta) {
        poMetaByJc.set(l.jobCardNumber, { ...existingMeta, ups: resolvedUps })
      }
      const unifiedBody =
        spec.unifiedGroupBody && typeof spec.unifiedGroupBody === 'object'
          ? (spec.unifiedGroupBody as Record<string, unknown>)
          : null
      const key =
        (typeof unifiedBody?.masterSetId === 'string' && unifiedBody.masterSetId.trim()) ||
        (typeof planningCore?.masterSetId === 'string' && planningCore.masterSetId.trim()) ||
        ''
      const layoutType =
        typeof planningCore?.layoutType === 'string' ? planningCore.layoutType.trim() : ''
      const memberIds = Array.isArray(planningCore?.mixSetMemberIds)
        ? planningCore?.mixSetMemberIds
        : []
      const isUnifiedGang = !!key && (layoutType === 'gang' || memberIds.length > 1)
      if (isUnifiedGang) {
        unifiedBodyKeyByJc.set(l.jobCardNumber, key)
        unifiedCounts.set(key, (unifiedCounts.get(key) || 0) + 1)
      } else if (!unifiedBodyKeyByJc.has(l.jobCardNumber)) {
        unifiedBodyKeyByJc.set(l.jobCardNumber, null)
      }
    }
  })

  const jcIds = Array.from(new Set(gatedRecords.map((r) => r.jobCardId)))
  const machineIds = Array.from(
    new Set(
      records
        .map((r) => r.jobCard?.machineId)
        .filter((id): id is string => id != null && id.length > 0),
    ),
  )

  // Run independent fetches in parallel — was previously sequential.
  const [pmHealthByMachineId, jobsForYield, ledgerRows, downtimeMinByJobId, issuedKgByJobId] = await Promise.all([
    loadMachinePmHealthMap(db, machineIds),
    jcIds.length > 0
      ? db.productionJobCard.findMany({
          where: { id: { in: jcIds } },
          include: { stages: true },
        })
      : Promise.resolve([] as Awaited<ReturnType<typeof db.productionJobCard.findMany>>),
    jcIds.length > 0
      ? db.productionOeeLedger.findMany({
          where: { productionJobCardId: { in: jcIds } },
        })
      : Promise.resolve([] as Awaited<ReturnType<typeof db.productionOeeLedger.findMany>>),
    sumDowntimeMinutesForJobs(db, jcIds),
    resolveActualIssuedKgForJobs(db, jcIds),
  ])

  type PoLineYield = NonNullable<Parameters<typeof computeJobYieldMetricsForCard>[2]>
  const yieldLineByJcNum = new Map<number, PoLineYield>()
  const jcNumsForYield = jobsForYield.map((j) => j.jobCardNumber)
  if (jcNumsForYield.length > 0) {
    const yLines = await db.poLineItem.findMany({
      where: { jobCardNumber: { in: jcNumsForYield } },
      select: {
        jobCardNumber: true,
        gsm: true,
        dimLengthMm: true,
        dimWidthMm: true,
        carton: {
          select: {
            finishedLength: true,
            finishedWidth: true,
            blankLength: true,
            blankWidth: true,
            gsm: true,
          },
        },
      },
    })
    for (const ln of yLines) {
      if (ln.jobCardNumber == null) continue
      yieldLineByJcNum.set(ln.jobCardNumber, {
        gsm: ln.gsm,
        dimLengthMm: ln.dimLengthMm,
        dimWidthMm: ln.dimWidthMm,
        carton: ln.carton,
      })
    }
  }

  // Parallelize the per-job yield computation; pass precomputed issued data so each
  // call does ZERO DB work (was 2 queries per card before batching).
  const yieldByJobId = new Map<string, Awaited<ReturnType<typeof computeJobYieldMetricsForCard>>>()
  const yieldEntries = await Promise.all(
    jobsForYield.map(async (j) => {
      const line = yieldLineByJcNum.get(j.jobCardNumber) ?? null
      const issued = issuedKgByJobId.get(j.id) ?? { kg: null, totalSheets: 0 }
      return [j.id, await computeJobYieldMetricsForCard(db, j, line, issued)] as const
    }),
  )
  for (const [id, val] of yieldEntries) yieldByJobId.set(id, val)

  const ledgerByJcId = new Map(ledgerRows.map((l) => [l.productionJobCardId, l]))

  type OeePayload = {
    oee: number
    availability: number
    performance: number
    quality: number
    currentSpeedPph: number
    ratedSpeedPph: number
    secondsSinceLastTick: number | null
    downtimeLock: boolean
    source: 'live' | 'ledger'
  }
  const oeeByStageId = new Map<string, OeePayload>()

  // Parallelize live OEE fetches (was sequential await in for-loop).
  const liveOeeEntries = await Promise.all(
    gatedRecords.map(async (r) => {
      const jc = r.jobCard
      if (!jc) return null
      const led = ledgerByJcId.get(jc.id)
      if (led) {
        return [
          r.id,
          {
            oee: Number(led.oeePct),
            availability: Number(led.availabilityPct),
            performance: Number(led.performancePct),
            quality: Number(led.qualityPct),
            currentSpeedPph: 0,
            ratedSpeedPph: led.ratedSpeedPph != null ? Number(led.ratedSpeedPph) : 0,
            secondsSinceLastTick: null,
            downtimeLock: false,
            source: 'ledger' as const,
          },
        ] as const
      }
      if (r.status !== 'in_progress') return null
      const live = await computeLiveOeeForJobCard(
        db,
        {
          id: jc.id,
          createdAt: jc.createdAt,
          totalSheets: jc.totalSheets,
          wastageSheets: jc.wastageSheets,
          status: jc.status,
          machineId: jc.machineId,
          machine: jc.machine,
        },
        {
          status: r.status,
          counter: r.counter,
          lastProductionTickAt: r.lastProductionTickAt,
          inProgressSince: r.inProgressSince,
          createdAt: r.createdAt,
        },
        downtimeMinByJobId.get(jc.id) ?? 0,
      )
      if (!live) return null
      return [r.id, { ...live, source: 'live' as const }] as const
    }),
  )
  for (const entry of liveOeeEntries) {
    if (entry) oeeByStageId.set(entry[0], entry[1])
  }

  const jobCards = gatedRecords.map((r) => {
    const jc = r.jobCard
    const idleHours =
      jc != null ? idleHoursForStage(r.status, r.createdAt, jc.updatedAt) : null
    const poMeta = jc?.jobCardNumber != null ? poMetaByJc.get(jc.jobCardNumber) ?? null : null
    const stageMap =
      jc?.stages?.reduce<Record<string, { id: string; status: string; counter: number | null; operator: string | null; completedAt: string | null }>>(
        (acc, s) => {
          acc[s.stageName] = {
            id: s.id,
            status: s.status,
            counter: s.counter,
            operator: s.operator,
            completedAt: s.completedAt ? s.completedAt.toISOString() : null,
          }
          return acc
        },
        {},
      ) ?? {}

    const getCounter = (stageName: string): number =>
      Number(stageMap[stageName]?.counter ?? 0) || 0
    const stageOutputs = {
      cutting: getCounter('Cutting'),
      printing: getCounter('Printing'),
      chemicalCoating: getCounter('Chemical Coating'),
      lamination: getCounter('Lamination'),
      spotUv: getCounter('Spot UV'),
      leafing: getCounter('Leafing'),
      embossing: getCounter('Embossing'),
      dyeCutting: getCounter('Dye Cutting'),
      sorting: getCounter('Sorting'),
      pasting: getCounter('Pasting'),
    }

    return {
      stageRecord: {
        id: r.id,
        stageName: r.stageName,
        status: r.status,
        operator: r.operator,
        counter: r.counter,
        sheetSize: r.sheetSize,
        completedAt: r.completedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        lastProductionTickAt: r.lastProductionTickAt?.toISOString() ?? null,
        inProgressSince: r.inProgressSince?.toISOString() ?? null,
      },
      idleHours,
      jobCard: jc
        ? {
            id: jc.id,
            jobCardNumber: jc.jobCardNumber,
            setNumber: jc.setNumber,
            batchNumber: jc.batchNumber,
            requiredSheets: jc.requiredSheets,
            totalSheets: jc.totalSheets,
            status: jc.status,
            postPressRouting:
              jc.postPressRouting && typeof jc.postPressRouting === 'object'
                ? (jc.postPressRouting as Record<string, unknown>)
                : null,
            customer: jc.customer,
            updatedAt: jc.updatedAt.toISOString(),
            machineId: jc.machineId,
            machine: jc.machine,
            industrialPriority:
              jc.jobCardNumber != null && priorityByJc.get(jc.jobCardNumber) === true,
            productName:
              jc.jobCardNumber != null ? productNameByJc.get(jc.jobCardNumber) ?? null : null,
            unifiedBodyId:
              jc.jobCardNumber != null
                ? (unifiedBodyKeyByJc.get(jc.jobCardNumber) ?? null)
                : null,
            unifiedBodySize:
              jc.jobCardNumber != null
                ? (() => {
                    const key = unifiedBodyKeyByJc.get(jc.jobCardNumber)
                    return key ? (unifiedCounts.get(key) ?? null) : null
                  })()
                : null,
            yield: yieldByJobId.get(jc.id) ?? null,
            oee: oeeByStageId.get(r.id) ?? null,
            poMeta,
            stageMap,
            stageOutputs,
            shiftOperator: jc.shiftOperator ?? null,
            incentiveLedger: (() => {
              const led = ledgerByJcId.get(jc.id)
              if (!led) return null
              return {
                incentiveEligible: led.incentiveEligible,
                yieldPercent: led.yieldPercent != null ? Number(led.yieldPercent) : null,
                oeePct: Number(led.oeePct),
                incentiveVerifiedAt: led.incentiveVerifiedAt?.toISOString() ?? null,
              }
            })(),
            machinePm: jc.machineId ? pmHealthByMachineId.get(jc.machineId) ?? null : null,
          }
        : null,
    }
  })

  return {
    stageKey,
    stageLabel,
    jobCards: jobCards.filter((x) => x.jobCard != null),
  }
}

const fetchStageDataCached = unstable_cache(
  fetchStageData,
  ['production-stage-data-v2'],
  { revalidate: 30, tags: [PRODUCTION_STAGES_TAG] },
)

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ stageKey: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { stageKey } = await context.params
  if (!stageLabelByKey[stageKey]) {
    return NextResponse.json({ error: 'Invalid stage key' }, { status: 400 })
  }

  const t0 = Date.now()
  const data = await fetchStageDataCached(stageKey)
  const elapsed = Date.now() - t0
  console.log(`[stages/${stageKey}] ${elapsed}ms (${data.jobCards.length} cards)`)
  return NextResponse.json(data)
}
