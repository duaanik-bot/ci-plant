import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type PlateHubDb = typeof db | Prisma.TransactionClient

/** Canonical zone labels written to hub events (also used in UI). */
export const HUB_ZONE = {
  INCOMING_TRIAGE: 'Incoming Triage',
  CTP_QUEUE: 'CTP Queue',
  OUTSIDE_VENDOR: 'Outside Vendor',
  LIVE_INVENTORY: 'Live Inventory',
  CUSTODY_FLOOR: 'Custody Floor',
  FULFILLED: 'Fulfilled',
  CANCELLED: 'Cancelled',
  ISSUED_PRESS: 'Issued to Press',
  OTHER: 'Other',
} as const

export const PLATE_HUB_ACTION = {
  DISPATCHED: 'DISPATCHED',
  RECEIVED: 'RECEIVED',
  SCRAPPED: 'SCRAPPED',
  RESIZED: 'RESIZED',
  RETURNED: 'RETURNED',
  MARKED_READY: 'MARKED_READY',
  REVERSED_READY: 'REVERSED_READY',
  TAKE_FROM_STOCK: 'TAKE_FROM_STOCK',
  /** One transaction: pull channels from multiple rack rows into custody. */
  BATCH_INVENTORY_PULL: 'BATCH_INVENTORY_PULL',
  FULFILLED: 'FULFILLED',
  CANCELLED: 'CANCELLED',
  SEND_BACK_TRIAGE: 'SEND_BACK_TRIAGE',
  VENDOR_SEND_BACK: 'VENDOR_SEND_BACK',
  VENDOR_RECEIVED_TO_TRIAGE: 'VENDOR_RECEIVED_TO_TRIAGE',
  RECALL_PREPRESS: 'RECALL_PREPRESS',
  UNDO_FINALIZE: 'UNDO_FINALIZE',
  EMERGENCY_ISSUE: 'EMERGENCY_ISSUE',
  PARTIAL_REMAKE_CREATED: 'PARTIAL_REMAKE_CREATED',
  MANUAL_CTP_CREATED: 'MANUAL_CTP_CREATED',
  MANUAL_VENDOR_CREATED: 'MANUAL_VENDOR_CREATED',
  REISSUE_REQUEST: 'REISSUE_REQUEST',
  MATERIALIZED_TO_INVENTORY: 'MATERIALIZED_TO_INVENTORY',
  PREPRESS_FINALIZE: 'PREPRESS_FINALIZE',
  /** CTP / vendor queue: operator changed plate sheet size from card. */
  SHOPFLOOR_SIZE_EDIT: 'SHOPFLOOR_SIZE_EDIT',
  /** CTP / vendor queue: operator toggled a colour off/on for burn list. */
  SHOPFLOOR_COLOUR_TOGGLE: 'SHOPFLOOR_COLOUR_TOGGLE',
  /** CTP / vendor: batch partial fulfillment — colours removed from manufacturing run. */
  PARTIAL_MANUFACTURING_ADJUST: 'PARTIAL_MANUFACTURING_ADJUST',
} as const

export type PlateHubActionType = (typeof PLATE_HUB_ACTION)[keyof typeof PLATE_HUB_ACTION]

export async function createPlateHubEvent(
  tx: PlateHubDb,
  args: {
    plateRequirementId?: string | null
    plateStoreId?: string | null
    actionType: string
    fromZone?: string | null
    toZone?: string | null
    details?: Prisma.InputJsonValue | null
  },
): Promise<void> {
  await tx.plateHubEvent.create({
    data: {
      plateRequirementId: args.plateRequirementId?.trim() || undefined,
      plateStoreId: args.plateStoreId?.trim() || undefined,
      actionType: args.actionType,
      fromZone: args.fromZone?.trim() || undefined,
      toZone: args.toZone?.trim() || undefined,
      details:
        args.details === undefined || args.details === null ? undefined : args.details,
    },
  })
}
