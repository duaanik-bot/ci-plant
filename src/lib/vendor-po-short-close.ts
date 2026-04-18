import type { PrismaClient } from '@prisma/client'

/**
 * Manual short-close authority: button enables when received/ordered ≥ this % (0–100 scale).
 * Server POST enforces the same gate.
 */
export const SHORT_CLOSE_AUTHORITY_THRESHOLD = 95.0

export const SHORT_CLOSE_REASONS = [
  'Reel/Core Variance',
  'Vendor Stock End',
  'Quality Rejection',
  'Director Override',
] as const

export type ShortCloseReason = (typeof SHORT_CLOSE_REASONS)[number]

/** Roles allowed to execute short-close (matches `roles.role_name`). */
export const SHORT_CLOSE_EXECUTOR_ROLES = ['md', 'director', 'procurement_manager'] as const

export type VendorPoShortCloseSnapshot = {
  orderedKg: number
  receivedKg: number
  completionPct: number
  /** True when dispatched PO meets authority threshold (may short-close). */
  eligible: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Sum net received kg per vendor PO line from gate reconciliations. */
export async function netReceivedKgByVendorLineId(
  db: PrismaClient,
  vendorLineIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (vendorLineIds.length === 0) return out
  const recons = await db.materialWeightReconciliation.findMany({
    where: { vendorMaterialPoLineId: { in: vendorLineIds } },
    select: { vendorMaterialPoLineId: true, netReceivedKg: true },
  })
  for (const r of recons) {
    const id = r.vendorMaterialPoLineId
    if (!id) continue
    const kg = Number(r.netReceivedKg)
    if (!Number.isFinite(kg)) continue
    out.set(id, (out.get(id) ?? 0) + kg)
  }
  return out
}

export function computeShortCloseSnapshot(
  vpo: {
    status: string
    isShortClosed: boolean
    lines: { id: string; totalWeightKg: unknown }[]
  },
  receivedByLineId: Map<string, number>,
): VendorPoShortCloseSnapshot {
  let orderedKg = 0
  let receivedKg = 0
  for (const li of vpo.lines) {
    orderedKg += Number(li.totalWeightKg)
    receivedKg += receivedByLineId.get(li.id) ?? 0
  }
  orderedKg = round2(orderedKg)
  receivedKg = round2(receivedKg)
  const completionPct = orderedKg > 0 ? round2((receivedKg / orderedKg) * 100) : 0

  if (vpo.status === 'closed' && vpo.isShortClosed) {
    return { orderedKg, receivedKg, completionPct, eligible: false }
  }

  if (vpo.status !== 'dispatched' || vpo.isShortClosed) {
    return { orderedKg, receivedKg, completionPct, eligible: false }
  }

  const eligible = orderedKg > 0 && completionPct >= SHORT_CLOSE_AUTHORITY_THRESHOLD
  return { orderedKg, receivedKg, completionPct, eligible }
}

export function canAuthorizeShortCloseRole(roleName: string | undefined | null): boolean {
  if (!roleName) return false
  const r = roleName.trim().toLowerCase()
  return r === 'md' || r === 'director' || r === 'procurement_manager'
}

/** Build map vendorPoId → snapshot for all POs in `vendorPos` (uses one recon query). */
export async function shortCloseSnapshotsForVendorPos<
  T extends {
    id: string
    status: string
    isShortClosed: boolean
    lines: { id: string; totalWeightKg: unknown }[]
  },
>(db: PrismaClient, vendorPos: T[]): Promise<Map<string, VendorPoShortCloseSnapshot>> {
  const allLineIds = vendorPos.flatMap((v) => v.lines.map((l) => l.id))
  const receivedByLine = await netReceivedKgByVendorLineId(db, allLineIds)
  const out = new Map<string, VendorPoShortCloseSnapshot>()
  for (const v of vendorPos) {
    out.set(v.id, computeShortCloseSnapshot(v, receivedByLine))
  }
  return out
}
