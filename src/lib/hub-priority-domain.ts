import type { PrismaClient } from '@prisma/client'
import { shadeCardAgeMonthsExact } from '@/lib/shade-card-age'
import { shadeCardKanbanColumn, type ShadeKanbanColumnId } from '@/lib/shade-card-kanban'
import {
  CUSTODY_AT_VENDOR,
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_HUB_ENGRAVING_QUEUE,
  CUSTODY_HUB_TRIAGE,
  CUSTODY_IN_STOCK,
  CUSTODY_ON_FLOOR,
} from '@/lib/inventory-hub-custody'

export const HUB_PRIORITY_DOMAINS = [
  'plate_ctp',
  'plate_vendor',
  'die_triage',
  'die_prep',
  'die_inventory',
  'die_custody',
  'emboss_triage',
  'emboss_prep',
  'emboss_inventory',
  'emboss_custody',
  'shade_in_stock',
  'shade_on_floor',
  'shade_reverify',
  'shade_expired',
] as const

export type HubPriorityDomain = (typeof HUB_PRIORITY_DOMAINS)[number]

type OrderGetter<T> = (row: T) => number | null | undefined

function sortByOrderThen<T>(rows: T[], getOrder: OrderGetter<T>, tie: (a: T, b: T) => number): T[] {
  return [...rows].sort((a, b) => {
    const oa = getOrder(a) ?? Number.MAX_SAFE_INTEGER
    const ob = getOrder(b) ?? Number.MAX_SAFE_INTEGER
    if (oa !== ob) return oa - ob
    return tie(a, b)
  })
}

/** Ordered IDs (highest priority first) for a hub column, for persistence. */
export async function getOrderedIdsForDomain(
  db: PrismaClient,
  domain: HubPriorityDomain,
): Promise<string[]> {
  if (domain === 'plate_ctp') {
    const rows = await db.plateRequirement.findMany({
      where: {
        hubSoftDeletedAt: null,
        status: 'ctp_internal_queue',
        triageChannel: 'inhouse_ctp',
      },
      select: { id: true, hubOrderCtp: true, createdAt: true },
    })
    return sortByOrderThen(
      rows,
      (r) => r.hubOrderCtp,
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    ).map((r) => r.id)
  }

  if (domain === 'plate_vendor') {
    const rows = await db.plateRequirement.findMany({
      where: {
        hubSoftDeletedAt: null,
        triageChannel: 'outside_vendor',
        status: 'awaiting_vendor_delivery',
      },
      select: { id: true, hubOrderVendor: true, createdAt: true },
    })
    return sortByOrderThen(
      rows,
      (r) => r.hubOrderVendor,
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    ).map((r) => r.id)
  }

  if (domain.startsWith('die_') || domain.startsWith('emboss_')) {
    const tool = domain.startsWith('die_') ? 'die' as const : 'emboss' as const
    const col = domain.replace(/^(die|emboss)_/, '') as
      | 'triage'
      | 'prep'
      | 'inventory'
      | 'custody'

    if (tool === 'die') {
      const where =
        col === 'triage'
          ? { active: true, hubSoftDeletedAt: null, custodyStatus: CUSTODY_HUB_TRIAGE }
          : col === 'prep'
            ? { active: true, hubSoftDeletedAt: null, custodyStatus: CUSTODY_AT_VENDOR }
            : col === 'inventory'
              ? { active: true, hubSoftDeletedAt: null, custodyStatus: CUSTODY_IN_STOCK }
              : {
                  active: true,
                  hubSoftDeletedAt: null,
                  custodyStatus: { in: [CUSTODY_HUB_CUSTODY_READY, CUSTODY_ON_FLOOR] },
                }
      const orderField =
        col === 'triage'
          ? 'hubOrderTriage'
          : col === 'prep'
            ? 'hubOrderPrep'
            : col === 'inventory'
              ? 'hubOrderInventory'
              : 'hubOrderCustody'
      const rows = await db.dye.findMany({
        where,
        select: { id: true, dyeNumber: true, createdAt: true, hubOrderTriage: true, hubOrderPrep: true, hubOrderInventory: true, hubOrderCustody: true },
      })
      const getO = (r: (typeof rows)[0]) => {
        if (orderField === 'hubOrderTriage') return r.hubOrderTriage
        if (orderField === 'hubOrderPrep') return r.hubOrderPrep
        if (orderField === 'hubOrderInventory') return r.hubOrderInventory
        return r.hubOrderCustody
      }
      return sortByOrderThen(rows, getO, (a, b) => a.dyeNumber - b.dyeNumber).map((r) => r.id)
    }

    // emboss
    const where =
      col === 'triage'
        ? { active: true, hubSoftDeletedAt: null, custodyStatus: CUSTODY_HUB_TRIAGE }
        : col === 'prep'
          ? { active: true, hubSoftDeletedAt: null, custodyStatus: CUSTODY_HUB_ENGRAVING_QUEUE }
          : col === 'inventory'
            ? { active: true, hubSoftDeletedAt: null, custodyStatus: CUSTODY_IN_STOCK }
            : {
                active: true,
                hubSoftDeletedAt: null,
                custodyStatus: { in: [CUSTODY_HUB_CUSTODY_READY, CUSTODY_ON_FLOOR] },
              }
    const orderField =
      col === 'triage'
        ? 'hubOrderTriage'
        : col === 'prep'
          ? 'hubOrderPrep'
          : col === 'inventory'
            ? 'hubOrderInventory'
            : 'hubOrderCustody'
    const rows = await db.embossBlock.findMany({
      where,
      select: {
        id: true,
        blockCode: true,
        createdAt: true,
        hubOrderTriage: true,
        hubOrderPrep: true,
        hubOrderInventory: true,
        hubOrderCustody: true,
      },
    })
    const getO = (r: (typeof rows)[0]) => {
      if (orderField === 'hubOrderTriage') return r.hubOrderTriage
      if (orderField === 'hubOrderPrep') return r.hubOrderPrep
      if (orderField === 'hubOrderInventory') return r.hubOrderInventory
      return r.hubOrderCustody
    }
    return sortByOrderThen(rows, getO, (a, b) => a.blockCode.localeCompare(b.blockCode)).map((r) => r.id)
  }

  // shade_* — same fields as queryShadeCardHubRows / kanban
  const col = domain.replace('shade_', '') as ShadeKanbanColumnId
  const orderKey =
    col === 'in_stock'
      ? 'hubOrderInStock'
      : col === 'on_floor'
        ? 'hubOrderOnFloor'
        : col === 'reverify'
          ? 'hubOrderReverify'
          : 'hubOrderExpired'

  const raw = await db.shadeCard.findMany({
    where: { isActive: true, hubSoftDeletedAt: null },
    select: {
      id: true,
      mfgDate: true,
      custodyStatus: true,
      hubOrderInStock: true,
      hubOrderOnFloor: true,
      hubOrderReverify: true,
      hubOrderExpired: true,
      shadeCode: true,
    },
  })
  const inCol = raw.filter((c) => {
    const months = shadeCardAgeMonthsExact(c.mfgDate ?? undefined)
    return (
      shadeCardKanbanColumn({
        currentAgeMonths: months,
        custodyStatus: c.custodyStatus,
      }) === col
    )
  })
  return sortByOrderThen(
    inCol,
    (r) => {
      if (orderKey === 'hubOrderInStock') return r.hubOrderInStock
      if (orderKey === 'hubOrderOnFloor') return r.hubOrderOnFloor
      if (orderKey === 'hubOrderReverify') return r.hubOrderReverify
      return r.hubOrderExpired
    },
    (a, b) => a.shadeCode.localeCompare(b.shadeCode),
  ).map((r) => r.id)
}

