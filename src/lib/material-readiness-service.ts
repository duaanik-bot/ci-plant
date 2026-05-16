import type { Prisma } from '@prisma/client'
import { subDays } from 'date-fns'
import { db } from '@/lib/db'
import { resolveRequirementFromLine } from '@/lib/production-os-resolvers'

type DbClient = typeof db | Prisma.TransactionClient

async function withTransaction<T>(client: DbClient, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ('$transaction' in client) {
    return client.$transaction(async (tx) => fn(tx), {
      maxWait: 5000,
      timeout: 15000,
    })
  }
  return fn(client)
}

type RequirementResult = {
  jobCardId: string
  planningId: string | null
  requiredSheets: number
  materialId: string | null
}

type PlanningPrImpactAction = 'keep' | 'reduce' | 'cancel_if_no_shortage'

type PlanningReservationControlInput = {
  planningId: string
  materialId: string
  requiredSheets: number
  targetReservedSheets: number
  prQty?: number
  actorUserId?: string | null
  reason?: string | null
  prImpactAction?: PlanningPrImpactAction
}

export class ShortagePrRecoveryError extends Error {
  shortageId: string

  constructor(shortageId: string, message = 'Reservation saved, but Purchase Request creation failed. Retry PR creation.') {
    super(message)
    this.name = 'ShortagePrRecoveryError'
    this.shortageId = shortageId
  }
}

function asNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function formatSheetDim(value: unknown): string | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n.toString()
}

function dateBucketKey(d: Date | null | undefined): string {
  if (!d) return 'none'
  const iso = d.toISOString()
  return iso.slice(0, 7) // YYYY-MM
}

function asPositive(v: unknown): number {
  const x = Number(v)
  if (!Number.isFinite(x) || x <= 0) return 0
  return x
}

function asNonNegativeInt(v: unknown): number {
  const x = Number(v)
  if (!Number.isFinite(x) || x <= 0) return 0
  return Math.floor(x)
}

async function getPlanningReservedSheets(
  tx: Prisma.TransactionClient,
  materialId: string,
  planningId: string,
) {
  const rows = await tx.stockMovement.findMany({
    where: {
      materialId,
      refId: planningId,
      refType: {
        in: [
          'planning_reserve',
          'planning_release',
          'planning_adjust_increase',
          'planning_adjust_decrease',
        ],
      },
    },
    select: { refType: true, qty: true },
  })

  let total = 0
  for (const r of rows) {
    const q = asNumber(r.qty)
    if (r.refType === 'planning_reserve' || r.refType === 'planning_adjust_increase') total += q
    if (r.refType === 'planning_release' || r.refType === 'planning_adjust_decrease') total -= q
  }
  return Math.max(0, total)
}

async function upsertPlanningShortage(
  tx: Prisma.TransactionClient,
  args: {
    materialId: string
    planningId: string
    shortageQty: number
    requiredByDate?: Date | null
  },
) {
  const existing = await tx.materialShortage.findFirst({
    where: {
      materialId: args.materialId,
      planningId: args.planningId,
      jobCardId: null,
      status: 'open',
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, remainingQty: true, purchaseReqId: true },
  })

  const currentShortage = existing ? Math.max(0, asNumber(existing.remainingQty)) : 0
  const delta = args.shortageQty - currentShortage
  if (delta !== 0) {
    await tx.inventory.update({
      where: { id: args.materialId },
      data:
        delta > 0
          ? { shortageSheets: { increment: delta } }
          : { shortageSheets: { decrement: Math.abs(delta) } },
    })
  }

  if (args.shortageQty <= 0) {
    if (existing) {
      await tx.materialShortage.update({
        where: { id: existing.id },
        data: { remainingQty: 0, status: 'closed' },
      })
    }
    return { shortageId: null as string | null, purchaseReqId: existing?.purchaseReqId ?? null }
  }

  const shortage = existing
    ? await tx.materialShortage.update({
        where: { id: existing.id },
        data: {
          shortageQty: args.shortageQty,
          remainingQty: args.shortageQty,
          sourcePoLineId: args.planningId,
          triggerReason: 'planning_shortage',
          requiredByDate: args.requiredByDate ?? null,
          status: 'open',
        },
        select: { id: true, purchaseReqId: true },
      })
    : await tx.materialShortage.create({
        data: {
          materialId: args.materialId,
          planningId: args.planningId,
          jobCardId: null,
          sourcePoLineId: args.planningId,
          triggerReason: 'planning_shortage',
          shortageQty: args.shortageQty,
          remainingQty: args.shortageQty,
          allocatedQty: 0,
          requiredByDate: args.requiredByDate ?? null,
          status: 'open',
        },
        select: { id: true, purchaseReqId: true },
      })

  return { shortageId: shortage.id, purchaseReqId: shortage.purchaseReqId ?? null }
}

