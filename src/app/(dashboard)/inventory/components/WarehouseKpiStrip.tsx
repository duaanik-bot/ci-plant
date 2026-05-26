'use client'

import { cn } from '@/lib/cn'
import type { ProcurementRag } from '@/lib/procurement-rag'

type KpiTileProps = {
  label: string
  value: string | number
  hint?: string
  colorClass: string
  onClick?: () => void
}

function KpiTile({ label, value, hint, colorClass, onClick }: KpiTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'min-h-20 rounded-ds-md bg-ds-elevated/45 px-4 py-3 text-left transition-colors',
        onClick && 'cursor-pointer hover:bg-ds-elevated transition-colors',
        !onClick && 'cursor-default',
      )}
    >
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</span>
      <span className={cn('mt-1 block text-xl font-bold tabular-nums leading-tight', colorClass)}>{value}</span>
      {hint ? <span className="mt-1 block truncate text-[11px] text-ds-ink-muted">{hint}</span> : null}
    </button>
  )
}

type Props = {
  ragCounts: Record<ProcurementRag, number>
  incomingKgThisWeek: number
  openPoValueInr: number
  reservedSheets: number
  freeSheets: number
  avgDaysOfCover?: number | null
  onFilterRed: () => void
  onFilterAmber: () => void
  onSwitchToOpenPos: () => void
  onSwitchToIncoming: () => void
}

const nf = new Intl.NumberFormat('en-IN')

export function WarehouseKpiStrip({
  ragCounts,
  incomingKgThisWeek,
  openPoValueInr,
  reservedSheets,
  freeSheets,
  onFilterRed,
  onFilterAmber,
  onSwitchToOpenPos,
  onSwitchToIncoming,
}: Props) {
  const freeColor = freeSheets < 0 ? 'text-ds-error' : freeSheets === 0 ? 'text-ds-warning' : 'text-ds-ink'

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiTile
        label="Critical shortages"
        value={ragCounts.red}
        hint="Needs procurement"
        colorClass="text-ds-error"
        onClick={onFilterRed}
      />
      <KpiTile
        label="Materials under watch"
        value={ragCounts.amber}
        hint="Near reorder"
        colorClass="text-ds-warning"
        onClick={onFilterAmber}
      />
      <KpiTile
        label="Incoming this week"
        value={`${nf.format(Math.round(incomingKgThisWeek))} kg`}
        hint="Expected receipts"
        colorClass="text-ds-ink"
        onClick={onSwitchToIncoming}
      />
      <KpiTile
        label="Open purchase orders"
        value={nf.format(Math.round(openPoValueInr))}
        hint="Vendor commitments"
        colorClass="text-ds-ink"
        onClick={onSwitchToOpenPos}
      />
      <KpiTile
        label="Reserved stock"
        value={nf.format(Math.round(reservedSheets))}
        hint="Committed to jobs"
        colorClass="text-ds-ink"
      />
      <KpiTile
        label="Free stock"
        value={nf.format(Math.round(freeSheets))}
        hint="Available to plan"
        colorClass={freeColor}
      />
    </div>
  )
}
