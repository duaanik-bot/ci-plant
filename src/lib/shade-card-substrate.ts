export const SHADE_SUBSTRATE_VALUES = ['FBB', 'SBS', 'GREY_BACK', 'KRAFT'] as const
export type ShadeSubstrateType = (typeof SHADE_SUBSTRATE_VALUES)[number]

export function shadeSubstrateLabel(v: string | null | undefined): string {
  const s = (v ?? '').trim().toUpperCase()
  if (s === 'GREY_BACK' || s === 'GREY-BACK') return 'Grey-Back'
  if (s === 'FBB') return 'FBB'
  if (s === 'SBS') return 'SBS'
  if (s === 'KRAFT') return 'Kraft'
  return v?.trim() || '—'
}
