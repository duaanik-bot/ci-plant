import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalize(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function compact(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function attributeValues(attributes: string | null): string[] {
  if (!attributes) return []
  try {
    const parsed = JSON.parse(attributes) as Record<string, unknown>
    return Object.values(parsed)
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      .map(String)
  } catch {
    return [attributes]
  }
}

function searchableText(material: {
  materialCode: string
  description: string
  boardType: string | null
  boardClassification: string | null
  gsm: number | null
  sheetLength: unknown
  sheetWidth: unknown
  storageLocation: string | null
  category: string
  attributes: string | null
  supplier?: { name: string } | null
}) {
  const boardType = normalizeBoardTypeForStorage(material.boardType)
  const boardClassification = normalizeBoardTypeForStorage(material.boardClassification)
  const length = toNumber(material.sheetLength)
  const width = toNumber(material.sheetWidth)
  return [
    material.materialCode,
    material.description,
    boardType,
    boardClassification,
    material.gsm == null ? null : `${material.gsm} gsm`,
    length && width ? `${length}x${width}` : null,
    length && width ? `${length} ${width}` : null,
    material.storageLocation,
    material.category,
    material.supplier?.name,
    ...attributeValues(material.attributes),
  ]
    .filter(Boolean)
    .join(' ')
}

function fuzzyContains(haystack: string, needle: string) {
  if (!needle) return true
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return false
}

function scoreMaterial(material: ReturnType<typeof toDto>, query: string) {
  const q = normalize(query)
  const qCompact = compact(query)
  const code = normalize(material.materialCode)
  const description = normalize(material.description)
  const search = normalize(material.searchText)
  let score = 100
  if (code === q) score -= 70
  else if (code.startsWith(q)) score -= 55
  else if (code.includes(q)) score -= 40
  if (description.startsWith(q)) score -= 25
  else if (description.includes(q)) score -= 12
  if (search.includes(q)) score -= 10
  if (qCompact && compact(material.searchText).includes(qCompact)) score -= 6
  return score
}

function toDto(material: {
  id: string
  materialCode: string
  description: string
  unit: string
  boardType: string | null
  boardClassification: string | null
  gsm: number | null
  sheetLength: unknown
  sheetWidth: unknown
  grainDirection?: string | null
  caliperMicrons?: number | null
  qtyAvailable: unknown
  qtyQuarantine: unknown
  qtyReserved: unknown
  qtyFg: unknown
  weightedAvgCost: unknown
  supplierId: string | null
  storageLocation: string | null
  category: string
  attributes: string | null
  active: boolean
  supplier?: { id: string; name: string } | null
}) {
  const searchText = searchableText(material)
  const boardType = normalizeBoardTypeForStorage(material.boardType)
  const boardClassification = normalizeBoardTypeForStorage(material.boardClassification)
  return {
    id: material.id,
    materialCode: material.materialCode,
    description: material.description,
    unit: material.unit,
    boardType,
    boardClassification,
    gsm: material.gsm,
    sheetLength: toNumber(material.sheetLength),
    sheetWidth: toNumber(material.sheetWidth),
    grainDirection: material.grainDirection ?? null,
    caliperMicrons: material.caliperMicrons ?? null,
    qtyAvailable: toNumber(material.qtyAvailable) ?? 0,
    qtyQuarantine: toNumber(material.qtyQuarantine) ?? 0,
    qtyReserved: toNumber(material.qtyReserved) ?? 0,
    qtyFg: toNumber(material.qtyFg) ?? 0,
    weightedAvgCost: toNumber(material.weightedAvgCost) ?? 0,
    supplierId: material.supplierId,
    supplierName: material.supplier?.name ?? null,
    supplier: material.supplier ? { id: material.supplier.id, name: material.supplier.name } : null,
    storageLocation: material.storageLocation,
    category: material.category,
    attributes: material.attributes,
    active: material.active,
    searchText,
  }
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const params = new URL(req.url).searchParams
  const q = (params.get('q') || '').trim()
  const limit = Math.max(1, Math.min(50, Number(params.get('limit') || 25)))
  const numericQuery = Number(q.replace(/[^\d.]/g, ''))
  const hasNumber = Number.isFinite(numericQuery) && q.replace(/[^\d.]/g, '').length > 0

  const select = {
    id: true,
    materialCode: true,
    description: true,
    unit: true,
    boardType: true,
    boardClassification: true,
    gsm: true,
    sheetLength: true,
    sheetWidth: true,
    qtyAvailable: true,
    qtyQuarantine: true,
    qtyReserved: true,
    qtyFg: true,
    weightedAvgCost: true,
    supplierId: true,
    storageLocation: true,
    category: true,
    attributes: true,
    active: true,
    supplier: { select: { id: true, name: true } },
  } as const

  const textFilters = q
    ? [
        { materialCode: { contains: q, mode: 'insensitive' as const } },
        { description: { contains: q, mode: 'insensitive' as const } },
        { boardType: { contains: q, mode: 'insensitive' as const } },
        { boardClassification: { contains: q, mode: 'insensitive' as const } },
        { storageLocation: { contains: q, mode: 'insensitive' as const } },
        { category: { contains: q, mode: 'insensitive' as const } },
        { attributes: { contains: q } },
        { supplier: { name: { contains: q, mode: 'insensitive' as const } } },
      ]
    : []

  const numberFilters = hasNumber
    ? [
        { gsm: numericQuery },
        { sheetLength: numericQuery },
        { sheetWidth: numericQuery },
      ]
    : []

  const [totalActive, directRows] = await Promise.all([
    db.inventory.count({ where: { active: true } }),
    db.inventory.findMany({
      where: q
        ? {
            active: true,
            OR: [...textFilters, ...numberFilters],
          }
        : { active: true },
      select,
      orderBy: { materialCode: 'asc' },
      take: q ? Math.max(limit * 4, 100) : limit,
    }),
  ])

  const fallbackRows =
    q && directRows.length === 0
      ? await db.inventory.findMany({
          where: { active: true },
          select,
          orderBy: { materialCode: 'asc' },
          take: 250,
        })
      : directRows

  const tokens = normalize(q).split(/\s+/).filter(Boolean)
  const compactQuery = compact(q)

  const items = fallbackRows
    .map(toDto)
    .filter((item) => {
      if (!q) return true
      const search = normalize(item.searchText)
      const dense = compact(item.searchText)
      return (
        tokens.every((token) => search.includes(token) || fuzzyContains(dense, token)) ||
        (compactQuery.length > 1 && dense.includes(compactQuery))
      )
    })
    .sort((a, b) => scoreMaterial(a, q) - scoreMaterial(b, q) || a.materialCode.localeCompare(b.materialCode))
    .slice(0, limit)

  if (totalActive > 0 && q && items.length === 0) {
    console.warn('[GRN material search] Active inventory exists, but query returned no results', {
      q,
      totalActive,
      directMatches: directRows.length,
    })
  }

  return NextResponse.json({
    items,
    diagnostics: {
      q,
      totalActive,
      directMatches: directRows.length,
      returned: items.length,
    },
  })
}
