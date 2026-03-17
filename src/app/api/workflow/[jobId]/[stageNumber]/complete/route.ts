import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { completeWorkflowStage } from '@/lib/workflow'

export const dynamic = 'force-dynamic'

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ jobId: string; stageNumber: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { jobId, stageNumber } = await context.params
  const sn = Number(stageNumber)
  if (!sn || Number.isNaN(sn)) {
    return NextResponse.json({ error: 'Invalid stage number' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    checklistData?: unknown
    notes?: string
  }

  try {
    const stages = await completeWorkflowStage({
      jobId,
      stageNumber: sn,
      userId: user!.id,
      userRole: user!.role as string,
      checklistData: body.checklistData,
      notes: body.notes,
    })
    return NextResponse.json(stages)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to complete stage'
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}

