// src/lib/sheet-issue-logic.ts
// ============================================================
// SHEET HARD-LIMIT ENFORCER — Solves Problem 1
// This is the most critical business logic in the system.
// Called by: POST /api/sheet-issues/attempt
// ============================================================

import { db } from './db'
import { sendWhatsApp } from './notifications'
import { createAuditLog } from './audit'
import { checkReorderPoints } from './reorder'

export type IssueResult = {
  success: boolean
  message: string
  remaining?: number
  issuedQty?: number
  excessRequestId?: string
}

export type ExcessReasonCode =
  | 'substrate_quality'
  | 'machine_setting'
  | 'colour_standard'
  | 'die_cutting_waste'
  | 'other'

// ─────────────────────────────────────────
// MAIN FUNCTION — Attempt to issue sheets
// Wraps everything in a transaction to prevent race conditions
// ─────────────────────────────────────────

export async function attemptSheetIssue(params: {
  bomLineId: string
  qtyRequested: number
  issuedByUserId: string
  lotNumber?: string
}): Promise<IssueResult> {
  const { bomLineId, qtyRequested, issuedByUserId, lotNumber } = params

  return await db.$transaction(async (tx) => {
    // Lock the BOM line row to prevent concurrent issues
    const bomLine = await tx.bomLine.findUniqueOrThrow({
      where: { id: bomLineId },
      include: {
        job: { select: { id: true, jobNumber: true, productName: true } },
        material: { select: { materialCode: true, description: true, unit: true } },
      },
    })

    // Sum all previously issued (approved) quantities for this BOM line
    const previouslyIssued = await tx.sheetIssue.aggregate({
      where: {
        bomLineId,
        OR: [
          { isExcess: false },
          { isExcess: true, approvedAt: { not: null }, rejectedAt: null },
        ],
      },
      _sum: { qtyRequested: true },
    })

    const alreadyIssued = Number(previouslyIssued._sum.qtyRequested ?? 0)
    const approved = Number(bomLine.qtyApproved)
    const remaining = approved - alreadyIssued

    // ── HARD STOP ──
    if (qtyRequested > remaining) {
      // Create a pending excess request instead of issuing
      const excessRequest = await tx.sheetIssue.create({
        data: {
          jobId: bomLine.jobId,
          bomLineId,
          materialId: bomLine.materialId,
          qtyRequested,
          isExcess: true,
          issuedBy: issuedByUserId,
          lotNumber,
        },
      })

      // Notify supervisor via WhatsApp
      await notifyExcessRequest({
        jobNumber: bomLine.job.jobNumber,
        productName: bomLine.job.productName,
        materialCode: bomLine.material.materialCode,
        approvedQty: approved,
        alreadyIssued,
        requestedQty: qtyRequested,
        excessRequestId: excessRequest.id,
      })

      return {
        success: false,
        message: `⛔ HARD STOP: Approved quantity (${approved}) fully issued. ${remaining <= 0 ? 'Zero' : remaining} units remaining. Excess request #${excessRequest.id.slice(0, 8)} raised — awaiting supervisor approval.`,
        remaining: Math.max(0, remaining),
        excessRequestId: excessRequest.id,
      }
    }

    // ── NORMAL ISSUE ──
    const issue = await tx.sheetIssue.create({
      data: {
        jobId: bomLine.jobId,
        bomLineId,
        materialId: bomLine.materialId,
        qtyRequested,
        isExcess: false,
        issuedBy: issuedByUserId,
        approvedAt: new Date(), // Normal issues are auto-approved
        lotNumber,
      },
    })

    // Update BOM line issued quantity
    await tx.bomLine.update({
      where: { id: bomLineId },
      data: { qtyIssued: { increment: qtyRequested } },
    })

    // Deduct from inventory available
    await tx.inventory.update({
      where: { id: bomLine.materialId },
      data: { qtyAvailable: { decrement: qtyRequested } },
    })

    await tx.stockMovement.create({
      data: {
        materialId: bomLine.materialId,
        movementType: 'issue',
        qty: qtyRequested,
        refType: 'sheet_issue',
        refId: issue.id,
        userId: issuedByUserId,
      },
    })

    await createAuditLog({
      userId: issuedByUserId,
      action: 'INSERT',
      tableName: 'sheet_issues',
      recordId: issue.id,
      newValue: { qty: qtyRequested, jobId: bomLine.jobId, isExcess: false },
    })

    const newRemaining = remaining - qtyRequested
    const warningMsg = newRemaining === 0
      ? ' ⚠️ All approved sheets now issued. No further issuance possible without excess approval.'
      : ''

    try {
      await checkReorderPoints(bomLine.materialId)
    } catch (_) {}

    return {
      success: true,
      message: `✅ Issued ${qtyRequested} ${bomLine.material.unit}. Remaining: ${newRemaining}.${warningMsg}`,
      remaining: newRemaining,
      issuedQty: qtyRequested,
    }
  })
}

