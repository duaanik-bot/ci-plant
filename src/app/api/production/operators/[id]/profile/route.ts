import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { buildOperatorProfile } from '@/lib/operator-performance'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  try {
    const profile = await buildOperatorProfile(db, id, { sinceDays: 90 })
    if (!profile) return NextResponse.json({ error: 'Operator not found' }, { status: 404 })
    return NextResponse.json(profile)
  } catch (e) {
    console.error('[operator-profile]', e)
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }
}
