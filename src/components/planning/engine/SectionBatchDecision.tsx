'use client'

import { useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Button } from '@/components/design-system/Button'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningCore } from '@/lib/planning-decision-spec'
import type { PlanningEngineLine, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  onPatch: SectionPatchFn
  onLock: () => Promise<void>
}

const STATUSES = ['Ready', 'Draft', 'Hold', 'ApprovedAW', 'Released'] as const
type Status = (typeof STATUSES)[number]

const STATUS_LABEL: Record<Status, string> = {
  Ready: 'Ready',
  Draft: 'Draft',
  Hold: 'Hold',
  ApprovedAW: 'Approved AW',
  Released: 'Released',
}

function SegmentedPill<T extends string>({
  value,
  options,
  labels,
  onChange,
  ariaLabel,
}: {
  value: T
  options: readonly T[]
  labels?: Record<string, string>
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex flex-wrap items-center gap-1">
      {options.map((opt) => {
        const selected = value === opt
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt)}
            className={
              selected
                ? 'rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 px-3 py-1 text-xs font-semibold'
                : 'rounded-full border border-ds-line/40 bg-ds-elevated text-ds-ink-muted hover:text-ds-ink px-3 py-1 text-xs font-medium'
            }
          >
            {labels?.[opt] ?? opt}
          </button>
        )
      })}
    </div>
  )
}

export function SectionBatchDecision({ line, onPatch, onLock }: Props) {
  const bd = line.batchDecision
  const status = (bd?.status ?? 'Draft') as Status | 'Locked'
  // Layout defaults to Single; a line that belongs to a multi-line mix-set defaults to Gang.
  // An explicit saved layout (view-model or planningCore) always wins.
  const core = readPlanningCore(line.specOverrides ?? null)
  const isMultiLineSet = !!core.masterSetId && (core.mixSetMemberIds?.length ?? 0) > 1
  const savedLayout =
    bd?.layoutType ?? (core.layoutType === 'gang' ? 'Gang' : core.layoutType === 'single' ? 'Single' : null)
  const layoutType: 'Gang' | 'Single' = savedLayout ?? (isMultiLineSet ? 'Gang' : 'Single')
  const setNumber = bd?.setNumber ?? null
  const setAuto = !!bd?.setNumberAuto
  const designerOptions = bd?.designerOptions ?? []
  const designerId = bd?.designerId ?? null
  const press = bd?.pressAssignment ?? null
  const readinessFive = bd?.readinessFive
  const locked = status === 'Locked' || !!bd?.lockedAt

  const [locking, setLocking] = useState(false)
  const blockers = readinessFive?.blockers ?? []
  const canLock = readinessFive?.allReady === true && !locked

  const handleLock = async () => {
    if (!canLock || locking) return
    setLocking(true)
    try { await onLock() } finally { setLocking(false) }
  }

  const persistLayout = (next: 'Gang' | 'Single') => {
    if (locked || next === layoutType) return
    const spec = { ...((line.specOverrides ?? {}) as Record<string, unknown>) }
    const pc = {
      ...(typeof spec.planningCore === 'object' && spec.planningCore ? (spec.planningCore as Record<string, unknown>) : {}),
    }
    pc.layoutType = next === 'Gang' ? 'gang' : 'single'
    spec.planningCore = pc
    void onPatch({ specOverrides: spec })
  }

  return (
    <CardSection title="BATCH DECISION">
      <div className="space-y-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">Status</div>
          <SegmentedPill
            value={status === 'Locked' ? 'Released' : (status as Status)}
            options={STATUSES}
            labels={STATUS_LABEL}
            ariaLabel="Decision status"
            onChange={() => {/* Phase 2.3 */}}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">Layout type</div>
            <SegmentedPill
              value={layoutType}
              options={['Single', 'Gang'] as const}
              ariaLabel="Layout type"
              onChange={persistLayout}
            />
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">Set number</div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                defaultValue={setNumber ?? ''}
                aria-label="Set number"
                className="w-full bg-ds-elevated border border-ds-line/40 rounded-ds-md px-2 py-1 text-sm font-semibold text-ds-ink outline-none tabular-nums"
              />
              {setAuto ? <Badge tone="neutral" className="text-[9px]">auto</Badge> : null}
            </div>
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">Designer</div>
          <SegmentedPill
            value={designerId ?? ''}
            options={designerOptions.map((d) => d.id) as readonly string[]}
            labels={Object.fromEntries(designerOptions.map((d) => [d.id, d.name]))}
            ariaLabel="Designer"
            onChange={() => {/* Phase 2.3 */}}
          />
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">Press assignment</div>
          {press ? (
            <div className="rounded-ds-md border border-ds-line/40 bg-ds-elevated p-3">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-semibold text-ds-ink">{press.code}</div>
                {press.smartPicked ? (
                  <Badge tone="success" className="text-[9px]">Smart pick</Badge>
                ) : null}
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs text-ds-ink-faint tabular-nums">
                <div>
                  <div className="text-ds-ink-faint">{press.deckLabel}</div>
                  <div className="text-ds-ink">~{press.runHours.toFixed(1)}h run</div>
                </div>
                <div>
                  <div className="text-ds-ink-faint">Size</div>
                  <div className="text-ds-ink">{press.size}</div>
                </div>
                <div>
                  <div className="text-ds-ink-faint">Load</div>
                  <div className="text-ds-ink">{press.loadPct}%</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-ds-md border border-dashed border-ds-line/50 bg-ds-elevated/40 p-3 text-center text-xs text-ds-ink-faint">
              No press assigned yet.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-xs text-ds-ink-faint min-h-[16px]">
            {locked
              ? `Locked${bd?.lockedByName ? ` · ${bd.lockedByName}` : ''}${bd?.lockedAt ? ` · ${new Date(bd.lockedAt).toLocaleString('en-IN')}` : ''}`
              : blockers.length > 0
                ? `Blockers: ${blockers.join(', ')}`
                : canLock
                  ? 'All readiness checks green'
                  : 'Readiness check pending'}
          </div>
          <Button
            type="button"
            onClick={() => { void handleLock() }}
            disabled={!canLock || locking}
            aria-label="Save & lock"
          >
            {locking ? 'Locking…' : locked ? 'Locked' : 'Save & lock'}
          </Button>
        </div>
      </div>
    </CardSection>
  )
}
