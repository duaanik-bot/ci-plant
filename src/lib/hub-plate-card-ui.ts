/** Map plate hub colour label (from JSON / display) to dot palette for CSS. */
export type HubColourDot = {
  key: string
  bgClass: string
  ringClass: string
  title: string
}

const PANTONE_RING = 'ring-2 ring-red-500 ring-offset-1 ring-offset-black'

export function colourDotFromLabel(label: string, index: number): HubColourDot {
  const raw = label.toLowerCase()
  const title = label.trim() || `Colour ${index + 1}`
  if (raw.includes('pantone') || /^p\d/.test(raw.trim())) {
    return {
      key: `p-${index}`,
      bgClass: 'bg-rose-600',
      ringClass: PANTONE_RING,
      title,
    }
  }
  if (raw.includes('cyan') || raw === 'c' || raw.startsWith('c '))
    return { key: `c-${index}`, bgClass: 'bg-cyan-500', ringClass: '', title }
  if (raw.includes('magenta') || raw === 'm' || raw.startsWith('m '))
    return { key: `m-${index}`, bgClass: 'bg-fuchsia-600', ringClass: '', title }
  if (raw.includes('yellow') || raw === 'y' || raw.startsWith('y '))
    return { key: `y-${index}`, bgClass: 'bg-yellow-400', ringClass: '', title }
  if (raw.includes('black') || raw === 'k' || raw.includes('key'))
    return { key: `k-${index}`, bgClass: 'bg-zinc-900 border border-zinc-600', ringClass: '', title }
  return {
    key: `x-${index}`,
    bgClass: 'bg-zinc-600',
    ringClass: '',
    title,
  }
}

export function hubPlateBadgeCount(args: {
  totalPlates?: number | null
  numberOfColours?: number | null
  plateColours?: string[] | null
}): number {
  const a = args.totalPlates != null && args.totalPlates > 0 ? args.totalPlates : 0
  const b = args.numberOfColours != null && args.numberOfColours > 0 ? args.numberOfColours : 0
  const c = args.plateColours?.length ?? 0
  return Math.max(a, b, c, 0) || c || b || a || 0
}

type PlateColourRow = { name?: string; status?: string }

export function countPlatesInRack(coloursJson: unknown): number {
  if (!Array.isArray(coloursJson)) return 0
  return (coloursJson as PlateColourRow[]).filter((c) => {
    const st = String(c?.status ?? '').toLowerCase()
    return st !== 'destroyed'
  }).length
}
