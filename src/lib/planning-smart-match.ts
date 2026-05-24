export type GangLine = {
  id: string
  quantity: number
  ups: number
  sheetSize: string | null
  gsm: number | null
  boardType: string | null
  coating: string | null
  printSide: string | null
  deliveryDays: number | null
  yieldPct: number
  poRef?: string
}

export type GangConfig = {
  gsmTolerance?: number
  weights?: { size: number; waste: number; urgency: number; tool: number }
}

export type GangSuggestion = {
  label: string
  tier: 'High' | 'Medium' | 'Low'
  composite: number
  sizeScore: number
  wasteScore: number
  urgencyScore: number
  toolScore: number
  poRefs: string[]
  linesIncluded: number
  totalPcs: number
  avgYieldPct: number
  totalSheets: number
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()

function computeSizeScore(a: string | null, b: string | null): number {
  if (!a || !b) return 0
  return norm(a) === norm(b) ? 100 : 40
}

export function scoreGangSuggestions(
  anchor: GangLine,
  candidates: GangLine[],
  config: GangConfig,
): GangSuggestion[] {
  const gsmTol = config.gsmTolerance ?? 10
  const w = config.weights ?? { size: 0.35, waste: 0.3, urgency: 0.2, tool: 0.15 }

  const scored = candidates
    .map((c) => {
      const size = computeSizeScore(anchor.sheetSize, c.sheetSize)
      const gsmOk = anchor.gsm != null && c.gsm != null && Math.abs(anchor.gsm - c.gsm) <= gsmTol
      const boardOk = norm(anchor.boardType) === norm(c.boardType)
      const coatOk = norm(anchor.coating) === norm(c.coating)
      const sideOk = norm(anchor.printSide) === norm(c.printSide)
      // tool score: partial points per matched dimension
      const tool = (boardOk ? 40 : 0) + (gsmOk ? 25 : 0) + (coatOk ? 20 : 0) + (sideOk ? 15 : 0)
      const waste = Math.max(0, Math.min(100, (anchor.yieldPct + c.yieldPct) / 2))
      const dd = c.deliveryDays ?? 999
      const urgency = dd <= 7 ? 100 : dd <= 14 ? 70 : dd <= 30 ? 40 : 10
      const composite = size * w.size + waste * w.waste + urgency * w.urgency + tool * w.tool
      const totalPcs = anchor.quantity + c.quantity
      const avgYieldPct = (anchor.yieldPct + c.yieldPct) / 2
      const totalSheets =
        Math.ceil(anchor.quantity / Math.max(1, anchor.ups)) +
        Math.ceil(c.quantity / Math.max(1, c.ups))
      return { c, size, waste, urgency, tool, composite, totalPcs, avgYieldPct, totalSheets }
    })
    // drop candidates with zero tool compatibility (no shared board/gsm/coating/side)
    .filter((s) => s.tool > 0)
    .sort((a, b) => b.composite - a.composite)
    .slice(0, 5)

  return scored.map((s, i) => ({
    label: `#${i + 1}`,
    tier: s.composite >= 75 ? 'High' : s.composite >= 50 ? 'Medium' : 'Low',
    composite: Number(s.composite.toFixed(1)),
    sizeScore: Math.round(s.size),
    wasteScore: Math.round(s.waste),
    urgencyScore: Math.round(s.urgency),
    toolScore: Math.round(s.tool),
    poRefs: [s.c.poRef].filter(Boolean) as string[],
    linesIncluded: 2,
    totalPcs: s.totalPcs,
    avgYieldPct: Number(s.avgYieldPct.toFixed(1)),
    totalSheets: s.totalSheets,
  }))
}
