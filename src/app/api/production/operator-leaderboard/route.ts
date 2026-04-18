import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { buildOperatorLeaderboard } from '@/lib/operator-performance'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  try {
    const operators = await buildOperatorLeaderboard(db, { sinceDays: 28 })
    return NextResponse.json({ operators })
  } catch (e) {
    console.error('[operator-leaderboard]', e)
    return NextResponse.json({ error: 'Failed to build leaderboard' }, { status: 500 })
  }
}