async function syncPrForShortage(
  tx: Prisma.TransactionClient,
  args: {
    shortageId: string | null
    shortageQty: number
    prQty: number
    prImpactAction: PlanningPrImpactAction
  },
) {
  if (!args.shortageId) return { prId: null as string | null }

  const shortage = await tx.materialShortage.findUnique({
    where: { id: args.shortageId },
    select: { purchaseReqId: true },
  })
  if (!shortage?.purchaseReqId) return { prId: null as string | null }

  const pr = await tx.purchaseRequisition.findUnique({
    where: { id: shortage.purchaseReqId },
    select: { id: true, status: true },
  })
  if (!pr) return { prId: null as string | null }

  if (pr.status === 'received') return { prId: pr.id }

  if (args.prImpactAction === 'keep') return { prId: pr.id }

  if (args.prImpactAction === 'cancel_if_no_shortage' && args.shortageQty <= 0) {
    await tx.purchaseRequisition.update({
      where: { id: pr.id },
      data: {
        qtyRequired: 0,
        status: 'rejected',
      },
    })
    return { prId: pr.id }
  }

  await tx.purchaseRequisition.update({
    where: { id: pr.id },
    data: { qtyRequired: Math.max(0, args.prQty) },
  })
  return { prId: pr.id }
}

async function shortagePriorityKey(
  planningId: string | null | undefined,
  client: DbClient = db,
): Promise<'high' | 'normal'> {
  if (!planningId) return 'normal'
  const line = await client.poLineItem.findUnique({
    where: { id: planningId },
    select: { directorPriority: true, po: { select: { isPriority: true } } },
  })
  if (!line) return 'normal'
  return line.directorPriority || line.po?.isPriority ? 'high' : 'normal'
}

async function resolvePlanningLineByJobCard(client: DbClient, jobCardId: string) {
  const jc = await client.productionJobCard.findUnique({ where: { id: jobCardId } })
  if (!jc?.jobCardNumber) return { jc, line: null }
  const line = await client.poLineItem.findFirst({
    where: { jobCardNumber: jc.jobCardNumber },
    include: {
      materialQueue: true,
    },
  })
  return { jc, line }
}

async function resolveMaterialIdForLine(client: DbClient, line: { materialQueue: { boardType: string; gsm: number; sheetLengthMm: Prisma.Decimal; sheetWidthMm: Prisma.Decimal } | null; specOverrides: Prisma.JsonValue | null }) {
  const spec = line.specOverrides && typeof line.specOverrides === 'object'
    ? (line.specOverrides as Record<string, unknown>)
    : {}
  const planningCore = spec.planningCore && typeof spec.planningCore === 'object'
    ? (spec.planningCore as Record<string, unknown>)
    : {}
  const explicitCandidates = [
    spec.planningMaterialId,
    spec.materialId,
    spec.selectedMaterialId,
    spec.chosenMaterialId,
    spec.inventoryMaterialId,
    planningCore.materialId,
  ]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
  for (const explicit of explicitCandidates) {
    const hit = await client.inventory.findUnique({ where: { id: explicit }, select: { id: true } })
    if (hit) return hit.id
  }

  const mq = line.materialQueue
  if (!mq) return null

  const bySpec = await client.inventory.findFirst({
    where: {
      active: true,
      boardType: mq.boardType,
      gsm: mq.gsm,
      sheetLength: mq.sheetLengthMm,
      sheetWidth: mq.sheetWidthMm,
    },
    select: { id: true },
  })

  return bySpec?.id ?? null
}

export async function calculateRequirement(input: { jobCardId?: string; planningId?: string }, client: DbClient = db): Promise<RequirementResult> {
  if (!input.jobCardId && !input.planningId) {
    throw new Error('Either jobCardId or planningId is required')
  }

  if (input.planningId) {
    const line = await client.poLineItem.findUnique({
      where: { id: input.planningId },
      include: { materialQueue: true },
    })
    if (!line) throw new Error('Planning line not found')

    const requiredFromResolver = resolveRequirementFromLine({ line }).requiredSheets
    const requiredSheets = Math.max(0, asNumber(line.materialQueue?.totalSheets) || requiredFromResolver)

    if (!input.jobCardId) {
      const jc = line.jobCardNumber
        ? await client.productionJobCard.findFirst({ where: { jobCardNumber: line.jobCardNumber } })
        : null
      if (!jc) throw new Error('Job card not found for planning line')
      const materialId = await resolveMaterialIdForLine(client, line)
      return { jobCardId: jc.id, planningId: line.id, requiredSheets, materialId }
    }

    const materialId = await resolveMaterialIdForLine(client, line)
    return { jobCardId: input.jobCardId, planningId: line.id, requiredSheets, materialId }
  }

  const jobCardId = input.jobCardId!
  const { jc, line } = await resolvePlanningLineByJobCard(client, jobCardId)
  if (!jc) throw new Error('Job card not found')

  const requiredFromQueue = asNumber(line?.materialQueue?.totalSheets)
  const requiredFromResolver = line ? resolveRequirementFromLine({ line }).requiredSheets : 0
  const requiredSheets = Math.max(
    0,
    requiredFromQueue || requiredFromResolver || asNumber(jc.totalSheets) || asNumber(jc.requiredSheets),
  )
  const materialId = line ? await resolveMaterialIdForLine(client, line) : null

  return {
    jobCardId,
    planningId: line?.id ?? null,
    requiredSheets,
    materialId,
  }
}

