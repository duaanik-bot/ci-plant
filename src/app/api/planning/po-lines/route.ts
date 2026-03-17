import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('planningStatus')
  const customerId = searchParams.get('customerId')

  const where: any = {}
  if (status) where.planningStatus = status
  if (customerId) where.po = { customerId }

  const list = await db.poLineItem.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      po: { select: { id: true, poNumber: true, status: true, customer: { select: { id: true, name: true } } } },
    },
  })

  return NextResponse.json(list)
}

