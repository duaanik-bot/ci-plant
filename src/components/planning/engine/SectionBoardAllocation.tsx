'use client'

import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  readinessLoading: boolean
  onPatch: SectionPatchFn
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

function resolveBoardType(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): string {
  return (
    readiness?.boardType ||
    line.materialQueue?.boardType ||
    line.paperType ||
    line.carton?.paperType ||
    '—'
  )
}

function resolveGsm(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): string {
  const gsm = readiness?.gsm ?? line.gsm ?? line.carton?.gsm ?? null
  return gsm ? `${gsm} gsm` : '—'
}

function resolveSheetSize(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): string {
  if (readiness?.size) return readiness.size
  const l = Number(line.materialQueue?.sheetLengthMm)
  const w = Number(line.materialQueue?.sheetWidthMm)
  if (Number.isFinite(l) && Number.isFinite(w) && l > 0 && w > 0) {
    return `${Math.round(l)}×${Math.round(w)} mm`
  }
  return '—'
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-base font-semibold text-ds-ink leading-tight mt-1">{value}</div>
    </div>
  )
}

export function SectionBoardAllocation({ line, readiness, readinessLoading, onPatch: _onPatch }: Props) {
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

  return (
    <CardSection title="BOARD ALLOCATION">
      <div className="grid grid-cols-2 gap-3">
        <MetricTile label="Board type" value={resolveBoardType(line, readiness)} />
        <MetricTile label="GSM" value={resolveGsm(line, readiness)} />
        <MetricTile label="Sheet size" value={resolveSheetSize(line, readiness)} />
        <MetricTile label="Required" value={formatSheets(required)} />
      </div>

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
            <Badge tone="danger" className="text-[10px] uppercase">Shortfall</Badge>
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
          <Badge tone="warning" className="text-[10px] uppercase">{readiness.prStatus || 'On order'}</Badge>
        </div>
      ) : null}

      {specIncomplete ? (
        <div className="mt-2 rounded-ds-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-300 mb-1">Spec check</div>
          <div className="text-ds-ink-faint">
            Spec incomplete — cannot compute: {bsi?.specIncompleteReason}
          </div>
        </div>
      ) : null}

      {recommendedBoardLabel ? (
        <div className="mt-2 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-3 py-2 text-xs">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">Recommended board</div>
          <div className="text-ds-ink font-semibold">{recommendedBoardLabel}</div>
        </div>
      ) : null}

      {procurementSuggestion ? (
        <div className="mt-2 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-3 py-2 text-xs">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">Suggested procurement</div>
          <div className="text-ds-ink font-semibold tabular-nums">
            {procurementSuggestion.suggestedSheets.toLocaleString()} sheets
            {[procurementSuggestion.boardGrade, procurementSuggestion.gsm != null ? `${procurementSuggestion.gsm} gsm` : null]
              .filter(Boolean).length > 0
              ? ` · ${[procurementSuggestion.boardGrade, procurementSuggestion.gsm != null ? `${procurementSuggestion.gsm} gsm` : null].filter(Boolean).join(' ')}`
              : null}
          </div>
        </div>
      ) : null}
    </CardSection>
  )
}
