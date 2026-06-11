'use client'

import { memo } from 'react'
import type { PlanningEngineReadiness } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  readiness: PlanningEngineReadiness | null
  selected: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-IN')

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return nf.format(Math.round(n))
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Compact KPI strip shown between Board Allocation and Cut Plan & Layout
 * whenever a board material is linked. Gives the planner a clear "you are
 * cutting from this board" confirmation before configuring the cut plan.
 *
 * Returns null when no material is linked (readiness.materialId absent).
 */
export const SectionSelectedParentSheet = memo(function SectionSelectedParentSheet({
  readiness,
  selected,
}: Props) {
  if (!selected || !readiness?.materialId) {
    return (
      <div className="rounded-ds-card bg-[var(--bg-card)] p-4 shadow-ds-depth">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-ds-brand">
          Selected Parent Sheet
        </div>
        <div className="mt-3 rounded-ds-md border border-dashed border-ds-line/50 bg-ds-elevated/35 px-4 py-5 text-center text-sm text-ds-ink-faint">
          Select warehouse board stock to make it the active planning material.
        </div>
      </div>
    )
  }

  const sizeLabel = readiness.size ?? '—'
  const freeSheets = Number(readiness.freeSheets ?? 0)
  const reservedForSelected = readiness.materialId
    ? Number(readiness.reservedByMaterial?.[readiness.materialId] ?? readiness.reservedForLine ?? 0)
    : 0
  const reservedSheets = Math.max(0, reservedForSelected || Number(readiness.reservedSheets ?? 0))

  const tiles = [
    { label: 'Board Type', value: readiness.boardType ?? '—' },
    { label: 'GSM', value: readiness.gsm != null ? String(readiness.gsm) : '—' },
    { label: 'Parent Sheet Size', value: sizeLabel },
    { label: 'Available Stock', value: `${fmt(readiness.availableSheets)} sh` },
    { label: 'Reserved', value: `${fmt(reservedSheets)} sh` },
    { label: 'Free Stock', value: `${fmt(freeSheets)} sh` },
  ]

  return (
    <div className="rounded-ds-card bg-[var(--bg-card)] p-4 shadow-ds-depth">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-ds-brand">
          Selected Parent Sheet
        </span>
        {readiness.materialCode ? (
          <span className="text-[11px] font-mono text-ds-ink-faint tabular-nums">
            {readiness.materialCode}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-0 rounded-ds-md border border-ds-line/30 overflow-hidden">
        {tiles.map((tile, idx) => (
          <div
            key={tile.label}
            className={[
              'bg-ds-elevated/35 px-4 py-3 min-w-0',
              idx > 0 ? 'border-l border-ds-line/25' : '',
            ].join(' ')}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              {tile.label}
            </div>
            <div className="mt-1 text-sm font-semibold text-ds-ink tabular-nums truncate">
              {tile.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})
