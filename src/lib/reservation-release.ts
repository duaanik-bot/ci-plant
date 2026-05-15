import type { Prisma, PrismaClient } from '@prisma/client'

export const TERMINAL_RELEASING_STATUSES = ['cancelled', 'completed', 'on_hold'] as const
export type TerminalReleasingStatus = (typeof TERMINAL_RELEASING_STATUSES)[number]

export const ACTIVE_RESERVATION_STATUSES = [
  'design_ready',
  'ready',
  'pending_artwork',
  'artwork_approved',
  'in_production',
  'folding',
  'final_qc',
  'packing',
] as const

export function isTerminalReleasingStatus(status: string): status is TerminalReleasingStatus {
  return (TERMINAL_RELEASING_STATUSES as readonly string[]).includes(status)
}

export type ReleaseTxClient = Prisma.TransactionClient | PrismaClient

export async function releaseReservationsForJob(
  jobCardId: string,
  newStatus: TerminalReleasingStatus,
  tx: ReleaseTxClient,
): Promise<{ releasedCount: number; materialIds: string[] }> {
  const targets = await tx.materialReservation.findMany({
    where: { jobCardId, isReleased: false },
    select: { id: true, materialId: true },
  })
  if (targets.length === 0) return { releasedCount: 0, materialIds: [] }

  const reason = `job_${newStatus}`
  await tx.materialReservation.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: {
      isReleased: true,
      releasedAt: new Date(),
      releasedReason: reason,
    },
  })

  const materialIds = Array.from(new Set(targets.map((t) => t.materialId)))
  return { releasedCount: targets.length, materialIds }
}

export async function recalculateMaterialShortage(
  materialId: string,
  tx: ReleaseTxClient,
): Promise<{ shortage: number; prCreated: boolean }> {
  throw new Error('not implemented')
}
