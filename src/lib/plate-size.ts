/**
 * Canonical plate sheet sizes for Plate Hub / future press planning.
 * DB stores exactly `SIZE_560_670` | `SIZE_630_700` — no spaces or alternate spellings.
 */
export const HUB_PLATE_SIZE_VALUES = ['SIZE_560_670', 'SIZE_630_700'] as const
export type HubPlateSize = (typeof HUB_PLATE_SIZE_VALUES)[number]

export const HUB_PLATE_SIZE_OPTIONS: {
  value: HubPlateSize
  /** Segmented control */
  label: string
  /** Card line: `Size: …` */
  mm: string
}[] = [
  { value: 'SIZE_560_670', label: '560×670 mm', mm: '560x670 mm' },
  { value: 'SIZE_630_700', label: '630×700 mm', mm: '630x700 mm' },
]

/** Single-line hub card text, e.g. `Size: 560x670 mm` */
export function hubPlateSizeCardLine(size: HubPlateSize | null | undefined): string | null {
  if (!size) return null
  const row = HUB_PLATE_SIZE_OPTIONS.find((o) => o.value === size)
  const mm = row?.mm ?? (size === 'SIZE_560_670' ? '560x670 mm' : '630x700 mm')
  return `Size: ${mm}`
}
