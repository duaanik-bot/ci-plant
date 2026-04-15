import type { DieIssueRecord, DieRequirement, DieStore, DieVendorOrder } from '@prisma/client'
import { db } from '@/lib/db'

export type DieAvailabilityResult = {
  status: 'available' | 'needs_attention' | 'end_of_life' | 'not_available'
  requiresNew: boolean
  message: string
  action:
    | 'issue_from_stock'
    | 'sharpen_before_use'
    | 'order_replacement'
    | 'trigger_vendor_order'
  estimatedLeadTime?: string
  die?: DieStore
  dieCode?: string
  dieNumber?: number | null
  location?: string | null
  compartment?: string | null
  condition?: string
  lifeUsed?: number
  lifeRemaining?: number
}

async function generateDieRequirementCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `DR-${year}-`
  const last = await db.dieRequirement.findFirst({
    where: { requirementCode: { startsWith: prefix } },
    orderBy: { requirementCode: 'desc' },
    select: { requirementCode: true },
  })
  const seq = last ? Number(last.requirementCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

async function generateVendorOrderCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `DVO-${year}-`
  const last = await db.dieVendorOrder.findFirst({
    where: { orderCode: { startsWith: prefix } },
    orderBy: { orderCode: 'desc' },
    select: { orderCode: true },
  })
  const seq = last ? Number(last.orderCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

export async function checkDieAvailability(
  cartonId: string,
  cartonSize: string,
  dieType: string,
  ups: number,
  sheetSize: string,
): Promise<DieAvailabilityResult> {
  let die = await db.dieStore.findFirst({
    where: {
      cartonId: cartonId || undefined,
      status: { in: ['in_stock', 'returned'] },
      condition: { notIn: ['Scrapped', 'Damaged'] },
    },
  })

  if (!die) {
    die = await db.dieStore.findFirst({
      where: {
        cartonSize: cartonSize || undefined,
        dieType: dieType || undefined,
        ups: ups || undefined,
        sheetSize: sheetSize || undefined,
        status: { in: ['in_stock', 'returned'] },
        condition: { notIn: ['Scrapped', 'Damaged'] },
      },
    })
  }

  if (!die) {
    return {
      status: 'not_available',
      requiresNew: true,
      message: 'No die available. New die must be ordered from vendor.',
      action: 'trigger_vendor_order',
      estimatedLeadTime: '7-14 days',
    }
  }

  const lifeUsed = die.maxImpressions > 0 ? (die.impressionCount / die.maxImpressions) * 100 : 0
  const sharpenUsed = die.maxSharpenCount > 0 ? (die.sharpenCount / die.maxSharpenCount) * 100 : 0

  if (die.condition === 'Needs Sharpening' || lifeUsed > 90) {
    return {
      status: 'needs_attention',
      die,
      lifeUsed,
      message: `Die ${die.dieNumber ?? '-'} available but needs sharpening (${lifeUsed.toFixed(0)}% life used)`,
      action: 'sharpen_before_use',
      requiresNew: false,
    }
  }

  if (lifeUsed > 95 || sharpenUsed >= 100) {
    return {
      status: 'end_of_life',
      die,
      lifeUsed,
      message: `Die ${die.dieNumber ?? '-'} at end of life. Replace immediately.`,
      action: 'order_replacement',
      requiresNew: true,
    }
  }

  return {
    status: 'available',
    die,
    dieCode: die.dieCode,
    dieNumber: die.dieNumber,
    location: die.storageLocation,
    compartment: die.compartment,
    condition: die.condition,
    lifeRemaining: 100 - lifeUsed,
    requiresNew: false,
    message: `Die ${die.dieNumber ?? '-'} available - ${(100 - lifeUsed).toFixed(0)}% life remaining`,
    action: 'issue_from_stock',
  }
}

export async function triggerVendorOrder(params: {
  jobCardId?: string
  cartonName?: string
  cartonSize: string
  dieType: string
  ups: number
  sheetSize: string
  requirementId?: string
  priority?: string
  userId: string
}): Promise<DieVendorOrder> {
  const orderCode = await generateVendorOrderCode()
  return db.dieVendorOrder.create({
    data: {
      orderCode,
      orderType: 'new_die',
      cartonName: params.cartonName ?? null,
      cartonSize: params.cartonSize,
      dieType: params.dieType,
      ups: params.ups,
      sheetSize: params.sheetSize,
      vendorName: 'To Be Assigned',
      priority: params.priority || 'Normal',
      jobCardId: params.jobCardId || null,
      status: 'ordered',
      createdBy: params.userId,
    },
  })
}

export async function onArtworkApprovedDieCheck(
  jobCardId: string,
  cartonId: string,
  cartonSize: string,
  dieType: string,
  ups: number,
  sheetSize: string,
  userId: string,
): Promise<DieRequirement> {
  const availability = await checkDieAvailability(cartonId, cartonSize, dieType, ups, sheetSize)
  const requirement = await db.dieRequirement.create({
    data: {
      requirementCode: await generateDieRequirementCode(),
      jobCardId,
      cartonName: cartonSize || 'Unknown',
      cartonSize,
      dieType,
      ups,
      sheetSize,
      requirementType: availability.requiresNew
        ? 'new_required'
        : availability.status === 'needs_attention'
          ? 'sharpening_required'
          : 'existing_available',
      existingDieId: availability.die?.id,
      existingDieCode: availability.die?.dieCode,
      existingCondition: availability.die?.condition,
      priority: 'Normal',
      status: availability.status === 'available' ? 'die_available' : 'pending',
      createdBy: userId,
    },
  })

  if (availability.requiresNew) {
    const order = await triggerVendorOrder({
      jobCardId,
      cartonSize,
      dieType,
      ups,
      sheetSize,
      requirementId: requirement.id,
      userId,
    })
    await db.dieRequirement.update({
      where: { id: requirement.id },
      data: { vendorOrderId: order.id, status: 'vendor_notified' },
    })
  }
  return requirement
}

export async function issueDie(
  dieStoreId: string,
  jobCardId: string,
  jobCardNumber: number,
  machineCode: string,
  issuedTo: string,
  issuedBy: string,
): Promise<DieIssueRecord> {
  return db.$transaction(async (tx) => {
    const die = await tx.dieStore.findUnique({ where: { id: dieStoreId } })
    if (!die) throw new Error('Die not found')

    await tx.dieStore.update({
      where: { id: dieStoreId },
      data: {
        status: 'issued',
        currentJobCardId: jobCardId,
        issuedTo,
        issuedAt: new Date(),
        totalJobsUsed: { increment: 1 },
      },
    })

    const issueRecord = await tx.dieIssueRecord.create({
      data: {
        dieStoreId,
        dieCode: die.dieCode,
        dieNumber: die.dieNumber,
        jobCardId,
        jobCardNumber,
        machineCode,
        issuedTo,
        issuedBy,
        impressionsAtIssue: die.impressionCount,
        status: 'issued',
      },
    })

    await tx.dieAuditLog.create({
      data: {
        dieStoreId,
        dieCode: die.dieCode,
        action: 'issued',
        performedBy: issuedBy,
        details: { jobCardId, jobCardNumber, machineCode, issuedTo },
      },
    })
    return issueRecord
  })
}

export async function returnDie(
  issueRecordId: string,
  returnedBy: string,
  impressionsThisRun: number,
  returnCondition: string,
  actionTaken: string,
  returnNotes: string,
  storageLocation: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const issueRecord = await tx.dieIssueRecord.findUnique({
      where: { id: issueRecordId },
      include: { dieStore: true },
    })
    if (!issueRecord) throw new Error('Issue record not found')
    const die = issueRecord.dieStore
    const newImpressionCount = die.impressionCount + impressionsThisRun
    const lifeUsed = die.maxImpressions > 0 ? (newImpressionCount / die.maxImpressions) * 100 : 0

    let newCondition = returnCondition
    if (lifeUsed > 95) newCondition = 'Needs Sharpening'
    if (actionTaken === 'scrapped') newCondition = 'Scrapped'

    await tx.dieStore.update({
      where: { id: die.id },
      data: {
        status:
          actionTaken === 'scrapped'
            ? 'scrapped'
            : actionTaken === 'sent_for_sharpening'
              ? 'with_vendor'
              : 'in_stock',
        condition: newCondition,
        impressionCount: newImpressionCount,
        currentJobCardId: null,
        issuedTo: null,
        returnedBy,
        returnedAt: new Date(),
        returnCondition,
        storageLocation,
        scrapReason: actionTaken === 'scrapped' ? returnNotes : undefined,
        scrappedBy: actionTaken === 'scrapped' ? returnedBy : undefined,
        scrappedAt: actionTaken === 'scrapped' ? new Date() : undefined,
      },
    })

    await tx.dieIssueRecord.update({
      where: { id: issueRecordId },
      data: {
        returnedBy,
        returnedAt: new Date(),
        impressionsAtReturn: newImpressionCount,
        impressionsThisRun,
        returnCondition,
        actionTaken,
        returnNotes,
        status: 'returned',
      },
    })

    if (actionTaken === 'sent_for_sharpening') {
      await tx.dieMaintenanceLog.create({
        data: {
          dieStoreId: die.id,
          dieCode: die.dieCode,
          actionType: 'sharpening',
          performedBy: returnedBy,
          conditionBefore: returnCondition,
          impressionsBefore: newImpressionCount,
          notes: returnNotes,
        },
      })
    }

    await tx.dieAuditLog.create({
      data: {
        dieStoreId: die.id,
        dieCode: die.dieCode,
        action: actionTaken === 'scrapped' ? 'scrapped' : 'returned',
        performedBy: returnedBy,
        details: {
          impressionsThisRun,
          newImpressionCount,
          returnCondition,
          actionTaken,
          storageLocation,
        },
      },
    })
  })
}