export async function createShortage(
  materialId: string,
  jobCardId: string | null,
  planningId: string | null,
  shortageQty: number,
  client: DbClient = db,
) {
  if (shortageQty <= 0) throw new Error('Shortage qty must be positive')

  return withTransaction(client, async (tx) => {
    const existing = await tx.materialShortage.findFirst({
      where: { materialId, jobCardId, planningId: planningId ?? null, status: 'open' },
      orderBy: { createdAt: 'desc' },
    })
    const shortage = existing
      ? await tx.materialShortage.update({
          where: { id: existing.id },
          data: {
            shortageQty: { increment: shortageQty },
            remainingQty: { increment: shortageQty },
          },
        })
      : await tx.materialShortage.create({
          data: {
            materialId,
            jobCardId: jobCardId ?? undefined,
            planningId: planningId ?? undefined,
            sourcePoLineId: planningId ?? undefined,
            triggerReason: planningId ? 'planning_shortage' : 'jobcard_shortage',
            shortageQty,
            remainingQty: shortageQty,
            status: 'open',
          },
        })

    await tx.inventory.update({
      where: { id: materialId },
      data: { shortageSheets: { increment: shortageQty } },
    })

    return shortage
  })
}

export async function createPurchaseRequestFromShortage(shortageId: string, client: DbClient = db) {
  return withTransaction(client, async (tx) => {
    const shortage = await tx.materialShortage.findUnique({
      where: { id: shortageId },
      select: {
        id: true,
        materialId: true,
        jobCardId: true,
        planningId: true,
        sourcePoLineId: true,
        triggerReason: true,
        shortageQty: true,
        allocatedQty: true,
        remainingQty: true,
        status: true,
        purchaseReqId: true,
        requiredByDate: true,
      },
    })
    if (!shortage) throw new Error('Shortage not found')

    if (shortage.purchaseReqId) {
      const existing = await tx.purchaseRequisition.findUnique({ where: { id: shortage.purchaseReqId } })
      if (existing) return existing
    }

    const dup = await tx.purchaseRequisition.findFirst({ where: { shortageId: shortage.id } })
    if (dup) {
      await tx.materialShortage.update({ where: { id: shortage.id }, data: { purchaseReqId: dup.id } })
      return dup
    }

    const material = await tx.inventory.findUnique({ where: { id: shortage.materialId } })
    if (!material) throw new Error('Material not found')

    const shortageBucket = dateBucketKey(shortage.requiredByDate ?? null)
    const shortagePriority = await shortagePriorityKey(shortage.planningId, tx)
      const openForMaterial = await tx.purchaseRequisition.findFirst({
        where: {
          materialId: shortage.materialId,
          status: { in: ['pending', 'approved', 'converted_to_po'] },
          supplierId: material.supplierId ?? null,
      },
      orderBy: { raisedAt: 'desc' },
    })
    if (openForMaterial) {
      const linkedShortage = openForMaterial.shortageId
        ? await tx.materialShortage.findUnique({
            where: { id: openForMaterial.shortageId },
            select: { planningId: true, requiredByDate: true },
          })
        : null
      const openBucket = dateBucketKey(linkedShortage?.requiredByDate ?? null)
      const openPriority = await shortagePriorityKey(linkedShortage?.planningId ?? null, tx)
      if (openBucket === shortageBucket && openPriority === shortagePriority) {
        const merged = await tx.purchaseRequisition.update({
          where: { id: openForMaterial.id },
          data: {
            qtyRequired: { increment: shortage.remainingQty },
            triggerReason: `${openForMaterial.triggerReason}; merged-shortage:${shortage.id}; ${shortage.jobCardId ? `job:${shortage.jobCardId}` : `planning:${shortage.planningId ?? '-'}`}`,
          },
        })
        await tx.materialShortage.update({ where: { id: shortage.id }, data: { purchaseReqId: merged.id } })
        return merged
      }
    }

    const length = formatSheetDim(material.sheetLength)
    const width = formatSheetDim(material.sheetWidth)
    const sizeLabel = length && width ? `${length}x${width}` : null

    const planningLine = shortage.planningId
      ? await tx.poLineItem.findUnique({
          where: { id: shortage.planningId },
          select: {
            id: true,
            cartonName: true,
            po: { select: { poNumber: true, deliveryRequiredBy: true } },
          },
        })
      : null
    const cartonRef = planningLine?.cartonName?.trim() || ''
    const poRef = planningLine?.po?.poNumber?.trim() || ''

    const pr = await tx.purchaseRequisition.create({
      data: {
        materialId: shortage.materialId,
        qtyRequired: shortage.remainingQty,
        estimatedValue: 0,
        triggerReason: [
          shortage.triggerReason || 'planning_shortage_auto',
          shortage.planningId ? `line:${shortage.planningId}` : null,
          shortage.sourcePoLineId ? `poLine:${shortage.sourcePoLineId}` : null,
          cartonRef ? `carton:${cartonRef}` : null,
          poRef ? `po:${poRef}` : null,
        ]
          .filter(Boolean)
          .join(';'),
        status: 'pending',
        raisedBy: 'system',
        boardType: material.boardType ?? undefined,
        sizeLabel: sizeLabel ?? undefined,
        gsm: material.gsm ?? undefined,
        sourceJobCardId: shortage.jobCardId ?? undefined,
        sourcePlanningId: shortage.planningId ?? undefined,
        expectedDelivery: planningLine?.po?.deliveryRequiredBy ?? undefined,
        shortageId: shortage.id,
      },
    })

    await tx.materialShortage.update({ where: { id: shortage.id }, data: { purchaseReqId: pr.id } })

    return pr
  })
}

