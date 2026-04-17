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
  MANUAL_LIVE_CREATE: 'MANUAL_LIVE_CREATE',
  SIZE_CHANGED_ON_RETURN: 'SIZE_CHANGED_ON_RETURN',
  MANUFACTURED_AND_RECEIVED: 'MANUFACTURED_AND_RECEIVED',
  TAKE_FROM_STOCK_TO_CUSTODY: 'TAKE_FROM_STOCK_TO_CUSTODY',
  TRIAGE_ARCHIVED_STOCK_FULFILL: 'TRIAGE_ARCHIVED_STOCK_FULFILL',
  VENDOR_TO_LIVE_INVENTORY: 'VENDOR_TO_LIVE_INVENTORY',
  INVENTORY_TO_CUSTODY_FLOOR: 'INVENTORY_TO_CUSTODY_FLOOR',
  ISSUE_TO_MACHINE: 'ISSUE_TO_MACHINE',
  TRIAGE_ON_HOLD: 'TRIAGE_ON_HOLD',
  TRIAGE_HOLD_RELEASED: 'TRIAGE_HOLD_RELEASED',
  MANUAL_LINK_STOCK_FULFILL: 'MANUAL_LINK_STOCK_FULFILL',
  MAINTENANCE_COMPLETE: 'MAINTENANCE_COMPLETE',
  /** Global reverse (↺) — does not delete prior row; links via supersededByUndoEventId */
  HUB_UNDO_LAST: 'HUB_UNDO_LAST',
} as const

/** High-level categories for compliance / timelines */
export const DIE_HUB_AUDIT_ACTION = {
  ISSUE: 'ISSUE',
  RETURN: 'RETURN',
  UNDO: 'UNDO',
  ZONE_MOVE: 'ZONE_MOVE',
  CONDITION_CHANGE: 'CONDITION_CHANGE',
  SCRAP: 'SCRAP',
} as const

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

/** Canonical labels stored on `die_hub_events.hub_action` for immutable timelines. */
export function canonicalHubAction(actionType: string): string {
  switch (actionType) {
    case DIE_HUB_ACTION.ISSUE_TO_MACHINE:
      return 'ISSUED_TO_MACHINE'
    case DIE_HUB_ACTION.RETURN_TO_RACK:
    case DIE_HUB_ACTION.SIZE_CHANGED_ON_RETURN:
      return 'RETURNED_TO_RACK'
    case DIE_HUB_ACTION.HUB_UNDO_LAST:
    case DIE_HUB_ACTION.REVERSE_STAGING:
      return 'REVERSED'
    case DIE_HUB_ACTION.SCRAP:
      return 'SCRAPPED'
    case DIE_HUB_ACTION.MAINTENANCE_COMPLETE:
      return 'MAINTENANCE_CLEARED'
    case DIE_HUB_ACTION.MARKED_READY:
      return 'MARKED_READY'
    case DIE_HUB_ACTION.TRIAGE_TO_VENDOR:
    case DIE_HUB_ACTION.PUSH_TO_TRIAGE:
    case DIE_HUB_ACTION.VENDOR_TO_LIVE_INVENTORY:
    case DIE_HUB_ACTION.INVENTORY_TO_CUSTODY_FLOOR:
    case DIE_HUB_ACTION.TRIAGE_ARCHIVED_STOCK_FULFILL:
      return 'ZONE_CHANGED'
    case DIE_HUB_ACTION.MANUAL_VENDOR_CREATE:
    case DIE_HUB_ACTION.MANUAL_LIVE_CREATE:
      return 'MANUAL_RECORD_ADDED'
    case DIE_HUB_ACTION.MANUFACTURED_AND_RECEIVED:
      return 'MANUFACTURED_AND_RECEIVED'
    case DIE_HUB_ACTION.TAKE_FROM_STOCK_TO_CUSTODY:
      return 'STOCK_TO_CUSTODY'
    case DIE_HUB_ACTION.TRIAGE_ON_HOLD:
      return 'TRIAGE_ON_HOLD'
    case DIE_HUB_ACTION.TRIAGE_HOLD_RELEASED:
      return 'TRIAGE_HOLD_RELEASED'
    case DIE_HUB_ACTION.MANUAL_LINK_STOCK_FULFILL:
      return 'MANUAL_LINK'
    default:
      return actionType
  }
}

