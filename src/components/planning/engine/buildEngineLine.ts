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

function sizePairToMm(pair: { l: number | null; w: number | null }): { l: number | null; w: number | null } {
  if (!(pair.l && pair.w)) return pair
  if (Math.max(pair.l, pair.w) > 150) return pair
  return { l: pair.l * 25.4, w: pair.w * 25.4 }
}

function readCutChildren(meta: Record<string, unknown>): Array<{ lMm: number; wMm: number; qty: number }> {
  const raw = meta.cutPlanChildSizes
  if (Array.isArray(raw)) {
    const rows = raw
      .map((item) => {
        const o = item as Record<string, unknown>
        return {
          lMm: Number(o.lMm ?? 0),
          wMm: Number(o.wMm ?? 0),
          qty: Math.floor(Number(o.qty ?? 0)),
        }
      })
      .filter((c) => c.lMm > 0 && c.wMm > 0 && c.qty > 0)
    if (rows.length > 0) return rows
  }

  const unit = meta.sheetUnit === 'inch' || meta.sheetUnit === 'in' ? 'inch' : 'mm'
  const lRaw = Number(meta.childInputLengthMm ?? meta.sheetLengthMm ?? 0)
  const wRaw = Number(meta.childInputWidthMm ?? meta.sheetWidthMm ?? 0)
  const lMm = unit === 'inch' ? lRaw * 25.4 : lRaw
  const wMm = unit === 'inch' ? wRaw * 25.4 : wRaw
  const qty = Math.floor(
    Number(meta.selectedCutsPerSheet ?? meta.cutsPerSheet ?? meta.ups ?? meta.cutType ?? 0),
  )
  if (lMm > 0 && wMm > 0 && qty > 0) {
    return [{ lMm, wMm, qty }]
  }
  return []
}

function readStoredCutChildren(meta: Record<string, unknown>): Array<{ lMm: number; wMm: number; qty: number }> {
  const raw = meta.cutPlanChildSizes
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      const o = item as Record<string, unknown>
      return {
        lMm: Number(o.lMm ?? 0),
        wMm: Number(o.wMm ?? 0),
        qty: Math.floor(Number(o.qty ?? 0)),
      }
    })
    .filter((c) => c.lMm > 0 && c.wMm > 0 && c.qty > 0)
}

function metaDimToMm(value: unknown, unit: unknown): number {
  const n = Number(value)
  if (!(n > 0)) return 0
  return unit === 'inch' || unit === 'in' ? n * 25.4 : n
}

function hasBalanceStock(meta: Record<string, unknown>, sheetLengthMm: number | null, sheetWidthMm: number | null): boolean {
  if (!(sheetLengthMm && sheetWidthMm)) return false
  const children = readStoredCutChildren(meta)
  if (children.length === 0) return false
  const direction = meta.cuttingDirection === 'width' ? 'width' : 'length'
  const usedAxis = children.reduce(
    (sum, child) => sum + (direction === 'length' ? child.lMm : child.wMm) * child.qty,
    0,
  )
  const parentAxis = direction === 'length' ? sheetWidthMm : sheetLengthMm
  return parentAxis - usedAxis >= 5
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

  const explicitL = metaDimToMm(meta.sheetLengthMm, meta.sheetUnit)
  const explicitW = metaDimToMm(meta.sheetWidthMm, meta.sheetUnit)
  const parentPair = sizePairToMm(parseSizePair(readiness?.size || (meta.parentSize as string) || null))
  const sheetLengthMm = parentPair.l ?? (Number.isFinite(explicitL) && explicitL > 0 ? explicitL : null)
  const sheetWidthMm = parentPair.w ?? (Number.isFinite(explicitW) && explicitW > 0 ? explicitW : null)

  const makeReadySheets = Number(meta.makeReadySheets ?? 0)
  const cutChildren = readCutChildren(meta)
  const cutPlanValid = cutChildren.length > 0
  const unitsPerSheet = cutChildren.reduce((sum, child) => sum + child.qty, 0)
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
  const balanceStockExists = hasBalanceStock(meta, sheetLengthMm, sheetWidthMm)
  const balanceActionSelected = typeof meta.balanceAction === 'string' && meta.balanceAction.trim().length > 0
  const reservationDecisionExists =
    materialSelected &&
    (Number(readiness?.reservedSheets ?? 0) > 0 ||
      Number(readiness?.freeSheets ?? readiness?.availableSheets ?? 0) >= 0 ||
      shortageSheets > 0 ||
      !!readiness?.prId)

  const readinessFive = computeReadinessFive({
    ups,
    sheetLengthMm,
    sheetWidthMm,
    boardType: readiness?.boardType ?? line.paperType ?? null,
    gsm: readiness?.gsm ?? line.gsm ?? null,
    materialSelected,
    cutPlanValid,
    reservationDecisionExists,
    calculationsComplete: !!(unitsPerSheet > 0 && qty > 0),
    balanceStockExists,
    balanceActionSelected,
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
      unit: (meta.sheetUnit as 'mm' | 'inch') ?? 'inch',
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