export async function reserveMaterial(
  materialId: string,
  jobCardId: string,
  requiredSheets: number,
  planningId?: string,
  client: DbClient = db,
) {
  if (requiredSheets <= 0) throw new Error('Required sheets must be positive')

  const txResult = await withTransaction(client, async (tx) => {
    const material = await tx.inventory.findUnique({ where: { id: materialId } })
    if (!material) throw new Error('Material not found')

    const available = Math.max(0, asNumber(material.qtyAvailable))
    const reserveQty = Math.min(available, requiredSheets)
    const shortageQty = Math.max(0, requiredSheets - reserveQty)

    if (reserveQty > 0) {
      const updated = await tx.inventory.updateMany({
        where: { id: materialId, qtyAvailable: { gte: reserveQty } },
        data: {
          qtyAvailable: { decrement: reserveQty },
          qtyReserved: { increment: reserveQty },
        },
      })
      if (updated.count === 0) {
        throw new Error('Stock changed. Please refresh and reserve again.')
      }

      await tx.stockMovement.create({
        data: {
          materialId,
          movementType: 'reserve',
          qty: reserveQty,
          refType: 'job_card_reserve',
          refId: jobCardId,
        },
      })
    }

    const status = shortageQty > 0 ? 'partial_shortage' : 'fully_reserved'
    const reservation = await tx.materialReservation.upsert({
      where: { materialId_jobCardId: { materialId, jobCardId } },
      create: {
        materialId,
        jobCardId,
        planningId,
        requiredSheets,
        reservedSheets: reserveQty,
        shortageSheets: shortageQty,
        status,
      },
      update: {
        planningId,
        requiredSheets,
        reservedSheets: reserveQty,
        shortageSheets: shortageQty,
        status,
      },
    })

    let shortage: { id: string } | null = null

    if (shortageQty > 0) {
      const existingShortage = await tx.materialShortage.findFirst({
        where: { materialId, jobCardId, planningId: planningId ?? null, status: 'open' },
        orderBy: { createdAt: 'desc' },
      })
      shortage = existingShortage
        ? await tx.materialShortage.update({
            where: { id: existingShortage.id },
            data: {
              shortageQty: { increment: shortageQty },
              remainingQty: { increment: shortageQty },
            },
          })
        : await tx.materialShortage.create({
            data: {
              materialId,
              jobCardId,
              planningId: planningId ?? undefined,
              shortageQty,
              remainingQty: shortageQty,
              status: 'open',
            },
          })

      await tx.inventory.update({
        where: { id: materialId },
        data: { shortageSheets: { increment: shortageQty } },
      })

    }

    return {
      status,
      requiredSheets,
      reservedSheets: reserveQty,
      shortageSheets: shortageQty,
      reservation,
      shortage,
    }
  })

  let purchaseRequest: { id: string } | null = null
  if (txResult.shortage?.id) {
    // Keep reservation transaction short to avoid interactive tx timeout (P2028).
    try {
      purchaseRequest = await createPurchaseRequestFromShortage(txResult.shortage.id, db)
    } catch (error) {
      const msg = error instanceof Error && error.message ? error.message : 'Purchase Request creation failed'
      throw new ShortagePrRecoveryError(
        txResult.shortage.id,
        `Reservation saved with shortage, but PR creation failed. You can retry using "Create PR for Shortage". (${msg})`,
      )
    }
  }

  return {
    ...txResult,
    purchaseRequest,
  }
}

export async function reserveMaterialForPlanning(
  materialId: string,
  requiredSheets: number,
  planningId: string,
  client: DbClient = db,
) {
  if (requiredSheets <= 0) throw new Error('Required sheets must be positive')
  if (!planningId) throw new Error('Planning line is required')

  const txResult = await withTransaction(client, async (tx) => {
    const planningLine = await tx.poLineItem.findUnique({
      where: { id: planningId },
      select: {
        id: true,
        cartonName: true,
        po: { select: { poNumber: true, deliveryRequiredBy: true } },
      },
    })
    if (!planningLine) throw new Error('Planning line not found')

    const material = await tx.inventory.findUnique({ where: { id: materialId } })
    if (!material) throw new Error('Material not found')

    const available = Math.max(0, asNumber(material.qtyAvailable))
    const reserveQty = Math.min(available, requiredSheets)
    const shortageQty = Math.max(0, requiredSheets - reserveQty)

    if (reserveQty > 0) {
      const updated = await tx.inventory.updateMany({
        where: { id: materialId, qtyAvailable: { gte: reserveQty } },
        data: {
          qtyAvailable: { decrement: reserveQty },
          qtyReserved: { increment: reserveQty },
        },
      })
      if (updated.count === 0) {
        throw new Error('Stock changed. Please refresh and reserve again.')
      }

      await tx.stockMovement.create({
        data: {
          materialId,
          movementType: 'reserve',
          qty: reserveQty,
          refType: 'planning_reserve',
          refId: planningId,
        },
      })
    }

    const existingShortage = await tx.materialShortage.findFirst({
      where: {
        materialId,
        planningId,
        jobCardId: null,
        status: 'open',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        shortageQty: true,
        remainingQty: true,
        allocatedQty: true,
      },
    })
    const currentOpenShortage = existingShortage ? Math.max(0, asNumber(existingShortage.remainingQty)) : 0
    const shortageDelta = shortageQty - currentOpenShortage
    if (shortageDelta !== 0) {
      await tx.inventory.update({
        where: { id: materialId },
        data:
          shortageDelta > 0
            ? { shortageSheets: { increment: shortageDelta } }
            : { shortageSheets: { decrement: Math.abs(shortageDelta) } },
      })
    }

    let shortage: { id: string } | null = null
    if (shortageQty > 0) {
      shortage = existingShortage
        ? await tx.materialShortage.update({
            where: { id: existingShortage.id },
            data: {
              shortageQty,
              remainingQty: shortageQty,
              planningId,
              sourcePoLineId: planningId,
              triggerReason: 'planning_shortage',
              status: 'open',
              requiredByDate: planningLine.po?.deliveryRequiredBy ?? null,
            },
            select: { id: true },
          })
        : await tx.materialShortage.create({
            data: {
              materialId,
              planningId,
              jobCardId: null,
              shortageQty,
              allocatedQty: 0,
              remainingQty: shortageQty,
              status: 'open',
              sourcePoLineId: planningId,
              triggerReason: 'planning_shortage',
              requiredByDate: planningLine.po?.deliveryRequiredBy ?? null,
            },
            select: { id: true },
          })
    } else if (existingShortage) {
      await tx.materialShortage.update({
        where: { id: existingShortage.id },
        data: {
          remainingQty: 0,
          status: 'closed',
        },
      })
    }

    const status = shortageQty > 0 ? 'partial_shortage' : 'fully_reserved'
    return {
      status,
      requiredSheets,
      reservedSheets: reserveQty,
      shortageSheets: shortageQty,
      shortage,
    }
  })

  let purchaseRequest: { id: string } | null = null
  if (txResult.shortage?.id) {
    try {
      const pr = await createPurchaseRequestFromShortage(txResult.shortage.id, db)
      purchaseRequest = { id: pr.id }
    } catch (error) {
      const msg = error instanceof Error && error.message ? error.message : 'Purchase Request creation failed'
      throw new ShortagePrRecoveryError(
        txResult.shortage.id,
        `Reservation saved with shortage, but PR creation failed. You can retry using "Create PR for Shortage". (${msg})`,
      )
    }
  }

  return {
    ...txResult,
    purchaseRequest,
  }
}

