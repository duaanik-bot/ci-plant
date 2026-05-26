'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import {
  CUT_TYPES,
  parseSheetDims,
  rankParentSheetMatches,
  computeParentFromChild,
  type CutType,
  type LengthUnit,
  type ParentSheetCandidate,
  type ParentSheetMatch,
  type ParentSheetMatchLabel,
} from '@/lib/smart-match-parent-sheets'
import type {
  PlanningEngineBoardOption,
  PlanningEngineLine,
  PlanningEngineReadiness,
  SectionPatchFn,
} from './types'

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  onPatch: SectionPatchFn
  /** Link the line to a board material — flows board type/GSM/size up into Board allocation. */
  onSelectBoard?: (materialId: string) => Promise<void>
  /** Render compact for the engine's narrow right sidebar (single-column). */
  sidebar?: boolean
}

const nf = new Intl.NumberFormat('en-IN')

function labelClass(label: ParentSheetMatchLabel): { pill: string; ring: string } {
  switch (label) {
    case 'Best Parent Sheet':
      return {
        pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
        ring: 'border-emerald-500/30 bg-emerald-500/[0.04]',
      }
    case 'Lowest Waste':
      return {
        pill: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
        ring: 'border-ds-line/40 bg-ds-elevated/40',
      }
    case 'Most Available':
      return {
        pill: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
        ring: 'border-ds-line/40 bg-ds-elevated/40',
      }
    case 'Manual Review':
      return {
        pill: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
        ring: 'border-amber-500/40 bg-amber-500/[0.04]',
      }
    default:
      return {
        pill: 'bg-ds-line/30 text-ds-ink-muted border-ds-line/50',
        ring: 'border-ds-line/40 bg-ds-elevated/40',
      }
  }
}

const ControlNumber = memo(function ControlNumber({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  suffix?: string
}) {
  return (
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 px-2.5 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-0.5">
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="w-full bg-transparent text-sm font-semibold text-ds-ink outline-none tabular-nums placeholder:text-ds-ink-faint/60"
          placeholder="—"
        />
        {suffix ? <span className="text-[11px] text-ds-ink-faint shrink-0">{suffix}</span> : null}
      </div>
    </div>
  )
})

const MatchField = memo(function MatchField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-xs font-medium text-ds-ink tabular-nums mt-0.5">{value}</div>
    </div>
  )
})

const ParentMatchCard = memo(function ParentMatchCard({
  m,
  rank,
  selected,
  onSelect,
}: {
  m: ParentSheetMatch
  rank: number
  selected: boolean
  onSelect?: (materialId: string) => void
}) {
  const t = labelClass(m.label)
  const boardLabel =
    [m.boardType, m.gsm != null ? `${m.gsm} gsm` : null].filter(Boolean).join(' · ') || m.materialCode

  return (
    <div className={`rounded-ds-md border p-3.5 ${t.ring}${selected ? ' ring-2 ring-ds-brand/60' : ''}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ds-ink truncate">
            #{rank} · {m.parentSize}
          </div>
          <div className="text-xs text-ds-ink-faint truncate">
            {boardLabel} · {m.materialCode}
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${t.pill}`}
        >
          {m.label} · <span className="tabular-nums">{m.matchScore.toFixed(0)}</span>
        </span>
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-2 mb-2">
        <MatchField label="Cut type" value={`${m.cutType}-cut`} />
        <MatchField label="Child size" value={m.childSize} />
        <MatchField label="Pieces / sheet" value={nf.format(m.piecesPerSheet)} />
        <MatchField label="Utilization" value={`${m.utilizationPct}%`} />
        <MatchField label="Waste" value={`${m.wastePct}%`} />
        <MatchField label="Balance" value={m.balanceSize ?? 'None'} />
        <MatchField label="Parent sheets" value={`${nf.format(m.requiredParentSheets)} sh`} />
        <MatchField label="Free stock" value={`${nf.format(Math.max(0, Math.round(m.freeStock)))} sh`} />
        <MatchField
          label="Available"
          value={`${nf.format(Math.max(0, Math.round(m.availableStock)))} sh`}
        />
      </div>

      {m.shortageParentSheets > 0 ? (
        <div className="mb-2 text-[11px] font-medium text-amber-300">
          Short {nf.format(Math.round(m.shortageParentSheets))} sh — purchase required
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-ds-ink-faint leading-snug min-w-0 truncate">{m.reason}</div>
        {onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(m.materialId)}
            aria-label={`Select parent sheet ${m.parentSize} ${m.materialCode}`}
            className="shrink-0 rounded-full border border-ds-brand/40 bg-ds-brand/10 px-3 py-1 text-xs font-semibold text-ds-brand hover:bg-ds-brand/20 transition-colors"
          >
            {selected ? 'Selected' : 'Select'}
          </button>
        ) : null}
      </div>
    </div>
  )
})

type EmptyKind = 'spec-incomplete' | 'no-material' | 'no-candidates' | 'no-match'

