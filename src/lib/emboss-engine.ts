import type {
  EmbossBlock,
  EmbossIssueRecord,
  EmbossRequirement,
  EmbossVendorOrder,
} from '@prisma/client'
import { db } from '@/lib/db'
import { isEmbossingRequired } from './emboss-conditions'

export type EmbossAvailabilityResult = {
  status: 'available' | 'needs_attention' | 'end_of_life' | 'not_available'
  requiresNew: boolean
  message: string
  action: 'issue_from_stock' | 'polish_before_use' | 'order_replacement' | 'trigger_vendor_order'
  estimatedLeadTime?: string
  block?: EmbossBlock
  blockCode?: string
  blockNumber?: number | null
  location?: string | null
  compartment?: string | null
  condition?: string
  lifeUsed?: number
  lifeRemaining?: number
}

export function requiresEmbossCheck(embossingLeafing: string | null): boolean {
  return isEmbossingRequired(embossingLeafing)
}

async function generateEmbossRequirementCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `ER-${year}-`
  const last = await db.embossRequirement.findFirst({
    where: { requirementCode: { startsWith: prefix } },
    orderBy: { requirementCode: 'desc' },
    select: { requirementCode: true },
  })
  const seq = last ? Number(last.requirementCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

async function generateEmbossVendorOrderCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `EVO-${year}-`
  const last = await db.embossVendorOrder.findFirst({
    where: { orderCode: { startsWith: prefix } },
    orderBy: { orderCode: 'desc' },
    select: { orderCode: true },
  })
  const seq = last ? Number(last.orderCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

export async function checkEmbossBlockAvailability(
  cartonId: string,
  artworkCode: string,
  blockType: string,
): Promise<EmbossAvailabilityResult> {
  let block = await db.embossBlock.findFirst({
    where: {
      cartonId: cartonId || undefined,
      status: { in: ['in_stock', 'returned'] },
      condition: { notIn: ['Scrapped', 'Damaged'] },
    },
  })

  if (!block && artworkCode) {
    block = await db.embossBlock.findFirst({
      where: {
        artworkCode,
        blockType: blockType || undefined,
        status: { in: ['in_stock', 'returned'] },
        condition: { notIn: ['Scrapped', 'Damaged'] },
      },
    })
  }

  if (!block) {
    return {
      status: 'not_available',
      requiresNew: true,
      message: 'No embossing block found. New block must be outsourced.',
      action: 'trigger_vendor_order',
      estimatedLeadTime: '10-15 days',
    }
  }

  const lifeUsed = block.maxImpressions > 0 ? (block.impressionCount / block.maxImpressions) * 100 : 0
  const polishUsed = block.maxPolishCount > 0 ? (block.polishCount / block.maxPolishCount) * 100 : 0

  if (block.condition === 'Needs Polish' || lifeUsed > 85) {
    return {
      status: 'needs_attention',
      block,
      lifeUsed,
      message: `Block ${block.blockCode} needs polishing (${lifeUsed.toFixed(0)}% life used)`,
      action: 'polish_before_use',
      requiresNew: false,
    }
  }

  if (lifeUsed > 95 || polishUsed >= 100) {
    return {
      status: 'end_of_life',
      block,
      lifeUsed,
      message: `Block ${block.blockCode} at end of life. Order replacement.`,
      action: 'order_replacement',
      requiresNew: true,
    }
  }

  return {
    status: 'available',
    block,
    blockCode: block.blockCode,
    blockNumber: block.blockNumber,
    location: block.storageLocation,
    compartment: block.compartment,
    condition: block.condition,
    lifeRemaining: 100 - lifeUsed,
    message: `Block ${block.blockCode} available - ${(100 - lifeUsed).toFixed(0)}% life remaining`,
    action: 'issue_from_stock',
    requiresNew: false,
  }
}

export async function triggerEmbossVendorOrder(params: {
  jobCardId?: string
  cartonId?: string
  cartonName?: string
  blockType?: string
  embossArea?: string
  requirementId?: string
  priority?: string
  userId: string
}): Promise<EmbossVendorOrder> {
  const orderCode = await generateEmbossVendorOrderCode()
  return db.embossVendorOrder.create({
    data: {
      orderCode,
      orderType: 'new_block',
      cartonName: params.cartonName ?? null,
      blockType: params.blockType ?? null,
      embossArea: params.embossArea ?? null,
      vendorName: 'To Be Assigned',
      priority: params.priority || 'Normal',
      jobCardId: params.jobCardId ?? null,
      status: 'ordered',
      createdBy: params.userId,
    },
  })
}

export async function onArtworkApprovedEmbossCheck(
  jobCardId: string,
  cartonId: string,
  artworkCode: string,
  embossingLeafing: string,
  userId: string,
): Promise<EmbossRequirement | null> {
  if (!isEmbossingRequired(embossingLeafing)) return null

  const carton = await db.carton.findUnique({ where: { id: cartonId } })
  const availability = await checkEmbossBlockAvailability(
    cartonId,
    artworkCode,
    carton?.embossingLeafing || 'Blind Emboss',
  )

  const requirement = await db.embossRequirement.create({
    data: {
      requirementCode: await generateEmbossRequirementCode(),
      jobCardId,
      cartonName: carton?.cartonName || '',
      cartonId,
      artworkCode,
      blockType: carton?.embossingLeafing ?? null,
      requirementType: availability.requiresNew
        ? 'new_required'
        : availability.status === 'needs_attention'
          ? 'polishing_required'
          : 'existing_available',
      existingBlockId: availability.block?.id,
      existingBlockCode: availability.block?.blockCode,
      existingCondition: availability.block?.condition,
      status: availability.status === 'available' ? 'block_available' : 'pending',
      createdBy: userId,
    },
  })

  if (availability.requiresNew) {
    const order = await triggerEmbossVendorOrder({
      jobCardId,
      cartonId,
      cartonName: carton?.cartonName,
      blockType: carton?.embossingLeafing ?? undefined,
      embossArea: carton?.specialInstructions ?? undefined,
      requirementId: requirement.id,
      userId,
    })
    await db.embossRequirement.update({
      where: { id: requirement.id },
      data: { vendorOrderId: order.id, status: 'vendor_notified' },
    })
  }
  return requirement
}

export async function issueEmbossBlock(
  embossBlockId: string,
  jobCardId: string,
  jobCardNumber: number,
  machineCode: string,
  issuedTo: string,
  issuedBy: string,
): Promise<EmbossIssueRecord> {
  return db.$transaction(async (tx) => {
    const block = await tx.embossBlock.findUnique({ where: { id: embossBlockId } })
    if (!block) throw new Error('Block not found')

    await tx.embossBlock.update({
      where: { id: embossBlockId },
      data: {
        status: 'issued',
        currentJobCardId: jobCardId,
        issuedTo,
        issuedAt: new Date(),
        totalJobsUsed: { increment: 1 },
      },
    })

    const issueRecord = await tx.embossIssueRecord.create({
      data: {
        embossBlockId,
        blockCode: block.blockCode,
        blockNumber: block.blockNumber,
        jobCardId,
        jobCardNumber,
        cartonName: block.cartonName,
        artworkCode: block.artworkCode,
        machineCode,
        issuedTo,
        issuedBy,
        impressionsAtIssue: block.impressionCount,
        status: 'issued',
      },
    })

    await tx.embossAuditLog.create({
      data: {
        embossBlockId,
        blockCode: block.blockCode,
        action: 'issued',
        performedBy: issuedBy,
        details: { jobCardId, jobCardNumber, machineCode, issuedTo },
      },
    })

    return issueRecord
  })
}

export async function returnEmbossBlock(
  issueRecordId: string,
  returnedBy: string,
  impressionsThisRun: number,
  returnCondition: string,
  actionTaken: string,
  returnNotes: string,
  storageLocation: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const issueRecord = await tx.embossIssueRecord.findUnique({
      where: { id: issueRecordId },
      include: { embossBlock: true },
    })
    if (!issueRecord) throw new Error('Issue record not found')
    const block = issueRecord.embossBlock

    const newCount = block.impressionCount + impressionsThisRun
    const lifeUsed = block.maxImpressions > 0 ? (newCount / block.maxImpressions) * 100 : 0
    let newCondition = returnCondition
    if (lifeUsed > 85) newCondition = 'Needs Polish'
    if (actionTaken === 'scrapped') newCondition = 'Scrapped'

    await tx.embossBlock.update({
      where: { id: block.id },
      data: {
        status:
          actionTaken === 'scrapped'
            ? 'scrapped'
            : actionTaken === 'sent_for_polishing'
              ? 'with_vendor'
              : 'in_stock',
        condition: newCondition,
        impressionCount: newCount,
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

    await tx.embossIssueRecord.update({
      where: { id: issueRecordId },
      data: {
        returnedBy,
        returnedAt: new Date(),
        impressionsThisRun,
        impressionsAtReturn: newCount,
        returnCondition,
        actionTaken,
        returnNotes,
        status: 'returned',
      },
    })

    if (actionTaken === 'sent_for_polishing') {
      await tx.embossMaintenanceLog.create({
        data: {
          embossBlockId: block.id,
          blockCode: block.blockCode,
          actionType: 'polishing',
          performedBy: returnedBy,
          conditionBefore: returnCondition,
          impressionsBefore: newCount,
          notes: returnNotes,
        },
      })
      await tx.embossBlock.update({
        where: { id: block.id },
        data: { polishCount: { increment: 1 } },
      })
    }

    await tx.embossAuditLog.create({
      data: {
        embossBlockId: block.id,
        blockCode: block.blockCode,
        action: actionTaken === 'scrapped' ? 'scrapped' : 'returned',
        performedBy: returnedBy,
        details: { impressionsThisRun, newCount, returnCondition, actionTaken, storageLocation },
      },
    })
  })
}

