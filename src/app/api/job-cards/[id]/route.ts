import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  computeJobYieldMetricsForCard,
  shortCloseFloorStockForJob,
  YIELD_FINAL_AUDIT_MESSAGE,
} from '@/lib/production-yield'
import { persistProductionOeeLedger } from '@/lib/production-oee'
import { incrementEmbossStrikesOnJobClose } from '@/lib/production-emboss-strikes'
import { z } from 'zod'
import { computeBoardMaterialForJobCard } from '@/lib/job-card-board-material'
import { postPressRoutingSchema } from '@/lib/job-card-routing-spec'

export const dynamic = 'force-dynamic'

function auditTimelineSummary(nv: unknown): string {
  if (!nv || typeof nv !== 'object') return 'Update'
  const o = nv as Record<string, unknown>
  if (o.jobCardNumber != null && o.poLineItemId != null) {
    return `Job card #${String(o.jobCardNumber)} created`
  }
  if (o.orchestrationSource === 'aw_orchestration') return 'AW orchestration · job card'
  if (o.cuttingQueueEnqueuedAt != null) return 'Cutting queue enqueue'
  if (o.postPressRouting != null || o.machineId !== undefined) return 'Print plan / machine update'
  if (o.status != null) return `Status → ${String(o.status)}`
  const keys = Object.keys(o).slice(0, 5)
  return keys.length ? keys.join(', ') : 'Update'
}

function fmtMm(d: unknown): string {
  const n = Number(d)
  return Number.isFinite(n) ? String(Math.round(n)) : '—'
}

function monthsBetweenStart(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), 1)
  const b = new Date(to.getFullYear(), to.getMonth(), 1)
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
}

function formatStorageParts(parts: (string | null | undefined)[]): string {
  const s = parts.map((p) => (p != null ? String(p).trim() : '')).filter(Boolean)
  return s.length ? s.join(' · ') : '—'
}

const stageUpdateSchema = z.object({
  id: z.string().uuid(),
  status: z.string().optional(),
  operator: z.string().optional().nullable(),
  counter: z.number().int().optional().nullable(),
  sheetSize: z.string().optional().nullable(),
  excessSheets: z.number().int().min(0).optional().nullable(),
})

