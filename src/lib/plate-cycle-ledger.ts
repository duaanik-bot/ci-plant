import {
  hubChannelRowsFromLabels,
  plateColourCanonicalKey,
  stripPlateColourDisplaySuffix,
} from '@/lib/hub-plate-card-ui'

/** Normalise DB JSON to non-negative integer counts per star-ledger key (C, M, Y, K, P1…). */
export function normalizeCycleData(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k).trim()
    if (!key) continue
    out[key] = Math.max(0, Math.floor(Number(v) || 0))
  }
  return out
}

type ColourLike = { name?: string; status?: string; reuseCount?: number }

/** Legacy: derive ledger from per-row `reuseCount` in `colours` JSON (order-preserving). */
export function cycleDataFromColoursReuseJson(coloursJson: unknown): Record<string, number> {
  if (!Array.isArray(coloursJson)) return {}
  const activeRows: ColourLike[] = []
  for (const item of coloursJson) {
    if (!item || typeof item !== 'object') continue
    const st = String((item as ColourLike).status ?? '').toLowerCase()
    if (st === 'destroyed') continue
    const name = String((item as ColourLike).name ?? '').trim()
    if (!name) continue
    activeRows.push(item as ColourLike)
  }
  const names = activeRows.map((r) => String(r.name ?? '').trim())
  const rows = hubChannelRowsFromLabels(names)
  const out: Record<string, number> = {}
  for (let i = 0; i < rows.length; i++) {
    const short = rows[i]!.short
    const rc = Math.max(0, Math.floor(Number(activeRows[i]!.reuseCount) || 0))
    out[short] = (out[short] ?? 0) + rc
  }
  return out
}

/** Prefer persisted `cycleData`; if empty, fall back to legacy per-channel reuse counts. */
export function mergeEffectiveCycleData(args: {
  cycleData: unknown
  colours: unknown
}): Record<string, number> {
  const norm = normalizeCycleData(args.cycleData)
  if (Object.keys(norm).length > 0) return norm
  return cycleDataFromColoursReuseJson(args.colours)
}

/** Short label (C / M / P1…) for a colour name among the active set (canonical match). */
export function cycleShortKeyForLabelAmongActive(
  targetName: string,
  allActiveNames: string[],
): string | null {
  const tCanon = plateColourCanonicalKey(stripPlateColourDisplaySuffix(targetName))
  if (!tCanon) return null
  const rows = hubChannelRowsFromLabels(allActiveNames)
  for (let i = 0; i < allActiveNames.length; i++) {
    const nm = allActiveNames[i]!
    if (plateColourCanonicalKey(stripPlateColourDisplaySuffix(nm)) === tCanon) {
      return rows[i]?.short ?? null
    }
  }
  return null
}

/** Increment ledger by 1 for each returned channel (physical return / rack in). */
export function incrementCycleDataForReturns(
  current: Record<string, number>,
  allActiveColourNames: string[],
  returnedColourNames: string[],
): Record<string, number> {
  const next = { ...current }
  for (let i = 0; i < returnedColourNames.length; i++) {
    const ret = returnedColourNames[i]!.trim()
    if (!ret) continue
    const key = cycleShortKeyForLabelAmongActive(ret, allActiveColourNames)
    if (!key) continue
    next[key] = (next[key] ?? 0) + 1
  }
  return next
}

/** First custody→rack materialization: one usage per manufactured channel. */
export function initialCycleDataForChannelNames(channelNames: string[]): Record<string, number> {
  const rows = hubChannelRowsFromLabels(channelNames)
  const out: Record<string, number> = {}
  for (let i = 0; i < rows.length; i++) {
    const short = rows[i]!.short
    out[short] = (out[short] ?? 0) + 1
  }
  return out
}

/** Keep only ledger keys still present in the active colour list (order from labels). */
export function pruneCycleDataForActiveLabels(
  cycle: Record<string, number>,
  activeColourNames: string[],
): Record<string, number> {
  const rows = hubChannelRowsFromLabels(activeColourNames)
  const out: Record<string, number> = {}
  for (const r of rows) {
    out[r.short] = cycle[r.short] ?? 0
  }
  return out
}

function ledgerKeySortRank(k: string): number {
  if (k === 'C') return 1
  if (k === 'M') return 2
  if (k === 'Y') return 3
  if (k === 'K') return 4
  const m = /^P(\d+)$/.exec(k)
  if (m) return 100 + parseInt(m[1]!, 10)
  return 1000
}

export function sortLedgerKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => ledgerKeySortRank(a) - ledgerKeySortRank(b) || a.localeCompare(b))
}

/** `C(3), M(2), …` for audit / hub events (channels with at least one use only). */
export function formatLifetimePerformanceSummary(cycleData: Record<string, number>): string {
  const keys = sortLedgerKeys(Object.keys(cycleData).filter((k) => (cycleData[k] ?? 0) > 0))
  const parts: string[] = []
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!
    parts.push(`${k}(${cycleData[k] ?? 0})`)
  }
  return parts.join(', ')
}

/** Active `name` values in JSON array order (non-destroyed). */
export function activeColourNamesInOrder(coloursJson: unknown): string[] {
  if (!Array.isArray(coloursJson)) return []
  const out: string[] = []
  for (const item of coloursJson) {
    if (!item || typeof item !== 'object') continue
    const st = String((item as ColourLike).status ?? '').toLowerCase()
    if (st === 'destroyed') continue
    const name = String((item as ColourLike).name ?? '').trim()
    if (name) out.push(name)
  }
  return out
}
