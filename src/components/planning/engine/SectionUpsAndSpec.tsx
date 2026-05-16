'use client'

import { useEffect, useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningMeta, mergePlanningMetaUps } from '@/lib/planning-decision-spec'
import { resolveUps } from '@/lib/production-os-resolvers'
import type { PlanningEngineLine, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  onPatch: SectionPatchFn
}

const nf = new Intl.NumberFormat('en-IN')

function MetricTile({
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
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className={`text-base font-semibold leading-tight mt-1 ${emphasisClass ?? 'text-ds-ink'}`}>{value}</div>
      {hint ? <div className="text-[11px] text-ds-ink-faint mt-1 leading-snug">{hint}</div> : null}
    </div>
  )
}

function computeSheetYield(line: PlanningEngineLine, ups: number | null): number | null {
  const qty = Number(line.quantity ?? 0)
  const required = Number(line.planningLedger?.boardStockInsight?.requiredSheets ?? 0)
  if (!ups || !qty || !required) return null
  const yieldPct = (qty / (ups * required)) * 100
  if (!Number.isFinite(yieldPct)) return null
  return Math.max(0, Math.min(100, yieldPct))
}

export function SectionUpsAndSpec({ line, onPatch }: Props) {
  const meta = readPlanningMeta(line.specOverrides ?? null)
  const upsSourceManual = meta?.upsSource === 'manual'
  const initialUps = (line.upsAndSpec?.ups ?? resolveUps(line) ?? null) as number | null

  const [upsDraft, setUpsDraft] = useState<string>(initialUps != null ? String(initialUps) : '')

  useEffect(() => {
    setUpsDraft(initialUps != null ? String(initialUps) : '')
  }, [initialUps])

  const persistUps = async () => {
    const next = upsDraft.trim() === '' ? null : Math.max(1, Math.floor(Number(upsDraft) || 0))
    if (next === initialUps) return
    const nextSpec = mergePlanningMetaUps((line.specOverrides ?? {}) as Record<string, unknown>, next)
    await onPatch({ specOverrides: nextSpec })
  }

  const ups = initialUps
  const sheetYield = line.upsAndSpec?.sheetYieldPct ?? computeSheetYield(line, ups)
  const makeReady = line.upsAndSpec?.makeReady
  const bpi = line.upsAndSpec?.bpi

  return (
    <CardSection title="UPS & SHEET SPEC">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Units per sheet</div>
            {!upsSourceManual ? <Badge tone="success" className="text-[9px]">Auto</Badge> : null}
          </div>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={upsDraft}
            onChange={(e) => setUpsDraft(e.target.value)}
            onBlur={() => { void persistUps() }}
            aria-label="Units per sheet"
            className="w-full bg-transparent text-base font-semibold text-ds-ink outline-none tabular-nums"
          />
        </div>
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
                  makeReady.colours ? ` + ${makeReady.colours.count}×${makeReady.colours.perColour}c` : ''
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
      </div>
    </CardSection>
  )
}
