import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { computeJobYieldMetricsForCard } from '@/lib/production-yield'
import { z } from 'zod'
import { jobCardSchema } from '@/lib/validations'
import { applyAllocatedStockToJobCard, get_allocated_stock_dims } from '@/lib/allocated-stock-dims'

export const dynamic = 'force-dynamic'

async function jobCardNumbersMatchingSearch(query: string): Promise<number[]> {
  const lines = await db.poLineItem.findMany({
    where: {
      jobCardNumber: { not: null },
      OR: [
        { cartonName: { contains: query, mode: 'insensitive' } },
        { artworkCode: { contains: query, mode: 'insensitive' } },
        { po: { poNumber: { contains: query, mode: 'insensitive' } } },
        { po: { customer: { name: { contains: query, mode: 'insensitive' } } } },
      ],
    },
    select: { jobCardNumber: true },
  })
  return Array.from(
    new Set(lines.map((l) => l.jobCardNumber!).filter((n): n is number => n != null)),
  )
}

async function priorityJobCardNumbers(): Promise<number[]> {
  const lines = await db.poLineItem.findMany({
    where: {
      jobCardNumber: { not: null },
      OR: [{ directorPriority: true }, { po: { isPriority: true } }],
    },
    select: { jobCardNumber: true },
  })
  return Array.from(
    new Set(lines.map((l) => l.jobCardNumber!).filter((n): n is number => n != null)),
  )
}

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
  const yieldMetrics = searchParams.get('yieldMetrics') === '1' || searchParams.get('yieldMetrics') === 'true'
  const segment = searchParams.get('segment')?.trim() ?? ''
  const q = searchParams.get('q')?.trim() ?? ''
  const priorityOnly =
    searchParams.get('priorityOnly') === '1' || searchParams.get('priorityOnly') === 'true'
  const machineIdParam = searchParams.get('machineId')?.trim() ?? ''
  const operatorIdParam = searchParams.get('operatorId')?.trim() ?? ''

  const where: Prisma.ProductionJobCardWhereInput = {}
  if (customerId) where.customerId = customerId
  if (machineIdParam) where.machineId = machineIdParam
  if (operatorIdParam) where.shiftOperatorUserId = operatorIdParam
  if (jobCardNumber) {
    const num = parseInt(jobCardNumber, 10)
    if (!isNaN(num)) where.jobCardNumber = num
  }

  if (segment === 'in_production') where.status = 'in_progress'
  else if (segment === 'awaiting_setup') where.status = 'design_ready'
  else if (segment === 'qa_hold') where.status = 'final_qc'
  else if (segment === 'completed') where.status = { in: ['closed', 'qa_released'] }
  else if (status) where.status = status

  let idFilter: number[] | null = null
  if (q) {
    idFilter = await jobCardNumbersMatchingSearch(q)
  }
  if (priorityOnly) {
    const p = await priorityJobCardNumbers()
    const pset = new Set(p)
    idFilter = idFilter ? idFilter.filter((n) => pset.has(n)) : Array.from(pset)
  }
  if (idFilter !== null) {
    where.jobCardNumber = { in: idFilter.length > 0 ? idFilter : [-1] }
  }

  const list = await db.productionJobCard.findMany({
    where,
    orderBy: { jobCardNumber: 'desc' },
    include: {
      customer: { select: { id: true, name: true } },
      machine: { select: { id: true, machineCode: true, capacityPerShift: true } },
      shiftOperator: { select: { id: true, name: true } },
      stages: true,
    },
  })

  const jcIds = list.map((j) => j.id)
  const openDowntimeRows =
    jcIds.length === 0
      ? []
      : await db.productionDowntimeLog.findMany({
          where: { productionJobCardId: { in: jcIds }, endedAt: null },
          select: { productionJobCardId: true },
        })
  const openDowntimeByCard = new Set(openDowntimeRows.map((r) => r.productionJobCardId))

  const poLineByJcNumber = new Map<
    number,
    {
      id: string
      cartonName: string
      cartonSize: string | null
      quantity: number
      industrialPriority: boolean
      poNumber: string
      artworkCode: string | null
      dyeNumber: number | null
      shadeCode: string | null
    }
  >()
  type PoLineYield = NonNullable<Parameters<typeof computeJobYieldMetricsForCard>[2]>
  const poLineForYield = new Map<number, PoLineYield>()

  if (list.length > 0) {
    const numbers = list.map((j) => j.jobCardNumber)
    const lines = await db.poLineItem.findMany({
      where: { jobCardNumber: { in: numbers } },
      select: {
        jobCardNumber: true,
        id: true,
        cartonName: true,
        cartonSize: true,
        quantity: true,
        directorPriority: true,
        artworkCode: true,
        gsm: true,
        dimLengthMm: true,
        dimWidthMm: true,
        po: { select: { isPriority: true, poNumber: true } },
        carton: {
          select: {
            artworkCode: true,
            finishedLength: true,
            finishedWidth: true,
            blankLength: true,
            blankWidth: true,
            gsm: true,
          },
        },
        dieMaster: { select: { dyeNumber: true } },
        shadeCard: { select: { shadeCode: true } },
      },
    })
    for (const l of lines) {
      if (l.jobCardNumber == null) continue
      const aw =
        (l.artworkCode && String(l.artworkCode).trim()) ||
        (l.carton?.artworkCode && String(l.carton.artworkCode).trim()) ||
        null
      poLineByJcNumber.set(l.jobCardNumber, {
        id: l.id,
        cartonName: l.cartonName,
        cartonSize: l.cartonSize,
        quantity: l.quantity,
        industrialPriority: l.directorPriority === true || l.po.isPriority === true,
        poNumber: l.po.poNumber,
        artworkCode: aw,
        dyeNumber: l.dieMaster?.dyeNumber ?? null,
        shadeCode: l.shadeCard?.shadeCode ?? null,
      })
      if (yieldMetrics) {
        poLineForYield.set(l.jobCardNumber, {
          gsm: l.gsm,
          dimLengthMm: l.dimLengthMm,
          dimWidthMm: l.dimWidthMm,
          carton: l.carton,
        })
      }
    }
  }

  const mapped = await Promise.all(
    list.map(async (jc) => {
      const base = {
        ...jc,
        openDowntime: openDowntimeByCard.has(jc.id),
        poLine: jc.jobCardNumber != null ? poLineByJcNumber.get(jc.jobCardNumber) ?? null : null,
      }
      if (!yieldMetrics) return base
      const line = jc.jobCardNumber != null ? poLineForYield.get(jc.jobCardNumber) ?? null : null
      const yieldM = await computeJobYieldMetricsForCard(db, jc, line)
      return { ...base, yield: yieldM }
    }),
  )

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

  const spec =
    li.specOverrides && typeof li.specOverrides === 'object'
      ? (li.specOverrides as Record<string, unknown>)
      : {}
  const awTarget =
    typeof spec.actualSheetSize === 'string' ? spec.actualSheetSize.trim() || null : null
  const allocated = await get_allocated_stock_dims(db, { poLineItemId: li.id })
  if (allocated) {
    await applyAllocatedStockToJobCard(db, created.id, allocated, awTarget)
  }

  const refreshed = await db.productionJobCard.findUnique({ where: { id: created.id } })
  return NextResponse.json(refreshed ?? created, { status: 201 })
}

