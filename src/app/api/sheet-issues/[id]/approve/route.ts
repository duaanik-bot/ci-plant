import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { approveExcessRequest } from '@/lib/sheet-issue-logic'

export const dynamic = 'force-dynamic'

const tierMap: Record<string, 1 | 2 | 3 | 4> = {
  production: 1,
  design_planning: 2,
  plant_head: 3,
  admin: 4,
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole(
    'admin',
    'plant_head',
    'production',
    'design_planning'
  )
  if (error) return error

  const { id } = await context.params
  const tier = user!.role ? tierMap[user.role] : undefined
  if (!tier) {
    return NextResponse.json(
      { error: 'Your role cannot approve excess requests' },
      { status: 403 }
    )
  }

  const result = await approveExcessRequest({
    sheetIssueId: id,
    approvedByUserId: user!.id,
    approvalTier: tier,
  })

  return NextResponse.json(result)
}
