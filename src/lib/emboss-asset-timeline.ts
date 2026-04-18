import { EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'

export type EmbossTimelineEntry = {
  id: string
  atIso: string
  actionLabel: string
  jobCardId: string | null
  jobDisplay: string | null
  impressionsDelta: number | null
  /** Running cumulative impressions after this event (usage rows only; newest-first list pre-computed). */
  impressionsCumulative: number | null
  operatorName: string | null
  source: 'usage' | 'hub' | 'maintenance'
}

export function hubEventToActionLabel(actionType: string): string {
  const a = actionType.trim().toUpperCase()
  switch (a) {
    case EMBOSS_HUB_ACTION.ISSUE_TO_MACHINE:
      return 'Mounted'
    case EMBOSS_HUB_ACTION.RETURN_TO_RACK:
      return 'Unmounted'
    case EMBOSS_HUB_ACTION.INVENTORY_TO_CUSTODY_FLOOR:
      return 'Received'
    case EMBOSS_HUB_ACTION.MARKED_READY:
      return 'QC'
    case EMBOSS_HUB_ACTION.TRIAGE_TO_ENGRAVING:
      return 'Received'
    case EMBOSS_HUB_ACTION.PUSH_TO_TRIAGE:
      return 'Received'
    case EMBOSS_HUB_ACTION.SCRAP:
      return 'Scrapped'
    case EMBOSS_HUB_ACTION.REVERSE_STAGING:
      return 'Reversed'
    case EMBOSS_HUB_ACTION.SIZE_CHANGED_ON_RETURN:
      return 'Size change'
    case EMBOSS_HUB_ACTION.MANUAL_ENGRAVING_CREATE:
      return 'Created'
    default:
      return actionType.replace(/_/g, ' ') || 'Hub event'
  }
}

export function maintenanceToActionLabel(actionType: string): string {
  const t = actionType.trim().toLowerCase()
  if (t.includes('polish')) return 'Polished'
  if (t.includes('qc') || t.includes('inspect')) return 'QC'
  if (t.includes('scrap')) return 'Scrapped'
  return actionType.trim() || 'Maintenance'
}

/** Merge hub events, maintenance, and usage into a single timeline (newest first). */
export function buildEmbossAssetTimeline(params: {
  hubEvents: Array<{
    id: string
    actionType: string
    createdAt: Date
    details: unknown
  }>
  maintenanceLogs: Array<{
    id: string
    actionType: string
    performedAt: Date
    performedBy: string
    notes: string | null
  }>
  usageLogs: Array<{
    id: string
    impressions: number
    usedOn: Date
    operatorName: string | null
    notes: string | null
    jobCardId: string | null
  }>
  jobNumberById: Map<string, number>
}): EmbossTimelineEntry[] {
  const hub: EmbossTimelineEntry[] = params.hubEvents.map((e) => {
    const d = (e.details || {}) as Record<string, unknown>
    const op =
      typeof d.operatorName === 'string'
        ? d.operatorName
        : typeof d.operator === 'string'
          ? d.operator
          : null
    return {
      id: `hub-${e.id}`,
      atIso: e.createdAt.toISOString(),
      actionLabel: hubEventToActionLabel(e.actionType),
      jobCardId: null,
      jobDisplay: null,
      impressionsDelta: null,
      impressionsCumulative: null,
      operatorName: op,
      source: 'hub',
    }
  })

  const maint: EmbossTimelineEntry[] = params.maintenanceLogs.map((m) => ({
    id: `maint-${m.id}`,
    atIso: m.performedAt.toISOString(),
    actionLabel: maintenanceToActionLabel(m.actionType),
    jobCardId: null,
    jobDisplay: null,
    impressionsDelta: null,
    impressionsCumulative: null,
    operatorName: m.performedBy?.trim() || null,
    source: 'maintenance',
  }))

  const usageChrono = [...params.usageLogs].sort(
    (a, b) => a.usedOn.getTime() - b.usedOn.getTime() || a.id.localeCompare(b.id),
  )
  let running = 0
  const usageWithCumulative = usageChrono.map((u) => {
    running += u.impressions
    const jcId = u.jobCardId
    const num = jcId ? params.jobNumberById.get(jcId) : undefined
    return {
      u,
      cumulative: running,
      jobDisplay: num != null ? `JC-${num}` : null,
    }
  })

  const usage: EmbossTimelineEntry[] = [...usageWithCumulative]
    .reverse()
    .map(({ u, cumulative, jobDisplay }) => ({
      id: `usage-${u.id}`,
      atIso: u.usedOn.toISOString(),
      actionLabel:
        u.notes?.includes('Auto: job close') || u.notes?.includes('job close')
          ? 'Production run'
          : 'Impressions logged',
      jobCardId: u.jobCardId,
      jobDisplay,
      impressionsDelta: u.impressions,
      impressionsCumulative: cumulative,
      operatorName: u.operatorName?.trim() || null,
      source: 'usage' as const,
    }))

  const merged = [...hub, ...maint, ...usage].sort(
    (a, b) => new Date(b.atIso).getTime() - new Date(a.atIso).getTime(),
  )
  return merged
}
