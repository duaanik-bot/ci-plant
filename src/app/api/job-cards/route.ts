import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { computeJobYieldMetricsForCard } from '@/lib/production-yield'
import { z } from 'zod'
import { jobCardSchema } from '@/lib/validations'
import { applyAllocatedStockToJobCard, get_allocated_stock_dims } from '@/lib/allocated-stock-dims'
import {
  postPressRoutingFromPoLine,
  postPressRoutingSchema,
} from '@/lib/job-card-routing-spec'

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
  machineId: z.string().uuid().optional().nullable(),
  /** When true and a job card already exists for the line, return 200 with existing row (parallel orchestration). */
  idempotentIfExists: z.boolean().optional(),
  postPressRouting: postPressRoutingSchema.optional(),
  orchestrationSource: z.string().max(64).optional(),
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
  else if (segment === 'print_planning') {
    // Planning triage should only show cards after explicit push/release from Job Card.
    where.status = { in: ['qa_released', 'in_progress', 'final_qc'] }
  } else if (status) where.status = status

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
      planningStatus: string | null
      materialQueue: {
        boardType: string
        gsm: number
        ups: number
        totalSheets: number
      } | null
      upsFromSpec: number | null
      designerName: string | null
      batchType: string | null
      numberOfColours: number | null
      colourBreakdown: string[]
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
        specOverrides: true,
        planningStatus: true,
        po: { select: { isPriority: true, poNumber: true } },
        materialQueue: {
          select: { boardType: true, gsm: true, ups: true, totalSheets: true },
        },
        carton: {
          select: {
            artworkCode: true,
            finishedLength: true,
            finishedWidth: true,
            blankLength: true,
            blankWidth: true,
            gsm: true,
            numberOfColours: true,
            colourBreakdown: true,
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
      const spec = (l.specOverrides && typeof l.specOverrides === 'object'
        ? (l.specOverrides as Record<string, unknown>)
        : {}) as Record<string, unknown>
      const core = spec.planningCore as Record<string, unknown> | undefined
      const upsFromSpec =
        typeof spec.upsPerSheet === 'number'
          ? spec.upsPerSheet
          : typeof core?.upsPerSheet === 'number'
            ? (core.upsPerSheet as number)
            : null
      const designerName =
        typeof spec.assignedDesignerName === 'string'
          ? spec.assignedDesignerName
          : typeof spec.designerName === 'string'
            ? (spec.designerName as string)
            : null
      const batchType =
        typeof core?.batchType === 'string'
          ? (core.batchType as string)
          : typeof spec.batchType === 'string'
            ? (spec.batchType as string)
            : null
      const colourBreakdown = Array.isArray(l.carton?.colourBreakdown)
        ? l.carton.colourBreakdown
            .map((entry) => {
              if (!entry || typeof entry !== 'object') return null
              const name = (entry as Record<string, unknown>).name
              return typeof name === 'string' ? name.trim() : null
            })
            .filter((name): name is string => !!name)
        : []
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
        planningStatus: l.planningStatus,
        materialQueue: l.materialQueue,
        upsFromSpec,
        designerName,
        batchType,
        numberOfColours: l.carton?.numberOfColours ?? null,
        colourBreakdown,
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
    idempotentIfExists: body.idempotentIfExists === true,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const {
    poLineItemId,
    requiredSheets,
    wastageSheets,
    assignedOperator,
    batchNumber,
    machineId: bodyMachineId,
    idempotentIfExists,
    postPressRouting: bodyPostPress,
    orchestrationSource,
  } = parsed.data

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
    include: {
      po: { include: { customer: true } },
      carton: {
        select: {
          embossingLeafing: true,
          coatingType: true,
          laminateType: true,
          foilType: true,
          embossBlockId: true,
        },
      },
    },
  })
  if (!li) return NextResponse.json({ error: 'PO line item not found' }, { status: 404 })
  if (li.jobCardNumber) {
    if (idempotentIfExists) {
      const existing = await db.productionJobCard.findFirst({
        where: { jobCardNumber: li.jobCardNumber },
        include: {
          customer: { select: { id: true, name: true } },
          machine: { select: { id: true, machineCode: true } },
          stages: true,
        },
      })
      if (existing) {
        return NextResponse.json({ ...existing, idempotent: true as const }, { status: 200 })
      }
    }
    return NextResponse.json(
      { error: `Job card already created for this line (JC# ${li.jobCardNumber})` },
      { status: 400 }
    )
  }

  let resolvedMachineId: string | null = bodyMachineId ?? null
  if (resolvedMachineId) {
    const m = await db.machine.findUnique({
      where: { id: resolvedMachineId },
      select: { id: true },
    })
    if (!m) {
      return NextResponse.json({ error: 'Invalid machineId', fields: { machineId: 'Machine not found' } }, { status: 400 })
    }
  }

  const baseRouting = postPressRoutingFromPoLine({
    embossingLeafing: li.embossingLeafing,
    coatingType: li.coatingType,
    carton: li.carton,
  })
  const overrideParsed =
    bodyPostPress != null ? postPressRoutingSchema.partial().safeParse(bodyPostPress) : null
  const fromBody = overrideParsed?.success ? overrideParsed.data : {}
  const defaultPrintPlan = {
    lane: 'triage' as const,
    machineId: null as string | null,
    order: 0,
    updatedAt: new Date().toISOString(),
  }
  const mergedRouting = {
    ...baseRouting,
    ...fromBody,
    printPlan: fromBody.printPlan ?? defaultPrintPlan,
  }

  const embossBlockId = li.carton?.embossBlockId ?? null

  const totalSheets = requiredSheets + wastageSheets

  const created = await db.$transaction(async (tx) => {
    const jc = await tx.productionJobCard.create({
      data: {
        customerId: li.po.customerId,
        setNumber: li.setNumber || null,
        machineId: resolvedMachineId,
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
        postPressRouting: mergedRouting as object,
        embossBlockId,
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
    newValue: {
      jobCardNumber: created.jobCardNumber,
      poLineItemId,
      ...(orchestrationSource ? { orchestrationSource } : {}),
    },
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

