import { plateScrapReasonLabel } from '@/lib/plate-scrap-reasons'
import { PLATE_HUB_ACTION } from '@/lib/plate-hub-events'

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function str(v: unknown): string {
  if (v == null) return ''
  return String(v).trim()
}

/** Human-readable line for modal / exports from stored JSON details. */
export function humanizePlateHubEventDetail(actionType: string, details: unknown): string {
  const d = asRecord(details)
  if (!d) {
    if (details == null) return '—'
    try {
      return JSON.stringify(details)
    } catch {
      return '—'
    }
  }

  switch (actionType) {
    case PLATE_HUB_ACTION.SCRAPPED: {
      const names = Array.isArray(d.scrappedColourNames)
        ? (d.scrappedColourNames as unknown[]).map((x) => str(x)).filter(Boolean)
        : Array.isArray(d.colourNames)
          ? (d.colourNames as unknown[]).map((x) => str(x)).filter(Boolean)
          : []
      const reason =
        str(d.reasonLabel) ||
        (str(d.reasonCode) ? plateScrapReasonLabel(str(d.reasonCode)) : '')
      const head = names.length ? `Scrapped ${names.join(', ')}` : 'Scrapped channels'
      return reason ? `${head} — ${reason}` : head
    }
    case PLATE_HUB_ACTION.RESIZED: {
      const oldS = str(d.oldSize ?? d.oldPlateSize)
      const newS = str(d.newSize ?? d.newPlateSize ?? d.plateSize)
      const reason = str(d.reason ?? d.sizeModificationReason)
      const core =
        oldS && newS ? `${oldS} → ${newS}` : newS ? `Size: ${newS}` : 'Plate size updated'
      return reason ? `${core} — ${reason}` : core
    }
    case PLATE_HUB_ACTION.DISPATCHED: {
      const ch = str(d.channel ?? d.triageChannel)
      const slot = str(d.rackSlot ?? d.reservedRackSlot)
      const parts = [ch ? `Channel: ${ch}` : '', slot ? `Slot: ${slot}` : ''].filter(Boolean)
      return parts.join(' · ') || 'Dispatched from triage'
    }
    case PLATE_HUB_ACTION.RETURNED: {
      const ch = Array.isArray(d.returnedColourNames)
        ? (d.returnedColourNames as unknown[]).map((x) => str(x)).filter(Boolean)
        : []
      const omitted = Array.isArray(d.omittedToScrap)
        ? (d.omittedToScrap as unknown[]).map((x) => str(x)).filter(Boolean)
        : []
      const lines: string[] = []
      if (ch.length) lines.push(`Returned: ${ch.join(', ')}`)
      if (omitted.length) lines.push(`Scrapped (not returned): ${omitted.join(', ')}`)
      if (d.plateSizeChanged === true) {
        lines.push(
          `Resized ${str(d.previousPlateSize)} → ${str(d.targetPlateSize)}${str(d.sizeModificationReason) ? ` (${str(d.sizeModificationReason)})` : ''}`,
        )
      }
      return lines.join(' · ') || 'Return to rack'
    }
    case PLATE_HUB_ACTION.MATERIALIZED_TO_INVENTORY: {
      const code = str(d.plateSetCode ?? d.newPlateSetCode)
      const ch = Array.isArray(d.channels)
        ? (d.channels as unknown[]).map((x) => str(x)).filter(Boolean)
        : []
      return [
        code ? `New set ${code}` : 'Materialized plate set',
        ch.length ? `Channels: ${ch.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case PLATE_HUB_ACTION.TAKE_FROM_STOCK: {
      const src = str(d.sourcePlateStoreId)
      const ch = Array.isArray(d.colourNames)
        ? (d.colourNames as unknown[]).map((x) => str(x)).filter(Boolean)
        : []
      const custody = str(d.custodyPlateId)
      return [
        ch.length ? `Pulled ${ch.join(', ')}` : 'Pulled from stock',
        src ? `from ${src}` : '',
        custody ? `→ custody ${custody}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    }
    case PLATE_HUB_ACTION.MARKED_READY: {
      const kind = str(d.kind)
      return kind ? `Mark ready (${kind})` : 'Marked ready for custody floor'
    }
    case PLATE_HUB_ACTION.REVERSED_READY: {
      const kind = str(d.kind)
      return kind ? `Reversed mark ready (${kind})` : 'Reversed mark ready'
    }
    case PLATE_HUB_ACTION.EMERGENCY_ISSUE: {
      return [str(d.machineCode), str(d.operatorName)].filter(Boolean).join(' · ') || 'Emergency issue'
    }
    case PLATE_HUB_ACTION.REISSUE_REQUEST: {
      const note = str(d.note)
      return note ? `Re-issue signal — ${note}` : 'High-priority re-issue request logged'
    }
    case PLATE_HUB_ACTION.PARTIAL_REMAKE_CREATED: {
      const lane = str(d.lane)
      const missing = Array.isArray(d.missingColourNames)
        ? (d.missingColourNames as unknown[]).map((x) => str(x)).filter(Boolean)
        : []
      return [lane ? `Lane: ${lane}` : '', missing.length ? `Missing: ${missing.join(', ')}` : '']
        .filter(Boolean)
        .join(' · ')
    }
    default: {
      const skipKeys = new Set(['userId'])
      const parts = Object.entries(d)
        .filter(([k, v]) => !skipKeys.has(k) && v != null && v !== '')
        .slice(0, 6)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      return parts.length ? parts.join(' · ') : '—'
    }
  }
}
