'use client'

import { cn } from '@/lib/cn'
import type { ProcurementRag } from '@/lib/procurement-rag'

type KpiTileProps = {
  label: string
  value: string | number
  colorClass: string
  onClick?: () => void
}

function KpiTile({ label, value, colorClass, onClick }: KpiTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex flex-col gap-0.5 rounded-ds-md border border-ds-line/30 bg-ds-elevated/60 px-4 py-3 text-left',
        onClick && 'cursor-pointer hover:bg-ds-elevated transition-colors',
        !onClick && 'cursor-default',
      )}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</span>
      <span className={cn('text-xl font-bold tabular-nums leading-tight', colorClass)}>{value}</span>
    </button>
  )
}

type Props = {
  ragCounts: Record<ProcurementRag, number>
  incomingKgThisWeek: number
  openPoValueInr: number
  avgDaysOfCover: number | null
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
  avgDaysOfCover,
  onFilterRed,
  onFilterAmber,
  onSwitchToOpenPos,
  onSwitchToIncoming,
}: Props) {
  const docColor =
    avgDaysOfCover == null
      ? 'text-ds-ink-muted'
      : avgDaysOfCover > 30
        ? 'text-ds-success'
        : avgDaysOfCover >= 10
          ? 'text-ds-warning'
          : 'text-ds-error'

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <KpiTile
        label="In shortage"
        value={ragCounts.red}
        colorClass="text-ds-error"
        onClick={onFilterRed}
      />
      <KpiTile
        label="Being handled"
        value={ragCounts.amber}
        colorClass="text-ds-warning"
        onClick={onFilterAmber}
      />
      <KpiTile
        label="Incoming this week"
        value={`${nf.format(Math.round(incomingKgThisWeek))} kg`}
        colorClass="text-ds-ink"
        onClick={onSwitchToIncoming}
      />
      <KpiTile
        label="Open PO value"
        value={`₹${nf.format(Math.round(openPoValueInr / 1000))}k`}
        colorClass="text-ds-ink"
        onClick={onSwitchToOpenPos}
      />
      <KpiTile
        label="Avg days of cover"
        value={avgDaysOfCover != null ? `${Math.round(avgDaysOfCover)}d` : '—'}
        colorClass={docColor}
      />
    </div>
  )
}
