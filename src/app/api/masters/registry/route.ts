import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeBoardTypeForStorage, normalizeBoardTypeKey } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

export type RegistryValue = { code: string; label: string; abbreviation: string | null; sortOrder: number }
export type RegistryCategory = { code: string; label: string; values: RegistryValue[] }
export type RegistryPayload = Record<string, RegistryCategory>

function registryValues(code: string, values: {
  code: string
  value: string
  abbreviation: string | null
  sortOrder: number
}[]): RegistryValue[] {
  const isBoardCategory = code === 'BOARD_TYPE' || code === 'BOARD_COLOUR'
  if (!isBoardCategory) {
    return values.map((v) => ({
      code: v.code,
      label: v.value,
      abbreviation: v.abbreviation,
      sortOrder: v.sortOrder,
    }))
  }

  const seen = new Set<string>()
  const out: RegistryValue[] = []
  for (const v of values) {
    const label = normalizeBoardTypeForStorage(v.value)
    if (!label) continue
    const key = normalizeBoardTypeKey(label)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      code: v.code,
      label,
      abbreviation: v.abbreviation,
      sortOrder: v.sortOrder,
    })
  }
  return out
}

export async function GET() {
  try {
    const categories = await db.effectCategory.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        values: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }],
          select: { code: true, value: true, abbreviation: true, sortOrder: true },
        },
      },
    })

    const payload: RegistryPayload = {}
    for (const c of categories) {
      payload[c.code] = {
        code: c.code,
        label: c.code === 'BOARD_COLOUR' ? 'Board Variant' : c.name,
        values: registryValues(c.code, c.values),
      }
    }
    return NextResponse.json(payload)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to load master registry'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
