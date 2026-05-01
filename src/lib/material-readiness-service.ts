import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

type DbClient = typeof db | Prisma.TransactionClient

async function withTransaction<T>(client: DbClient, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ('$transaction' in client) {
    return client.$transaction(async (tx) => fn(tx))
  }
  return fn(client)
}

type RequirementResult = {
  jobCardId: string
  planningId: string | null
  requiredSheets: number
  materialId: string | null
}

function asNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
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
  const explicit = typeof spec.planningMaterialId === 'string' ? spec.planningMaterialId : ''
  if (explicit) {
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

    const requiredSheets = Math.max(0, asNumber(line.materialQueue?.totalSheets) || Math.ceil(line.quantity / 4))

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
  const requiredSheets = Math.max(0, requiredFromQueue || asNumber(jc.totalSheets) || asNumber(jc.requiredSheets))
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
  jobCardId: string,
  planningId: string | null,
  shortageQty: number,
  client: DbClient = db,
) {
  if (shortageQty <= 0) throw new Error('Shortage qty must be positive')

  return withTransaction(client, async (tx) => {
    const shortage = await tx.materialShortage.create({
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

    return shortage
  })
}

export async function createPurchaseRequestFromShortage(shortageId: string, client: DbClient = db) {
  return withTransaction(client, async (tx) => {
    const shortage = await tx.materialShortage.findUnique({ where: { id: shortageId } })
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

    const sizeLabel = material.sheetLength && material.sheetWidth
      ? `${Math.round(Number(material.sheetLength))}x${Math.round(Number(material.sheetWidth))}`
      : null

    const pr = await tx.purchaseRequisition.create({
      data: {
        materialId: shortage.materialId,
        qtyRequired: shortage.remainingQty,
        estimatedValue: 0,
        triggerReason: 'planning_shortage_auto',
        status: 'pending',
        raisedBy: 'system',
        boardType: material.boardType ?? undefined,
        sizeLabel: sizeLabel ?? undefined,
        gsm: material.gsm ?? undefined,
        sourceJobCardId: shortage.jobCardId,
        sourcePlanningId: shortage.planningId ?? undefined,
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

  return withTransaction(client, async (tx) => {
    const material = await tx.inventory.findUnique({ where: { id: materialId } })
    if (!material) throw new Error('Material not found')

    const available = Math.max(0, asNumber(material.qtyAvailable))
    const reserveQty = Math.min(available, requiredSheets)
    const shortageQty = Math.max(0, requiredSheets - reserveQty)

    if (reserveQty > 0) {
      await tx.inventory.update({
        where: { id: materialId },
        data: {
          qtyAvailable: { decrement: reserveQty },
          qtyReserved: { increment: reserveQty },
        },
      })

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
    let purchaseRequest: { id: string } | null = null

    if (shortageQty > 0) {
      shortage = await tx.materialShortage.create({
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

      const sizeLabel = material.sheetLength && material.sheetWidth
        ? `${Math.round(Number(material.sheetLength))}x${Math.round(Number(material.sheetWidth))}`
        : null

      purchaseRequest = await tx.purchaseRequisition.create({
        data: {
          materialId,
          qtyRequired: shortageQty,
          estimatedValue: 0,
          triggerReason: 'planning_shortage_auto',
          status: 'pending',
          raisedBy: 'system',
          boardType: material.boardType ?? undefined,
          sizeLabel: sizeLabel ?? undefined,
          gsm: material.gsm ?? undefined,
          sourceJobCardId: jobCardId,
          sourcePlanningId: planningId ?? undefined,
          shortageId: shortage.id,
        },
      })

      await tx.materialShortage.update({
        where: { id: shortage.id },
        data: { purchaseReqId: purchaseRequest.id },
      })
    }

    return {
      status,
      requiredSheets,
      reservedSheets: reserveQty,
      shortageSheets: shortageQty,
      reservation,
      shortage,
      purchaseRequest,
    }
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
        data: { status: remainingQty === 0 ? 'converted_to_po' : 'approved' },
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

  const [material, reservation, openShortage] = await Promise.all([
    client.inventory.findUnique({ where: { id: req.materialId } }),
    client.materialReservation.findFirst({ where: { materialId: req.materialId, jobCardId } }),
    client.materialShortage.findFirst({
      where: { materialId: req.materialId, jobCardId, status: 'open' },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const pr = openShortage?.purchaseReqId
    ? await client.purchaseRequisition.findUnique({ where: { id: openShortage.purchaseReqId } })
    : null

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
    planningId: req.planningId,
  }
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
