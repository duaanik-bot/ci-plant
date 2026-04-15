import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const stageUpdateSchema = z.object({
  id: z.string().uuid(),
  status: z.string().optional(),
  operator: z.string().optional().nullable(),
  counter: z.number().int().optional().nullable(),
  sheetSize: z.string().optional().nullable(),
  excessSheets: z.number().int().min(0).optional().nullable(),
})

const postPressRoutingSchema = z.object({
  chemicalCoating: z.boolean().optional(),
  lamination: z.boolean().optional(),
  spotUv: z.boolean().optional(),
  leafing: z.boolean().optional(),
  embossing: z.boolean().optional(),
})

const updateSchema = z.object({
  assignedOperator: z.string().optional().nullable(),
  batchNumber: z.string().optional().nullable(),
  requiredSheets: z.number().int().positive().optional(),
  wastageSheets: z.number().int().min(0).optional(),
  sheetsIssued: z.number().int().min(0).optional(),
  artworkApproved: z.boolean().optional(),
  firstArticlePass: z.boolean().optional(),
  finalQcPass: z.boolean().optional(),
  qaReleased: z.boolean().optional(),
  status: z.string().optional(),
  postPressRouting: postPressRoutingSchema.optional().nullable(),
  stages: z.array(stageUpdateSchema).optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const jc = await db.productionJobCard.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true } },
      stages: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  let poLine: Awaited<ReturnType<typeof db.poLineItem.findFirst>> & { carton?: { id: string; coatingType: string | null; laminateType: string | null; foilType: string | null; embossingLeafing: string | null; embossBlockId: string | null } | null } =
    jc.jobCardNumber != null
      ? await db.poLineItem.findFirst({
          where: { jobCardNumber: jc.jobCardNumber },
          include: { po: { select: { poNumber: true } } },
        })
      : null

  if (poLine?.cartonId) {
    const carton = await db.carton.findUnique({
      where: { id: poLine.cartonId },
      select: {
        id: true,
        coatingType: true,
        laminateType: true,
        foilType: true,
        embossingLeafing: true,
        embossBlockId: true,
      },
    })
    poLine = { ...poLine, carton: carton ?? null }
  } else if (poLine) {
    poLine = { ...poLine, carton: null }
  }

  return NextResponse.json({ ...jc, poLine })
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.productionJobCard.findUnique({
    where: { id },
    include: { stages: true },
  })
  if (!existing) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    requiredSheets: body.requiredSheets != null ? Number(body.requiredSheets) : undefined,
    wastageSheets: body.wastageSheets != null ? Number(body.wastageSheets) : undefined,
    sheetsIssued: body.sheetsIssued != null ? Number(body.sheetsIssued) : undefined,
    stages: Array.isArray(body.stages)
      ? body.stages.map((s: any) => ({
          ...s,
          counter: s.counter != null ? Number(s.counter) : undefined,
        }))
      : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data
  const requiredSheets = data.requiredSheets ?? existing.requiredSheets
  const wastageSheets = data.wastageSheets ?? existing.wastageSheets
  const totalSheets = requiredSheets + wastageSheets

  const updated = await db.$transaction(async (tx) => {
    const header = await tx.productionJobCard.update({
      where: { id },
      data: {
        ...(data.assignedOperator !== undefined
          ? { assignedOperator: data.assignedOperator }
          : {}),
        ...(data.batchNumber !== undefined ? { batchNumber: data.batchNumber } : {}),
        ...(data.requiredSheets !== undefined ? { requiredSheets: data.requiredSheets } : {}),
        ...(data.wastageSheets !== undefined ? { wastageSheets: data.wastageSheets } : {}),
        totalSheets,
        ...(data.sheetsIssued !== undefined ? { sheetsIssued: data.sheetsIssued } : {}),
        ...(data.artworkApproved !== undefined ? { artworkApproved: data.artworkApproved } : {}),
        ...(data.firstArticlePass !== undefined
          ? { firstArticlePass: data.firstArticlePass }
          : {}),
        ...(data.finalQcPass !== undefined ? { finalQcPass: data.finalQcPass } : {}),
        ...(data.qaReleased !== undefined ? { qaReleased: data.qaReleased } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.postPressRouting !== undefined
          ? { postPressRouting: data.postPressRouting as object }
          : {}),
      },
    })

    const stageOrder = [
      'Cutting',
      'Printing',
      'Chemical Coating',
      'Lamination',
      'Embossing',
      'Leafing',
      'Spot UV',
      'Dye Cutting',
      'Pasting',
    ]

    if (data.stages?.length) {
      const completedStageIds = new Set(
        data.stages.filter((s) => s.status === 'completed').map((s) => s.id),
      )
      await Promise.all(
        data.stages.map((s) =>
          tx.productionStageRecord.update({
            where: { id: s.id },
            data: {
              ...(s.status !== undefined ? { status: s.status } : {}),
              ...(s.operator !== undefined ? { operator: s.operator } : {}),
              ...(s.counter !== undefined ? { counter: s.counter } : {}),
              ...(s.sheetSize !== undefined ? { sheetSize: s.sheetSize } : {}),
              ...(s.excessSheets !== undefined ? { excessSheets: s.excessSheets } : {}),
              ...(s.status === 'completed' ? { completedAt: new Date() } : {}),
            },
          })
        )
      )

      if (completedStageIds.size > 0) {
        const orderedStages = [...existing.stages].sort(
          (a, b) =>
            stageOrder.indexOf(a.stageName) - stageOrder.indexOf(b.stageName) ||
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )
        for (const s of data.stages) {
          if (s.status !== 'completed') continue
          const rec = existing.stages.find((r) => r.id === s.id)
          if (!rec) continue
          const idx = orderedStages.findIndex((r) => r.id === rec.id)
          if (idx < 0 || idx >= orderedStages.length - 1) continue
          const nextRec = orderedStages[idx + 1]
          await tx.productionStageRecord.update({
            where: { id: nextRec.id },
            data: { status: 'ready' },
          })
        }
      }
    }

    return header
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'production_job_cards',
    recordId: id,
    newValue: data,
  })

  return NextResponse.json(updated)
}

