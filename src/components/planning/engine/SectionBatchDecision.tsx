'use client'

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CardSection } from '@/components/design-system/CardSection'
import { Button } from '@/components/design-system/Button'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningCore, readPlanningMeta } from '@/lib/planning-decision-spec'
import { resolveUps } from '@/lib/production-os-resolvers'
import { validatePlanningLine } from '@/lib/planning-validation'
import type { PlanningEngineLine, SectionPatchFn } from './types'

/** First two positive numbers in a size string (tolerates unit suffixes). */
function parseSizePair(raw: unknown): { l: number; w: number } | null {
  if (typeof raw !== 'string') return null
  const nums = raw.match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 2) return null
  const l = Number(nums[0])
  const w = Number(nums[1])
  return l > 0 && w > 0 ? { l, w } : null
}

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
  disabled,
}: {
  value: T
  options: readonly T[]
  labels?: Record<string, string>
  onChange: (v: T) => void
  ariaLabel: string
  disabled?: boolean
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
              selected
                ? 'rounded-full bg-emerald-500/15 text-emerald-300 px-3 py-1 text-xs font-semibold disabled:opacity-60'
                : 'rounded-full bg-ds-elevated text-ds-ink-muted hover:text-ds-ink px-3 py-1 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed'
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

export const SectionBatchDecision = memo(function SectionBatchDecision({
  line,
  onPatch,
  onLock,
}: Props) {
  const bd = line.batchDecision
  const status = (bd?.status ?? 'Draft') as Status | 'Locked'
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

  // ── Client-side mandatory-field + release validation ──────────────────────
  const validation = useMemo(() => {
    const spec = (line.specOverrides ?? {}) as Record<string, unknown>
    const meta = readPlanningMeta(spec)
    const fromMeta = parseSizePair(meta.parentSize)
    const sheetLengthMm =
      Number(meta.sheetLengthMm) > 0 ? Number(meta.sheetLengthMm) : fromMeta?.l ?? null
    const sheetWidthMm =
      Number(meta.sheetWidthMm) > 0 ? Number(meta.sheetWidthMm) : fromMeta?.w ?? null
    return validatePlanningLine({
      boardType: line.paperType ?? null,
      gsm: line.gsm ?? null,
      ups: resolveUps(line) ?? null,
      sheetLengthMm,
      sheetWidthMm,
      shortageSheets: Number(
        (line.planningLedger?.boardStockInsight as { shortageSheets?: number } | undefined)
          ?.shortageSheets ?? 0,
      ),
      hasPurchaseRequest: !!(
        line.planningLedger?.boardStockInsight as { prId?: string | null } | undefined
      )?.prId,
      status: status === 'Locked' ? 'Released' : (status as string),
    })
  }, [line, status])

  const canLock = readinessFive?.allReady === true && validation.canLock && !locked

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
      if (next === 'Released' && validation.releaseBlocked) {
        toast.error(validation.releaseReason ?? 'Cannot release with an open shortage.')
        return
      }
      void onPatch(patchPlanningCore(line, 'status', next))
    },
    [locked, status, line, onPatch, validation.releaseBlocked, validation.releaseReason],
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
          />
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
                className="w-full bg-ds-elevated rounded-ds-md px-2 py-1 text-sm font-semibold text-ds-ink outline-none tabular-nums disabled:opacity-50"
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
            <div className="rounded-ds-md bg-ds-elevated p-3">
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

        {/* Mandatory-field validation hint */}
        {!locked && validation.missingMandatory.length > 0 ? (
          <div className="rounded-ds-md bg-amber-500/10 px-3 py-2 text-xs">
            <span className="font-semibold text-amber-300">Required to lock: </span>
            <span className="text-ds-ink-muted">{validation.missingMandatory.join(', ')}</span>
          </div>
        ) : null}

        {/* Lock row */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-xs text-ds-ink-faint min-h-[16px]">
            {locked
              ? `Locked${bd?.lockedByName ? ` · ${bd.lockedByName}` : ''}${bd?.lockedAt ? ` · ${new Date(bd.lockedAt).toLocaleString('en-IN')}` : ''}`
              : validation.missingMandatory.length > 0
                ? `Missing: ${validation.missingMandatory.join(', ')}`
                : blockers.length > 0
                  ? `Blockers: ${blockers.join(', ')}`
                  : canLock
                    ? 'All readiness checks green'
                    : 'Readiness check pending'}
          </div>
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
    </CardSection>
  )
})
