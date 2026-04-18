import { addHours } from 'date-fns'

/** Press capability — extend via DB later; keyed by machine code prefix. */
export type PressPhysics = {
  maxColours: number
  bedLengthMm: number
  bedWidthMm: number
}

const DEFAULT_PHYSICS: PressPhysics = {
  maxColours: 6,
  bedLengthMm: 1020,
  bedWidthMm: 720,
}

export function pressPhysicsForMachine(machineCode: string, specification?: string | null): PressPhysics {
  const code = machineCode.toUpperCase()
  const spec = (specification ?? '').toLowerCase()
  if (/six|6\s*col|6c/i.test(spec) || /-06|-6\b/.test(code)) {
    return { maxColours: 6, bedLengthMm: 1020, bedWidthMm: 760 }
  }
  if (/large|xl|b1/i.test(spec)) {
    return { maxColours: 6, bedLengthMm: 1200, bedWidthMm: 820 }
  }
  if (/ci-0[12]\b/.test(code) || /01|02/.test(code)) {
    return { maxColours: 6, bedLengthMm: 1020, bedWidthMm: 760 }
  }
  return DEFAULT_PHYSICS
}

export function sheetsEstimateForLine(args: {
  quantity: number
  materialQueueTotalSheets: number | null
}): number {
  if (args.materialQueueTotalSheets != null && args.materialQueueTotalSheets > 0) {
    return args.materialQueueTotalSheets
  }
  return Math.max(1, Math.ceil(args.quantity / 4))
}

/** Run hours = sheets / (sheets per hour) + setup. */
export function computeJobRunHours(args: {
  sheets: number
  capacityPerShift: number
  setupHours?: number
}): number {
  const perHour = Math.max(1, args.capacityPerShift) / 8
  const run = args.sheets / perHour
  const setup = args.setupHours ?? 0.75
  return run + setup
}

