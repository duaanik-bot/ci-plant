/** Map plate hub colour label (from JSON / display) to dot palette for CSS. */
export type HubColourDot = {
  key: string
  bgClass: string
  ringClass: string
  title: string
}

/** Strip designer / hub display suffixes so dots match master channel names. */
export function stripPlateColourDisplaySuffix(s: string): string {
  return s.replace(/\s*\((new|existing)\)\s*$/i, '').trim()
}

export function colourDotFromLabel(label: string, index: number): HubColourDot {
  const raw = label.toLowerCase()
  const title = label.trim() || `Colour ${index + 1}`
  if (raw.includes('pantone') || /^p\d/.test(raw.trim())) {
    return {
      key: `p-${index}`,
      bgClass: 'bg-white',
      ringClass: 'ring-2 ring-amber-500 ring-offset-1 ring-offset-black border border-zinc-500',
      title,
    }
  }
  if (raw.includes('cyan') || raw === 'c' || raw.startsWith('c '))
    return { key: `c-${index}`, bgClass: 'bg-cyan-500', ringClass: '', title }
  if (raw.includes('magenta') || raw === 'm' || raw.startsWith('m '))
    return { key: `m-${index}`, bgClass: 'bg-pink-500', ringClass: '', title }
  if (raw.includes('yellow') || raw === 'y' || raw.startsWith('y '))
    return { key: `y-${index}`, bgClass: 'bg-yellow-400', ringClass: '', title }
  if (raw.includes('black') || raw === 'k' || raw.includes('key'))
    return { key: `k-${index}`, bgClass: 'bg-gray-900 border border-gray-600', ringClass: '', title }
  return {
    key: `x-${index}`,
    bgClass: 'bg-zinc-600',
    ringClass: '',
    title,
  }
}

export type HubColourChannelRow = {
  key: string
  dot: HubColourDot
  short: string
  label: string
}

/** One row per plate channel with CMYK / P1-style short tags for hub cards. */
export function hubChannelRowsFromLabels(labels: string[]): HubColourChannelRow[] {
  let pIdx = 0
  return labels.map((raw, i) => {
    const label = stripPlateColourDisplaySuffix(raw)
    const dot = colourDotFromLabel(label, i)
    const low = label.toLowerCase().trim()
    let short: string
    if (low.includes('pantone') || /^p\d/.test(label.trim())) {
      pIdx += 1
      short = `P${pIdx}`
    } else if (low.includes('cyan') || low === 'c' || low.startsWith('c ')) short = 'C'
    else if (low.includes('magenta') || low === 'm' || low.startsWith('m ')) short = 'M'
    else if (low.includes('yellow') || low === 'y' || low.startsWith('y ')) short = 'Y'
    else if (low.includes('black') || low === 'k' || low.includes('key')) short = 'K'
    else short = label.length <= 4 ? label : `${label.slice(0, 3)}…`
    return { key: `${i}-${short}-${label}`, dot, short, label }
  })
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

/** Active plates in rack (after partial scrap); falls back to nominal counts. */
export function hubLivePlateBadgeCount(args: {
  platesInRackCount?: number | null
  totalPlates?: number | null
  numberOfColours?: number | null
  plateColours?: string[] | null
}): number {
  if (args.platesInRackCount != null && args.platesInRackCount >= 0) {
    return Math.min(99, args.platesInRackCount)
  }
  return hubPlateBadgeCount(args)
}

type PlateColourRow = { name?: string; status?: string }

export function countPlatesInRack(coloursJson: unknown): number {
  if (!Array.isArray(coloursJson)) return 0
  return (coloursJson as PlateColourRow[]).filter((c) => {
    const st = String(c?.status ?? '').toLowerCase()
    return st !== 'destroyed'
  }).length
}
