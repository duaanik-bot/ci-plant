import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { getShadeIncomingRows } from '@/lib/hub-shade-incoming'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error
  return NextResponse.json(getShadeIncomingRows())
}
