// src/lib/artwork-logic.ts
// ============================================================
// ARTWORK 4-LOCK APPROVAL GATE — Solves Problem 2
// Called by artwork approval APIs and CTP stage start check
// ============================================================

import { db } from './db'
import { sendWhatsApp } from './notifications'
import { createAuditLog } from './audit'
import { nanoid } from 'nanoid'

export const LOCK_NAMES: Record<number, string> = {
  1: 'Customer Approval Document',
  2: 'QA Officer Text Checklist',
  3: 'QA Manager Sign-off',
  4: 'CTP Release',
}

// The 12-point checklist for Lock 2
export const LOCK_2_CHECKLIST = [
  { key: 'drug_name_spelling', label: 'Drug name spelled correctly' },
  { key: 'dosage_correct', label: 'Dosage matches approved specification' },
  { key: 'batch_format', label: 'Batch number format correct' },
  { key: 'date_format', label: 'Manufacturing / expiry date format correct' },
  { key: 'warning_text', label: 'Warning text present and complete' },
  { key: 'storage_conditions', label: 'Storage conditions stated' },
  { key: 'manufacturer_details', label: 'Manufacturer name and address correct' },
  { key: 'regulatory_text', label: 'Regulatory text (Schedule H / OTC) correct' },
  { key: 'barcode_present', label: 'Barcode present and scannable' },
  { key: 'mrp_area', label: 'MRP / price area correct' },
  { key: 'font_legibility', label: 'Font size legible (minimum 10pt)' },
  { key: 'bleed_marks', label: 'Bleed and crop marks correct' },
] as const

// ─────────────────────────────────────────
// SUBMIT AN APPROVAL LOCK
// ─────────────────────────────────────────

export async function submitArtworkLock(params: {
  artworkId: string
  lockNumber: 1 | 2 | 3
  approvedByUserId: string
  checklistData?: Record<string, boolean> // Lock 2 only
  comments?: string
}): Promise<{ success: boolean; message: string; locksCompleted: number }> {
  const { artworkId, lockNumber, approvedByUserId, checklistData, comments } = params

  const artwork = await db.artwork.findUniqueOrThrow({
    where: { id: artworkId },
    include: {
      job: { select: { jobNumber: true, productName: true } },
      approvals: true,
    },
  })

  // Validate lock sequence — cannot skip locks
  const completedLocks = artwork.approvals
    .filter(a => !a.rejected && a.approvedAt)
    .map(a => a.lockNumber)
    .sort()

  if (lockNumber > 1 && !completedLocks.includes(lockNumber - 1)) {
    return {
      success: false,
      message: `Lock ${lockNumber - 1} (${LOCK_NAMES[lockNumber - 1]}) must be completed first.`,
      locksCompleted: completedLocks.length,
    }
  }

  // Lock 2 — validate checklist is complete
  if (lockNumber === 2 && checklistData) {
    const allChecked = LOCK_2_CHECKLIST.every(item => checklistData[item.key] === true)
    if (!allChecked) {
      const failed = LOCK_2_CHECKLIST
        .filter(item => !checklistData[item.key])
        .map(item => item.label)
      return {
        success: false,
        message: `Checklist incomplete. Failed items: ${failed.join('; ')}`,
        locksCompleted: completedLocks.length,
      }
    }
  }

  // Create approval record
  await db.artworkApproval.upsert({
    where: { artworkId_lockNumber: { artworkId, lockNumber } },
    update: {
      approvedBy: approvedByUserId,
      approvedAt: new Date(),
      checklistData: checklistData ?? undefined,
      comments,
      rejected: false,
      rejectionReason: null,
    },
    create: {
      artworkId,
      lockNumber,
      approvedBy: approvedByUserId,
      approvedAt: new Date(),
      checklistData: checklistData ?? undefined,
      comments,
    },
  })

  const newLocksCompleted = completedLocks.length + 1

  // Update artwork locks count
  await db.artwork.update({
    where: { id: artworkId },
    data: {
      locksCompleted: newLocksCompleted,
      status: newLocksCompleted >= 3 ? 'approved' : 'partially_approved',
    },
  })

  await createAuditLog({
    userId: approvedByUserId,
    action: 'UPDATE',
    tableName: 'artwork_approvals',
    recordId: artworkId,
    newValue: { lockNumber, locksCompleted: newLocksCompleted },
  })

  // If Lock 3 complete, trigger CTP release (Lock 4)
  if (lockNumber === 3) {
    await triggerCTPRelease(artworkId, artwork.job.jobNumber)
    return {
      success: true,
      message: `✅ Lock 3 approved. CTP release triggered. Plate imaging can now begin.`,
      locksCompleted: 4,
    }
  }

  // Notify next approver
  await notifyNextApprover(lockNumber, artwork.job.jobNumber, artwork.job.productName, artworkId)

  return {
    success: true,
    message: `✅ Lock ${lockNumber} (${LOCK_NAMES[lockNumber]}) approved. ${4 - newLocksCompleted} lock(s) remaining.`,
    locksCompleted: newLocksCompleted,
  }
}

// ─────────────────────────────────────────
// REJECT AN APPROVAL LOCK
// ─────────────────────────────────────────