function deriveBlockingEmptyState(
  line: PlanningEngineLine,
  readiness: PlanningEngineReadiness | null,
  candidateCount: number,
): { kind: EmptyKind; title: string; detail: string } | null {
  const bsi = line.planningLedger?.boardStockInsight
  if (bsi?.specComplete === false) {
    return {
      kind: 'spec-incomplete',
      title: 'Spec incomplete — matches blocked',
      detail:
        bsi.specIncompleteReason ||
        'Carton spec is missing required fields. Complete the spec pack to unlock board matches.',
    }
  }
  if (!readiness || (!readiness.materialId && !readiness.materialCode && candidateCount === 0)) {
    return {
      kind: 'no-material',
      title: 'No board linked',
      detail: 'Link a board material in Board allocation above to search warehouse parent sheets.',
    }
  }
  return null
}

const NoMatchEmptyState = memo(function NoMatchEmptyState() {
  const actions = [
    'View all warehouse stock',
    'Try a different cut type',
    'Try rotated orientation',
    'Raise Purchase Request',
    'Create manual planning option',
  ]
  return (
    <div className="rounded-ds-md border border-ds-line bg-ds-elevated/60 px-4 py-3.5">
      <div className="text-sm font-semibold text-ds-ink">No matching parent sheet available</div>
      <div className="mt-1 text-xs text-ds-ink-muted leading-relaxed">
        No parent sheet in warehouse can produce this child size and cut type. Adjust the inputs or
        choose an action below.
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <span
            key={a}
            className="rounded-full border border-ds-line/50 bg-ds-elevated px-2.5 py-1 text-[11px] font-medium text-ds-ink-muted"
          >
            {a}
          </span>
        ))}
      </div>
    </div>
  )
})

const BlockingEmptyState = memo(function BlockingEmptyState({
  title,
  detail,
  warn,
}: {
  title: string
  detail: string
  warn: boolean
}) {
  return (
    <div
      className={`rounded-ds-md border px-4 py-3.5 ${warn ? 'border-amber-500/40 bg-amber-500/[0.06]' : 'border-ds-line bg-ds-elevated/60'}`}
    >
      <div className={`text-sm font-semibold ${warn ? 'text-amber-300' : 'text-ds-ink'}`}>{title}</div>
      <div className="mt-1 text-xs text-ds-ink-muted leading-relaxed">{detail}</div>
    </div>
  )
})

function toCandidate(opt: PlanningEngineBoardOption): ParentSheetCandidate {
  return {
    materialId: opt.materialId,
    materialCode: opt.materialCode,
    boardType: opt.boardType,
    gsm: opt.gsm,
    size: opt.size,
    freeSheets: opt.freeSheets,
    availableSheets: opt.availableSheets,
    gsmDelta: opt.gsmDelta,
  }
}

function resolveChildAndCut(line: PlanningEngineLine): {
  l: string
  w: string
  unit: LengthUnit
  cut: CutType
} {
  const sizeStr = line.sheetSpec?.childSize ?? line.cartonSize ?? null
  const dims = parseSheetDims(sizeStr)
  const unit: LengthUnit =
    line.sheetSpec?.unit === 'mm' || (dims && Math.max(dims.length, dims.width) > 200) ? 'mm' : 'inch'
  const rawCut = line.sheetSpec?.cutType
  const cut = (rawCut && rawCut >= 1 && rawCut <= 6 ? Math.round(rawCut) : 1) as CutType
  if (!dims) return { l: '', w: '', unit, cut }
  return { l: String(dims.length), w: String(dims.width), unit, cut }
}

