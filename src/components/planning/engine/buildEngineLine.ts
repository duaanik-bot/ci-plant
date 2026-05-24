import type { PlanningGridLine } from '@/components/planning/PlanningDecisionGrid'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import { resolveUps } from '@/lib/production-os-resolvers'
import { computeReadinessFive, computeReleaseGuard } from './planningValidation'

export type BuildEngineLineExtras = {
  designerOptions?: Array<{ id: string; name: string }>
  designerId?: string | null
  pressAssignment?: NonNullable<PlanningEngineLine['batchDecision']>['pressAssignment']
  smartMatchSuggestions?: NonNullable<PlanningEngineLine['smartMatch']>['suggestions']
}

function parseSizePair(size: string | null | undefined): { l: number | null; w: number | null } {
  if (!size) return { l: null, w: null }
  const m = String(size).match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i)
  if (!m) return { l: null, w: null }
  return { l: Number(m[1]), w: Number(m[2]) }
}

const STATUS_VALUES = ['Ready', 'Draft', 'Hold', 'ApprovedAW', 'Released', 'Locked'] as const
type BdStatus = (typeof STATUS_VALUES)[number]

export function buildEngineLine(
  line: PlanningGridLine,
  readiness: PlanningEngineReadiness | null,
  extras: BuildEngineLineExtras = {},
): PlanningEngineLine {
  const spec = (line.specOverrides ?? {}) as Record<string, unknown>
  const meta = readPlanningMeta(spec)
  // Use raw planningCore — persisted keys (status, setNumber, lockedAt, lockedByName) are NOT
  // in the typed PlanningCore shape, so we must read the raw object directly.
  const pc = (spec.planningCore ?? {}) as Record<string, unknown>

  const ups = (Number(meta.ups) || resolveUps(line) || null) as number | null
  const qty = Number(line.quantity ?? 0)
  const requiredSheets = Number(readiness?.requiredSheets ?? 0)
  const sheetYieldPct =
    ups && qty && requiredSheets ? Math.max(0, Math.min(100, (qty / (ups * requiredSheets)) * 100)) : null

  const explicitL = Number(meta.sheetLengthMm)
  const explicitW = Number(meta.sheetWidthMm)
  const fromPair = parseSizePair((meta.parentSize as string) || readiness?.size || null)
  const sheetLengthMm = Number.isFinite(explicitL) && explicitL > 0 ? explicitL : fromPair.l
  const sheetWidthMm = Number.isFinite(explicitW) && explicitW > 0 ? explicitW : fromPair.w

  const makeReadySheets = Number(meta.makeReadySheets ?? 0)
  const allocatedSheets =
    Number(readiness?.reservedSheets ?? 0) || Number(readiness?.freeSheets ?? 0)
  const expectedYieldUnits = ups && allocatedSheets ? allocatedSheets * ups : null
  const balanceAfterAllocation = readiness
    ? Number(readiness.freeSheets ?? readiness.availableSheets ?? 0) - requiredSheets
    : null
  const childSize = (readiness as { requiredFinalSize?: string | null } | null)?.requiredFinalSize ?? null

  const materialSelected = !!(spec.planningMaterialId || readiness?.materialId)
  const shortageSheets = Number(readiness?.shortageSheets ?? 0)
  const prStatus = readiness?.prStatus ?? 'not_created'

  const readinessFive = computeReadinessFive({
    ups,
    sheetLengthMm,
    sheetWidthMm,
    boardType: readiness?.boardType ?? line.paperType ?? null,
    gsm: readiness?.gsm ?? line.gsm ?? null,
    materialSelected,
    shortageSheets,
    prStatus,
  })

  const rawStatus = String(pc.status ?? 'Draft')
  const status = (STATUS_VALUES.includes(rawStatus as BdStatus) ? rawStatus : 'Draft') as BdStatus
  const layoutType: 'Gang' | 'Single' =
    pc.layoutType === 'gang' ? 'Gang' : pc.layoutType === 'single' ? 'Single' : 'Single'

  const topOption =
    (readiness?.suggestedBoardOptions && readiness.suggestedBoardOptions[0]) ||
    (readiness?.closestAvailableOptions && readiness.closestAvailableOptions[0]) ||
    null

  return {
    ...(line as unknown as PlanningEngineLine),
    upsAndSpec: {
      ups,
      upsSource: meta.ups != null ? 'manual' : ups != null ? 'auto' : null,
      sheetYieldPct,
      makeReady: makeReadySheets > 0 ? { total: makeReadySheets, base: makeReadySheets } : null,
      bpi: null,
      expectedYieldUnits,
      balanceAfterAllocation,
    },
    sheetSpec: {
      lengthMm: sheetLengthMm,
      widthMm: sheetWidthMm,
      unit: (meta.sheetUnit as 'mm' | 'inch') ?? 'mm',
      cutType: meta.cutType != null ? Number(meta.cutType) : (Number(meta.cutsPerSheet) || null),
      parentSize: (meta.parentSize as string) ?? readiness?.size ?? null,
      childSize,
    },
    smartMatch: {
      // Emitted as a 0–1 fraction; SectionSmartMatch renders it as `confidence * 100`%.
      boardMatchConfidence: topOption ? Math.round(topOption.yieldPct) / 100 : 0,
      materialCode: readiness?.materialCode ?? topOption?.materialCode ?? null,
      matchedOn: topOption?.matchType ?? null,
      suggestions: extras.smartMatchSuggestions ?? [],
    },
    batchDecision: {
      status,
      layoutType,
      setNumber: (pc.setNumber as string) ?? null,
      setNumberAuto: !pc.setNumber,
      designerOptions: extras.designerOptions ?? [],
      designerId: extras.designerId ?? ((pc.designerKey as string) || null),
      pressAssignment: extras.pressAssignment ?? null,
      readinessFive,
      releaseGuard: computeReleaseGuard({ shortageSheets, prStatus }),
      lockedAt: (pc.lockedAt as string) ?? null,
      lockedByName: (pc.lockedByName as string) ?? null,
    },
  }
}