export async function getPlanningReservationSnapshot(
  planningId: string,
  materialId: string,
  requiredSheets: number,
  client: DbClient = db,
) {
  if (!planningId) throw new Error('Planning line is required')
  if (!materialId) throw new Error('Material is required')

  const [material, planningLine] = await Promise.all([
    client.inventory.findUnique({ where: { id: materialId } }),
    client.poLineItem.findUnique({
      where: { id: planningId },
      select: {
        id: true,
        cartonName: true,
        po: { select: { poNumber: true, deliveryRequiredBy: true } },
        jobCardNumber: true,
      },
    }),
  ])
  if (!material) throw new Error('Material not found')
  if (!planningLine) throw new Error('Planning line not found')

  const reservedForLine = await withTransaction(client, (tx) =>
    getPlanningReservedSheets(tx, materialId, planningId),
  )

  const openShortage = await client.materialShortage.findFirst({
    where: {
      materialId,
      planningId,
      jobCardId: null,
      status: 'open',
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, remainingQty: true, purchaseReqId: true },
  })

  const activePr = await client.purchaseRequisition.findFirst({
    where: {
      materialId,
      sourcePlanningId: planningId,
      status: { in: ['pending', 'approved', 'converted_to_po'] },
    },
    orderBy: { raisedAt: 'desc' },
    select: { id: true, status: true, qtyRequired: true },
  })

  const jobCard = planningLine.jobCardNumber
    ? await client.productionJobCard.findFirst({
        where: { jobCardNumber: planningLine.jobCardNumber },
        select: { id: true, status: true, jobCardNumber: true },
      })
    : null

  return {
    planningId,
    materialId,
    materialCode: material.materialCode,
    availableSheets: Math.max(0, asNumber(material.qtyAvailable)),
    reservedSheets: Math.max(0, asNumber(material.qtyReserved)),
    requiredSheets: Math.max(0, requiredSheets),
    reservedForLine,
    shortageSheets: Math.max(0, asNumber(openShortage?.remainingQty)),
    shortageId: openShortage?.id ?? null,
    prId: activePr?.id ?? openShortage?.purchaseReqId ?? null,
    prStatus: activePr?.status ?? 'not_created',
    prQty: activePr ? asNumber(activePr.qtyRequired) : 0,
    jobCard,
  }
}