export const SectionSmartMatch = memo(function SectionSmartMatch({
  line,
  readiness,
  onPatch: _onPatch,
  onSelectBoard,
  sidebar = false,
}: Props) {
  const candidates = useMemo<ParentSheetCandidate[]>(() => {
    const strict = readiness?.suggestedBoardOptions ?? []
    const fallback = readiness?.closestAvailableOptions ?? []
    const merged = new Map<string, ParentSheetCandidate>()
    for (const o of [...strict, ...fallback]) {
      if (!merged.has(o.materialId)) merged.set(o.materialId, toCandidate(o))
    }
    return Array.from(merged.values())
  }, [readiness])

  const resolved = useMemo(() => resolveChildAndCut(line), [line])
  const childL = Number(resolved.l)
  const childW = Number(resolved.w)
  const childEntered = childL > 0 && childW > 0

  const [unit, setUnit] = useState<LengthUnit>(resolved.unit)
  const [cutType, setCutType] = useState<CutType>(resolved.cut)
  const defaultQty = String(Math.max(1, Math.round(readiness?.requiredSheets || line.quantity || 1)))
  const [requiredQty, setRequiredQty] = useState(defaultQty)

  const snapTargets = useMemo(() => readiness?.masterSheetSizes ?? [], [readiness])

  const computedParent = useMemo(
    () =>
      childEntered
        ? computeParentFromChild({ childLength: childL, childWidth: childW, cutType, unit, snapTargets })
        : null,
    [childEntered, childL, childW, cutType, unit, snapTargets],
  )

  // The editable Parent field seeds from the computed default and re-seeds
  // whenever the seed context (child size, unit, or cut type) changes — even
  // across line switches, since this component is memoised and may not remount.
  // Within a single context the planner's manual edits persist.
  // NOTE: the Parent value intentionally does NOT drive `matches` (the warehouse
  // list stays child-driven). It feeds the live utilization preview (added next).
  const seedSignature = `${resolved.l}|${resolved.w}|${unit}|${cutType}`
  const seededRef = useRef<string | null>(null)
  const [parentLength, setParentLength] = useState('')
  const [parentWidth, setParentWidth] = useState('')

  useEffect(() => {
    if (!computedParent || seededRef.current === seedSignature) return
    seededRef.current = seedSignature
    setParentLength(String(computedParent.length))
    setParentWidth(String(computedParent.width))
  }, [computedParent, seedSignature])

  const onParentLength = useCallback((v: string) => setParentLength(v), [])
  const onParentWidth = useCallback((v: string) => setParentWidth(v), [])

  const matches = useMemo<ParentSheetMatch[]>(() => {
    if (!childEntered) return []
    return rankParentSheetMatches({
      childLength: childL,
      childWidth: childW,
      cutType,
      requiredQty: Number(requiredQty) || 1,
      unit,
      boardType: readiness?.boardType ?? null,
      gsm: readiness?.gsm ?? null,
      candidates,
    })
  }, [childEntered, childL, childW, cutType, requiredQty, unit, readiness?.boardType, readiness?.gsm, candidates])

  const selectedMaterialId = readiness?.materialId ?? null

  const handleSelect = useCallback(
    (materialId: string) => {
      void onSelectBoard?.(materialId)
    },
    [onSelectBoard],
  )

  const blocking = deriveBlockingEmptyState(line, readiness, candidates.length)
  const matchBasis =
    [readiness?.boardType, readiness?.gsm ? `${readiness.gsm} gsm` : null].filter(Boolean).join(' · ') || '—'
  const childLabel = childEntered ? `Child ${resolved.l} × ${resolved.w} ${unit === 'mm' ? 'mm' : 'in'}` : null

  return (
    <CardSection title="SMART MATCH">
      <div className="flex items-center justify-between text-xs text-ds-ink-faint mb-2.5">
        <span>Warehouse parent sheets for this child size · {candidates.length} in pool</span>
        <span>{matchBasis}</span>
      </div>

      {/* Inputs that drive cut-type matching. Board & GSM come from the linked board. */}
      <div className={`grid gap-2 mb-3 ${sidebar ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6'}`}>
        <ControlNumber label="Parent L" value={parentLength} onChange={onParentLength} suffix={unit === 'mm' ? 'mm' : 'in'} />
        <ControlNumber label="Parent W" value={parentWidth} onChange={onParentWidth} suffix={unit === 'mm' ? 'mm' : 'in'} />
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 px-2.5 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-0.5">Unit</div>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as LengthUnit)}
            aria-label="Unit"
            className="w-full bg-transparent text-sm font-semibold text-ds-ink outline-none"
          >
            <option value="inch">inch</option>
            <option value="mm">mm</option>
          </select>
        </div>
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 px-2.5 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-0.5">Cut type</div>
          <select
            value={cutType}
            onChange={(e) => setCutType(Number(e.target.value) as CutType)}
            aria-label="Cut type"
            className="w-full bg-transparent text-sm font-semibold text-ds-ink outline-none tabular-nums"
          >
            {CUT_TYPES.map((c) => (
              <option key={c} value={c}>
                {c}-cut
              </option>
            ))}
          </select>
        </div>
        <ControlNumber label="Required qty" value={requiredQty} onChange={setRequiredQty} suffix="sh" />
      </div>
      {childLabel ? (
        <div className="-mt-1.5 mb-3 text-[11px] text-ds-ink-faint">
          {childLabel} · from Board Allocation{computedParent?.snappedTo === 'master' ? ' · parent snapped to a stock size' : ''}
        </div>
      ) : null}

      {blocking ? (
        <BlockingEmptyState title={blocking.title} detail={blocking.detail} warn={blocking.kind === 'spec-incomplete'} />
      ) : !childEntered ? (
        <BlockingEmptyState
          title="Set the carton size in Board Allocation"
          detail="Smart Match derives the child size and cut count from Board Allocation to compute the parent sheet. Set the carton size above to continue."
          warn={false}
        />
      ) : matches.length > 0 ? (
        <div className={`grid gap-3 ${sidebar ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'}`}>
          {matches.slice(0, 6).map((m, idx) => (
            <ParentMatchCard
              key={m.materialId}
              m={m}
              rank={idx + 1}
              selected={!!selectedMaterialId && m.materialId === selectedMaterialId}
              onSelect={onSelectBoard ? handleSelect : undefined}
            />
          ))}
        </div>
      ) : (
        <NoMatchEmptyState />
      )}
    </CardSection>
  )
})
