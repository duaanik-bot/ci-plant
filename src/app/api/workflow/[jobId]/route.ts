import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { getWorkflowForJob, initializeWorkflowForJob } from '@/lib/workflow'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { jobId } = await context.params
  const stages = await getWorkflowForJob(jobId).then((s) =>
    s.length ? s : initializeWorkflowForJob(jobId)
  )
  return NextResponse.json(stages)
}