export async function adjustPlanningReservation(
  input: PlanningReservationControlInput,
  client: DbClient = db,
) {
  return withTransaction(client, async (tx) => {
    const planningLine = await tx.poLineItem.findUnique({
      where: { id: input.planningId },
      select: {
        id: true,
        po: { select: { deliveryRequiredBy: true } },
        jobCardNumber: true,
      },
    })
    if (!planningLine) throw new Error('Planning line not found')

    const material = await tx.inventory.findUnique({ where: { id: input.materialId } })
    if (!material) throw new Error('Material not found')

    const requiredSheets = asPositive(input.requiredSheets)
    const targetReserved = asPositive(input.targetReservedSheets)
    if (requiredSheets <= 0) throw new Error('Required sheets must be positive')
    if (targetReserved > requiredSheets) throw new Error('Reserve Qty cannot exceed required sheets')

    const currentReservedForLine = await getPlanningReservedSheets(tx, input.materialId, input.planningId)
    const available = Math.max(0, asNumber(material.qtyAvailable))
    const maxReservable = available + currentReservedForLine
    if (targetReserved > maxReservable) {
      throw new Error('Reserve Qty cannot exceed available + currently reserved')
    }

    const delta = targetReserved - currentReservedForLine
    if (delta > 0) {
      const updated = await tx.inventory.updateMany({
        where: { id: input.materialId, qtyAvailable: { gte: delta } },
        data: {
          qtyAvailable: { decrement: delta },
          qtyReserved: { increment: delta },
        },
      })
      if (updated.count === 0) throw new Error('Stock changed. Please refresh and reserve again')
      await tx.stockMovement.create({
        data: {
          materialId: input.materialId,
          movementType: 'reserve',
          qty: delta,
          refType: 'planning_adjust_increase',
          refId: input.planningId,
          userId: input.actorUserId ?? undefined,
        },
      })
    } else if (delta < 0) {
      const release = Math.abs(delta)
      const updated = await tx.inventory.updateMany({
        where: { id: input.materialId, qtyReserved: { gte: release } },
        data: {
          qtyAvailable: { increment: release },
          qtyReserved: { decrement: release },
        },
      })
      if (updated.count === 0) throw new Error('Reserved stock changed. Please refresh and try again')
      await tx.stockMovement.create({
        data: {
          materialId: input.materialId,
          movementType: 'adjust',
          qty: release,
          refType: 'planning_adjust_decrease',
          refId: input.planningId,
          userId: input.actorUserId ?? undefined,
        },
      })
    }

    const shortageQty = Math.max(0, requiredSheets - targetReserved)
    const upsert = await upsertPlanningShortage(tx, {
      materialId: input.materialId,
      planningId: input.planningId,
      shortageQty,
      requiredByDate: planningLine.po?.deliveryRequiredBy ?? null,
    })

    const prQty = asNonNegativeInt(input.prQty ?? shortageQty)
    const prImpactAction: PlanningPrImpactAction = input.prImpactAction ?? 'reduce'
    const pr = await syncPrForShortage(tx, {
      shortageId: upsert.shortageId,
      shortageQty,
      prQty,
      prImpactAction,
    })

    const materialAfter = await tx.inventory.findUnique({ where: { id: input.materialId } })

    return {
      status: shortageQty > 0 ? 'partial_shortage' : 'fully_reserved',
      requiredSheets,
      reservedForLine: targetReserved,
      shortageSheets: shortageQty,
      availableSheets: Math.max(0, asNumber(materialAfter?.qtyAvailable)),
      reservedSheets: Math.max(0, asNumber(materialAfter?.qtyReserved)),
      shortageId: upsert.shortageId,
      purchaseRequestId: pr.prId,
    }
  })
}

export async function releasePlanningReservation(
  input: {
    planningId: string
    materialId: string
    requiredSheets: number
    releaseQty: number
    prImpactAction?: PlanningPrImpactAction
    actorUserId?: string | null
  },
  client: DbClient = db,
) {
  return withTransaction(client, async (tx) => {
    const planningLine = await tx.poLineItem.findUnique({
      where: { id: input.planningId },
      select: {
        id: true,
        po: { select: { deliveryRequiredBy: true } },
        jobCardNumber: true,
      },
    })
    if (!planningLine) throw new Error('Planning line not found')

    const currentReserved = await getPlanningReservedSheets(tx, input.materialId, input.planningId)
    const releaseQty = asPositive(input.releaseQty)
    if (releaseQty <= 0) throw new Error('Release qty must be positive')
    if (releaseQty > currentReserved) throw new Error('Release qty cannot exceed current reserved qty')

    const jc = planningLine.jobCardNumber
      ? await tx.productionJobCard.findFirst({ where: { jobCardNumber: planningLine.jobCardNumber } })
      : null
    const fullRelease = Math.abs(releaseQty - currentReserved) < 0.000001
    if (fullRelease && jc && ['in_progress', 'final_qc', 'packing', 'qa_released', 'closed'].includes(String(jc.status || ''))) {
      throw new Error('Full release blocked: production started or material already consumed')
    }

    const updated = await tx.inventory.updateMany({
      where: { id: input.materialId, qtyReserved: { gte: releaseQty } },
      data: {
        qtyAvailable: { increment: releaseQty },
        qtyReserved: { decrement: releaseQty },
      },
    })
    if (updated.count === 0) throw new Error('Reserved stock changed. Please refresh and try again')

    await tx.stockMovement.create({
      data: {
        materialId: input.materialId,
        movementType: 'adjust',
        qty: releaseQty,
        refType: 'planning_release',
        refId: input.planningId,
        userId: input.actorUserId ?? undefined,
      },
    })

    const targetReserved = Math.max(0, currentReserved - releaseQty)
    const requiredSheets = asPositive(input.requiredSheets)
    const shortageQty = Math.max(0, requiredSheets - targetReserved)
    const upsert = await upsertPlanningShortage(tx, {
      materialId: input.materialId,
      planningId: input.planningId,
      shortageQty,
      requiredByDate: planningLine.po?.deliveryRequiredBy ?? null,
    })

    const pr = await syncPrForShortage(tx, {
      shortageId: upsert.shortageId,
      shortageQty,
      prQty: shortageQty,
      prImpactAction: input.prImpactAction ?? 'reduce',
    })

    const materialAfter = await tx.inventory.findUnique({ where: { id: input.materialId } })

    return {
      status: shortageQty > 0 ? 'partial_shortage' : 'fully_reserved',
      reservedForLine: targetReserved,
      shortageSheets: shortageQty,
      availableSheets: Math.max(0, asNumber(materialAfter?.qtyAvailable)),
      reservedSheets: Math.max(0, asNumber(materialAfter?.qtyReserved)),
      shortageId: upsert.shortageId,
      purchaseRequestId: pr.prId,
      jobCardWarning:
        jc && ['draft', 'planned', 'queued', 'ready'].includes(String(jc.status || ''))
          ? 'Job card exists but production not started.'
          : null,
    }
  })
}

