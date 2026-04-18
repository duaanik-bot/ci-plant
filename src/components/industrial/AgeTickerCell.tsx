'use client'

export type IndustrialAgeMode = 'hub24h' | 'procurement48hNotOrdered' | 'productionIdle2h'

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / 3_600_000
}

export function AgeTickerCell({
  referenceIso,
  mode,
  notOrdered,
  idleHours,
}: {
  referenceIso?: string | null
  mode: IndustrialAgeMode
  /** Procurement: material line still pending vendor order */
  notOrdered?: boolean
  /** Production: hours machine / stage idle */
  idleHours?: number | null
}) {
  const h = hoursSince(referenceIso ?? null)
  let critical = false
  if (mode === 'hub24h' && h != null && h >= 24) critical = true
  if (mode === 'procurement48hNotOrdered' && notOrdered && h != null && h >= 48) critical = true
  if (mode === 'productionIdle2h') {
    const ih = idleHours ?? h
    if (ih != null && ih > 2) critical = true
  }

  const label =
    mode === 'productionIdle2h' && idleHours != null
      ? `${idleHours.toFixed(1)}h idle`
      : h != null
        ? `${Math.max(0, Math.floor(h))}h`
        : '—'

  return (
    <span
      className={`tabular-nums text-[11px] font-medium ${
        critical ? 'text-rose-400 animate-industrial-age-pulse' : 'text-slate-400'
      }`}
      title={critical ? 'Threshold exceeded — review' : undefined}
    >
      {label}
    </span>
  )
}
