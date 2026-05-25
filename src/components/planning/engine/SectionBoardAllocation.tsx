'use client'

import { useEffect, useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  readinessLoading: boolean
  onPatch: SectionPatchFn
  onSelectBoard?: (materialId: string) => Promise<void>
  onReserve?: () => Promise<void>
  onUnreserve?: () => Promise<void>
  onRaisePR?: () => Promise<void>
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
    ''
  )
}

function resolveGsm(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): number | null {
  return readiness?.gsm ?? line.gsm ?? line.carton?.gsm ?? null
}

function resolveSheetSize(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): string {
  if (readiness?.size) return readiness.size
  const meta = (line.specOverrides ?? {}) as Record<string, unknown>
  if (typeof meta.sheetSize === 'string' && meta.sheetSize.trim()) return meta.sheetSize
  const l = Number(line.materialQueue?.sheetLengthMm)
  const w = Number(line.materialQueue?.sheetWidthMm)
  if (Number.isFinite(l) && Number.isFinite(w) && l > 0 && w > 0) {
    return `${Math.round(l)}×${Math.round(w)} mm`
  }
  return ''
}

/** Editable field tile — text/number input that patches on blur if changed. */
function EditableTile({
  label,
  value,
  type = 'text',
  onCommit,
}: {
  label: string
  value: string
  type?: 'text' | 'number'
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <div className="bg-ds-elevated rounded-ds-md p-3 focus-within:ring-1 focus-within:ring-ds-brand/40 transition-all">
      <label className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</label>
      <input
        type={type}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onCommit(draft) }}
        className="w-full bg-transparent text-base font-semibold text-ds-ink leading-tight mt-1 outline-none tabular-nums"
        placeholder="—"
      />
    </div>
  )
}

function ReadTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ds-elevated/70 rounded-ds-md p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-base font-semibold text-ds-ink leading-tight mt-1 tabular-nums">{value}</div>
    </div>
  )
}

export function SectionBoardAllocation({ line, readiness, readinessLoading, onPatch }: Props) {
  const shortage = Math.max(0, Number(readiness?.shortageSheets ?? 0))
  const required = Number(readiness?.requiredSheets ?? line.planningLedger?.boardStockInsight?.requiredSheets ?? 0)
  const netStock = Number(
    readiness?.availableSheets ?? line.planningLedger?.boardStockInsight?.availableTotalSheets ?? 0,
  )
  const reserved = Number(
    readiness?.reservedSheets ?? line.planningLedger?.boardStockInsight?.reservedSheets ?? 0,
  )

  const boardType = resolveBoardType(line, readiness)
  const gsm = resolveGsm(line, readiness)
  const sheetSize = resolveSheetSize(line, readiness)

  return (
    <CardSection title="BOARD ALLOCATION">
      <div className="grid grid-cols-2 gap-3">
        <EditableTile
          label="Board type"
          value={boardType}
          onCommit={(v) => { void onPatch({ paperType: v.trim() || null }) }}
        />
        <EditableTile
          label="GSM"
          type="number"
          value={gsm != null ? String(gsm) : ''}
          onCommit={(v) => {
            const n = v.trim() === '' ? null : Math.max(1, Math.round(Number(v) || 0))
            void onPatch({ gsm: n })
          }}
        />
        <EditableTile
          label="Sheet size"
          value={sheetSize}
          onCommit={(v) => {
            void onPatch({
              specOverrides: { ...(line.specOverrides ?? {}), sheetSize: v.trim() },
            })
          }}
        />
        <ReadTile label="Required" value={formatSheets(required)} />
      </div>

      {readinessLoading ? (
        <div className="mt-3 rounded-ds-md bg-ds-elevated p-3 text-xs text-ds-ink-faint">
          Checking material…
        </div>
      ) : shortage > 0 ? (
        <div className="mt-3 rounded-ds-md bg-red-500/10 p-3">
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
        <div className="mt-3 rounded-ds-md bg-emerald-500/10 p-3 text-xs text-emerald-200">
          Paper warehouse — stock covers required sheets.
        </div>
      )}

      {readiness?.prId ? (
        <div className="mt-2 flex items-center justify-between rounded-ds-md bg-amber-500/10 px-3 py-2 text-xs">
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
    </CardSection>
  )
}
