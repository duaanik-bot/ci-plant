const SIZE_REASON_LABELS: Record<string, string> = {
  alternate_machine: 'Resized for alternate machine assignment',
  edge_damage: 'Trimmed due to edge damage / wear',
  prepress_error: 'Pre-press layout error / Manual correction',
}

function str(v: unknown): string {
  if (v == null) return ''
  return String(v).trim()
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

/** Human-readable detail line for die / emboss hub events (modal + exports). */
export function humanizeToolingHubEventDetail(actionType: string, details: unknown): string {
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
    case 'SCRAP': {
      const reason = str(d.reason ?? d.scrapReason)
      return reason ? `Scrapped — ${reason}` : 'Scrapped'
    }
    case 'RETURN_TO_RACK':
    case 'SIZE_CHANGED_ON_RETURN': {
      const parts: string[] = []
      const prev = str(d.previousCartonSize ?? d.previousBlockSize ?? d.previousSize)
      const next = str(d.targetCartonSize ?? d.targetBlockSize ?? d.targetSize)
      if (prev && next) parts.push(`${prev} → ${next}`)
      const reasonCode = str(d.sizeModificationReason)
      const reasonLabel = SIZE_REASON_LABELS[reasonCode]
      if (reasonLabel) parts.push(reasonLabel)
      const remarks = str(d.sizeModificationRemarks)
      if (remarks) parts.push(remarks)
      return parts.join(' · ') || 'Return to live inventory'
    }
    default: {
      const ch = str(d.custodyStatus ?? d.nextStatus)
      const from = str(d.fromZone)
      const to = str(d.toZone)
      const bits = [from && to ? `${from} → ${to}` : '', ch ? `Status: ${ch}` : '']
        .filter(Boolean)
        .join(' · ')
      return bits || actionType.replace(/_/g, ' ')
    }
  }
}
