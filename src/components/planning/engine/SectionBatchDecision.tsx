'use client'

import { memo, useCallback, useEffect, useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Button } from '@/components/design-system/Button'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningCore } from '@/lib/planning-decision-spec'
import type { PlanningEngineLine, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  onPatch: SectionPatchFn
  onLock: () => Promise<void>
  /**
   * Generate a Job Card from the locked decision. Button is shown only when
   * the line is locked AND this handler is provided. When undefined the button
   * is hidden.
   */
  onGenerateJobCard?: () => Promise<void>
  /** Compact desktop placement for the landscape planning console sidebar. */
  compact?: boolean
}

const STATUSES = ['Released', 'Hold'] as const
type Status = (typeof STATUSES)[number]

const STATUS_LABEL: Record<Status, string> = {
  Released: 'Release',
  Hold: 'Hold',
}

function statusPillClass(option: Status, selected: boolean) {
  const inactive =
    'rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50'
  if (option === 'Hold') {
    return selected
      ? 'rounded-full border border-rose-400 bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-950 disabled:opacity-60'
      : inactive
  }
  return selected
    ? 'rounded-full border border-emerald-500 bg-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-950 disabled:opacity-60'
    : inactive
}

function SegmentedPill<T extends string>({
  value,
  options,
  labels,
  onChange,
  ariaLabel,
  disabled,
  optionClassName,
}: {
  value: T
  options: readonly T[]
  labels?: Record<string, string>
  onChange: (v: T) => void
  ariaLabel: string
  disabled?: boolean
  optionClassName?: (option: T, selected: boolean) => string
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
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={
              optionClassName?.(opt, selected) ??
              (selected
                ? 'rounded-full border border-emerald-500 bg-emerald-100 text-emerald-900 px-3 py-1 text-xs font-semibold disabled:opacity-60'
                : 'rounded-full border border-ds-line/40 bg-ds-elevated text-ds-ink-muted hover:text-ds-ink px-3 py-1 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed')
            }
          >
            {labels?.[opt] ?? opt}
          </button>
        )
      })}
    </div>
  )
}

/** Persist a planningCore key into specOverrides. */
function patchPlanningCore(
  line: PlanningEngineLine,
  key: string,
  value: unknown,
): Parameters<SectionPatchFn>[0] {
  const spec = { ...((line.specOverrides ?? {}) as Record<string, unknown>) }
  const pc = {
    ...(typeof spec.planningCore === 'object' && spec.planningCore
      ? (spec.planningCore as Record<string, unknown>)
      : {}),
  }
  pc[key] = value
  spec.planningCore = pc
  return { specOverrides: spec }
}

function layoutPillClass(option: 'Single' | 'Gang', selected: boolean) {
  const inactive =
    'rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50'
  if (option === 'Gang') {
    return selected
      ? 'rounded-full border border-purple-500 bg-purple-200 px-3 py-1 text-xs font-semibold text-purple-950 disabled:opacity-60'
      : inactive
  }
  return selected
    ? 'rounded-full border border-emerald-500 bg-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-950 disabled:opacity-60'
    : inactive
}