/** Who reordered; applied only to the row that the user moved. */
export type HubPriorityAudit = { entityId: string; userName: string }

/** Writes dense 0..n-1 indices for every ID in the column. Optionally stamps last reordered on `audit.entityId`. */
export async function persistOrderedIds(
  db: PrismaClient,
  domain: HubPriorityDomain,
  orderedIds: string[],
  audit?: HubPriorityAudit,
): Promise<void> {
  const now = audit ? new Date() : null
  const stamp = (id: string) =>
    audit && id === audit.entityId && now
      ? { lastReorderedBy: audit.userName, lastReorderedAt: now }
      : {}

  const updates = orderedIds.map((id, i) => {
    if (domain === 'plate_ctp') {
      return db.plateRequirement.update({ where: { id }, data: { hubOrderCtp: i, ...stamp(id) } })
    }
    if (domain === 'plate_vendor') {
      return db.plateRequirement.update({ where: { id }, data: { hubOrderVendor: i, ...stamp(id) } })
    }
    if (domain === 'die_triage' || domain === 'emboss_triage') {
      return domain.startsWith('die')
        ? db.dye.update({ where: { id }, data: { hubOrderTriage: i, ...stamp(id) } })
        : db.embossBlock.update({ where: { id }, data: { hubOrderTriage: i, ...stamp(id) } })
    }
    if (domain === 'die_prep' || domain === 'emboss_prep') {
      return domain.startsWith('die')
        ? db.dye.update({ where: { id }, data: { hubOrderPrep: i, ...stamp(id) } })
        : db.embossBlock.update({ where: { id }, data: { hubOrderPrep: i, ...stamp(id) } })
    }
    if (domain === 'die_inventory' || domain === 'emboss_inventory') {
      return domain.startsWith('die')
        ? db.dye.update({ where: { id }, data: { hubOrderInventory: i, ...stamp(id) } })
        : db.embossBlock.update({ where: { id }, data: { hubOrderInventory: i, ...stamp(id) } })
    }
    if (domain === 'die_custody' || domain === 'emboss_custody') {
      return domain.startsWith('die')
        ? db.dye.update({ where: { id }, data: { hubOrderCustody: i, ...stamp(id) } })
        : db.embossBlock.update({ where: { id }, data: { hubOrderCustody: i, ...stamp(id) } })
    }
    if (domain === 'shade_in_stock') {
      return db.shadeCard.update({ where: { id }, data: { hubOrderInStock: i, ...stamp(id) } })
    }
    if (domain === 'shade_on_floor') {
      return db.shadeCard.update({ where: { id }, data: { hubOrderOnFloor: i, ...stamp(id) } })
    }
    if (domain === 'shade_reverify') {
      return db.shadeCard.update({ where: { id }, data: { hubOrderReverify: i, ...stamp(id) } })
    }
    return db.shadeCard.update({ where: { id }, data: { hubOrderExpired: i, ...stamp(id) } })
  })
  await db.$transaction(updates)
}
