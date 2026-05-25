'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningMeta, mergePlanningMetaUps } from '@/lib/planning-decision-spec'
import { resolveUps } from '@/lib/production-os-resolvers'
import { resolveSheetSize as resolveSheetSizeFromLine } from '@/lib/planning-sheet-size'
import type { PlanningEngineBoardOption, PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

export type StockSearchResult = {
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  size: string | null
  freeSheets: number
  reservedSheets: number
  storageLocation: string | null
  supplierName: string | null
  lot: string | null
}

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  readinessLoading: boolean
  onPatch: SectionPatchFn
  /** Link the line to a board material (same path Smart Match uses). */
  onSelectBoard?: (materialId: string) => Promise<void>
  /** Called when planner clicks Reserve — parent wires to POST reserve-material. */
  onReserve?: () => Promise<void>
  /** Called when planner clicks Raise PR — parent wires to PR creation. */
  onRaisePR?: () => Promise<void>
  /** Release reserved stock for this line. qty omitted = full release. */
  onRelease?: (qty?: number) => Promise<void>
  /** Server-side search across all warehouse stock. */
  onStockSearch?: (q: string) => Promise<StockSearchResult[]>
}

// ─── Formatters ───────────────────────────────────────────────────────────────
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

// ─── Pure resolvers ────────────────────────────────────────────────────────────
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

// ─── Sub-components ───────────────────────────────────────────────────────────
const EditableTile = memo(function EditableTile({
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
        min={type === 'number' ? 0 : undefined}
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
})

const ReadOnlyTile = memo(function ReadOnlyTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-base font-semibold text-ds-ink leading-tight mt-1">{value}</div>
    </div>
  )
})