export function auditCategoryForGranularAction(actionType: string): string {
  switch (actionType) {
    case DIE_HUB_ACTION.ISSUE_TO_MACHINE:
      return DIE_HUB_AUDIT_ACTION.ISSUE
    case DIE_HUB_ACTION.RETURN_TO_RACK:
    case DIE_HUB_ACTION.SIZE_CHANGED_ON_RETURN:
      return DIE_HUB_AUDIT_ACTION.RETURN
    case DIE_HUB_ACTION.HUB_UNDO_LAST:
    case DIE_HUB_ACTION.REVERSE_STAGING:
      return DIE_HUB_AUDIT_ACTION.UNDO
    case DIE_HUB_ACTION.SCRAP:
      return DIE_HUB_AUDIT_ACTION.SCRAP
    case DIE_HUB_ACTION.MAINTENANCE_COMPLETE:
      return DIE_HUB_AUDIT_ACTION.CONDITION_CHANGE
    default:
      return DIE_HUB_AUDIT_ACTION.ZONE_MOVE
  }
}

function buildDefaultMetadata(
  actionType: string,
  details: Prisma.InputJsonValue | null | undefined,
): Prisma.InputJsonValue | undefined {
  const d = asRecord(details)
  if (!d) return undefined
  const condition =
    typeof d.returnCondition === 'string'
      ? d.returnCondition
      : typeof d.condition === 'string'
        ? d.condition
        : undefined
  const remarks =
    typeof d.sizeModificationRemarks === 'string'
      ? d.sizeModificationRemarks
      : typeof d.remarks === 'string'
        ? d.remarks
        : undefined
  const reason = typeof d.reason === 'string' ? d.reason : typeof d.scrapReason === 'string' ? d.scrapReason : undefined
  if (!condition && !remarks && !reason) return undefined
  const meta: Record<string, unknown> = {}
  if (condition) meta.condition = condition
  if (remarks) meta.remarks = remarks
  if (reason) meta.remarks = meta.remarks ? `${meta.remarks} · ${reason}` : reason
  return meta as Prisma.InputJsonValue
}

export type LogDieHubEventArgs = {
  dyeId: string
  actionType: string
  fromZone?: string | null
  toZone?: string | null
  details?: Prisma.InputJsonValue | null
  /** @deprecated prefer actorName */
  operatorName?: string | null
  actorName?: string | null
  auditActionType?: string | null
  metadata?: Prisma.InputJsonValue | null
  /** Override canonical hub_action (rare). */
  hubAction?: string | null
  /** Good | Fair | Poor when applicable. */
  eventCondition?: string | null
}

/**
 * Immutable-style Die Hub audit row. Use this (or `logDieHubEvent`) for every die hub mutation.
 */
function resolveEventCondition(args: LogDieHubEventArgs): string | null {
  if (args.eventCondition !== undefined && args.eventCondition !== null) {
    const c = args.eventCondition.trim()
    return c || null
  }
  if (
    args.actionType === DIE_HUB_ACTION.RETURN_TO_RACK ||
    args.actionType === DIE_HUB_ACTION.SIZE_CHANGED_ON_RETURN
  ) {
    const d = asRecord(args.details)
    const rc = d?.returnCondition
    if (typeof rc === 'string' && rc.trim()) return rc.trim()
  }
  if (args.actionType === DIE_HUB_ACTION.MAINTENANCE_COMPLETE) {
    const m = asRecord(args.metadata)
    const c = m?.condition
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

const DEFAULT_DIE_HUB_EVENT_ACTOR = 'Anik Dua'

export async function createDieHubEvent(tx: DieHubDb, args: LogDieHubEventArgs): Promise<void> {
  const id = args.dyeId.trim()
  if (!id) return
  const actor =
    args.actorName?.trim() ||
    args.operatorName?.trim() ||
    DEFAULT_DIE_HUB_EVENT_ACTOR
  const audit =
    args.auditActionType?.trim() || auditCategoryForGranularAction(args.actionType)
  const meta =
    args.metadata !== undefined && args.metadata !== null
      ? args.metadata
      : buildDefaultMetadata(args.actionType, args.details)
  const hubAction = (args.hubAction?.trim() || canonicalHubAction(args.actionType)) || undefined
  const eventCondition = resolveEventCondition(args)
  await tx.dieHubEvent.create({
    data: {
      dyeId: id,
      actionType: args.actionType,
      fromZone: args.fromZone?.trim() || undefined,
      toZone: args.toZone?.trim() || undefined,
      details: args.details === undefined || args.details === null ? undefined : args.details,
      operatorName: actor,
      actorName: actor,
      auditActionType: audit,
      metadata: meta === undefined ? undefined : meta,
      hubAction,
      eventCondition: eventCondition || undefined,
    },
  })
}

/** Alias — same as createDieHubEvent (explicit “log” naming for architects). */
export const logDieHubEvent = createDieHubEvent
