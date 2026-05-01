import { db } from '@/lib/db'

export type EffectOption = {
  id: string
  value: string
  description: string | null
  sortOrder: number
}

/**
 * Returns active effect values for a category, sorted for dropdown consumption.
 */
export async function getEffectValues(category: string): Promise<EffectOption[]> {
  const name = category.trim()
  if (!name) return []

  const rows = await db.effectValue.findMany({
    where: {
      active: true,
      category: {
        name: { equals: name, mode: 'insensitive' },
        active: true,
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }],
    select: {
      id: true,
      value: true,
      description: true,
      sortOrder: true,
    },
  })

  return rows
}