export const SectionBatchDecision = memo(function SectionBatchDecision({
  line,
  onPatch,
  onLock,
  onGenerateJobCard,
  compact = false,
}: Props) {
  const bd = line.batchDecision
  const rawStatus = bd?.status ?? 'Draft'
  const status = (rawStatus === 'Hold' ? 'Hold' : rawStatus === 'Locked' ? 'Locked' : 'Released') as Status | 'Locked'
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
  const releaseGuard = bd?.releaseGuard
  const locked = status === 'Locked' || !!bd?.lockedAt

  const [locking, setLocking] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [releaseBlockedReason, setReleaseBlockedReason] = useState<string | null>(null)
  const blockers = readinessFive?.blockers ?? []
  const canLock = readinessFive?.allReady === true && !locked

  // ── Controlled Set Number ─────────────────────────────────────────────────
  const [setNumberDraft, setSetNumberDraft] = useState(setNumber ?? '')

  // Sync when the line reloads
  useEffect(() => {
    setSetNumberDraft(setNumber ?? '')
  }, [setNumber])

  const commitSetNumber = useCallback(() => {
    const v = setNumberDraft.trim() || null
    if (v === setNumber) return
    void onPatch(patchPlanningCore(line, 'setNumber', v))
  }, [setNumberDraft, setNumber, line, onPatch])

  // ── Status persist ────────────────────────────────────────────────────────
  const persistStatus = useCallback(
    (next: Status) => {
      if (locked || next === (status as Status)) return
      if (next === 'Released' && releaseGuard && !releaseGuard.canRelease) {
        setReleaseBlockedReason(releaseGuard.reason || 'Cannot release while a shortage is open without a PR.')
        return
      }
      setReleaseBlockedReason(null)
      void onPatch(patchPlanningCore(line, 'status', next))
    },
    [locked, status, line, onPatch, releaseGuard],
  )

  // ── Layout persist ────────────────────────────────────────────────────────
  const persistLayout = useCallback(
    (next: 'Gang' | 'Single') => {
      if (locked || next === layoutType) return
      void onPatch(patchPlanningCore(line, 'layoutType', next === 'Gang' ? 'gang' : 'single'))
    },
    [locked, layoutType, line, onPatch],
  )

  // ── Designer persist ──────────────────────────────────────────────────────
  const persistDesigner = useCallback(
    (next: string) => {
      if (locked || next === designerId) return
      void onPatch(patchPlanningCore(line, 'designerKey', next || null))
    },
    [locked, designerId, line, onPatch],
  )

  const handleLock = useCallback(async () => {
    if (!canLock || locking) return
    setLocking(true)
    try {
      await onLock()
    } finally {
      setLocking(false)
    }
  }, [canLock, locking, onLock])

  const handleGenerateJobCard = useCallback(async () => {
    if (!onGenerateJobCard || generating) return
    setGenerating(true)
    try {
      await onGenerateJobCard()
    } finally {
      setGenerating(false)
    }
  }, [onGenerateJobCard, generating])

  if (compact) {
    return (
      <CardSection title="BATCH DECISION" className="p-4 md:p-4">
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              Status
            </div>
            <SegmentedPill
              value={status === 'Locked' ? 'Released' : (status as Status)}
              options={STATUSES}
              labels={STATUS_LABEL}
              ariaLabel="Decision status"
              disabled={locked}
              onChange={persistStatus}
              optionClassName={statusPillClass}
            />
            {releaseBlockedReason ? (
              <div className="mt-1.5 rounded-ds-sm border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">{releaseBlockedReason}</div>
            ) : null}
          </div>

          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                Layout
              </div>
              <SegmentedPill
                value={layoutType}
                options={['Single', 'Gang'] as const}
                ariaLabel="Layout type"
                disabled={locked}
                onChange={persistLayout}
                optionClassName={layoutPillClass}
              />
            </div>

            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                Set No.
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={setNumberDraft}
                  aria-label="Set number"
                  disabled={locked}
                  onChange={(e) => setSetNumberDraft(e.target.value)}
                  onBlur={commitSetNumber}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  className="min-w-0 flex-1 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-2 py-1 text-xs font-semibold text-ds-ink outline-none tabular-nums disabled:opacity-50"
                />
                {setAuto ? (
                  <Badge tone="neutral" className="text-[9px]">
                    auto
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-ds-line/20 pt-3 text-xs">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                Designer
              </div>
              <div className="mt-1 truncate font-medium text-ds-ink-muted">
                {designerOptions.find((d) => d.id === designerId)?.name ?? 'Not assigned'}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                Press
              </div>
              <div className="mt-1 truncate font-medium text-ds-ink-muted">
                {press?.code ?? 'Not assigned'}
              </div>
            </div>
          </div>

          <div className="text-[11px] text-ds-ink-faint">
            {locked
              ? 'Locked'
              : blockers.length > 0
                ? `Blockers: ${blockers.join(', ')}`
                : canLock
                  ? 'Ready to lock from footer'
                  : 'Readiness check pending'}
          </div>
        </div>
      </CardSection>
    )
  }

  return (
    <CardSection title="BATCH DECISION">
      <div className="space-y-3">
        {/* Status */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">
            Status
          </div>
          <SegmentedPill
            value={status === 'Locked' ? 'Released' : (status as Status)}
            options={STATUSES}
            labels={STATUS_LABEL}
            ariaLabel="Decision status"
            disabled={locked}
            onChange={persistStatus}
            optionClassName={statusPillClass}
          />
          {releaseBlockedReason ? (
            <div className="mt-1.5 rounded-ds-sm border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">{releaseBlockedReason}</div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Layout type */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">
              Layout type
            </div>
            <SegmentedPill
              value={layoutType}
              options={['Single', 'Gang'] as const}
              ariaLabel="Layout type"
              disabled={locked}
              onChange={persistLayout}
              optionClassName={layoutPillClass}
            />
          </div>

          {/* Set number — controlled input, commits on blur / Enter */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">
              Set number
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={setNumberDraft}
                aria-label="Set number"
                disabled={locked}
                onChange={(e) => setSetNumberDraft(e.target.value)}
                onBlur={commitSetNumber}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="w-full bg-ds-elevated border border-ds-line/40 rounded-ds-md px-2 py-1 text-sm font-semibold text-ds-ink outline-none tabular-nums disabled:opacity-50"
              />
              {setAuto ? (
                <Badge tone="neutral" className="text-[9px]">
                  auto
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        {/* Designer */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">
            Designer
          </div>
          {designerOptions.length > 0 ? (
            <SegmentedPill
              value={designerId ?? ''}
              options={designerOptions.map((d) => d.id) as readonly string[]}
              labels={Object.fromEntries(designerOptions.map((d) => [d.id, d.name]))}
              ariaLabel="Designer"
              disabled={locked}
              onChange={persistDesigner}
            />
          ) : (
            <div className="text-xs text-ds-ink-faint italic">No designers configured</div>
          )}
        </div>

        {/* Press assignment */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1.5">
            Press assignment
          </div>
          {press ? (
            <div className="rounded-ds-md border border-ds-line/40 bg-ds-elevated p-3">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-semibold text-ds-ink">{press.code}</div>
                {press.smartPicked ? (
                  <Badge tone="success" className="text-[9px]">
                    Smart pick
                  </Badge>
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

        {/* Lock row */}
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
          <div className="flex items-center gap-2">
            {locked && onGenerateJobCard ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void handleGenerateJobCard()
                }}
                disabled={generating}
                aria-label="Generate job card"
              >
                {generating ? 'Generating…' : 'Generate job card'}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => {
                void handleLock()
              }}
              disabled={!canLock || locking}
              aria-label="Save & lock"
            >
              {locking ? 'Locking…' : locked ? 'Locked' : 'Save & lock'}
            </Button>
          </div>
        </div>
      </div>
    </CardSection>
  )
})