const updateSchema = z.object({
  assignedOperator: z.string().optional().nullable(),
  shiftOperatorUserId: z.string().uuid().optional().nullable(),
  batchNumber: z.string().optional().nullable(),
  machineId: z.string().uuid().optional().nullable(),
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
      shiftOperator: { select: { id: true, name: true } },
      stages: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  let poLine: Awaited<ReturnType<typeof db.poLineItem.findFirst>> & {
    carton?: {
      id: string
      coatingType: string | null
      laminateType: string | null
      foilType: string | null
      embossingLeafing: string | null
      embossBlockId: string | null
    } | null
    materialProcurementStatus?: string
    materialQueue?: {
      sheetLengthMm: unknown
      sheetWidthMm: unknown
      ups: number
      grainDirection: string
      totalSheets: number
      boardType: string
      gsm: number
    } | null
    shadeCard?: {
      id: string
      shadeCode: string
      mfgDate: Date | null
      approvalDate: Date | null
      createdAt: Date
      custodyStatus: string
    } | null
  } =
    jc.jobCardNumber != null
      ? await db.poLineItem.findFirst({
          where: { jobCardNumber: jc.jobCardNumber },
          include: {
            po: { select: { poNumber: true } },
            materialQueue: {
              select: {
                sheetLengthMm: true,
                sheetWidthMm: true,
                ups: true,
                grainDirection: true,
                totalSheets: true,
                boardType: true,
                gsm: true,
              },
            },
            shadeCard: {
              select: {
                id: true,
                shadeCode: true,
                mfgDate: true,
                approvalDate: true,
                createdAt: true,
                custodyStatus: true,
              },
            },
          },
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

  const mq = poLine?.materialQueue ?? null
  const sheetSizeLabel =
    mq != null ? `${fmtMm(mq.sheetLengthMm)}×${fmtMm(mq.sheetWidthMm)} mm` : null

  const scRow = poLine?.shadeCard ?? null
  let shadeCardBible: {
    shadeCode: string
    ageMonths: number
    expired: boolean
    custodyStatus: string
  } | null = null
  if (scRow) {
    const ref = scRow.mfgDate ?? scRow.approvalDate ?? scRow.createdAt
    const ageMonths = monthsBetweenStart(ref, new Date())
    shadeCardBible = {
      shadeCode: scRow.shadeCode,
      ageMonths,
      expired: ageMonths > 12,
      custodyStatus: scRow.custodyStatus,
    }
  }

  const [plateRow, dieRow, embossRow] = await Promise.all([
    jc.plateSetId
      ? db.plateStore.findUnique({
          where: { id: jc.plateSetId },
          select: {
            plateSetCode: true,
            rackNumber: true,
            rackLocation: true,
            slotNumber: true,
            storageLocation: true,
            status: true,
          },
        })
      : Promise.resolve(null),
    poLine?.dyeId
      ? db.dye.findUnique({
          where: { id: poLine.dyeId },
          select: {
            dyeNumber: true,
            location: true,
            custodyStatus: true,
          },
        })
      : Promise.resolve(null),
    jc.embossBlockId
      ? db.embossBlock.findUnique({
          where: { id: jc.embossBlockId },
          select: {
            blockCode: true,
            storageLocation: true,
            custodyStatus: true,
          },
        })
      : Promise.resolve(null),
  ])

  const toolingKit = {
    plate: plateRow
      ? {
          code: plateRow.plateSetCode,
          coordinates: formatStorageParts([
            plateRow.rackLocation,
            plateRow.rackNumber ? `Rack ${plateRow.rackNumber}` : null,
            plateRow.slotNumber ? `Slot ${plateRow.slotNumber}` : null,
            plateRow.storageLocation,
          ]),
          hubStatus: plateRow.status,
        }
      : null,
    die: dieRow
      ? {
          code: `#${dieRow.dyeNumber}`,
          coordinates: formatStorageParts([dieRow.location]),
          custodyStatus: dieRow.custodyStatus,
        }
      : null,
    emboss: embossRow
      ? {
          code: embossRow.blockCode,
          coordinates: formatStorageParts([embossRow.storageLocation]),
          custodyStatus: embossRow.custodyStatus,
        }
      : null,
    shade: shadeCardBible,
  }

  const productionBible = {
    sheetSizeLabel,
    ups: mq?.ups ?? null,
    grainDirection: mq?.grainDirection ?? null,
    toolingKit,
    shadeCard: shadeCardBible,
  }

  const boardMaterial = await computeBoardMaterialForJobCard(
    db,
    { id: jc.id, totalSheets: jc.totalSheets, sheetsIssued: jc.sheetsIssued },
    poLine
      ? {
          materialProcurementStatus: poLine.materialProcurementStatus,
          materialQueue: poLine.materialQueue,
        }
      : null,
  )

  const wantTimeline = req.nextUrl.searchParams.get('auditTimeline') === '1'
  let auditTimeline:
    | {
        id: string
        at: string
        action: string
        tableName: string
        userName: string | null
        summary: string
      }[]
    | undefined
  if (wantTimeline) {
    const or: Array<{ tableName: string; recordId: string }> = [
      { tableName: 'production_job_cards', recordId: id },
    ]
    if (poLine?.id) {
      or.push({ tableName: 'po_line_items', recordId: poLine.id })
    }
    const logs = await db.auditLog.findMany({
      where: { OR: or },
      orderBy: { timestamp: 'asc' },
      take: 120,
      select: {
        id: true,
        timestamp: true,
        action: true,
        tableName: true,
        newValue: true,
        user: { select: { name: true } },
      },
    })
    auditTimeline = logs.map((l) => ({
      id: String(l.id),
      at: l.timestamp.toISOString(),
      action: l.action,
      tableName: l.tableName,
      userName: l.user?.name ?? null,
      summary: auditTimelineSummary(l.newValue),
    }))
  }

  return NextResponse.json({
    ...jc,
    poLine,
    productionBible,
    boardMaterial,
    ...(auditTimeline != null ? { auditTimeline } : {}),
  })
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
  const isClosing = data.status === 'closed' && existing.status !== 'closed'

  if (data.machineId !== undefined && data.machineId !== null && data.machineId !== '') {
    const m = await db.machine.findUnique({ where: { id: data.machineId }, select: { id: true } })
    if (!m) {
      return NextResponse.json(
        { error: 'Invalid machineId', fields: { machineId: 'Machine not found' } },
        { status: 400 },
      )
    }
  }

  let mergedPostPress: object | undefined
  if (data.postPressRouting !== undefined) {
    const prev =
      existing.postPressRouting && typeof existing.postPressRouting === 'object'
        ? (existing.postPressRouting as Record<string, unknown>)
        : {}
    const incoming = data.postPressRouting === null ? {} : (data.postPressRouting as Record<string, unknown>)
    const combined = { ...prev, ...incoming }
    const checked = postPressRoutingSchema.safeParse(combined)
    mergedPostPress = (checked.success ? checked.data : combined) as object
  }

  const requestsRelease =
    (data.qaReleased === true && !existing.qaReleased) ||
    (data.status === 'qa_released' && existing.status !== 'qa_released') ||
    (data.status === 'closed' && existing.status !== 'closed')
  if (requestsRelease && existing.grainFitStatus === 'critical_mismatch') {
    return NextResponse.json(
      {
        error:
          'CRITICAL: STOCK SIZE MISMATCH — inventory sheet size is smaller than AW target sheet size. Resolve material or artwork before release.',
      },
      { status: 400 },
    )
  }

  const updated = await db.$transaction(async (tx) => {
    const header = await tx.productionJobCard.update({
      where: { id },
      data: {
        ...(data.assignedOperator !== undefined
          ? { assignedOperator: data.assignedOperator }
          : {}),
        ...(data.shiftOperatorUserId !== undefined
          ? { shiftOperatorUserId: data.shiftOperatorUserId }
          : {}),
        ...(data.batchNumber !== undefined ? { batchNumber: data.batchNumber } : {}),
        ...(data.machineId !== undefined ? { machineId: data.machineId } : {}),
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
        ...(mergedPostPress !== undefined ? { postPressRouting: mergedPostPress } : {}),
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
        data.stages.map((s) => {
          const prev = existing.stages.find((r) => r.id === s.id)
          const counterTicked =
            prev &&
            s.counter !== undefined &&
            s.counter !== prev.counter
          const becameInProgress =
            s.status === 'in_progress' && prev && prev.status !== 'in_progress'
          const leftInProgress =
            s.status != null &&
            s.status !== 'in_progress' &&
            prev?.status === 'in_progress'

          return tx.productionStageRecord.update({
            where: { id: s.id },
            data: {
              ...(s.status !== undefined ? { status: s.status } : {}),
              ...(s.operator !== undefined ? { operator: s.operator } : {}),
              ...(s.counter !== undefined ? { counter: s.counter } : {}),
              ...(s.sheetSize !== undefined ? { sheetSize: s.sheetSize } : {}),
              ...(s.excessSheets !== undefined ? { excessSheets: s.excessSheets } : {}),
              ...(s.status === 'completed' ? { completedAt: new Date() } : {}),
              ...(counterTicked ? { lastProductionTickAt: new Date() } : {}),
              ...(becameInProgress ? { inProgressSince: new Date() } : {}),
              ...(leftInProgress ? { inProgressSince: null } : {}),
            },
          })
        }),
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

    if (isClosing) {
      await shortCloseFloorStockForJob(tx, id)
    }

    return header
  })

  let yieldAudit: Record<string, unknown> = {}
  if (isClosing) {
    await persistProductionOeeLedger(db, id)
    await incrementEmbossStrikesOnJobClose(db, id, user?.name ?? null)
  }

  if (isClosing) {
    const jc = await db.productionJobCard.findUnique({
      where: { id },
      include: { stages: true },
    })
    const poLine =
      jc?.jobCardNumber != null
        ? await db.poLineItem.findFirst({
            where: { jobCardNumber: jc.jobCardNumber },
            select: {
              gsm: true,
              dimLengthMm: true,
              dimWidthMm: true,
              carton: {
                select: {
                  finishedLength: true,
                  finishedWidth: true,
                  blankLength: true,
                  blankWidth: true,
                  gsm: true,
                },
              },
            },
          })
        : null
    if (jc) {
      const yieldMetrics = await computeJobYieldMetricsForCard(db, jc, poLine)
      yieldAudit = {
        yieldFinalAudit: YIELD_FINAL_AUDIT_MESSAGE,
        yieldMetrics,
      }
    }
  }

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'production_job_cards',
    recordId: id,
    newValue: isClosing ? { ...data, ...yieldAudit } : data,
  })

  return NextResponse.json(updated)
}

