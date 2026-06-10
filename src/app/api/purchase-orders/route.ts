import { NextRequest, NextResponse } from 'next/server'
import { PastingStyle, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'
import { purchaseOrderSchema } from '@/lib/validations'
import { dyeMapFromRows, poHasCriticalTooling } from '@/lib/po-tooling-critical'
import { computePoReadiness } from '@/lib/po-readiness'
import { buildPoNumber, createPurchaseOrderWithLines } from '@/lib/po-create'
import {
  clampListLimit,
  isCompactRequest,
  isExportRequest,
  listSkip,
  logListPerformance,
  parseListPage,
  shouldReturnPagedEnvelope,
} from '@/lib/api-list-params'

export const dynamic = 'force-dynamic'

const PO_LIST_DEFAULT_LIMIT = 100
const PO_LIST_MAX_LIMIT = 500

async function sanitizeCartonIds<T extends { cartonId?: string | null }>(
  lineItems: T[],
): Promise<Array<T & { cartonId: string | null }>> {
  const requested = Array.from(
    new Set(
      lineItems
        .map((li) => (typeof li.cartonId === 'string' ? li.cartonId.trim() : ''))
        .filter((id) => id.length > 0),
    ),
  )
  if (!requested.length) return lineItems.map((li) => ({ ...li, cartonId: li.cartonId?.trim() || null }))

  const rows = await db.carton.findMany({ where: { id: { in: requested } }, select: { id: true } })
  const valid = new Set(rows.map((r) => r.id))
  return lineItems.map((li) => {
    const id = typeof li.cartonId === 'string' ? li.cartonId.trim() : ''
    return { ...li, cartonId: id && valid.has(id) ? id : null }
  })
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const specOverridesSchema = z
  .object({
    ups: z.number().int().min(1).optional(),
    wastagePct: z.number().min(0).optional(),
    requiredSheets: z.number().int().min(0).optional(),
    totalSheets: z.number().int().min(0).optional(),
    boardGrade: z.string().optional(),
    foilType: z.string().optional(),
    pastingStyle: z.nativeEnum(PastingStyle).optional(),
    pastingType: z.string().optional(),
  })
  .passthrough()
  .optional()

const lineItemSchema = purchaseOrderSchema.shape.lineItems.element.extend({
  cartonId: z.string().uuid().optional().nullable(),
  cartonSize: z.string().optional(),
  backPrint: z.string().optional(),
  gstPct: z.number().int().min(0).max(28).default(5),
  coatingType: z.string().optional(),
  otherCoating: z.string().optional(),
  embossingLeafing: z.string().optional(),
  paperType: z.string().optional(),
  remarks: z.string().optional(),
  setNumber: z.string().optional(),
  specOverrides: specOverridesSchema,
  dieMasterId: z.string().uuid().optional().nullable(),
  toolingLocked: z.boolean().optional(),
  lineDieType: z.string().optional().nullable(),
  dimLengthMm: z.coerce.number().optional().nullable(),
  dimWidthMm: z.coerce.number().optional().nullable(),
  dimHeightMm: z.coerce.number().optional().nullable(),
})

const createSchema = purchaseOrderSchema.omit({
  poNumber: true,
  deliveryRequiredBy: true,
  paymentTerms: true,
  priority: true,
  specialInstructions: true,
  lineItems: true,
}).extend({
  poDate: z.string().min(1, 'PO date is required'),
  poNumber: z.string().min(1).max(100).optional(),
  remarks: z.string().optional(),
  status: z.string().optional(),
  /** Pins PO to the top in Planning and Plate hubs when true. */
  isPriority: z.boolean().optional(),
  /** ISO date YYYY-MM-DD — stored on header for MRP / vendor scheduling */
  deliveryRequiredBy: z.string().optional().nullable(),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item is required'),
})

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const customerId = searchParams.get('customerId')
  const deepSearch = (searchParams.get('deepSearch') ?? searchParams.get('q'))?.trim() ?? ''
  const compact = isCompactRequest(searchParams)
  const lookup = searchParams.get('lookup')?.trim() ?? ''
  const jobCardLookup = compact && lookup === 'job-card'
  const exportRequested = isExportRequest(searchParams)
  const paged = shouldReturnPagedEnvelope(searchParams)
  const page = parseListPage(searchParams.get('page'))
  const limit = exportRequested
    ? clampListLimit(searchParams.get('limit'), { defaultLimit: PO_LIST_MAX_LIMIT, max: 5000 })
    : clampListLimit(searchParams.get('limit'), { defaultLimit: PO_LIST_DEFAULT_LIMIT, max: PO_LIST_MAX_LIMIT })
  const sort = searchParams.get('sort')?.trim() ?? 'poDate:desc'

  const where: Prisma.PurchaseOrderWhereInput = {}
  if (status) where.status = status
  if (customerId) where.customerId = customerId

  if (deepSearch.length >= 2) {
    const mode = Prisma.QueryMode.insensitive
    where.OR = [
      { poNumber: { contains: deepSearch, mode } },
      { customer: { name: { contains: deepSearch, mode } } },
      {
        lineItems: {
          some: { cartonName: { contains: deepSearch, mode } },
        },
      },
    ]
  }

  const orderBy =
    sort === 'poDate:asc'
      ? ({ poDate: 'asc' } as const)
      : sort === 'poNumber:asc'
        ? ({ poNumber: 'asc' } as const)
        : sort === 'poNumber:desc'
          ? ({ poNumber: 'desc' } as const)
          : ({ poDate: 'desc' } as const)

  const [listRaw, total] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      orderBy,
      ...(exportRequested ? {} : { take: limit, skip: listSkip(page, limit) }),
      ...(compact
        ? {
            select: {
              id: true,
              poNumber: true,
              poDate: true,
              status: true,
              remarks: true,
              isPriority: true,
              customer: { select: { id: true, name: true } },
              lineItems: {
                select: {
                  id: true,
                  cartonName: true,
                  cartonSize: true,
                  quantity: true,
                  rate: true,
                  gsm: true,
                  paperType: true,
                  coatingType: true,
                  embossingLeafing: true,
                  setNumber: true,
                  jobCardNumber: true,
                  planningStatus: true,
                  dieMasterId: true,
                  cartonId: true,
                  materialProcurementStatus: true,
                },
              },
            },
          }
        : {
            include: {
              customer: { select: { id: true, name: true } },
              lineItems: true,
            },
          }),
    } as Prisma.PurchaseOrderFindManyArgs),
    paged ? db.purchaseOrder.count({ where }) : Promise.resolve(null),
  ])
  const list = listRaw as any[]

  const mapped = list.map((po) => {
    const lineItems = po.lineItems as any[]
    const value = lineItems.reduce((sum, li) => {
      const rate = li.rate ? Number(li.rate) : 0
      return sum + rate * li.quantity
    }, 0)
    return {
      ...po,
      value,
    }
  })

  const allDieIds = jobCardLookup
    ? []
    : Array.from(
    new Set(
      mapped.flatMap((po) =>
        (po.lineItems as any[]).map((li) => li.dieMasterId).filter((id): id is string => Boolean(id)),
      ),
    ),
  )
  const dyes =
    allDieIds.length > 0
      ? await db.dye.findMany({
          where: { id: { in: allDieIds } },
          select: {
            id: true,
            custodyStatus: true,
            condition: true,
            dyeNumber: true,
            location: true,
            hubStatusFlag: true,
          },
        })
      : []
  const dyeById = dyeMapFromRows(dyes)

  const dsLower = deepSearch.length >= 2 ? deepSearch.toLowerCase() : ''

  const withTooling = mapped.map((po) => {
    let deepMatchProductName: string | null = null
    if (dsLower) {
      const headerMatch =
        po.poNumber.toLowerCase().includes(dsLower) ||
        po.customer.name.toLowerCase().includes(dsLower)
      const lineHit = (po.lineItems as any[]).find((li) => li.cartonName.toLowerCase().includes(dsLower))
      if (lineHit && !headerMatch) deepMatchProductName = lineHit.cartonName
    }
    return {
      ...po,
      ...(jobCardLookup
        ? {}
        : {
            toolingCritical: poHasCriticalTooling(po.lineItems as any, dyeById),
            readiness: computePoReadiness(po.lineItems as any, dyeById),
          }),
      deepMatchProductName,
    }
  })

  logListPerformance({
    route: '/api/purchase-orders',
    startedAt,
    rowCount: withTooling.length,
    limit: exportRequested ? null : limit,
    mode: compact ? 'compact' : 'full',
    exportRequested,
  })

  if (paged) {
    return NextResponse.json({
      rows: withTooling,
      meta: {
        page,
        limit: exportRequested ? withTooling.length : limit,
        total: total ?? withTooling.length,
        hasMore: total != null ? page * limit < total : false,
        mode: compact ? 'compact' : 'full',
      },
    })
  }

  return NextResponse.json(withTooling)
}

