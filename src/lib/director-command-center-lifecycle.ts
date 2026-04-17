import type { PoLineItem, ProductionJobCard, PurchaseOrder } from '@prisma/client'
import { classifyPoToolingSignal, type DieStatusSnapshot } from '@/lib/po-tooling-signal'

export type DirectorStageKey = 'artwork' | 'tooling' | 'material' | 'production' | 'logistics' | 'complete'

export type BarPart = { n: number; c: string }

export type DirectorLifeBars = {
  artworks: BarPart[]
  tooling: BarPart[]
  material: BarPart[]
  production: BarPart[]
  logistics: BarPart[]
}

const MS_DAY = 86_400_000
const MS_48H = 48 * 60 * 60 * 1000

export const DIRECTOR_AUDIT_ACTOR =
  'Actioned by Anik Dua via Command Center.'

function asSpec(li: PoLineItem): Record<string, unknown> {
  return li.specOverrides && typeof li.specOverrides === 'object'
    ? (li.specOverrides as Record<string, unknown>)
    : {}
}

export function toolingSnapshotFromRow(d: {
  custodyStatus: string
  condition: string
  dyeNumber: number
  location: string | null
  hubStatusFlag: string | null
}): DieStatusSnapshot {
  return {
    custodyStatus: d.custodyStatus,
    condition: d.condition,
    dyeNumber: d.dyeNumber,
    location: d.location,
    hubStatusFlag: d.hubStatusFlag,
  }
}

export function computeToolingInput(li: PoLineItem) {
  return {
    cartonName: li.cartonName,
    quantity: String(li.quantity),
    cartonId: li.cartonId ?? '',
    dieMasterId: li.dieMasterId ?? '',
    toolingUnlinked: !(li.cartonId && li.dieMasterId),
  }
}

/** Single-line tooling R/Y/G stack for life-bar. */
export function artworksBarParts(li: PoLineItem, _jc: ProductionJobCard | null): BarPart[] {
  const spec = asSpec(li)
  const prePress = Boolean(spec.prePressSentToPlateHubAt)
  const a = Boolean(spec.customerApprovalPharma)
  const b = Boolean(spec.shadeCardQaTextApproval)
  if (prePress) return [{ n: 1, c: 'bg-emerald-500' }]
  if (a || b) return [{ n: 1, c: 'bg-sky-500' }]
  return [{ n: 1, c: 'bg-slate-600' }]
}

export function toolingBarParts(li: PoLineItem, dye: DieStatusSnapshot | null | undefined): BarPart[] {
  const sig = classifyPoToolingSignal(computeToolingInput(li), dye ?? undefined)
  if (sig === 'green') return [{ n: 1, c: 'bg-emerald-500' }]
  if (sig === 'yellow') return [{ n: 1, c: 'bg-amber-400' }]
  return [{ n: 1, c: 'bg-rose-500' }]
}

export function materialBarParts(li: PoLineItem): BarPart[] {
  const x = (li.materialProcurementStatus ?? '').trim().toLowerCase()
  if (x === 'received') return [{ n: 1, c: 'bg-emerald-500' }]
  if (x === 'on_order' || x === 'dispatched' || x === 'paper_ordered') return [{ n: 1, c: 'bg-sky-500' }]
  return [{ n: 1, c: 'bg-slate-600' }]
}

export function productionBarParts(li: PoLineItem, jc: ProductionJobCard | null): BarPart[] {
  if (li.planningStatus === 'closed' || jc?.qaReleased) return [{ n: 1, c: 'bg-emerald-500' }]
  if (li.planningStatus === 'in_production') return [{ n: 1, c: 'bg-orange-500' }]
  return [{ n: 1, c: 'bg-slate-600' }]
}

export function logisticsBarParts(_li: PoLineItem, po: PurchaseOrder, _jc: ProductionJobCard | null): BarPart[] {
  if (po.status === 'closed') return [{ n: 1, c: 'bg-emerald-500' }]
  return [{ n: 1, c: 'bg-slate-600' }]
}

export function computeLifeBars(
  li: PoLineItem,
  po: PurchaseOrder,
  jc: ProductionJobCard | null,
  dye: DieStatusSnapshot | null | undefined,
): DirectorLifeBars {
  return {
    artworks: artworksBarParts(li, jc),
    tooling: toolingBarParts(li, dye),
    material: materialBarParts(li),
    production: productionBarParts(li, jc),
    logistics: logisticsBarParts(li, po, jc),
  }
}

