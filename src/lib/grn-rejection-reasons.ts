/** Dropdown values for partial / full rejection on GRN QC. */
export const GRN_REJECTION_REASONS = [
  'GSM below specification',
  'Shade / colour mismatch',
  'Surface / cleanliness defect',
  'Moisture / physical damage',
  'Wrong grade / board mix',
  'Other (see remarks)',
] as const

export type GrnRejectionReason = (typeof GRN_REJECTION_REASONS)[number]