export async function rejectArtworkLock(params: {
  artworkId: string
  lockNumber: 1 | 2 | 3
  rejectedByUserId: string
  rejectionReason: string
}): Promise<{ success: boolean; message: string }> {
  const { artworkId, lockNumber, rejectedByUserId, rejectionReason } = params

  const artwork = await db.artwork.findUniqueOrThrow({
    where: { id: artworkId },
    include: { job: true, uploader: { select: { whatsappNumber: true, name: true } } },
  })

  await db.artworkApproval.upsert({
    where: { artworkId_lockNumber: { artworkId, lockNumber } },
    update: {
      approvedBy: rejectedByUserId,
      approvedAt: new Date(),
      rejected: true,
      rejectionReason,
    },
    create: {
      artworkId,
      lockNumber,
      approvedBy: rejectedByUserId,
      approvedAt: new Date(),
      rejected: true,
      rejectionReason,
    },
  })

  await db.artwork.update({
    where: { id: artworkId },
    data: { status: 'pending' },
  })

  // Notify the artwork uploader
  const message = `❌ ARTWORK REJECTED — Lock ${lockNumber}
Job: ${artwork.job.jobNumber} | ${artwork.job.productName}
Rejected by: Lock ${lockNumber} approver
Reason: ${rejectionReason}
Please upload corrected artwork at: ${process.env.NEXT_PUBLIC_APP_URL}/jobs/${artwork.jobId}/artwork`

  if (artwork.uploader.whatsappNumber) {
    await sendWhatsApp(artwork.uploader.whatsappNumber, message)
  }

  return {
    success: true,
    message: `Lock ${lockNumber} rejected. Artwork uploader notified via WhatsApp.`,
  }
}

// ─────────────────────────────────────────
// LOCK 4 — CTP AUTO-RELEASE
// Triggered automatically when Lock 3 is approved
// ─────────────────────────────────────────

async function triggerCTPRelease(artworkId: string, jobNumber: string) {
  const plateBarcode = `PLT-${jobNumber}-${nanoid(8).toUpperCase()}`

  await db.artwork.update({
    where: { id: artworkId },
    data: {
      locksCompleted: 4,
      status: 'approved',
      ctpReleaseAt: new Date(),
      plateBarcode,
    },
  })

  // Create Lock 4 record (system-generated)
  const systemUserId = await getSystemUserId()
  await db.artworkApproval.create({
    data: {
      artworkId,
      lockNumber: 4,
      approvedBy: systemUserId,
      approvedAt: new Date(),
      comments: `Auto-released. Plate barcode: ${plateBarcode}`,
    },
  })

  // Notify CTP operator and QA Manager
  const ctpOperators = await db.user.findMany({
    where: {
      active: true,
      machineAccess: { has: 'CI-12' },
      whatsappNumber: { not: null },
    },
  })

  const message = `✅ ARTWORK APPROVED — READY FOR CTP
Job: ${jobNumber}
All 4 locks complete ✓
Plate barcode: ${plateBarcode}
CTP queue: ${process.env.NEXT_PUBLIC_APP_URL}/ctp`

  for (const op of ctpOperators) {
    if (op.whatsappNumber) await sendWhatsApp(op.whatsappNumber, message)
  }
}

// ─────────────────────────────────────────
// VALIDATE PLATE AT PRESS — called when operator scans plate
// ─────────────────────────────────────────

export async function validatePlateAtPress(params: {
  plateBarcode: string
  jobId: string
  machineCode: string
  operatorUserId: string
}): Promise<{ valid: boolean; message: string; artworkVersion?: number }> {
  const { plateBarcode, jobId, machineCode } = params

  const artwork = await db.artwork.findFirst({
    where: { plateBarcode },
    include: { job: { select: { jobNumber: true } } },
  })

  if (!artwork) {
    return { valid: false, message: '❌ Plate barcode not recognised. Check plate is correct.' }
  }

  if (artwork.jobId !== jobId) {
    return {
      valid: false,
      message: `❌ WRONG PLATE. This plate belongs to Job ${artwork.job.jobNumber}, not this job. Do not proceed.`,
    }
  }

  if (artwork.status !== 'approved' || artwork.locksCompleted < 4) {
    return {
      valid: false,
      message: `❌ Artwork not fully approved. Locks completed: ${artwork.locksCompleted}/4. Cannot start press.`,
    }
  }

  return {
    valid: true,
    message: `✅ Plate verified for Job ${artwork.job.jobNumber} — Version ${artwork.versionNumber}. Press cleared to run.`,
    artworkVersion: artwork.versionNumber,
  }
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

async function notifyNextApprover(
  completedLock: number,
  jobNumber: string,
  productName: string,
  artworkId: string
) {
  const nextLock = completedLock + 1
  if (nextLock > 3) return

  const roleForLock: Record<number, string> = {
    2: 'qa_officer',
    3: 'qa_manager',
  }

  const role = roleForLock[nextLock]
  if (!role) return

  const approvers = await db.user.findMany({
    where: { active: true, role: { roleName: role }, whatsappNumber: { not: null } },
  })

  const message = `📋 ARTWORK READY — Lock ${nextLock} Required
Job: ${jobNumber} | ${productName}
Lock ${completedLock} ✓ completed
Your approval needed: ${process.env.NEXT_PUBLIC_APP_URL}/artwork/${artworkId}`

  for (const a of approvers) {
    if (a.whatsappNumber) await sendWhatsApp(a.whatsappNumber, message)
  }
}

async function getSystemUserId(): Promise<string> {
  const system = await db.user.findFirst({ where: { email: 'system@ci.internal' } })
  if (system) return system.id

  const mdRole = await db.role.findFirstOrThrow({ where: { roleName: 'md' } })
  const created = await db.user.create({
    data: {
      name: 'System',
      email: 'system@ci.internal',
      pinHash: 'system',
      roleId: mdRole.id,
      active: false,
    },
  })
  return created.id
}
