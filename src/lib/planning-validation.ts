/**
 * Planning Engine — pre-commit validation.
 *
 * Pure, deterministic gate used by the engine to decide what's missing before
 * calculation, whether Save & Lock is allowed, and whether a Release should be
 * blocked. Kept separate from the server 5-point readiness (which covers
 * artwork/plates/material/die/emboss); this layer covers the planner's own
 * mandatory inputs + the shortage→Release rule.
 */

export type PlanningValidationInput = {
  boardType: string | null
  gsm: number | null
  ups: number | null
  sheetLengthMm: number | null
  sheetWidthMm: number | null
  shortageSheets: number
  hasPurchaseRequest: boolean
  /** Current or target batch status. */
  status: string
}

export type PlanningValidation = {
  /** Human labels of mandatory fields still missing. */
  missingMandatory: string[]
  /** All calculation inputs are present. */
  canCalc: boolean
  /** Save & Lock is allowed from this layer's perspective (mandatory complete). */
  canLock: boolean
  /** Release should be blocked (shortage without PR/approval). */
  releaseBlocked: boolean
  releaseReason: string | null
}

function pos(n: number | null | undefined): boolean {
  return n != null && Number.isFinite(n) && n > 0
}

export function validatePlanningLine(input: PlanningValidationInput): PlanningValidation {
  const missingMandatory: string[] = []
  if (!input.boardType || !input.boardType.trim()) missingMandatory.push('Board type')
  if (!pos(input.gsm)) missingMandatory.push('GSM')
  if (!(input.ups != null && Number.isInteger(input.ups) && input.ups >= 1)) missingMandatory.push('UPS')
  if (!pos(input.sheetLengthMm)) missingMandatory.push('Sheet length')
  if (!pos(input.sheetWidthMm)) missingMandatory.push('Sheet width')

  const canCalc = missingMandatory.length === 0
  const canLock = canCalc

  const shortage = Math.max(0, Number(input.shortageSheets) || 0)
  const approved = input.status === 'ApprovedAW' || input.status === 'Released'
  const releaseBlocked = shortage > 0 && !input.hasPurchaseRequest && !approved
  const releaseReason = releaseBlocked
    ? 'Shortage open — raise a PR or get approval before releasing'
    : null

  return { missingMandatory, canCalc, canLock, releaseBlocked, releaseReason }
}
