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

/**
 * Stable key for matching colours across `plate_requirements.colours_needed`,
 * `plate_store.colours[].name`, and hub UI (e.g. `C` vs `Cyan`, `M` vs `Magenta`).
 * Pantones / spot colours use `spot:<normalized>` so "Pantone 185" stays distinct.
 */
export function plateColourCanonicalKey(raw: string): string {
  const s = stripPlateColourDisplaySuffix(raw).trim()
  if (!s) return ''
  const low = s.toLowerCase()
  if (low.includes('pantone') || /^p\d/.test(low.trim())) {
    return `spot:${low.replace(/\s+/g, ' ')}`
  }
  if (low === 'c' || low === 'cyan' || low.startsWith('c ') || low.includes('cyan')) {
    return 'cmyk:c'
  }
  if (low === 'm' || low === 'magenta' || low.startsWith('m ') || low.includes('magenta')) {
    return 'cmyk:m'
  }
  if (
    low === 'y' ||
    low === 'yellow' ||
    low.startsWith('y ') ||
    (low.includes('yellow') && !low.includes('pantone'))
  ) {
    return 'cmyk:y'
  }
  if (low === 'k' || low.includes('black') || low.includes('key')) {
    return 'cmyk:k'
  }
  return `other:${low.replace(/\s+/g, ' ')}`
}

export function colourDotFromLabel(label: string, index: number): HubColourDot {
  const raw = label.toLowerCase()
  const title = label.trim() || `Colour ${index + 1}`
  if (raw.includes('pantone') || /^p\d/.test(raw.trim())) {
    return {
      key: `p-${index}`,
      bgClass: 'bg-white',
      ringClass: 'ring-2 ring-ds-warning ring-offset-1 ring-offset-black border border-ds-line/50',
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
    bgClass: 'bg-ds-line/40',
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
/** Visual channel bucket for Plate Hub CMYK + spot swatches (not the same as canonical keys). */
export type PlateHubSwatchKind =
  | 'cyan'
  | 'magenta'
  | 'yellow'
  | 'black'
  | 'spotOrange'
  | 'spotPurple'
  | 'other'

/** Map hub `short` + label to a high-contrast swatch kind (P1/P2 alternate spot colours). */
export function plateHubSwatchKind(short: string, label: string): PlateHubSwatchKind {
  const s = String(short ?? '').trim().toUpperCase()
  const low = String(label ?? '').toLowerCase().trim()
  if (s === 'C') return 'cyan'
  if (s === 'M') return 'magenta'
  if (s === 'Y') return 'yellow'
  if (s === 'K') return 'black'
  const pNum = /^P(\d+)$/.exec(s)
  if (pNum) {
    const n = parseInt(pNum[1]!, 10)
    return n % 2 === 1 ? 'spotOrange' : 'spotPurple'
  }
  if (low.includes('pantone') || /^p\d/.test(low)) {
    return low.length % 2 === 0 ? 'spotOrange' : 'spotPurple'
  }
  if (s === 'S' || low.includes('special') || low.includes('spot colour')) return 'spotOrange'
  return 'other'
}

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

/** Colour JSON rows that are not scrapped/destroyed — use for hub display + counts. */
export function activeColourRowsFromJson(json: unknown): unknown[] {
  if (!Array.isArray(json)) return []
  return json.filter((item) => {
    if (!item || typeof item !== 'object') return false
    const st = String((item as PlateColourRow).status ?? '').toLowerCase()
    return st !== 'destroyed'
  })
}

export function countPlatesInRack(coloursJson: unknown): number {
  if (!Array.isArray(coloursJson)) return 0
  return (coloursJson as PlateColourRow[]).filter((c) => {
    const st = String(c?.status ?? '').toLowerCase()
    return st !== 'destroyed'
  }).length
}

type ColourRowReuse = PlateColourRow & { reuseCount?: number }

/** Max reuse cycles among active channels (per-colour JSON `reuseCount`). */
export function hubReuseCyclesFromColoursJson(coloursJson: unknown): {
  max: number
  byName: Record<string, number>
} {
  if (!Array.isArray(coloursJson)) return { max: 0, byName: {} }
  let max = 0
  const byName: Record<string, number> = {}
  for (const item of coloursJson as ColourRowReuse[]) {
    const st = String(item?.status ?? '').toLowerCase()
    if (st === 'destroyed') continue
    const name = String(item?.name ?? '').trim()
    if (!name) continue
    const n = Math.max(0, Math.floor(Number(item.reuseCount) || 0))
    byName[name] = n
    if (n > max) max = n
  }
  return { max, byName }
}
