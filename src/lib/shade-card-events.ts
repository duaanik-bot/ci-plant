import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type ShadeCardDb = typeof db | Prisma.TransactionClient

export const SHADE_CARD_ACTION = {
  CREATED: 'CREATED',
  ISSUED: 'ISSUED',
  RECEIVED: 'RECEIVED',
  VENDOR_RECEIVED: 'VENDOR_RECEIVED',
} as const

export async function createShadeCardEvent(
  tx: ShadeCardDb,
  args: {
    shadeCardId: string
    actionType: string
    details?: Prisma.InputJsonValue | null
  },
): Promise<void> {
  const id = args.shadeCardId.trim()
  if (!id) return
  await tx.shadeCardEvent.create({
    data: {
      shadeCardId: id,
      actionType: args.actionType,
      details: args.details === undefined || args.details === null ? undefined : args.details,
    },
  })
}