// ─────────────────────────────────────────
// APPROVE EXCESS REQUEST — tiered approval
// ─────────────────────────────────────────

export async function approveExcessRequest(params: {
  sheetIssueId: string
  approvedByUserId: string
  approvalTier: 1 | 2 | 3 | 4
}): Promise<IssueResult> {
  const { sheetIssueId, approvedByUserId, approvalTier } = params

  return await db.$transaction(async (tx) => {
    const issue = await tx.sheetIssue.findUniqueOrThrow({
      where: { id: sheetIssueId },
      include: {
        bomLine: true,
        material: true,
        job: true,
      },
    })

    if (!issue.isExcess || issue.approvedAt || issue.rejectedAt) {
      return { success: false, message: 'Request already processed or not an excess request.' }
    }

    // Check approver's role limit
    const approver = await tx.user.findUniqueOrThrow({
      where: { id: approvedByUserId },
      include: { role: true },
    })

    const bomLine = await tx.bomLine.findUniqueOrThrow({
      where: { id: issue.bomLineId },
    })

    const approvedQty = Number(bomLine.qtyApproved)
    const excessPct = (Number(issue.qtyRequested) / approvedQty) * 100
    const roleLimit = Number(approver.role.wastageApproveLimitPct)

    if (excessPct > roleLimit && roleLimit !== 999) {
      // Escalate to next tier
      await notifyEscalation({
        excessRequestId: sheetIssueId,
        jobNumber: issue.job.jobNumber,
        currentTier: approvalTier,
        excessPct,
      })
      return {
        success: false,
        message: `Excess of ${excessPct.toFixed(1)}% exceeds your approval limit of ${roleLimit}%. Escalated to next level.`,
      }
    }

    // Approve
    await tx.sheetIssue.update({
      where: { id: sheetIssueId },
      data: {
        approvedBy: approvedByUserId,
        approvedAt: new Date(),
        approvalTier,
      },
    })

    // Update BOM issued qty
    await tx.bomLine.update({
      where: { id: issue.bomLineId },
      data: { qtyIssued: { increment: issue.qtyRequested } },
    })

    // Deduct from inventory
    await tx.inventory.update({
      where: { id: issue.materialId },
      data: { qtyAvailable: { decrement: issue.qtyRequested } },
    })

    await tx.stockMovement.create({
      data: {
        materialId: issue.materialId,
        movementType: 'issue',
        qty: issue.qtyRequested,
        refType: 'sheet_issue',
        refId: issue.id,
        userId: approvedByUserId,
      },
    })

    // Auto-raise NCR if tier 3+ approval (systemic issue)
    if (approvalTier >= 3) {
      await tx.ncr.create({
        data: {
          jobId: issue.jobId,
          trigger: 'excess_wastage',
          severity: 'major',
          description: `Excess sheet request required Tier ${approvalTier} approval (${excessPct.toFixed(1)}% over BOM). Reason: ${issue.reasonCode} — ${issue.reasonDetail}`,
          raisedBy: approvedByUserId,
          dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        },
      })
    }

    return {
      success: true,
      message: `✅ Excess approved at Tier ${approvalTier}. ${issue.qtyRequested} units now released to stores.`,
      issuedQty: Number(issue.qtyRequested),
    }
  })
}

