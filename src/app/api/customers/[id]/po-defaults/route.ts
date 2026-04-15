import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

function extractTaggedValue(remarks: string | null, tag: string): string | null {
  if (!remarks) return null
  const regex = new RegExp(`(?:^|[.;\\n])\\s*${tag}:\\s*([^.;\\n]+)`, 'i')
  const match = remarks.match(regex)
  return match?.[1]?.trim() || null
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await params

  const latestPo = await db.purchaseOrder.findFirst({
    where: { customerId: id },
    orderBy: [{ poDate: 'desc' }, { createdAt: 'desc' }],
    select: {
      poNumber: true,
      poDate: true,
      remarks: true,
    },
  })

  const paymentTerms = extractTaggedValue(latestPo?.remarks ?? null, 'Payment')

  return NextResponse.json({
    paymentTerms,
    source: latestPo
      ? {
          poNumber: latestPo.poNumber,
          poDate: latestPo.poDate,
        }
      : null,
  })
}
