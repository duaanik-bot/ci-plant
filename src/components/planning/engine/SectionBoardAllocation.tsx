'use client'

import { useEffect, useRef, useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningMeta, mergePlanningMetaUps } from '@/lib/planning-decision-spec'
import { resolveUps } from '@/lib/production-os-resolvers'
import { resolveSheetSize as resolveSheetSizeFromLine } from '@/lib/planning-sheet-size'
import type { PlanningEngineBoardOption, PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  readinessLoading: boolean
  onPatch: SectionPatchFn
  /** Link the line to a board material (same path Smart Match uses). */
  onSelectBoard?: (materialId: string) => Promise<void>
}

const nf = new Intl.NumberFormat('en-IN')

function formatSheets(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${nf.format(Math.round(n))} sh`
}

function formatEta(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

function hasText(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/** Board type the engine wants to commit: the line's own value first, then the matched material / queue / carton. */
function resolveBoardType(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): string {
  return (
    (hasText(line.paperType) ? (line.paperType as string) : '') ||
    readiness?.boardType ||
    line.materialQueue?.boardType ||
    line.carton?.paperType ||
    ''
  ).trim()
}

function resolveGsm(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): number | null {
  const gsm = line.gsm ?? readiness?.gsm ?? line.carton?.gsm ?? null
  return gsm != null && Number.isFinite(gsm) ? gsm : null
}

/** Parent board sheet size — saved value (meta.parentSize) first, then readiness label, then queue dims. */
function resolveSheetSize(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): string {
  const m = readPlanningMeta(line.specOverrides ?? null)
  if (hasText(m.parentSize)) return (m.parentSize as string).trim().replace(/x/gi, '×')
  if (readiness?.size) return readiness.size
  const fromLine = resolveSheetSizeFromLine({
    specOverrides: line.specOverrides ?? null,
    carton: (line.carton ?? null) as Record<string, unknown> | null,
    materialQueue: (line.materialQueue ?? null) as Record<string, unknown> | null,
  })
  if (fromLine && fromLine !== '-') return fromLine.replace(/x/gi, '×')
  return ''
}

function metaParentSizeSet(spec: Record<string, unknown>, size: string | null): Record<string, unknown> {
  const meta = { ...readPlanningMeta(spec) }
  const v = (size ?? '').trim()
  if (v) meta.parentSize = v
  else delete meta.parentSize
  const next = { ...spec }
  if (Object.keys(meta).length === 0) delete next.meta
  else next.meta = meta
  return next
}

function EditableTile({
  label,
  value,
  onChange,
  onCommit,
  type = 'text',
  placeholder,
  ariaLabel,
  badge,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  type?: 'text' | 'number'
  placeholder?: string
  ariaLabel: string
  badge?: React.ReactNode
}) {
  return (
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
        {badge}
      </div>
      <input
        type={type}
        inputMode={type === 'number' ? 'numeric' : undefined}
        min={type === 'number' ? 1 : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        aria-label={ariaLabel}
        className="w-full bg-transparent text-base font-semibold text-ds-ink outline-none leading-tight tabular-nums placeholder:text-ds-ink-faint/60"
      />
    </div>
  )
}

function ReadOnlyTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-base font-semibold text-ds-ink leading-tight mt-1">{value}</div>
    </div>
  )
}

export function SectionBoardAllocation({ line, readiness, readinessLoading, onPatch, onSelectBoard }: Props) {
  const shortage = Math.max(0, Number(readiness?.shortageSheets ?? 0))
  const required = Number(readiness?.requiredSheets ?? line.planningLedger?.boardStockInsight?.requiredSheets ?? 0)
  const netStock = Number(
    readiness?.availableSheets ?? line.planningLedger?.boardStockInsight?.availableTotalSheets ?? 0,
  )
  const reserved = Number(
    readiness?.reservedSheets ?? line.planningLedger?.boardStockInsight?.reservedSheets ?? 0,
  )

  const bsi = line.planningLedger?.boardStockInsight
  const specIncomplete = bsi?.specComplete === false
  const procurementSuggestion = bsi?.procurementSuggestion ?? null

  const recommendedBoardParts = [
    bsi?.recommendedBoardGrade ?? null,
    bsi?.recommendedGsm != null ? `${bsi.recommendedGsm} gsm` : null,
    bsi?.recommendedPaperType ?? null,
  ].filter(Boolean)
  const recommendedBoardLabel = recommendedBoardParts.length > 0 ? recommendedBoardParts.join(' · ') : null

  const meta = readPlanningMeta(line.specOverrides ?? null)
  const upsManual = meta?.upsSource === 'manual'

  const resolvedBoardType = resolveBoardType(line, readiness)
  const resolvedGsm = resolveGsm(line, readiness)
  const resolvedSheetSize = resolveSheetSize(line, readiness)
  const resolvedUps = (resolveUps(line) ?? null) as number | null

  const [boardDraft, setBoardDraft] = useState(resolvedBoardType)
  const [gsmDraft, setGsmDraft] = useState(resolvedGsm != null ? String(resolvedGsm) : '')
  const [sizeDraft, setSizeDraft] = useState(resolvedSheetSize)
  const [upsDraft, setUpsDraft] = useState(resolvedUps != null ? String(resolvedUps) : '')

  useEffect(() => { setBoardDraft(resolvedBoardType) }, [resolvedBoardType])
  useEffect(() => { setGsmDraft(resolvedGsm != null ? String(resolvedGsm) : '') }, [resolvedGsm])
  useEffect(() => { setSizeDraft(resolvedSheetSize) }, [resolvedSheetSize])
  useEffect(() => { setUpsDraft(resolvedUps != null ? String(resolvedUps) : '') }, [resolvedUps])

  // Commit the auto-populated values onto the line once per line: fill-empty-only,
  // so a value derived from the matched material / carton becomes a saved fact and
  // survives reload. Never overwrites a value the planner already set.
  const backfilledRef = useRef<string | null>(null)
  useEffect(() => {
    if (readinessLoading) return
    if (!line.id || backfilledRef.current === line.id) return
    backfilledRef.current = line.id

    const patch: Parameters<SectionPatchFn>[0] = {}
    if (!hasText(line.paperType) && resolvedBoardType) patch.paperType = resolvedBoardType
    if (line.gsm == null && resolvedGsm != null) patch.gsm = resolvedGsm

    let spec = { ...((line.specOverrides ?? {}) as Record<string, unknown>) }
    let specChanged = false
    const m = readPlanningMeta(spec)
    if (!hasText(m.parentSize) && resolvedSheetSize) {
      spec = metaParentSizeSet(spec, resolvedSheetSize)
      specChanged = true
    }
    if (m.ups == null && resolvedUps != null) {
      spec = mergePlanningMetaUps(spec, resolvedUps)
      specChanged = true
    }
    if (specChanged) patch.specOverrides = spec

    if (Object.keys(patch).length > 0) void onPatch(patch)
  }, [
    line.id,
    line.paperType,
    line.gsm,
    line.specOverrides,
    readinessLoading,
    resolvedBoardType,
    resolvedGsm,
    resolvedSheetSize,
    resolvedUps,
    onPatch,
  ])

  const commitBoardType = () => {
    const v = boardDraft.trim()
    if (v === (line.paperType ?? '').trim()) return
    void onPatch({ paperType: v || null })
  }
  const commitGsm = () => {
    const v = gsmDraft.trim() === '' ? null : Math.max(1, Math.round(Number(gsmDraft) || 0))
    if (v === (line.gsm ?? null)) return
    void onPatch({ gsm: v })
  }
  const commitSize = () => {
    const v = sizeDraft.trim()
    const spec = (line.specOverrides ?? {}) as Record<string, unknown>
    const current = (readPlanningMeta(spec).parentSize as string | undefined)?.trim() ?? ''
    if (v === current) return
    void onPatch({ specOverrides: metaParentSizeSet({ ...spec }, v || null) })
  }
  const commitUps = () => {
    const next = upsDraft.trim() === '' ? null : Math.max(1, Math.floor(Number(upsDraft) || 0))
    if (next === resolvedUps) return
    void onPatch({ specOverrides: mergePlanningMetaUps((line.specOverrides ?? {}) as Record<string, unknown>, next) })
  }

  // Board master options the engine already ranked (strict first, then compatible).
  const boardOptions: PlanningEngineBoardOption[] =
    (readiness?.suggestedBoardOptions?.length ? readiness.suggestedBoardOptions : readiness?.closestAvailableOptions) ?? []
  const cartonBoardType = (line.carton?.paperType ?? '').trim()
  const cartonGsm = line.carton?.gsm ?? null
  const canLinkCarton = !!onPatch && (!!cartonBoardType || cartonGsm != null)
  const canLinkBoard = !!onSelectBoard && boardOptions.length > 0

  const [linkOpen, setLinkOpen] = useState<null | 'carton' | 'board'>(null)

  const linkFromCarton = () => {
    const patch: Parameters<SectionPatchFn>[0] = {}
    if (cartonBoardType) patch.paperType = cartonBoardType
    if (cartonGsm != null) patch.gsm = cartonGsm
    if (Object.keys(patch).length > 0) void onPatch(patch)
    setLinkOpen(null)
  }

  return (
    <CardSection title="BOARD ALLOCATION">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <EditableTile
          label="Board type"
          ariaLabel="Board type"
          value={boardDraft}
          placeholder="—"
          onChange={setBoardDraft}
          onCommit={commitBoardType}
        />
        <EditableTile
          label="GSM"
          ariaLabel="GSM"
          type="number"
          value={gsmDraft}
          placeholder="—"
          onChange={setGsmDraft}
          onCommit={commitGsm}
        />
        <EditableTile
          label="Sheet size"
          ariaLabel="Sheet size"
          value={sizeDraft}
          placeholder="—"
          onChange={setSizeDraft}
          onCommit={commitSize}
        />
        <EditableTile
          label="Units per sheet"
          ariaLabel="Units per sheet"
          type="number"
          value={upsDraft}
          placeholder="—"
          onChange={setUpsDraft}
          onCommit={commitUps}
          badge={!upsManual && upsDraft ? <Badge tone="success" className="text-[9px]">Auto</Badge> : undefined}
        />
        <ReadOnlyTile label="Required" value={formatSheets(required)} />
      </div>

      {canLinkCarton || canLinkBoard ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">Link to master</span>
          {canLinkCarton ? (
            <button
              type="button"
              onClick={linkFromCarton}
              className="rounded-full border border-ds-line/50 bg-ds-elevated px-2.5 py-1 text-xs font-medium text-ds-ink-muted hover:text-ds-ink"
            >
              Carton master
              {cartonBoardType || cartonGsm != null
                ? ` · ${[cartonBoardType || null, cartonGsm != null ? `${cartonGsm} gsm` : null].filter(Boolean).join(' / ')}`
                : ''}
            </button>
          ) : null}
          {canLinkBoard ? (
            <button
              type="button"
              onClick={() => setLinkOpen((p) => (p === 'board' ? null : 'board'))}
              aria-expanded={linkOpen === 'board'}
              className="rounded-full border border-ds-line/50 bg-ds-elevated px-2.5 py-1 text-xs font-medium text-ds-ink-muted hover:text-ds-ink"
            >
              Board master ▾
            </button>
          ) : null}
        </div>
      ) : null}

      {linkOpen === 'board' && canLinkBoard ? (
        <div className="mt-2 rounded-ds-md border border-ds-line/40 bg-ds-elevated p-2 space-y-1">
          {boardOptions.slice(0, 6).map((opt) => (
            <button
              key={opt.materialId || opt.materialCode}
              type="button"
              onClick={() => {
                void onSelectBoard?.(opt.materialId)
                setLinkOpen(null)
              }}
              className="flex w-full items-center justify-between gap-3 rounded-ds-sm px-2 py-1.5 text-left text-xs hover:bg-ds-line/10"
            >
              <span className="min-w-0 truncate text-ds-ink">
                {[opt.boardType, opt.gsm != null ? `${opt.gsm} gsm` : null, opt.size].filter(Boolean).join(' · ') ||
                  opt.materialCode}
              </span>
              <span className="shrink-0 tabular-nums text-ds-ink-faint">{nf.format(Math.round(opt.freeSheets))} free</span>
            </button>
          ))}
        </div>
      ) : null}

      {readinessLoading ? (
        <div className="mt-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated p-3 text-xs text-ds-ink-faint">
          Checking material…
        </div>
      ) : shortage > 0 ? (
        <div className="mt-3 rounded-ds-md border border-red-500/40 bg-red-500/10 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-red-300">
              Paper warehouse — shortage
            </div>
            <Badge tone="danger" className="text-[11px] uppercase">Shortfall</Badge>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-ds-ink-faint">Net stock</div>
              <div className="text-ds-ink font-semibold tabular-nums">{formatSheets(netStock)}</div>
            </div>
            <div>
              <div className="text-ds-ink-faint">Reserved</div>
              <div className="text-ds-ink font-semibold tabular-nums">{formatSheets(reserved)}</div>
            </div>
            <div>
              <div className="text-red-300">Shortfall</div>
              <div className="text-red-300 font-semibold tabular-nums">{formatSheets(shortage)}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-ds-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
          Paper warehouse — stock covers required sheets.
        </div>
      )}

      {readiness?.prId ? (
        <div className="mt-2 flex items-center justify-between rounded-ds-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-id-mono text-amber-200 truncate">{readiness.prId}</span>
            <span className="text-ds-line/60">·</span>
            <span className="text-amber-200/80">
              {readiness.grnEta ? `ETA ${formatEta(readiness.grnEta)}` : 'ETA pending'}
            </span>
          </div>
          <Badge tone="warning" className="text-[11px] uppercase">{readiness.prStatus || 'On order'}</Badge>
        </div>
      ) : null}

      {specIncomplete ? (
        <div className="mt-2 rounded-ds-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-300 mb-1">Spec check</div>
          <div className="text-ds-ink-faint">
            {bsi?.specIncompleteReason
              ? `Spec incomplete — cannot compute: ${bsi.specIncompleteReason}`
              : 'Spec incomplete — reason unavailable'}
          </div>
        </div>
      ) : null}

      {recommendedBoardLabel ? (
        <div className="mt-2 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-3 py-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">Recommended board</div>
          <div className="text-ds-ink font-semibold">{recommendedBoardLabel}</div>
        </div>
      ) : null}

      {procurementSuggestion ? (
        <div className="mt-2 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-3 py-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">Suggested procurement</div>
          <div className="text-ds-ink font-semibold tabular-nums">
            {(() => {
              const procParts = [
                procurementSuggestion.boardGrade,
                procurementSuggestion.gsm != null ? `${procurementSuggestion.gsm} gsm` : null,
              ].filter(Boolean)
              const procSuffix = procParts.length > 0 ? ` · ${procParts.join(' · ')}` : ''
              return `${procurementSuggestion.suggestedSheets.toLocaleString()} sheets${procSuffix}`
            })()}
          </div>
        </div>
      ) : null}
    </CardSection>
  )
}
