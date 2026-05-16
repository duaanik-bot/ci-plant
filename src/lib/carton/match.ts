export function levenshtein(a: string, b: string): number {
  a = a.toLowerCase()
  b = b.toLowerCase()
  const m = a.length
  const k = b.length
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [
    i,
    ...Array(k).fill(0),
  ])
  for (let j = 0; j <= k; j++) d[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= k; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
  return d[m][k]
}

export function nameSimilarity(a: string, b: string): number {
  if (!a && !b) return 1
  const dist = levenshtein(a, b)
  const maxLen = Math.max(a.length, b.length) || 1
  return Math.max(0, 1 - dist / maxLen)
}

type Dims = { l: number | null; w: number | null; h: number | null }

export function dimensionMatch(
  target: Dims,
  candidate: Dims,
  tolMm: number,
): 'exact' | 'rotated' | 'none' {
  const within = (a: number | null, b: number | null) =>
    a != null && b != null && Math.abs(a - b) <= tolMm
  if (
    within(target.l, candidate.l) &&
    within(target.w, candidate.w) &&
    within(target.h, candidate.h)
  )
    return 'exact'
  if (
    within(target.l, candidate.w) &&
    within(target.w, candidate.l) &&
    within(target.h, candidate.h)
  )
    return 'rotated'
  return 'none'
}

export function scoreSuggestion(p: {
  clientMatch: boolean
  nameSim: number
  dimWithinTol: boolean
  specMatch: number
}): number {
  const score =
    (p.clientMatch ? 30 : 0) +
    p.nameSim * 25 +
    (p.dimWithinTol ? 25 : 0) +
    p.specMatch * 20
  return Math.round(Math.min(100, Math.max(0, score)))
}
