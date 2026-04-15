import { plateColourCanonicalKey } from '@/lib/hub-plate-card-ui'

type NeedRow = {
  name?: string
  isNew?: boolean
  hubShopfloorActive?: boolean
  status?: string
}

export function shopfloorInactiveCanonicalKeysFromJson(json: unknown): string[] {
  if (!Array.isArray(json)) return []
  const keys: string[] = []
  for (const item of json) {
    if (!item || typeof item !== 'object') continue
    const row = item as NeedRow
    if (String(row.status ?? '').toLowerCase() === 'destroyed') continue
    if (row.hubShopfloorActive === false) {
      const k = plateColourCanonicalKey(String(row.name ?? ''))
      if (k) keys.push(k)
    }
  }
  return keys
}

/** Remove shop-floor-disabled channels and strip flags before custody / rack materialization. */
export function commitShopfloorColoursForCustody(coloursNeeded: unknown): {
  committed: Record<string, unknown>[]
  error?: string
} {
  if (!Array.isArray(coloursNeeded)) return { committed: [], error: 'Invalid colours data' }
  const committed: Record<string, unknown>[] = []
  for (const item of coloursNeeded) {
    if (!item || typeof item !== 'object') continue
    const row = { ...(item as Record<string, unknown>) }
    const st = String(row.status ?? '').toLowerCase()
    if (st === 'destroyed') continue
    if (row.hubShopfloorActive === false) continue
    delete row.hubShopfloorActive
    committed.push(row)
  }
  if (committed.length === 0) {
    return {
      committed: [],
      error: 'At least one active plate colour is required before moving to custody floor',
    }
  }
  return { committed }
}

export function newPlatesNeededFromCommitted(committed: Record<string, unknown>[]): number {
  let n = 0
  for (const row of committed) {
    if (row.isNew === true) n += 1
  }
  return n > 0 ? n : committed.length
}

export function cloneColoursNeededJson(json: unknown): Record<string, unknown>[] {
  if (!Array.isArray(json)) return []
  return json.map((item) =>
    item && typeof item === 'object' ? { ...(item as Record<string, unknown>) } : {},
  )
}

export function findColourRowIndexByCanonicalKey(
  rows: Record<string, unknown>[],
  canonicalKey: string,
): number {
  return rows.findIndex((row) => {
    const st = String(row.status ?? '').toLowerCase()
    if (st === 'destroyed') return false
    const name = String(row.name ?? '').trim()
    return name && plateColourCanonicalKey(name) === canonicalKey
  })
}

export function countShopfloorActiveRows(rows: Record<string, unknown>[]): number {
  return rows.filter((row) => {
    const st = String(row.status ?? '').toLowerCase()
    if (st === 'destroyed') return false
    return row.hubShopfloorActive !== false
  }).length
}

/** Active “burn” channels on a requirement (excludes destroyed and shop-floor dimmed). */
export function countActiveShopfloorColours(json: unknown): number {
  if (!Array.isArray(json)) return 0
  let n = 0
  for (const item of json) {
    if (!item || typeof item !== 'object') continue
    const row = item as NeedRow
    if (String(row.status ?? '').toLowerCase() === 'destroyed') continue
    if (row.hubShopfloorActive === false) continue
    n += 1
  }
  return n
}