export async function POST(req: NextRequest) {
  try {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    lineItems: Array.isArray(body.lineItems)
      ? body.lineItems.map((li: any) => ({
          ...li,
          quantity: toOptionalNumber(li.quantity),
          rate: toOptionalNumber(li.rate),
          gsm: toOptionalNumber(li.gsm),
          gstPct: toOptionalNumber(li.gstPct),
          specOverrides:
            li.specOverrides && typeof li.specOverrides === 'object'
              ? {
                  ...li.specOverrides,
                  ups: toOptionalNumber(li.specOverrides.ups),
                  wastagePct: toOptionalNumber(li.specOverrides.wastagePct),
                  requiredSheets: toOptionalNumber(li.specOverrides.requiredSheets),
                  totalSheets: toOptionalNumber(li.specOverrides.totalSheets),
                }
              : undefined,
        }))
      : [],
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
  const safeLineItems = await sanitizeCartonIds(data.lineItems)

  const rawPoNumber = data.poNumber?.trim()
  let poNumber: string
  if (rawPoNumber) {
    const existing = await db.purchaseOrder.findUnique({
      where: { poNumber: rawPoNumber },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'PO number already exists', fields: { poNumber: 'This PO number is already in use' } },
        { status: 400 }
      )
    }
    poNumber = rawPoNumber
  } else {
    const lastPo = await db.purchaseOrder.findFirst({
      orderBy: { poNumber: 'desc' },
      select: { poNumber: true },
    })
    poNumber = buildPoNumber(lastPo?.poNumber ?? null)
  }

  let created: Awaited<ReturnType<typeof db.purchaseOrder.create>>
  try {
    created = await db.$transaction(
      (tx) =>
        createPurchaseOrderWithLines(tx, {
          poNumber,
          customerId: data.customerId,
          poDate: new Date(data.poDate),
          deliveryRequiredBy: data.deliveryRequiredBy?.trim()
            ? new Date(data.deliveryRequiredBy.trim())
            : null,
          remarks: data.remarks || null,
          status: data.status || 'draft',
          isPriority: data.isPriority === true,
          createdBy: user!.id,
          lineItems: safeLineItems.map((li) => ({
            cartonId: li.cartonId,
            cartonName: li.cartonName,
            cartonSize: li.cartonSize || null,
            quantity: li.quantity,
            artworkCode: li.artworkCode || null,
            backPrint: li.backPrint || 'No',
            rate: li.rate ?? null,
            gsm: li.gsm ?? null,
            gstPct: li.gstPct,
            coatingType: li.coatingType || null,
            otherCoating: li.otherCoating || null,
            embossingLeafing: li.embossingLeafing || null,
            paperType: li.paperType || null,
            dyeId: li.dyeId || null,
            remarks: li.remarks || null,
            setNumber: li.setNumber || null,
            dieMasterId: li.dieMasterId || null,
            toolingLocked: li.toolingLocked ?? true,
            lineDieType: li.lineDieType || null,
            dimLengthMm: li.dimLengthMm ?? null,
            dimWidthMm: li.dimWidthMm ?? null,
            dimHeightMm: li.dimHeightMm ?? null,
            specOverrides:
              li.specOverrides && Object.keys(li.specOverrides).length > 0
                ? (li.specOverrides as Record<string, unknown>)
                : null,
          })),
        }),
      // Neon round-trips + per-line material-MRP work occasionally pushed the
      // 5 s default over the cliff. 30 s is comfortably above worst-case
      // observed without masking a real regression.
      { maxWait: 10_000, timeout: 30_000 },
    )
  } catch (err) {
    console.error('[POST /api/purchase-orders] DB error:', err)
    const message = err instanceof Error ? err.message : 'Database error while saving PO'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'purchase_orders',
    recordId: created.id,
    newValue: { poNumber, customerId: created.customerId, actorLabel: 'Anik Dua' },
  })

  return NextResponse.json(created, { status: 201 })
  } catch (err) {
    console.error('[POST /api/purchase-orders] Unhandled error:', err)
    const message = err instanceof Error ? err.message : 'Unexpected server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