export function formatDurationHMM(totalHours: number): string {
  if (!Number.isFinite(totalHours) || totalHours < 0) return '00h 00m'
  const h = Math.floor(totalHours)
  const m = Math.round((totalHours - h) * 60) % 60
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`
}

export function sheetFitsBed(args: {
  lengthMm: number | null | undefined
  widthMm: number | null | undefined
  bedL: number
  bedW: number
}): boolean {
  const l = Number(args.lengthMm)
  const w = Number(args.widthMm)
  if (!Number.isFinite(l) || !Number.isFinite(w) || l <= 0 || w <= 0) return true
  const a = Math.max(l, w)
  const b = Math.min(l, w)
  const bedA = Math.max(args.bedL, args.bedW)
  const bedB = Math.min(args.bedL, args.bedW)
  return a <= bedA && b <= bedB
}

export function smartMachineForLine(args: {
  machineCode: string
  specification: string | null | undefined
  capacityPerShift: number
  colours: number | null | undefined
  sheetLengthMm: number | null | undefined
  sheetWidthMm: number | null | undefined
}): { score: number; physics: PressPhysics; fitsBed: boolean; fitsColours: boolean } {
  const physics = pressPhysicsForMachine(args.machineCode, args.specification)
  const n = args.colours ?? 4
  const fitsColours = n <= physics.maxColours
  const fitsBed = sheetFitsBed({
    lengthMm: args.sheetLengthMm,
    widthMm: args.sheetWidthMm,
    bedL: physics.bedLengthMm,
    bedW: physics.bedWidthMm,
  })
  let score = 100
  if (!fitsColours) score -= 40
  if (!fitsBed) score -= 40
  score += Math.min(args.capacityPerShift, 8000) / 200
  return { score, physics, fitsBed, fitsColours }
}

export function pickBestMachineId(
  machines: {
    id: string
    machineCode: string
    specification?: string | null
    capacityPerShift: number
  }[],
  args: {
    colours: number | null | undefined
    sheetLengthMm: number | null | undefined
    sheetWidthMm: number | null | undefined
    /** Prefer machine with lower scheduled hours in horizon. */
    scheduledHoursByMachineId: Record<string, number>
  },
): { id: string; machineCode: string } | null {
  if (!machines.length) return null
  let best: { id: string; machineCode: string; score: number } | null = null
  for (const m of machines) {
    const { score, fitsBed, fitsColours } = smartMachineForLine({
      machineCode: m.machineCode,
      specification: m.specification ?? null,
      capacityPerShift: m.capacityPerShift,
      colours: args.colours,
      sheetLengthMm: args.sheetLengthMm,
      sheetWidthMm: args.sheetWidthMm,
    })
    const load = args.scheduledHoursByMachineId[m.id] ?? 0
    const loadPenalty = load * 0.02
    const s = score - loadPenalty + (fitsBed && fitsColours ? 10 : 0)
    if (!best || s > best.score) {
      best = { id: m.id, machineCode: m.machineCode, score: s }
    }
  }
  return best ? { id: best.id, machineCode: best.machineCode } : null
}

export type BlockerCategory = 'plates' | 'dies' | 'emboss' | 'shade_cards' | 'paper' | 'artwork'

export type BlockerAggregate = {
  key: BlockerCategory
  label: string
  count: number
  lineIds: string[]
}

export function aggregatePlanningBlockers<
  L extends {
    id: string
    planningLedger?: {
      toolingInterlock: { segments: { key: string; ok: boolean }[] }
      materialGate: { status: string }
      readinessFive?: {
        segments: { key: string; state: string }[]
        allGreen: boolean
      }
    } | null
    specOverrides?: { artworkLocksCompleted?: number; platesStatus?: string } | null
    readiness?: { artworkLocksCompleted?: number; platesStatus?: string } | null
  },
>(lines: L[]): BlockerAggregate[] {
  const map: Record<BlockerCategory, { count: number; lineIds: Set<string> }> = {
    plates: { count: 0, lineIds: new Set() },
    dies: { count: 0, lineIds: new Set() },
    emboss: { count: 0, lineIds: new Set() },
    shade_cards: { count: 0, lineIds: new Set() },
    paper: { count: 0, lineIds: new Set() },
    artwork: { count: 0, lineIds: new Set() },
  }

  for (const line of lines) {
    const ledger = line.planningLedger
    const five = ledger?.readinessFive
    if (five?.segments?.length) {
      for (const seg of five.segments) {
        if (seg.state === 'ready') continue
        if (seg.state === 'neutral' && seg.key === 'eb') continue
        if (seg.key === 'aw') {
          map.artwork.lineIds.add(line.id)
        } else if (seg.key === 'pa') {
          map.paper.lineIds.add(line.id)
        } else if (seg.key === 'di') {
          map.dies.lineIds.add(line.id)
        } else if (seg.key === 'eb') {
          map.emboss.lineIds.add(line.id)
        } else if (seg.key === 'sc') {
          map.shade_cards.lineIds.add(line.id)
        }
      }
      const platesSt = String(
        line.specOverrides?.platesStatus ?? line.readiness?.platesStatus ?? 'new_required',
      )
      if (platesSt !== 'available') {
        map.plates.lineIds.add(line.id)
      }
      continue
    }

    const locks = Number(
      line.specOverrides?.artworkLocksCompleted ?? line.readiness?.artworkLocksCompleted ?? 0,
    )
    if (locks < 2) {
      map.artwork.lineIds.add(line.id)
    }

    if (!ledger) continue

    if (ledger.materialGate.status === 'shortage') {
      map.paper.lineIds.add(line.id)
    }

    for (const seg of ledger.toolingInterlock.segments) {
      if (seg.ok) continue
      if (seg.key === 'pl') {
        map.plates.lineIds.add(line.id)
      } else if (seg.key === 'di') {
        map.dies.lineIds.add(line.id)
      } else if (seg.key === 'eb') {
        map.emboss.lineIds.add(line.id)
      } else if (seg.key === 'sc') {
        map.shade_cards.lineIds.add(line.id)
      }
    }
  }

  for (const k of Object.keys(map) as BlockerCategory[]) {
    map[k].count = map[k].lineIds.size
  }

  const labels: Record<BlockerCategory, string> = {
    plates: 'Plates',
    dies: 'Dies',
    emboss: 'Emboss blocks',
    shade_cards: 'Shade cards',
    paper: 'Paper / board',
    artwork: 'Artwork & plates',
  }

  return (Object.keys(map) as BlockerCategory[])
    .map((key) => ({
      key,
      label: labels[key],
      count: map[key].count,
      lineIds: Array.from(map[key].lineIds),
    }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
}

export function computeLaneFinishes(args: {
  orderedLineIds: string[]
  lineById: Map<
    string,
    {
      quantity: number
      materialQueue?: { totalSheets: number } | null
    }
  >
  capacityPerShift: number
  start?: Date
}): { finishByLineId: Record<string, string>; cumulativeHours: number } {
  const start = args.start ?? new Date()
  let t = start
  const finishByLineId: Record<string, string> = {}
  let cumulative = 0
  for (const id of args.orderedLineIds) {
    const line = args.lineById.get(id)
    const sheets = line
      ? sheetsEstimateForLine({
          quantity: line.quantity,
          materialQueueTotalSheets: line.materialQueue?.totalSheets ?? null,
        })
      : 1
    const hrs = computeJobRunHours({ sheets, capacityPerShift: args.capacityPerShift })
    cumulative += hrs
    t = addHours(t, hrs)
    finishByLineId[id] = t.toISOString()
  }
  return { finishByLineId, cumulativeHours: cumulative }
}

export function computeMachineLoadPct(args: {
  scheduledHours: number
  horizonHours?: number
}): number {
  const cap = args.horizonHours ?? 7 * 24
  if (cap <= 0) return 0
  return Math.min(100, Math.round((args.scheduledHours / cap) * 1000) / 10)
}

export function priorityRippleForLane(args: {
  orderedLineIds: string[]
  priorityLineIds: Set<string>
  hoursByLineId: Record<string, number>
}): Record<string, { delayedJobs: number; delayedHours: number }> {
  const out: Record<string, { delayedJobs: number; delayedHours: number }> = {}
  const { orderedLineIds, priorityLineIds, hoursByLineId } = args
  for (let i = 0; i < orderedLineIds.length; i++) {
    const id = orderedLineIds[i]
    if (!priorityLineIds.has(id)) continue
    let delayedJobs = 0
    let delayedHours = 0
    for (let j = i + 1; j < orderedLineIds.length; j++) {
      delayedJobs += 1
      delayedHours += hoursByLineId[orderedLineIds[j]] ?? 0
    }
    out[id] = { delayedJobs, delayedHours }
  }
  return out
}
