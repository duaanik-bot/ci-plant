import { readPlanningMeta } from '@/lib/planning-decision-spec'
import { resolveUps } from '@/lib/production-os-resolvers'
import { computeEqualDivisionFit, parseSheetDims, type CutType } from '@/lib/smart-match-parent-sheets'
import type { PlanningEngineLine } from './types'

const DEFAULT_WASTAGE_SHEETS = 150

function positiveNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function readCutPlanUnits(meta: Record<string, unknown>): number | null {
  const children = meta.cutPlanChildSizes
  if (!Array.isArray(children)) return null
  const total = children.reduce((sum, child) => {
    if (!child || typeof child !== 'object') return sum
    return sum + Math.max(0, Math.floor(Number((child as Record<string, unknown>).qty ?? 0)))
  }, 0)
  return total > 0 ? total : null
}

function normalizeUnit(value: unknown): 'mm' | 'inch' {
  return value === 'mm' ? 'mm' : 'inch'
}

function inferUnit(length: number, width: number): 'mm' | 'inch' {
  return Math.max(length, width) > 200 ? 'mm' : 'inch'
}

function convertDimension(value: number, from: 'mm' | 'inch', to: 'mm' | 'inch'): number {
  if (from === to) return value
  return from === 'inch' ? value * 25.4 : value / 25.4
}

function readAutoFitUnits(meta: Record<string, unknown>): number | null {
  const parent = parseSheetDims(typeof meta.parentSize === 'string' ? meta.parentSize : null)
  const childLength = positiveNumber(meta.sheetLengthMm)
  const childWidth = positiveNumber(meta.sheetWidthMm)
  const cutType = Math.max(1, Math.min(6, Math.floor(Number(meta.cutType ?? meta.cutsPerSheet ?? 0))))
  if (!parent || !childLength || !childWidth || !(cutType > 0)) return null
  const parentUnit = inferUnit(parent.length, parent.width)
  const childUnit = normalizeUnit(meta.sheetUnit)
  const fit = computeEqualDivisionFit({
    parentLength: parent.length,
    parentWidth: parent.width,
    childLength: convertDimension(childLength, childUnit, parentUnit),
    childWidth: convertDimension(childWidth, childUnit, parentUnit),
    cutType: cutType as CutType,
    allowRotation: true,
  })
  return fit.qualifies && fit.piecesPerSheet > 0 ? fit.piecesPerSheet : null
}

export function getPlanningRequirement(
  line: PlanningEngineLine,
  override?: { unitsPerSheet?: number | null; wastageSheets?: number | null },
) {
  const meta = readPlanningMeta(line.specOverrides ?? null)
  const totalPoQty = Math.max(0, Number(line.quantity ?? 0))
  const upsEdited = meta.upsEdited === true || meta.upsSource === 'manual'
  const autoFitUnits = readAutoFitUnits(meta)
  const unitsPerSheet =
    positiveNumber(override?.unitsPerSheet) ??
    (upsEdited ? positiveNumber(meta.ups) : null) ??
    positiveNumber(autoFitUnits) ??
    positiveNumber(meta.selectedCutsPerSheet) ??
    positiveNumber(meta.cutsPerSheet) ??
    positiveNumber(meta.ups) ??
    positiveNumber(line.upsAndSpec?.ups) ??
    positiveNumber(resolveUps(line)) ??
    readCutPlanUnits(meta)
  const wastageSheets =
    override?.wastageSheets != null
      ? Math.max(0, Math.round(Number(override.wastageSheets) || 0))
      : typeof meta.wastageSheets === 'number'
        ? Math.max(0, Math.round(meta.wastageSheets))
        : DEFAULT_WASTAGE_SHEETS
  const rawBaseSheets = unitsPerSheet && totalPoQty > 0 ? totalPoQty / unitsPerSheet : null
  const baseSheets = rawBaseSheets != null ? Math.ceil(rawBaseSheets) : null
  const reserveBaseSheets = baseSheets
  const totalRequired = reserveBaseSheets != null ? reserveBaseSheets + wastageSheets : null

  return { totalPoQty, unitsPerSheet, baseSheets, reserveBaseSheets, wastageSheets, totalRequired }
}
