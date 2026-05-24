/**
 * Pure gang/batch mix-set compatibility checker.
 * No I/O — fully unit-testable.
 */

export type GangCompatLine = {
  id: string
  boardType: string | null
  gsm: number | null
  coating: string | null
  printSide: string | null
  sheetSize: string | null
  deliveryDays: number | null
  press: string | null
}

export type GangConflict = { field: string; values: string[] }

export type GangCompatResult = {
  ok: boolean
  conflicts: GangConflict[] // hard — must block
  warnings: GangConflict[]  // soft — allow but surface
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()

export function checkGangCompat(
  lines: GangCompatLine[],
  opts?: { gsmTolerance?: number; deliveryBucketDays?: number },
): GangCompatResult {
  const conflicts: GangConflict[] = []
  const warnings: GangConflict[] = []
  if (lines.length <= 1) return { ok: true, conflicts, warnings }

  const gsmTol = opts?.gsmTolerance ?? 10
  const bucket = opts?.deliveryBucketDays ?? 7

  const uniq = (vals: (string | null | undefined)[]) =>
    Array.from(new Set(vals.map(norm).filter((v) => v !== '')))

  // HARD conflicts
  const boards = uniq(lines.map((l) => l.boardType))
  if (boards.length > 1) conflicts.push({ field: 'boardType', values: boards })

  const coatings = uniq(lines.map((l) => l.coating))
  if (coatings.length > 1) conflicts.push({ field: 'coating', values: coatings })

  const sides = uniq(lines.map((l) => l.printSide))
  if (sides.length > 1) conflicts.push({ field: 'printSide', values: sides })

  // GSM hard conflict if spread beyond tolerance
  const gsms = lines.map((l) => l.gsm).filter((g): g is number => g != null)
  if (gsms.length > 1 && Math.max(...gsms) - Math.min(...gsms) > gsmTol) {
    conflicts.push({ field: 'gsm', values: Array.from(new Set(gsms.map(String))) })
  }

  // SOFT warnings
  const sizes = uniq(lines.map((l) => l.sheetSize))
  if (sizes.length > 1) warnings.push({ field: 'sheetSize', values: sizes })

  const presses = uniq(lines.map((l) => l.press))
  if (presses.length > 1) warnings.push({ field: 'press', values: presses })

  const dd = lines.map((l) => l.deliveryDays).filter((d): d is number => d != null)
  if (dd.length > 1 && Math.max(...dd) - Math.min(...dd) > bucket) {
    warnings.push({ field: 'deliveryTimeline', values: Array.from(new Set(dd.map(String))) })
  }

  return { ok: conflicts.length === 0, conflicts, warnings }
}
