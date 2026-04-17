import { Prisma } from '@prisma/client'

export type ParsedCartonDims = { l: number; w: number; h: number }

/** Options shown on Die Hub add / triage forms. */
export const DIE_HUB_PASTING_TYPES = [
  'Lock Bottom',
  'RTF',
  'Side Paste',
  'BSO',
  'Crash lock',
  'Straight line',
  'Window pasting',
  'Single wall',
  'Double wall',
  'None',
] as const

export function normalizeDieMake(v: string | null | undefined): 'local' | 'laser' {
  const s = (v ?? '').trim().toLowerCase()
  return s === 'laser' ? 'laser' : 'local'
}

export function parseCartonSizeToDims(input: string | null | undefined): ParsedCartonDims | null {
  if (!input?.trim()) return null
  const s = input.replace(/×/g, 'x').replace(/X/g, 'x')
  const m = s.match(
    /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i,
  )
  if (m) {
    const l = parseFloat(m[1])
    const w = parseFloat(m[2])
    const h = parseFloat(m[3])
    if ([l, w, h].every((n) => Number.isFinite(n))) return { l, w, h }
  }
  const parts = s
    .split(/[x,\s]+/i)
    .map((p) => p.trim())
    .filter(Boolean)
  const nums = parts
    .map((p) => parseFloat(p.replace(/[^\d.-]/g, '')))
    .filter((n) => Number.isFinite(n))
  if (nums.length >= 3) return { l: nums[0], w: nums[1], h: nums[2] }
  return null
}

export function prismaDimsFromParsed(
  p: ParsedCartonDims | null | undefined,
): {
  dimLengthMm: Prisma.Decimal
  dimWidthMm: Prisma.Decimal
  dimHeightMm: Prisma.Decimal
} | undefined {
  if (!p) return undefined
  return {
    dimLengthMm: new Prisma.Decimal(p.l),
    dimWidthMm: new Prisma.Decimal(p.w),
    dimHeightMm: new Prisma.Decimal(p.h),
  }
}

export function formatDimsLwhFromDb(d: {
  dimLengthMm: { toString(): string } | null | undefined
  dimWidthMm: { toString(): string } | null | undefined
  dimHeightMm: { toString(): string } | null | undefined
}): string | null {
  if (d.dimLengthMm == null || d.dimWidthMm == null || d.dimHeightMm == null) return null
  return `${d.dimLengthMm}×${d.dimWidthMm}×${d.dimHeightMm}`
}

export function formatDimsLwhFromParsed(p: ParsedCartonDims): string {
  return `${p.l}×${p.w}×${p.h}`
}

export type DieSimilarIndexEntry = {
  id: string
  dyeNumber: number
  location: string | null
  impressionCount: number
  reuseCount: number
}

export function buildDieSimilarityBuckets(
  rows: Array<{
    id: string
    dyeNumber: number
    dimLengthMm: unknown
    dimWidthMm: unknown
    dimHeightMm: unknown
    location: string | null
    impressionCount: number
    reuseCount: number
  }>,
): Map<string, DieSimilarIndexEntry[]> {
  const buckets = new Map<string, DieSimilarIndexEntry[]>()
  for (const r of rows) {
    if (r.dimLengthMm == null || r.dimWidthMm == null || r.dimHeightMm == null) continue
    const k = `${String(r.dimLengthMm)}|${String(r.dimWidthMm)}|${String(r.dimHeightMm)}`
    const ent: DieSimilarIndexEntry = {
      id: r.id,
      dyeNumber: r.dyeNumber,
      location: r.location,
      impressionCount: r.impressionCount,
      reuseCount: r.reuseCount,
    }
    const arr = buckets.get(k) ?? []
    arr.push(ent)
    buckets.set(k, arr)
  }
  return buckets
}

export function similarDiesForRow(
  id: string,
  dimLengthMm: unknown,
  dimWidthMm: unknown,
  dimHeightMm: unknown,
  buckets: Map<string, DieSimilarIndexEntry[]>,
): DieSimilarIndexEntry[] {
  if (dimLengthMm == null || dimWidthMm == null || dimHeightMm == null) return []
  const k = `${String(dimLengthMm)}|${String(dimWidthMm)}|${String(dimHeightMm)}`
  return (buckets.get(k) ?? []).filter((e) => e.id !== id)
}

/** L×W×H for matching triage ↔ rack (DB mm or parsed carton text). */
export type DimTriple = { l: number; w: number; h: number }

export function tripleFromDyeRow(d: {
  dimLengthMm: unknown
  dimWidthMm: unknown
  dimHeightMm: unknown
  cartonSize: string
}): DimTriple | null {
  if (d.dimLengthMm != null && d.dimWidthMm != null && d.dimHeightMm != null) {
    const l = Number(d.dimLengthMm)
    const w = Number(d.dimWidthMm)
    const h = Number(d.dimHeightMm)
    if ([l, w, h].every((n) => Number.isFinite(n))) return { l, w, h }
  }
  return parseCartonSizeToDims(d.cartonSize)
}

export function dimTriplesEqual(a: DimTriple | null, b: DimTriple | null): boolean {
  if (!a || !b) return false
  const eps = 1e-4
  return (
    Math.abs(a.l - b.l) < eps &&
    Math.abs(a.w - b.w) < eps &&
    Math.abs(a.h - b.h) < eps
  )
}
