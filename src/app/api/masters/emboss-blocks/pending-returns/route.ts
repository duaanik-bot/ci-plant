import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const issues = await db.blockTransaction.findMany({
    where: { type: 'ISSUE' },
    orderBy: { createdAt: 'desc' },
    distinct: ['blockId'],
    include: {
      block: { select: { id: true, blockCode: true, blockMaterial: true, active: true } },
    },
  })

  const pending: Array<{
    transactionId: string
    blockId: string
    blockCode: string
    blockMaterial: string
    operatorId: string
    issuedAt: string
  }> = []

  for (const issue of issues) {
    if (!issue.block.active) continue
    const returned = await db.blockTransaction.findFirst({
      where: {
        blockId: issue.blockId,
        type: 'RETURN',
        createdAt: { gt: issue.createdAt },
      },
    })
    if (!returned) {
      pending.push({
        transactionId: issue.id,
        blockId: issue.blockId,
        blockCode: issue.block.blockCode,
        blockMaterial: issue.block.blockMaterial,
        operatorId: issue.operatorId,
        issuedAt: issue.createdAt.toISOString(),
      })
    }
  }

  return NextResponse.json(pending)
}
