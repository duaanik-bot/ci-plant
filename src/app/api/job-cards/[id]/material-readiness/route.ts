import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { getMaterialReadiness } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const jc = await db.productionJobCard.findUnique({ where: { id } })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const readiness = await getMaterialReadiness(id)
  return NextResponse.json(readiness)
}
