import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { getMachinePmKpiBundle } from '@/lib/machine-pm-health'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const bundle = await getMachinePmKpiBundle(db)
  return NextResponse.json(bundle)
}
