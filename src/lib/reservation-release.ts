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
  throw new Error('not implemented')
}

export async function recalculateMaterialShortage(
  materialId: string,
  tx: ReleaseTxClient,
): Promise<{ shortage: number; prCreated: boolean }> {
  throw new Error('not implemented')
}
