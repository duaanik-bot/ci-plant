export type ReadinessFiveInput = {
  ups: number | null
  sheetLengthMm: number | null
  sheetWidthMm: number | null
  boardType: string | null
  gsm: number | null
  materialSelected: boolean
  cutPlanValid?: boolean
  reservationDecisionExists?: boolean
  calculationsComplete?: boolean
  balanceStockExists?: boolean
  balanceActionSelected?: boolean
  shortageSheets: number
  prStatus: string
}

export type ReadinessFive = { allReady: boolean; blockers: string[] }

export function computeReadinessFive(input: ReadinessFiveInput): ReadinessFive {
  const blockers: string[] = []
  if (!input.ups || input.ups <= 0) blockers.push('UPS not set')
  if (!input.sheetLengthMm || !input.sheetWidthMm) blockers.push('Sheet size incomplete')
  if (!input.boardType || input.gsm == null) blockers.push('Board type / GSM missing')
  if (!input.materialSelected) blockers.push('No board allocated')
  if (input.cutPlanValid === false) blockers.push('Cut plan incomplete')
  if (input.calculationsComplete === false) blockers.push('Required calculations incomplete')
  if (input.balanceStockExists && input.balanceActionSelected === false) {
    blockers.push('Balance stock action required')
  }
  return { allReady: blockers.length === 0, blockers }
}

export function computeReleaseGuard(input: { shortageSheets: number; prStatus: string }): {
  canRelease: boolean
  reason: string | null
} {
  return { canRelease: true, reason: null }
}
