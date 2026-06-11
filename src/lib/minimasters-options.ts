export type MiniMasterOption = {
  id: string
  value: string
}

import { normalizeBoardTypeOptions } from '@/lib/board-vocabulary'

export async function fetchMiniMasterOptions(category: string): Promise<string[]> {
  const c = category.trim()
  if (!c) return []
  const normalizedCategory = c.toLowerCase() === 'board classification' ? 'Board Type' : c
  try {
    const res = await fetch(`/api/minimasters/values?category=${encodeURIComponent(normalizedCategory)}`, {
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = (await res.json().catch(() => [])) as MiniMasterOption[]
    if (!Array.isArray(data)) return []
    const values = data
      .map((d) => (typeof d.value === 'string' ? d.value.trim() : ''))
      .filter((v) => v.length > 0)
    if (normalizedCategory.toLowerCase() !== 'board type') return values
    return normalizeBoardTypeOptions(values).filter((v) => {
      const key = v.toLowerCase()
      return !key.includes('sbs') && !key.includes('duplex') && !key.includes('dup')
    })
  } catch {
    return []
  }
}
