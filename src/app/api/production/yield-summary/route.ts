import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { computeYieldSummaryForDashboard } from '@/lib/production-yield'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  try {
    const summary = await computeYieldSummaryForDashboard(db)
    return NextResponse.json(summary)
  } catch (e) {
    console.error('[yield-summary]', e)
    return NextResponse.json({ error: 'Failed to compute yield summary' }, { status: 500 })
  }
}
