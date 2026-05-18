import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export type RegistryValue = { code: string; label: string; abbreviation: string | null; sortOrder: number }
export type RegistryCategory = { code: string; label: string; values: RegistryValue[] }
export type RegistryPayload = Record<string, RegistryCategory>

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
        label: c.name,
        values: c.values.map((v) => ({
          code: v.code,
          label: v.value,
          abbreviation: v.abbreviation,
          sortOrder: v.sortOrder,
        })),
      }
    }
    return NextResponse.json(payload)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to load master registry'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
