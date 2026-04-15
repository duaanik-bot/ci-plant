import { format } from 'date-fns'
import { HUB_PLATE_SIZE_OPTIONS, type HubPlateSize } from '@/lib/plate-size'

export type RawAuditRow = {
  id: bigint
  userId: string | null
  action: string
  tableName: string
  recordId: string | null
  oldValue: unknown
  newValue: unknown
  timestamp: Date
}

function nv(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  return obj as Record<string, unknown>
}

function mmForSize(v: unknown): string | null {
  if (v !== 'SIZE_560_670' && v !== 'SIZE_630_700') return null
  const row = HUB_PLATE_SIZE_OPTIONS.find((o) => o.value === (v as HubPlateSize))
  return row?.mm ?? null
}

/**
 * Turn one audit_log row into timeline copy for the Plate Hub modal.
 */
export function presentPlateHubAuditRow(row: RawAuditRow): {
  timeLabel: string
  action: string
  detail: string
} {
  const n = nv(row.newValue)
  const o = nv(row.oldValue)
  const table = row.tableName
  const action = row.action

  let title = `${table} · ${action}`
  let detail = ''

  if (table === 'plate_requirements') {
    if (n?.source === 'hub_triage_inline_size' && n.plateSize) {
      title = 'Plate size updated (triage)'
      const mm = mmForSize(n.plateSize)
      detail = mm ? `Size set to ${mm}` : String(n.plateSize)
    } else if (n?.triageChannel != null || n?.status != null) {
      title = 'Requirement updated'
      const parts: string[] = []
      if (typeof n.triageChannel === 'string') parts.push(`Channel: ${n.triageChannel.replace(/_/g, ' ')}`)
      if (typeof n.status === 'string') parts.push(`Status: ${n.status.replace(/_/g, ' ')}`)
      if (typeof n.plateFlowStatus === 'string') parts.push(`Flow: ${n.plateFlowStatus}`)
      detail = parts.join(' · ') || 'Hub routing / status change'
    } else if (n?.custodyReturnToRack) {
      title = 'Custody return to rack (requirement)'
      detail =
        typeof n.channelsToInventory === 'object' && Array.isArray(n.channelsToInventory)
          ? `Channels to inventory: ${(n.channelsToInventory as string[]).join(', ')}`
          : 'Channels moved to live inventory'
    } else {
      detail = summarizeJson(n, o)
    }
  } else if (table === 'plate_store') {
    const ev = n?.plateEvent
    if (ev === 'issued') {
      title = 'Plates issued'
      detail = Array.isArray(n?.coloursIssued) ? `Colours: ${(n.coloursIssued as string[]).join(', ')}` : 'Issue recorded'
    } else if (ev === 'returned') {
      title = 'Plates returned / stored'
      detail = summarizeJson(n, null)
    } else if (ev === 'colour_destroyed') {
      title = 'Colour destroyed'
      detail =
        typeof n.colourName === 'string'
          ? `${n.colourName}${typeof n.reason === 'string' ? ` — ${n.reason}` : ''}`
          : summarizeJson(n, null)
    } else if (n?.custodyRequirementReturn) {
      title = 'New plate set from custody requirement'
      const mm = mmForSize(n.targetPlateSize)
      detail = [
        typeof n.requirementCode === 'string' ? `From ${n.requirementCode}` : '',
        mm ? `Size ${mm}` : '',
        Array.isArray(n.returnedColourNames) ? `Colours: ${(n.returnedColourNames as string[]).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    } else if (action === 'INSERT') {
      title = 'Plate set created'
      detail = typeof n?.plateSetCode === 'string' ? `Code ${n.plateSetCode}` : summarizeJson(n, null)
    } else {
      title = 'Plate store updated'
      detail = summarizeJson(n, o)
    }
  } else if (table === 'plate_store_issue') {
    title = 'Issue event'
    detail =
      typeof n?.plateSetCode === 'string'
        ? `${n.plateSetCode} · ${Array.isArray(n.coloursIssued) ? (n.coloursIssued as string[]).join(', ') : ''}`
        : summarizeJson(n, null)
  } else {
    detail = summarizeJson(n, o)
  }

  const timeLabel = format(row.timestamp, 'MMM d, yyyy - hh:mm a')

  return { timeLabel, action: title, detail: detail || '—' }
}

function summarizeJson(n: Record<string, unknown> | null, o: Record<string, unknown> | null): string {
  if (!n && !o) return '—'
  const keys = n
    ? Object.keys(n).filter((k) => !['password', 'token'].includes(k.toLowerCase()))
    : []
  if (!keys.length && o) return `Previous values updated (${Object.keys(o).length} fields)`
  if (!keys.length) return '—'
  return keys.slice(0, 6).map((k) => `${k}: ${String(n![k]).slice(0, 80)}`).join(' · ')
}
