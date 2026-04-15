// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { checkDieAvailability } from '@/lib/die-engine'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const sp = req.nextUrl.searchParams
  const cartonId = sp.get('cartonId') ?? ''
  const cartonSize = sp.get('cartonSize') ?? ''
  const dieType = sp.get('dieType') ?? ''
  const ups = Number(sp.get('ups') || 1)
  const sheetSize = sp.get('sheetSize') ?? ''
  const result = await checkDieAvailability(cartonId, cartonSize, dieType, ups, sheetSize)
  return NextResponse.json(result)
}