// ─────────────────────────────────────────
// NOTIFICATION HELPERS
// ─────────────────────────────────────────

async function notifyExcessRequest(data: {
  jobNumber: string
  productName: string
  materialCode: string
  approvedQty: number
  alreadyIssued: number
  requestedQty: number
  excessRequestId: string
}) {
  const message = `⚠️ EXCESS SHEET REQUEST
Job: ${data.jobNumber} | ${data.productName}
Material: ${data.materialCode}
Approved: ${data.approvedQty} | Issued: ${data.alreadyIssued}
Requesting: ${data.requestedQty} extra
Approve: ${process.env.NEXT_PUBLIC_APP_URL || 'https://ci-plant.vercel.app'}/stores/approve-excess/${data.excessRequestId}`

  // Get all shift supervisors and production managers
  const approvers = await db.user.findMany({
    where: {
      active: true,
      role: { roleName: { in: ['shift_supervisor', 'production_manager'] } },
      whatsappNumber: { not: null },
    },
    select: { whatsappNumber: true },
  })

  for (const approver of approvers) {
    if (approver.whatsappNumber) {
      await sendWhatsApp(approver.whatsappNumber, message)
    }
  }
}

async function notifyEscalation(data: {
  excessRequestId: string
  jobNumber: string
  currentTier: number
  excessPct: number
}) {
  const tierToRole: Record<number, string> = {
    1: 'shift_supervisor',
    2: 'production_manager',
    3: 'operations_head',
    4: 'md',
  }

  const nextTierRole = tierToRole[data.currentTier + 1]
  if (!nextTierRole) return

  const approvers = await db.user.findMany({
    where: {
      active: true,
      role: { roleName: nextTierRole },
      whatsappNumber: { not: null },
    },
    select: { whatsappNumber: true },
  })

  const message = `🔴 ESCALATED EXCESS REQUEST
Job: ${data.jobNumber}
Excess: ${data.excessPct.toFixed(1)}% — needs your approval
Approve: ${process.env.NEXT_PUBLIC_APP_URL || 'https://ci-plant.vercel.app'}/stores/approve-excess/${data.excessRequestId}`

  for (const approver of approvers) {
    if (approver.whatsappNumber) {
      await sendWhatsApp(approver.whatsappNumber, message)
    }
  }
}

// ─────────────────────────────────────────
// BOM EXPLOSION — calculate all materials needed
// ─────────────────────────────────────────

export async function explodeBOM(params: {
  jobId: string
  qtyOrdered: number
  imposition: number
  machineId: string
  boardMaterialId: string
}) {
  const { jobId, qtyOrdered, imposition, machineId, boardMaterialId } = params

  const machine = await db.machine.findUniqueOrThrow({ where: { id: machineId } })
  const wasteMultiplier = 1 + (Number(machine.stdWastePct) / 100)
  const netSheets = Math.ceil(qtyOrdered / imposition)
  const approvedSheets = Math.ceil(netSheets * wasteMultiplier)
  const wasteStd = approvedSheets - netSheets

  const bomLine = await db.bomLine.create({
    data: {
      jobId,
      materialId: boardMaterialId,
      machineId,
      netQty: netSheets,
      qtyApproved: approvedSheets,
      qtyWasteStd: wasteStd,
      lockedAt: new Date(),
    },
  })

  // Reserve the material in inventory
  await db.$transaction(async (tx) => {
    await tx.inventory.update({
      where: { id: boardMaterialId },
      data: {
        qtyAvailable: { decrement: approvedSheets },
        qtyReserved: { increment: approvedSheets },
      },
    })
    await tx.stockMovement.create({
      data: {
        materialId: boardMaterialId,
        movementType: 'reserve',
        qty: approvedSheets,
        refType: 'job',
        refId: jobId,
        userId: null,
      },
    })
  })

  return bomLine
}
