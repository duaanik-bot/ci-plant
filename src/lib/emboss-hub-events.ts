import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type EmbossHubDb = typeof db | Prisma.TransactionClient

export const EMBOSS_HUB_ACTION = {
  TRIAGE_TO_ENGRAVING: 'TRIAGE_TO_ENGRAVING',
  PUSH_TO_TRIAGE: 'PUSH_TO_TRIAGE',
  MARKED_READY: 'MARKED_READY',
  REVERSE_STAGING: 'REVERSE_STAGING',
  RETURN_TO_RACK: 'RETURN_TO_RACK',
  SCRAP: 'SCRAP',
  MANUAL_ENGRAVING_CREATE: 'MANUAL_ENGRAVING_CREATE',
  SIZE_CHANGED_ON_RETURN: 'SIZE_CHANGED_ON_RETURN',
  ISSUE_TO_MACHINE: 'ISSUE_TO_MACHINE',
  INVENTORY_TO_CUSTODY_FLOOR: 'INVENTORY_TO_CUSTODY_FLOOR',
} as const

export async function createEmbossHubEvent(
  tx: EmbossHubDb,
  args: {
    blockId: string
    actionType: string
    fromZone?: string | null
    toZone?: string | null
    details?: Prisma.InputJsonValue | null
  },
): Promise<void> {
  const id = args.blockId.trim()
  if (!id) return
  await tx.embossHubEvent.create({
    data: {
      blockId: id,
      actionType: args.actionType,
      fromZone: args.fromZone?.trim() || undefined,
      toZone: args.toZone?.trim() || undefined,
      details:
        args.details === undefined || args.details === null ? undefined : args.details,
    },
  })
}
