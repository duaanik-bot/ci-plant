import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  jobId: z.string().uuid(),
  stageId: z.string().uuid().optional().nullable(),
  checkType: z.string().min(1),
  instrumentName: z.string().min(1),
  measuredValue: z.string().optional().nullable(),
  specMin: z.string().optional().nullable(),
  specMax: z.string().optional().nullable(),
  result: z.enum(['PASS', 'FAIL']),
  isFirstArticle: z.boolean().default(false),
  notes: z.string().optional().nullable(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const jobId = searchParams.get('jobId')

  const list = await db.qcRecord.findMany({
    where: jobId ? { jobId } : undefined,
    orderBy: { checkedAt: 'desc' },
    include: {
      job: { select: { id: true, jobNumber: true, productName: true } },
      stage: { select: { id: true, stageNumber: true } },
      checker: { select: { id: true, name: true } },
    },
  })

  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const job = await db.job.findUnique({ where: { id: parsed.data.jobId } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const record = await db.qcRecord.create({
    data: {
      jobId: parsed.data.jobId,
      stageId: parsed.data.stageId ?? undefined,
      checkType: parsed.data.checkType,
      instrumentName: parsed.data.instrumentName,
      measuredValue: parsed.data.measuredValue ?? undefined,
      specMin: parsed.data.specMin ?? undefined,
      specMax: parsed.data.specMax ?? undefined,
      result: parsed.data.result,
      checkedBy: user!.id,
      isFirstArticle: parsed.data.isFirstArticle,
      notes: parsed.data.notes ?? undefined,
    },
    include: {
      job: { select: { jobNumber: true } },
    },
  })

  return NextResponse.json(record, { status: 201 })
}
