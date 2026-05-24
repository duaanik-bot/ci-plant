'use client'

import { memo, useMemo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { resolveUps } from '@/lib/production-os-resolvers'
import type { PlanningEngineLine, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  // onPatch kept in props for future BPI / make-ready overrides; unused here.
  onPatch: SectionPatchFn
}

const nf = new Intl.NumberFormat('en-IN')

const MetricTile = memo(function MetricTile({
  label,
  value,
  hint,
  emphasisClass,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  emphasisClass?: string
}) {
  return (
    <div className="bg-ds-elevated rounded-ds-md p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
        {label}
      </div>
      <div className={`text-base font-semibold leading-tight mt-1 ${emphasisClass ?? 'text-ds-ink'}`}>
        {value}
      </div>
      {hint ? <div className="text-xs text-ds-ink-faint mt-1 leading-snug">{hint}</div> : null}
    </div>
  )
})

export const SectionUpsAndSpec = memo(function SectionUpsAndSpec({ line }: Props) {
  const ups = useMemo(
    () => (line.upsAndSpec?.ups ?? resolveUps(line) ?? null) as number | null,
    [line],
  )

  // Sheet yield — use pre-computed view-model value; fall back to deriving it.
  const sheetYield = useMemo(() => {
    if (line.upsAndSpec?.sheetYieldPct != null) return line.upsAndSpec.sheetYieldPct
    const qty = Number(line.quantity ?? 0)
    const required = Number(line.planningLedger?.boardStockInsight?.requiredSheets ?? 0)
    if (!ups || !qty || !required) return null
    const pct = (qty / (ups * required)) * 100
    return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null
  }, [line, ups])

  const makeReady = line.upsAndSpec?.makeReady
  const bpi = line.upsAndSpec?.bpi
  const expectedYield = line.upsAndSpec?.expectedYieldUnits
  const balance = line.upsAndSpec?.balanceAfterAllocation

  return (
    <CardSection title="SHEET METRICS">
      <div className="grid grid-cols-2 gap-3">
        {/* UPS — read-only here; editable in Cut Plan & Layout above. */}
        <MetricTile
          label="Units per sheet"
          value={ups != null ? ups : '—'}
          hint="Edit in Cut Plan & Layout ↑"
        />
        <MetricTile
          label="Sheet yield"
          value={sheetYield != null ? `${sheetYield.toFixed(1)}%` : '—'}
        />
        <MetricTile
          label="Make-ready sheets"
          value={makeReady?.total != null ? `${nf.format(makeReady.total)} sh` : '—'}
          hint={
            makeReady
              ? `${makeReady.base} base${
                  makeReady.colours
                    ? ` + ${makeReady.colours.count}×${makeReady.colours.perColour}c`
                    : ''
                }${makeReady.uv ? ` + ${makeReady.uv} UV` : ''}`
              : undefined
          }
        />
        <MetricTile
          label="BPI"
          value={bpi?.status ?? '—'}
          hint={
            bpi
              ? `₹${nf.format(bpi.marginInr)} margin vs ₹${nf.format(bpi.setupInr)} setup`
              : undefined
          }
          emphasisClass={
            bpi?.status === 'Optimal'
              ? 'text-emerald-300'
              : bpi?.status === 'Suboptimal'
                ? 'text-amber-300'
                : 'text-ds-ink'
          }
        />
        <MetricTile
          label="Expected yield"
          value={expectedYield != null ? `${nf.format(expectedYield)} pcs` : '—'}
          hint="Allocated sheets × UPS"
        />
        <MetricTile
          label="Balance after alloc."
          value={balance != null ? `${nf.format(balance)} sh` : '—'}
          emphasisClass={balance != null && balance < 0 ? 'text-red-300' : 'text-ds-ink'}
        />
      </div>
    </CardSection>
  )
})
