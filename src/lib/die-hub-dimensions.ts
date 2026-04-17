import { Prisma } from '@prisma/client'
import { masterDieTypeLabel, normalizeDieTypeKey } from '@/lib/master-die-type'

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
    dyeType: string
    dimLengthMm: unknown
    dimWidthMm: unknown
    dimHeightMm: unknown
    pastingType: string | null
    location: string | null
    impressionCount: number
    reuseCount: number
  }>,
): Map<string, DieSimilarIndexEntry[]> {
  const buckets = new Map<string, DieSimilarIndexEntry[]>()
  for (const r of rows) {
    if (r.dimLengthMm == null || r.dimWidthMm == null || r.dimHeightMm == null) continue
    const typeKey = normalizeDieTypeKey(
      masterDieTypeLabel({ dyeType: r.dyeType, pastingType: r.pastingType }),
    )
    const k = `${String(r.dimLengthMm)}|${String(r.dimWidthMm)}|${String(r.dimHeightMm)}|${typeKey}`
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
  dyeType: string,
  pastingType: string | null | undefined,
  buckets: Map<string, DieSimilarIndexEntry[]>,
): DieSimilarIndexEntry[] {
  if (dimLengthMm == null || dimWidthMm == null || dimHeightMm == null) return []
  const typeKey = normalizeDieTypeKey(
    masterDieTypeLabel({ dyeType, pastingType: pastingType ?? null }),
  )
  const k = `${String(dimLengthMm)}|${String(dimWidthMm)}|${String(dimHeightMm)}|${typeKey}`
  return (buckets.get(k) ?? []).filter((e) => e.id !== id)
}

/** Bucket by L×W×H only — used to detect same-size dies with different master types. */
export type DieDimBucketEntry = DieSimilarIndexEntry & { typeKey: string; typeLabel: string }

export function buildDieDimensionOnlyBuckets(
  rows: Array<{
    id: string
    dyeNumber: number
    dyeType: string
    dimLengthMm: unknown
    dimWidthMm: unknown
    dimHeightMm: unknown
    pastingType: string | null
    location: string | null
    impressionCount: number
    reuseCount: number
  }>,
): Map<string, DieDimBucketEntry[]> {
  const buckets = new Map<string, DieDimBucketEntry[]>()
  for (const r of rows) {
    if (r.dimLengthMm == null || r.dimWidthMm == null || r.dimHeightMm == null) continue
    const typeLabel = masterDieTypeLabel({ dyeType: r.dyeType, pastingType: r.pastingType })
    const typeKey = normalizeDieTypeKey(typeLabel)
    const k = `${String(r.dimLengthMm)}|${String(r.dimWidthMm)}|${String(r.dimHeightMm)}`
    const ent: DieDimBucketEntry = {
      id: r.id,
      dyeNumber: r.dyeNumber,
      location: r.location,
      impressionCount: r.impressionCount,
      reuseCount: r.reuseCount,
      typeKey,
      typeLabel,
    }
    const arr = buckets.get(k) ?? []
    arr.push(ent)
    buckets.set(k, arr)
  }
  return buckets
}

/** Same L×W×H as this row, but different die type — wrong tool if treated as “similar”. */
export function typeMismatchDiesForRow(
  id: string,
  dimLengthMm: unknown,
  dimWidthMm: unknown,
  dimHeightMm: unknown,
  dyeType: string,
  pastingType: string | null | undefined,
  dimBuckets: Map<string, DieDimBucketEntry[]>,
): DieDimBucketEntry[] {
  if (dimLengthMm == null || dimWidthMm == null || dimHeightMm == null) return []
  const myKey = normalizeDieTypeKey(
    masterDieTypeLabel({ dyeType, pastingType: pastingType ?? null }),
  )
  const k = `${String(dimLengthMm)}|${String(dimWidthMm)}|${String(dimHeightMm)}`
  const list = dimBuckets.get(k) ?? []
  return list.filter((e) => e.id !== id && e.typeKey !== myKey)
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
