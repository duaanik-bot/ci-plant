import { format } from 'date-fns'

function str(v: unknown): string {
  if (v == null) return ''
  return String(v).trim()
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

export type DieHubTimelineInput = {
  createdAt: Date
  actorName: string | null
  operatorName: string | null
  auditActionType: string | null
  actionType: string
  fromZone: string | null
  toZone: string | null
  details: unknown
  metadata: unknown
}

/** One-line transparency summary, e.g. "Apr 17, 14:30: Anik Dua issued DYE-137 to press" */
export function buildDieHubTimelineSummary(e: DieHubTimelineInput): string {
  const actor = str(e.actorName) || str(e.operatorName) || 'Operator'
  const t = Number.isNaN(e.createdAt.getTime()) ? '—' : format(e.createdAt, 'MMM d, HH:mm')
  const d = asRecord(e.details)
  const meta = asRecord(e.metadata)
  const code = str(d?.displayCode) || 'die'
  const fromZ = str(e.fromZone)
  const toZ = str(e.toZone)

  if (e.actionType === 'HUB_UNDO_LAST') {
    const cz = str(meta?.currentZoneLabel)
    const pz = str(meta?.previousZoneLabel)
    const line = str(meta?.remarks)
    if (line) return `${t}: ${line}`
    if (cz && pz) return `${t}: ${actor} reversed the last action. Tool moved from ${cz} back to ${pz}.`
    return `${t}: ${actor} reversed the last hub action.`
  }

  if (e.actionType === 'ISSUE_TO_MACHINE') {
    const mc = str(d?.machineCode)
    const mn = str(d?.machineName)
    const mach = mc && mn ? `${mc} (${mn})` : mc || mn || 'machine'
    return `${t}: ${actor} issued ${code} to ${mach}`
  }

  if (e.actionType === 'RETURN_TO_RACK' || e.actionType === 'SIZE_CHANGED_ON_RETURN') {
    const cond = str(meta?.condition) || str(d?.returnCondition) || '—'
    return `${t}: ${actor} returned ${code} to live inventory — condition ${cond}`
  }

  if (e.actionType === 'SCRAP') {
    const reason = str(d?.reason ?? d?.scrapReason)
    return `${t}: ${actor} scrapped ${code}${reason ? ` — ${reason}` : ''}`
  }

  if (e.actionType === 'MAINTENANCE_COMPLETE') {
    return `${t}: ${actor} cleared maintenance — condition reset to Good`
  }

  if (e.auditActionType === 'UNDO' || e.actionType === 'REVERSE_STAGING') {
    return `${t}: ${actor} reversed staging — ${fromZ || '—'} → ${toZ || '—'}`
  }

  if (fromZ && toZ) return `${t}: ${actor} moved ${code} — ${fromZ} → ${toZ}`
  return `${t}: ${actor} — ${e.actionType.replace(/_/g, ' ')}`
}
