import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { getEffectValues } from '@/lib/effects-master'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const category = req.nextUrl.searchParams.get('category')?.trim() ?? ''
  if (!category) {
    return NextResponse.json({ error: 'category is required' }, { status: 400 })
  }

  const values = await getEffectValues(category)
  return NextResponse.json(values)
}
