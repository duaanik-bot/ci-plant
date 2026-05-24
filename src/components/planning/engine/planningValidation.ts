export type ReadinessFiveInput = {
  ups: number | null
  sheetLengthMm: number | null
  sheetWidthMm: number | null
  boardType: string | null
  gsm: number | null
  materialSelected: boolean
  shortageSheets: number
  prStatus: string
}

export type ReadinessFive = { allReady: boolean; blockers: string[] }

const PR_ACTIVE = new Set(['pending', 'approved', 'converted_to_po'])

export function computeReadinessFive(input: ReadinessFiveInput): ReadinessFive {
  const blockers: string[] = []
  if (!input.ups || input.ups <= 0) blockers.push('UPS not set')
  if (!input.sheetLengthMm || !input.sheetWidthMm) blockers.push('Sheet size incomplete')
  if (!input.boardType || input.gsm == null) blockers.push('Board type / GSM missing')
  if (!input.materialSelected) blockers.push('No board allocated')
  if (input.shortageSheets > 0 && !PR_ACTIVE.has(input.prStatus)) {
    blockers.push('Shortage — raise PR or approval')
  }
  return { allReady: blockers.length === 0, blockers }
}

export function computeReleaseGuard(input: { shortageSheets: number; prStatus: string }): {
  canRelease: boolean
  reason: string | null
} {
  if (input.shortageSheets > 0 && !PR_ACTIVE.has(input.prStatus)) {
    return { canRelease: false, reason: 'Shortage open with no PR/approval' }
  }
  return { canRelease: true, reason: null }
}
