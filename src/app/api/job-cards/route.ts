import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'
import { jobCardSchema } from '@/lib/validations'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  poLineItemId: z.string().uuid('PO line item is required'),
  requiredSheets: z.number().int().positive('Required sheets must be > 0'),
  wastageSheets: z.number().int().min(0).default(0),
  assignedOperator: z.string().optional(),
  batchNumber: z.string().optional(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const customerId = searchParams.get('customerId')
  const jobCardNumber = searchParams.get('jobCardNumber')

  const where: { status?: string; customerId?: string; jobCardNumber?: number } = {}
  if (status) where.status = status
  if (customerId) where.customerId = customerId
  if (jobCardNumber) {
    const num = parseInt(jobCardNumber, 10)
    if (!isNaN(num)) where.jobCardNumber = num
  }

  const list = await db.productionJobCard.findMany({
    where,
    orderBy: { jobCardNumber: 'desc' },
    include: {
      customer: { select: { id: true, name: true } },
      stages: true,
    },
  })

  const poLineByJcNumber = new Map<number, { id: string; cartonName: string; cartonSize: string | null; quantity: number }>()
  if (list.length > 0) {
    const numbers = list.map((j) => j.jobCardNumber)
    const lines = await db.poLineItem.findMany({
      where: { jobCardNumber: { in: numbers } },
      select: { jobCardNumber: true, id: true, cartonName: true, cartonSize: true, quantity: true },
    })
    lines.forEach((l) => {
      if (l.jobCardNumber != null) poLineByJcNumber.set(l.jobCardNumber, l)
    })
  }

  const mapped = list.map((jc) => ({
    ...jc,
    poLine: jc.jobCardNumber != null ? poLineByJcNumber.get(jc.jobCardNumber) ?? null : null,
  }))

  return NextResponse.json(mapped)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    requiredSheets: body.requiredSheets != null ? Number(body.requiredSheets) : undefined,
    wastageSheets: body.wastageSheets != null ? Number(body.wastageSheets) : 0,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const { poLineItemId, requiredSheets, wastageSheets, assignedOperator, batchNumber } =
    parsed.data

  const shared = jobCardSchema.safeParse({
    customerId: 'resolved-later',
    requiredSheets,
    wastageSheets,
    assignedOperator,
  })
  if (!shared.success) {
    const fields: Record<string, string> = {}
    shared.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const li = await db.poLineItem.findUnique({
    where: { id: poLineItemId },
    include: { po: { include: { customer: true } } },
  })
  if (!li) return NextResponse.json({ error: 'PO line item not found' }, { status: 404 })
  if (li.jobCardNumber) {
    return NextResponse.json(
      { error: `Job card already created for this line (JC# ${li.jobCardNumber})` },
      { status: 400 }
    )
  }

  const totalSheets = requiredSheets + wastageSheets

  const created = await db.$transaction(async (tx) => {
    const jc = await tx.productionJobCard.create({
      data: {
        customerId: li.po.customerId,
        setNumber: li.setNumber || null,
        assignedOperator: assignedOperator || null,
        requiredSheets,
        wastageSheets,
        totalSheets,
        sheetsIssued: 0,
        artworkApproved: false,
        firstArticlePass: false,
        finalQcPass: false,
        qaReleased: false,
        coaGenerated: false,
        batchNumber: batchNumber || null,
        status: 'design_ready',
      },
    })

    const stageNames = [
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
    await Promise.all(
      stageNames.map((stageName) =>
        tx.productionStageRecord.create({
          data: {
            jobCardId: jc.id,
            stageName,
            status: stageName === 'Cutting' ? 'ready' : 'pending',
          },
        })
      )
    )

    await tx.poLineItem.update({
      where: { id: li.id },
      data: {
        jobCardNumber: jc.jobCardNumber,
        planningStatus: 'job_card_created',
      },
    })

    return jc
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'production_job_cards',
    recordId: created.id,
    newValue: { jobCardNumber: created.jobCardNumber, poLineItemId },
  })

  return NextResponse.json(created, { status: 201 })
}