export async function generatePrForPlanningShortage(
  input: {
    planningId: string
    materialId: string
    requiredSheets: number
    reservedSheets: number
    prQty: number
  },
  client: DbClient = db,
) {
  return withTransaction(client, async (tx) => {
    const planningLine = await tx.poLineItem.findUnique({
      where: { id: input.planningId },
      select: { id: true, po: { select: { deliveryRequiredBy: true } } },
    })
    if (!planningLine) throw new Error('Planning line not found')

    const required = asPositive(input.requiredSheets)
    const reserved = asPositive(input.reservedSheets)
    const shortageQty = Math.max(0, required - reserved)
    if (shortageQty <= 0) throw new Error('No shortage available for PR generation')

    const upsert = await upsertPlanningShortage(tx, {
      materialId: input.materialId,
      planningId: input.planningId,
      shortageQty,
      requiredByDate: planningLine.po?.deliveryRequiredBy ?? null,
    })
    if (!upsert.shortageId) throw new Error('Shortage could not be prepared')

    const dup = await tx.purchaseRequisition.findFirst({
      where: {
        materialId: input.materialId,
        sourcePlanningId: input.planningId,
        shortageId: upsert.shortageId,
        status: { in: ['pending', 'approved', 'converted_to_po'] },
      },
      select: { id: true },
    })
    if (dup) {
      return { purchaseRequestId: dup.id, shortageId: upsert.shortageId, duplicate: true }
    }

    const pr = await createPurchaseRequestFromShortage(upsert.shortageId, tx)
    const desiredQty = asPositive(input.prQty)
    if (desiredQty > 0) {
      await tx.purchaseRequisition.update({
        where: { id: pr.id },
        data: { qtyRequired: desiredQty },
      })
    }
    return { purchaseRequestId: pr.id, shortageId: upsert.shortageId, duplicate: false }
  })
}

export async function allocateGRNToShortage(grnId: string, shortageId: string, client: DbClient = db) {
  return withTransaction(client, async (tx) => {
    const [movement, shortage] = await Promise.all([
      tx.stockMovement.findUnique({ where: { id: grnId } }),
      tx.materialShortage.findUnique({ where: { id: shortageId } }),
    ])

    if (!movement || movement.movementType !== 'grn_quarantine') {
      throw new Error('Invalid GRN movement')
    }
    if (!shortage) throw new Error('Shortage not found')
    if (shortage.status === 'closed' || asNumber(shortage.remainingQty) <= 0) {
      throw new Error('Shortage already closed')
    }

    const existingAlloc = await tx.grnShortageAllocation.findUnique({
      where: { grnId_shortageId: { grnId, shortageId } },
    })
    if (existingAlloc) throw new Error('This GRN is already allocated to this shortage')

    if (movement.materialId !== shortage.materialId) {
      throw new Error('GRN material does not match shortage material')
    }

    const allocQty = Math.min(asNumber(movement.qty), asNumber(shortage.remainingQty))
    if (allocQty <= 0) throw new Error('No allocable quantity')

    const material = await tx.inventory.findUnique({ where: { id: shortage.materialId } })
    if (!material) throw new Error('Material not found')

    if (asNumber(material.qtyQuarantine) < allocQty) {
      throw new Error('Insufficient quarantine stock to allocate')
    }

    await tx.inventory.update({
      where: { id: shortage.materialId },
      data: {
        qtyQuarantine: { decrement: allocQty },
        qtyReserved: { increment: allocQty },
        physicalStockSheets: { increment: allocQty },
        shortageSheets: { decrement: allocQty },
      },
    })

    await tx.grnShortageAllocation.create({
      data: {
        grnId,
        shortageId,
        materialId: shortage.materialId,
        allocatedQty: allocQty,
      },
    })

    const remainingQty = Math.max(0, asNumber(shortage.remainingQty) - allocQty)
    await tx.materialShortage.update({
      where: { id: shortageId },
      data: {
        allocatedQty: { increment: allocQty },
        remainingQty,
        status: remainingQty === 0 ? 'closed' : 'open',
      },
    })

    await tx.materialReservation.updateMany({
      where: { materialId: shortage.materialId, jobCardId: shortage.jobCardId },
      data: {
        reservedSheets: { increment: allocQty },
        shortageSheets: { decrement: allocQty },
        status: remainingQty === 0 ? 'fully_reserved' : 'partial_shortage',
      },
    })

    if (shortage.purchaseReqId) {
      await tx.purchaseRequisition.update({
        where: { id: shortage.purchaseReqId },
        data: { status: remainingQty === 0 ? 'received' : 'approved' },
      })
    }

    return { shortageId, grnId, allocatedQty: allocQty, remainingQty }
  })
}