/** Warehouse stock bar — visualises free / reserved / incoming vs required. */
const WarehouseStrip = memo(function WarehouseStrip({
  free,
  reserved,
  incoming,
  required,
}: {
  free: number
  reserved: number
  incoming: number
  required: number
}) {
  const total = Math.max(1, free + reserved + incoming)
  const freePct = Math.min(100, Math.round((free / total) * 100))
  const resPct = Math.min(100, Math.round((reserved / total) * 100))
  const incPct = Math.min(100, Math.round((incoming / total) * 100))
  const needPct = Math.min(100, Math.round((required / total) * 100))

  return (
    <div className="mt-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated/60 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-2">
        Warehouse snapshot
      </div>
      {/* Stacked stock bar */}
      <div className="relative h-3 rounded-full bg-ds-main/60 overflow-hidden mb-2.5">
        <div className="absolute left-0 top-0 h-full bg-emerald-500/60 rounded-full" style={{ width: `${freePct}%` }} />
        <div
          className="absolute top-0 h-full bg-amber-500/60"
          style={{ left: `${freePct}%`, width: `${resPct}%` }}
        />
        {incoming > 0 ? (
          <div
            className="absolute top-0 h-full bg-blue-500/40"
            style={{ left: `${freePct + resPct}%`, width: `${incPct}%` }}
          />
        ) : null}
        {/* Required marker */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white/60"
          style={{ left: `${needPct}%` }}
          title={`Required: ${nf.format(Math.round(required))} sh`}
        />
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500/70" />
          <span className="text-ds-ink-faint">Free</span>
          <span className="font-semibold text-emerald-300">{formatSheets(free)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500/70" />
          <span className="text-ds-ink-faint">Reserved</span>
          <span className="font-semibold text-ds-ink">{formatSheets(reserved)}</span>
        </span>
        {incoming > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-blue-500/50" />
            <span className="text-ds-ink-faint">Incoming</span>
            <span className="font-semibold text-blue-300">{formatSheets(incoming)}</span>
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="inline-block h-2 w-0.5 bg-white/50" />
          <span className="text-ds-ink-faint">Required</span>
          <span className="font-semibold text-ds-ink">{formatSheets(required)}</span>
        </span>
      </div>
    </div>
  )
})

// ─── Main component ───────────────────────────────────────────────────────────
const WASTAGE_DEFAULT = 150

export const SectionBoardAllocation = memo(function SectionBoardAllocation({
  line,
  readiness,
  readinessLoading,
  onPatch,
  onSelectBoard,
  onReserve,
  onRaisePR,
  onRelease,
  onStockSearch,
}: Props) {
  const shortage = Math.max(0, Number(readiness?.shortageSheets ?? 0))
  const required = Number(
    readiness?.requiredSheets ?? line.planningLedger?.boardStockInsight?.requiredSheets ?? 0,
  )
  const netStock = Number(
    readiness?.availableSheets ?? line.planningLedger?.boardStockInsight?.availableTotalSheets ?? 0,
  )
  const reserved = Number(
    readiness?.reservedSheets ?? line.planningLedger?.boardStockInsight?.reservedSheets ?? 0,
  )
  const incoming = Number(readiness?.incomingSheets ?? 0)

  const bsi = line.planningLedger?.boardStockInsight
  const specIncomplete = bsi?.specComplete === false
  const procurementSuggestion = bsi?.procurementSuggestion ?? null

  const recommendedBoardParts = [
    bsi?.recommendedBoardGrade ?? null,
    bsi?.recommendedGsm != null ? `${bsi.recommendedGsm} gsm` : null,
    bsi?.recommendedPaperType ?? null,
  ].filter(Boolean)
  const recommendedBoardLabel = recommendedBoardParts.length > 0 ? recommendedBoardParts.join(' · ') : null

  // ── Memoised spec & resolved values ─────────────────────────────────────────
  const spec = useMemo(
    () => (line.specOverrides ?? {}) as Record<string, unknown>,
    [line.specOverrides],
  )
  const meta = useMemo(() => readPlanningMeta(spec), [spec])
  const upsManual = meta?.upsSource === 'manual'

  const resolvedBoardType = useMemo(() => resolveBoardType(line, readiness), [line, readiness])
  const resolvedGsm = useMemo(() => resolveGsm(line, readiness), [line, readiness])
  const resolvedSheetSize = useMemo(() => resolveSheetSize(line, readiness), [line, readiness])
  const resolvedUps = useMemo(() => (resolveUps(line) ?? null) as number | null, [line])

  const wastageFromSpec = useMemo(
    () => (spec.wastageSheets != null ? Number(spec.wastageSheets) : WASTAGE_DEFAULT),
    [spec],
  )

  // Base sheets — computed client-side for the display tile
  const qty = Number(line.quantity ?? 0)
  const baseSheets = useMemo(
    () => (resolvedUps && qty ? Math.max(1, Math.ceil(qty / resolvedUps)) : null),
    [resolvedUps, qty],
  )
  const totalRequired = required || (baseSheets != null ? baseSheets + wastageFromSpec : null)

  // ── SINGLE combined state — one setState = one re-render ──────────────────
  const [drafts, setDrafts] = useState({
    board: resolvedBoardType,
    gsm: resolvedGsm != null ? String(resolvedGsm) : '',
    size: resolvedSheetSize,
    ups: resolvedUps != null ? String(resolvedUps) : '',
    wastage: String(wastageFromSpec),
  })

  // ONE effect replaces the previous four — fires when any resolved value changes
  useEffect(() => {
    setDrafts({
      board: resolvedBoardType,
      gsm: resolvedGsm != null ? String(resolvedGsm) : '',
      size: resolvedSheetSize,
      ups: resolvedUps != null ? String(resolvedUps) : '',
      wastage: String(wastageFromSpec),
    })
  }, [resolvedBoardType, resolvedGsm, resolvedSheetSize, resolvedUps, wastageFromSpec])

  // Backfill — commit auto-populated values onto the line once per line-id.
  // Fill-empty-only: never overwrites a value the planner already set.
  const backfilledRef = useRef<string | null>(null)
  useEffect(() => {
    if (readinessLoading) return
    if (!line.id || backfilledRef.current === line.id) return
    backfilledRef.current = line.id

    const patch: Parameters<SectionPatchFn>[0] = {}
    if (!hasText(line.paperType) && resolvedBoardType) patch.paperType = resolvedBoardType
    if (line.gsm == null && resolvedGsm != null) patch.gsm = resolvedGsm

    let s = { ...spec }
    let specChanged = false
    const m = readPlanningMeta(s)
    if (!hasText(m.parentSize) && resolvedSheetSize) {
      s = metaParentSizeSet(s, resolvedSheetSize)
      specChanged = true
    }
    if (m.ups == null && resolvedUps != null) {
      s = mergePlanningMetaUps(s, resolvedUps)
      specChanged = true
    }
    if (specChanged) patch.specOverrides = s
    if (Object.keys(patch).length > 0) void onPatch(patch)
  }, [
    line.id,
    line.paperType,
    line.gsm,
    readinessLoading,
    resolvedBoardType,
    resolvedGsm,
    resolvedSheetSize,
    resolvedUps,
    onPatch,
    spec,
  ])

  // ── Commit handlers ───────────────────────────────────────────────────────
  const commitBoardType = useCallback(() => {
    const v = drafts.board.trim()
    if (v === (line.paperType ?? '').trim()) return
    void onPatch({ paperType: v || null })
  }, [drafts.board, line.paperType, onPatch])

  const commitGsm = useCallback(() => {
    const v = drafts.gsm.trim() === '' ? null : Math.max(1, Math.round(Number(drafts.gsm) || 0))
    if (v === (line.gsm ?? null)) return
    void onPatch({ gsm: v })
  }, [drafts.gsm, line.gsm, onPatch])

  const commitSize = useCallback(() => {
    const v = drafts.size.trim()
    const current = (readPlanningMeta(spec).parentSize as string | undefined)?.trim() ?? ''
    if (v === current) return
    void onPatch({ specOverrides: metaParentSizeSet({ ...spec }, v || null) })
  }, [drafts.size, spec, onPatch])

  const commitUps = useCallback(() => {
    const next = drafts.ups.trim() === '' ? null : Math.max(1, Math.floor(Number(drafts.ups) || 0))
    if (next === resolvedUps) return
    void onPatch({ specOverrides: mergePlanningMetaUps(spec, next) })
  }, [drafts.ups, resolvedUps, spec, onPatch])

  const commitWastage = useCallback(() => {
    const next =
      drafts.wastage.trim() === ''
        ? WASTAGE_DEFAULT
        : Math.max(0, Math.round(Number(drafts.wastage) || 0))
    if (next === wastageFromSpec) return
    void onPatch({ specOverrides: { ...spec, wastageSheets: next } })
  }, [drafts.wastage, wastageFromSpec, spec, onPatch])

  // ── Board master options ──────────────────────────────────────────────────
  const boardOptions: PlanningEngineBoardOption[] = useMemo(
    () =>
      (readiness?.suggestedBoardOptions?.length
        ? readiness.suggestedBoardOptions
        : readiness?.closestAvailableOptions) ?? [],
    [readiness],
  )

  const cartonBoardType = (line.carton?.paperType ?? '').trim()
  const cartonGsm = line.carton?.gsm ?? null
  const canLinkCarton = !!onPatch && (!!cartonBoardType || cartonGsm != null)
  const canLinkBoard = !!onSelectBoard && boardOptions.length > 0
  const [linkOpen, setLinkOpen] = useState<null | 'carton' | 'board'>(null)

  const linkFromCarton = useCallback(() => {
    const patch: Parameters<SectionPatchFn>[0] = {}
    if (cartonBoardType) patch.paperType = cartonBoardType
    if (cartonGsm != null) patch.gsm = cartonGsm
    if (Object.keys(patch).length > 0) void onPatch(patch)
    setLinkOpen(null)
  }, [cartonBoardType, cartonGsm, onPatch])

  // ── Reserve & Raise PR ────────────────────────────────────────────────────
  const [reserving, setReserving] = useState(false)
  const [raisingPR, setRaisingPR] = useState(false)

  const handleReserve = useCallback(async () => {
    if (!onReserve || reserving) return
    setReserving(true)
    try {
      await onReserve()
    } finally {
      setReserving(false)
    }
  }, [onReserve, reserving])

  const handleRaisePR = useCallback(async () => {
    if (!onRaisePR || raisingPR) return
    setRaisingPR(true)
    try {
      await onRaisePR()
    } finally {
      setRaisingPR(false)
    }
  }, [onRaisePR, raisingPR])

  const reservedForLine = Number(readiness?.reservedForLine ?? 0)
  const [releasing, setReleasing] = useState(false)
  const [releaseInput, setReleaseInput] = useState('')

  const handleRelease = useCallback(
    async (qty?: number) => {
      if (!onRelease || releasing) return
      setReleasing(true)
      try {
        await onRelease(qty)
        setReleaseInput('')
      } finally {
        setReleasing(false)
      }
    },
    [onRelease, releasing],
  )

  // ── Stock search ──────────────────────────────────────────────────────────
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!onStockSearch) return
    const q = searchTerm.trim()
    if (q.length < 2) {
      setSearchResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const rows = await onStockSearch(q)
        if (!cancelled) setSearchResults(rows)
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [searchTerm, onStockSearch])

  const canReserve = !!onReserve && !!readiness?.materialId && shortage === 0 && !readinessLoading
  const canRaisePR = !!onRaisePR && shortage > 0 && !readiness?.prId && !readinessLoading

  return (
    <CardSection title="BOARD ALLOCATION">
      {/* ── Row 1: Board type | GSM | Sheet size | UPS ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <EditableTile
          label="Board type"
          ariaLabel="Board type"
          value={drafts.board}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, board: v }))}
          onCommit={commitBoardType}
        />
        <EditableTile
          label="GSM"
          ariaLabel="GSM"
          type="number"
          value={drafts.gsm}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, gsm: v }))}
          onCommit={commitGsm}
        />
        <EditableTile
          label="Sheet size"
          ariaLabel="Sheet size"
          value={drafts.size}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, size: v }))}
          onCommit={commitSize}
        />
        <EditableTile
          label="Units per sheet"
          ariaLabel="Units per sheet"
          type="number"
          value={drafts.ups}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, ups: v }))}
          onCommit={commitUps}
          badge={
            !upsManual && drafts.ups ? (
              <Badge tone="success" className="text-[9px]">
                Auto
              </Badge>
            ) : undefined
          }
        />
      </div>

      {/* ── Row 2: Base sheets (r/o) | Wastage sheets (editable) | Total required (r/o) ── */}
      <div className="grid grid-cols-3 gap-3 mt-3">
        <ReadOnlyTile
          label="Base sheets"
          value={baseSheets != null ? formatSheets(baseSheets) : '—'}
        />
        <EditableTile
          label="Wastage sheets"
          ariaLabel="Wastage sheets"
          type="number"
          value={drafts.wastage}
          placeholder={String(WASTAGE_DEFAULT)}
          onChange={(v) => setDrafts((d) => ({ ...d, wastage: v }))}
          onCommit={commitWastage}
          badge={
            <Badge tone="neutral" className="text-[9px]">
              editable
            </Badge>
          }
        />
        <ReadOnlyTile
          label="Total required"
          value={totalRequired ? formatSheets(totalRequired) : '—'}
        />
      </div>

      {/* ── Link to master row ── */}
      {canLinkCarton || canLinkBoard ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
            Link to master
          </span>
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
                {[opt.boardType, opt.gsm != null ? `${opt.gsm} gsm` : null, opt.size]
                  .filter(Boolean)
                  .join(' · ') || opt.materialCode}
              </span>
              <span className="shrink-0 tabular-nums text-ds-ink-faint">
                {nf.format(Math.round(opt.freeSheets))} free
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {/* ── Stock search ── */}
      {onStockSearch ? (
        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-wider text-ds-ink-faint mb-1.5">
            Search all warehouse stock
          </div>
          <input
            aria-label="Search warehouse stock"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Code, size, GSM, lot, location, supplier…"
            className="w-full rounded-ds-md border border-ds-line bg-ds-base px-3 py-2 text-sm text-ds-ink placeholder:text-ds-ink-faint"
          />
          {searching ? <div className="mt-2 text-xs text-ds-ink-faint">Searching…</div> : null}
          {searchResults.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {searchResults.map((r) => (
                <button
                  key={r.materialId}
                  type="button"
                  onClick={() => onSelectBoard && void onSelectBoard(r.materialId)}
                  className="flex w-full items-center justify-between gap-3 rounded-ds-md border border-ds-line bg-ds-elevated px-3 py-2 text-left text-xs hover:border-ds-brand/50 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="font-semibold text-ds-ink">{r.materialCode}</span>
                    <span className="block text-ds-ink-faint truncate">
                      {[r.size, r.gsm ? `${r.gsm}g` : null, r.boardType].filter(Boolean).join(' · ')}
                      {r.lot ? ` · Lot ${r.lot}` : ''}
                      {r.storageLocation ? ` · ${r.storageLocation}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums text-ds-ink-muted">
                    Free {nf.format(Math.round(r.freeSheets))}
                    {r.supplierName ? <span className="block text-ds-ink-faint">{r.supplierName}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Warehouse snapshot strip ── */}
      {!readinessLoading && (netStock > 0 || reserved > 0 || incoming > 0) ? (
        <WarehouseStrip
          free={netStock}
          reserved={reserved}
          incoming={incoming}
          required={totalRequired ?? 0}
        />
      ) : null}

      {/* ── Stock state banner ── */}
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
            <div className="flex items-center gap-2">
              {canRaisePR ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleRaisePR()
                  }}
                  disabled={raisingPR}
                  className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
                >
                  {raisingPR ? 'Raising…' : '↑ Raise PR'}
                </button>
              ) : null}
              <Badge tone="danger" className="text-[11px] uppercase">
                Shortfall
              </Badge>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-ds-ink-faint">Net stock</div>
              <div className="font-semibold tabular-nums text-ds-ink">{formatSheets(netStock)}</div>
            </div>
            <div>
              <div className="text-ds-ink-faint">Reserved</div>
              <div className="font-semibold tabular-nums text-ds-ink">{formatSheets(reserved)}</div>
            </div>
            <div>
              <div className="text-red-300">Shortfall</div>
              <div className="font-semibold tabular-nums text-red-300">{formatSheets(shortage)}</div>
            </div>
          </div>
        </div>
      ) : readiness?.materialId ? (
        <div className="mt-3 rounded-ds-md border border-emerald-500/30 bg-emerald-500/10 p-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs text-emerald-200">
              Paper warehouse — stock covers required sheets.
            </span>
            {reservedForLine > 0 && onRelease ? (
              <div className="ml-3 flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => void handleRelease(undefined)}
                  disabled={releasing}
                  className="rounded-full border border-red-500/40 bg-red-500/15 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-50 transition-colors"
                >
                  {releasing ? 'Releasing…' : 'Unreserve all'}
                </button>
                <label className="flex items-center gap-1 text-[11px] text-ds-ink-faint">
                  release
                  <input
                    aria-label="Release quantity"
                    inputMode="numeric"
                    value={releaseInput}
                    onChange={(e) => setReleaseInput(e.target.value.replace(/[^\d]/g, ''))}
                    className="w-16 rounded-md border border-ds-line bg-ds-base px-2 py-1 text-right tabular-nums text-ds-ink"
                  />
                  sh
                  <button
                    type="button"
                    onClick={() => {
                      const q = Number(releaseInput)
                      if (q > 0) void handleRelease(q)
                    }}
                    disabled={releasing || !releaseInput}
                    className="rounded-full border border-ds-line bg-ds-elevated px-2.5 py-1 font-semibold text-ds-ink-muted hover:border-ds-brand/50 disabled:opacity-50 transition-colors"
                  >
                    Release
                  </button>
                </label>
              </div>
            ) : canReserve ? (
              <button
                type="button"
                onClick={() => void handleReserve()}
                disabled={reserving}
                className="ml-3 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
              >
                {reserving ? 'Reserving…' : '✓ Reserve'}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-ds-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
          Paper warehouse — stock covers required sheets.
        </div>
      )}

      {/* ── PR on-order badge ── */}
      {readiness?.prId ? (
        <div className="mt-2 flex items-center justify-between rounded-ds-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-id-mono text-amber-200 truncate">{readiness.prId}</span>
            <span className="text-ds-line/60">·</span>
            <span className="text-amber-200/80">
              {readiness.grnEta ? `ETA ${formatEta(readiness.grnEta)}` : 'ETA pending'}
            </span>
          </div>
          <Badge tone="warning" className="text-[11px] uppercase">
            {readiness.prStatus || 'On order'}
          </Badge>
        </div>
      ) : null}

      {/* ── Spec incomplete warning ── */}
      {specIncomplete ? (
        <div className="mt-2 rounded-ds-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-300 mb-1">
            Spec check
          </div>
          <div className="text-ds-ink-faint">
            {bsi?.specIncompleteReason
              ? `Spec incomplete — cannot compute: ${bsi.specIncompleteReason}`
              : 'Spec incomplete — reason unavailable'}
          </div>
        </div>
      ) : null}

      {/* ── Recommended board ── */}
      {recommendedBoardLabel ? (
        <div className="mt-2 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-3 py-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
            Recommended board
          </div>
          <div className="font-semibold text-ds-ink">{recommendedBoardLabel}</div>
        </div>
      ) : null}

      {/* ── Suggested procurement ── */}
      {procurementSuggestion ? (
        <div className="mt-2 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-3 py-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
            Suggested procurement
          </div>
          <div className="font-semibold tabular-nums text-ds-ink">
            {(() => {
              const parts = [
                procurementSuggestion.boardGrade,
                procurementSuggestion.gsm != null ? `${procurementSuggestion.gsm} gsm` : null,
              ].filter(Boolean)
              const suffix = parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
              return `${procurementSuggestion.suggestedSheets.toLocaleString()} sheets${suffix}`
            })()}
          </div>
        </div>
      ) : null}
    </CardSection>
  )
})
