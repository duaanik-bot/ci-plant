import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { buildPaperGenealogy } from '@/lib/paper-interconnect'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  try {
    const data = await buildPaperGenealogy(db, id)
    return NextResponse.json(data)
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    }
    throw e
  }
}
