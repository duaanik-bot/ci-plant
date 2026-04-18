import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { getSupplierScorecardDetail } from '@/lib/vendor-reliability-scorecard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const supplierId = req.nextUrl.searchParams.get('supplierId')?.trim() ?? ''
  if (!supplierId) {
    return NextResponse.json({ error: 'supplierId required' }, { status: 400 })
  }

  const detail = await getSupplierScorecardDetail(db, supplierId)
  if (!detail) {
    return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
  }

  return NextResponse.json(detail)
}
