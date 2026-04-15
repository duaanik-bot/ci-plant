/** Industry-standard plate scrap reasons — hub UI + API must stay in sync. */
export const PLATE_SCRAP_REASONS = [
  { code: 'scratched_press', label: 'Scratched / Damaged on press' },
  { code: 'edge_cracking', label: 'Edge cracking / Bending fatigue' },
  { code: 'oxidation_storage', label: 'Oxidation / Storage wear' },
  { code: 'burn_calibration', label: 'Image / Burn calibration error' },
  { code: 'custody_not_returned', label: 'Not returned from custody floor' },
] as const

export type PlateScrapReasonCode = (typeof PLATE_SCRAP_REASONS)[number]['code']

export const PLATE_SCRAP_REASON_CODE_LIST = PLATE_SCRAP_REASONS.map((r) => r.code) as [
  PlateScrapReasonCode,
  ...PlateScrapReasonCode[],
]

export function plateScrapReasonLabel(code: string): string {
  const hit = PLATE_SCRAP_REASONS.find((r) => r.code === code)
  return hit?.label ?? code
}