export function deriveDirectorStageKey(
  li: PoLineItem,
  po: PurchaseOrder,
  jc: ProductionJobCard | null,
  dye: DieStatusSnapshot | null | undefined,
): DirectorStageKey {
  if (po.status === 'closed') return 'complete'

  const spec = asSpec(li)
  const prePress = Boolean(spec.prePressSentToPlateHubAt)
  const approvals = Boolean(spec.customerApprovalPharma && spec.shadeCardQaTextApproval)
  if (!prePress || !approvals) return 'artwork'

  const t = classifyPoToolingSignal(computeToolingInput(li), dye ?? undefined)
  if (t !== 'green') return 'tooling'

  const mat = (li.materialProcurementStatus ?? '').trim().toLowerCase()
  if (mat !== 'received') return 'material'

  if (jc?.qaReleased && po.status !== 'closed') return 'logistics'

  if (po.status === 'confirmed') return 'production'

  return 'complete'
}

/** WIP value: confirmed, open PO, not on hold, primary stage tooling|material|production. */
export function lineContributesToWipValue(
  li: PoLineItem,
  po: PurchaseOrder,
  jc: ProductionJobCard | null,
  dye: DieStatusSnapshot | null | undefined,
): boolean {
  if (po.status !== 'confirmed') return false
  if (li.directorHold) return false
  const k = deriveDirectorStageKey(li, po, jc, dye)
  return k === 'tooling' || k === 'material' || k === 'production'
}

export function lineValueRupee(li: PoLineItem): number {
  return (li.rate ? Number(li.rate) : 0) * li.quantity
}

export function isDirectorBottleneck(
  li: PoLineItem,
  po: PurchaseOrder,
  now: Date = new Date(),
): boolean {
  if (po.status === 'closed' || li.directorHold) return false
  const entered = li.directorCurrentStageEnteredAt
  if (!entered) return false
  return now.getTime() - entered.getTime() > MS_48H
}

export function daysSince(date: Date | null | undefined, now: Date = new Date()): number {
  if (!date) return 0
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.max(0, Math.round((a.getTime() - b.getTime()) / MS_DAY))
}

export function poReceiptAgeDays(poDate: Date, now: Date = new Date()): number {
  return daysSince(poDate, now)
}

export function stageWipDays(
  stageKey: DirectorStageKey,
  li: PoLineItem,
  now: Date = new Date(),
): number | null {
  const map: Record<string, Date | null | undefined> = {
    artwork: li.artworkStageEnteredAt,
    tooling: li.toolingStageEnteredAt,
    material: li.materialStageEnteredAt,
    production: li.productionStageEnteredAt,
    logistics: li.logisticsStageEnteredAt,
    complete: li.logisticsStageEnteredAt,
  }
  const d = map[stageKey]
  if (!d) return null
  return Math.max(0, (now.getTime() - d.getTime()) / MS_DAY)
}

/** Patch Prisma fields when derived stage changes or first-seen clocks. */
export function buildDirectorStageSyncPatch(
  li: PoLineItem,
  nextKey: DirectorStageKey,
  now: Date = new Date(),
): Partial<PoLineItem> {
  const patch: Partial<PoLineItem> = {}
  if (!li.artworkStageEnteredAt) {
    patch.artworkStageEnteredAt = li.createdAt
  }

  const cur = li.directorCurrentStageKey as DirectorStageKey | null | undefined
  if (cur !== nextKey) {
    patch.directorCurrentStageKey = nextKey
    patch.directorCurrentStageEnteredAt = now
    if (nextKey === 'tooling' && !li.toolingStageEnteredAt) patch.toolingStageEnteredAt = now
    if (nextKey === 'material' && !li.materialStageEnteredAt) patch.materialStageEnteredAt = now
    if (nextKey === 'production' && !li.productionStageEnteredAt) patch.productionStageEnteredAt = now
    if (nextKey === 'logistics' && !li.logisticsStageEnteredAt) patch.logisticsStageEnteredAt = now
    if (nextKey === 'complete' && !li.logisticsStageEnteredAt) patch.logisticsStageEnteredAt = now
  }

  return patch
}