export async function getMaterialReadiness(jobCardId: string, client: DbClient = db) {
  const req = await calculateRequirement({ jobCardId }, client)
  if (!req.materialId) {
    return {
      requiredSheets: req.requiredSheets,
      reservedSheets: 0,
      shortageSheets: req.requiredSheets,
      availableStock: 0,
      prStatus: 'not_created',
      grnEta: null as string | null,
      status: 'shortage',
    }
  }

  const [material, reservationByJob, reservationByPlanning, openShortageByJob, openShortageByPlanning] = await Promise.all([
    client.inventory.findUnique({ where: { id: req.materialId } }),
    client.materialReservation.findFirst({ where: { materialId: req.materialId, jobCardId } }),
    req.planningId
      ? client.materialReservation.findFirst({
          where: { materialId: req.materialId, planningId: req.planningId },
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve(null),
    client.materialShortage.findFirst({
      where: { materialId: req.materialId, jobCardId, status: 'open' },
      orderBy: { createdAt: 'desc' },
    }),
    req.planningId
      ? client.materialShortage.findFirst({
          where: { materialId: req.materialId, planningId: req.planningId, status: 'open' },
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve(null),
  ])
  const reservation = reservationByJob ?? reservationByPlanning
  const openShortage = openShortageByJob ?? openShortageByPlanning

  const prFromOpenShortage = openShortage?.purchaseReqId
    ? await client.purchaseRequisition.findUnique({ where: { id: openShortage.purchaseReqId } })
    : null

  let pr = prFromOpenShortage
  if (!pr) {
    const shortages = await client.materialShortage.findMany({
      where: {
        materialId: req.materialId,
        OR: [
          { jobCardId },
          ...(req.planningId ? [{ planningId: req.planningId }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, purchaseReqId: true },
    })
    const shortagePrIds = shortages
      .map((s) => s.purchaseReqId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)

    if (shortagePrIds.length > 0) {
      pr = await client.purchaseRequisition.findFirst({
        where: { id: { in: shortagePrIds } },
        orderBy: { raisedAt: 'desc' },
      })
    }

    if (!pr) {
      pr = await client.purchaseRequisition.findFirst({
        where: {
          OR: [
            { materialId: req.materialId, sourceJobCardId: jobCardId },
            ...(req.planningId
              ? [{ materialId: req.materialId, sourcePlanningId: req.planningId }]
              : []),
          ],
        },
        orderBy: { raisedAt: 'desc' },
      })
    }
  }

  const requiredSheets = asNumber(reservation?.requiredSheets) || req.requiredSheets
  const reservedSheets = asNumber(reservation?.reservedSheets)
  const shortageSheets = asNumber(reservation?.shortageSheets) || asNumber(openShortage?.remainingQty)
  const availableStock = asNumber(material?.qtyAvailable)

  const status = shortageSheets <= 0 && reservedSheets >= requiredSheets
    ? 'fully_reserved'
    : reservedSheets > 0
      ? 'partial_shortage'
      : 'shortage'

  return {
    requiredSheets,
    reservedSheets,
    shortageSheets,
    availableStock,
    prStatus: pr?.status ?? 'not_created',
    grnEta: pr?.expectedDelivery ? pr.expectedDelivery.toISOString() : null,
    status,
    materialId: req.materialId,
    materialCode: material?.materialCode ?? null,
    planningId: req.planningId,
  }
}

/**
 * Average daily consumption per material over the last 30 days, computed
 * from SheetIssueRecord rows on COMPLETED job cards, attributed to materials
 * via MaterialReservation.
 *
 * Caveat: a job with reservations for multiple materials has its sheet
 * issues attributed to EACH material. Overcounts when multi-material
 * reservations exist; acceptable for v1 (follow-up: weighted attribution).
 */
export async function computeAvgDailyConsumption(
  materialIds: string[],
): Promise<Map<string, number>> {
  if (materialIds.length === 0) return new Map()

  const thirtyDaysAgo = subDays(new Date(), 30)

  // Reservations that link our target materials to completed jobs with recent issues
  const reservations = await db.materialReservation.findMany({
    where: {
      materialId: { in: materialIds },
      jobCard: {
        status: 'completed',
        issues: { some: { issuedAt: { gte: thirtyDaysAgo } } },
      },
    },
    select: {
      materialId: true,
      jobCard: {
        select: {
          id: true,
          issues: {
            where: { issuedAt: { gte: thirtyDaysAgo } },
            select: { qtyRequested: true },
          },
        },
      },
    },
  })

  // Avoid double-counting the same job-card's issues if it has multiple
  // reservations for the SAME material (e.g. partial reservations). Use
  // (materialId, jobCardId) as the dedupe key.
  const counted = new Set<string>()
  const totals = new Map<string, number>()
  for (const r of reservations) {
    const key = `${r.materialId}|${r.jobCard.id}`
    if (counted.has(key)) continue
    counted.add(key)
    const sum = r.jobCard.issues.reduce((s, i) => s + i.qtyRequested, 0)
    totals.set(r.materialId, (totals.get(r.materialId) ?? 0) + sum)
  }

  const avgPerDay = new Map<string, number>()
  totals.forEach((total, mid) => {
    avgPerDay.set(mid, total / 30)
  })
  return avgPerDay
}

export async function findOpenShortagesForMaterial(materialId: string, client: DbClient = db) {
  return client.materialShortage.findMany({
    where: { materialId, status: 'open' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      jobCardId: true,
      planningId: true,
      remainingQty: true,
      shortageQty: true,
      purchaseReqId: true,
    },
  })
}
