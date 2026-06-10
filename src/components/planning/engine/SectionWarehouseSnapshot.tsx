'use client'

import { memo } from 'react'
import type { PlanningEngineReadiness } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = { readiness: PlanningEngineReadiness | null }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-IN')

function fmt(n: number): string {
  return nf.format(Math.round(n))
}

// ─── Component ────────────────────────────────────────────────────────────────

export const SectionWarehouseSnapshot = memo(function SectionWarehouseSnapshot({ readiness }: Props) {
  const total = Math.max(0, Number(readiness?.availableSheets ?? 0))
  const reserved = Math.max(0, Number(readiness?.reservedSheets ?? 0))
  const free = Math.max(0, Number(readiness?.freeSheets ?? Math.max(0, total - reserved)))
  const required = Math.max(0, Number(readiness?.requiredSheets ?? 0))
  const shortage = Math.max(0, Number(readiness?.shortageSheets ?? 0))
  const openPo = Math.max(0, Number(readiness?.openPoQty ?? 0))
  const incoming = Math.max(0, Number(readiness?.incomingQty ?? readiness?.incomingSheets ?? 0))
  const safetyStock = Math.max(0, Number(readiness?.safetyStock ?? 0))
  const netRequirement = Math.max(0, Number(readiness?.netRequirement ?? shortage))
  const procurementStatus = readiness?.procurementStatus ?? (readiness?.prStatus && readiness.prStatus !== 'not_created' ? 'PR Raised' : 'Not Raised')

  const fillPct = total > 0 ? Math.min(100, Math.round((free / total) * 100)) : 0
  const covered = shortage <= 0 && required > 0
  const stockTone = covered
    ? {
        fill: 'rgba(5,150,105,0.78)',
        text: 'text-emerald-800',
        panel: 'border-emerald-200 bg-emerald-50 text-emerald-950',
        muted: 'text-emerald-700',
      }
    : {
        fill: 'rgba(217,119,6,0.72)',
        text: 'text-amber-800',
        panel: 'border-amber-200 bg-amber-50 text-amber-950',
        muted: 'text-amber-700',
      }

  return (
    <div className="rounded-ds-card bg-[var(--bg-card)] p-4 shadow-ds-depth">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-semibold text-ds-brand">
          Warehouse Snapshot
        </div>
        <span className="text-[11px] font-semibold text-ds-brand">View warehouse</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Total Stock</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(total)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Reserved</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(reserved)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Free Stock</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(free)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Open PO</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(openPo)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Incoming</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(incoming)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Net Req.</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(netRequirement)} sh</div>
        </div>
      </div>

      <div className="mt-3">
        <div className="h-2 w-full overflow-hidden rounded-full bg-ds-elevated">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${total > 0 ? fillPct : 0}%`,
              background: stockTone.fill,
            }}
          />
        </div>
        <div className={['mt-2 text-[12px] font-semibold', stockTone.text].join(' ')}>
          {covered
            ? 'Covers required sheets.'
            : required > 0
              ? `Required: ${fmt(required)} sh${shortage > 0 ? ` · Shortage: ${fmt(shortage)} sh` : ''}`
              : 'No material selected.'}
        </div>
      </div>

      {/* Incoming / PR */}
      {readiness?.prId ? (
        <div className={['mt-3 rounded-ds-sm border px-2.5 py-2 text-[12px] font-semibold leading-relaxed', stockTone.panel].join(' ')}>
          <span>{procurementStatus}</span>
          <span className="ml-2 font-mono">{readiness.linkedPrNumber ?? readiness.prId}</span>
          {readiness.linkedPoNumber ? <span className="ml-2 font-mono">PO {readiness.linkedPoNumber}</span> : null}
          {readiness.expectedArrivalDate || readiness.grnEta ? (
            <span className={['ml-2', stockTone.muted].join(' ')}>
              ETA {new Date(readiness.expectedArrivalDate ?? readiness.grnEta!).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 rounded-ds-sm border border-ds-line/60 bg-ds-elevated/35 px-2.5 py-2 text-[12px] font-semibold leading-relaxed text-ds-ink-muted">
          {procurementStatus} · Safety {fmt(safetyStock)} sh
        </div>
      )}
    </div>
  )
})
