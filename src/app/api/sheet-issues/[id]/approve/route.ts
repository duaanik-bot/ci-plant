import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { approveExcessRequest } from '@/lib/sheet-issue-logic'

const tierMap: Record<string, 1 | 2 | 3 | 4> = {
  shift_supervisor: 1,
  production_manager: 2,
  operations_head: 3,
  md: 4,
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole(
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'md'
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
