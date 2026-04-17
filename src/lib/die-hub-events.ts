import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type DieHubDb = typeof db | Prisma.TransactionClient

export const DIE_HUB_ACTION = {
  TRIAGE_TO_VENDOR: 'TRIAGE_TO_VENDOR',
  PUSH_TO_TRIAGE: 'PUSH_TO_TRIAGE',
  MARKED_READY: 'MARKED_READY',
  REVERSE_STAGING: 'REVERSE_STAGING',
  RETURN_TO_RACK: 'RETURN_TO_RACK',
  SCRAP: 'SCRAP',
  MANUAL_VENDOR_CREATE: 'MANUAL_VENDOR_CREATE',
  SIZE_CHANGED_ON_RETURN: 'SIZE_CHANGED_ON_RETURN',
  MANUFACTURED_AND_RECEIVED: 'MANUFACTURED_AND_RECEIVED',
  TAKE_FROM_STOCK_TO_CUSTODY: 'TAKE_FROM_STOCK_TO_CUSTODY',
  TRIAGE_ARCHIVED_STOCK_FULFILL: 'TRIAGE_ARCHIVED_STOCK_FULFILL',
} as const

export async function createDieHubEvent(
  tx: DieHubDb,
  args: {
    dyeId: string
    actionType: string
    fromZone?: string | null
    toZone?: string | null
    details?: Prisma.InputJsonValue | null
  },
): Promise<void> {
  const id = args.dyeId.trim()
  if (!id) return
  await tx.dieHubEvent.create({
    data: {
      dyeId: id,
      actionType: args.actionType,
      fromZone: args.fromZone?.trim() || undefined,
      toZone: args.toZone?.trim() || undefined,
      details:
        args.details === undefined || args.details === null ? undefined : args.details,
    },
  })
}
