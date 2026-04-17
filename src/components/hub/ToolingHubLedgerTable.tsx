'use client'

import { useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { hubLastActionLine } from '@/lib/hub-card-time'
import type { ToolingLedgerZoneKey } from '@/lib/tooling-hub-zones'
import type { ToolingHubAuditContext } from '@/components/hub/ToolingJobAuditModal'
import { DieMakeSwitcher } from '@/components/hub/die/DieMakeSwitcher'
import { SimilarDiesModal, type SimilarDieMatch } from '@/components/hub/die/SimilarDiesModal'

export type ToolingSimilarMatch = SimilarDieMatch

export type ToolingLedgerRow = {
  kind: 'die' | 'emboss'
  id: string
  displayCode: string
  title: string
  zoneKey: ToolingLedgerZoneKey
  zoneLabel: string
  zoneBadgeClass: string
  specSummary: string
  units: number
  lastStatusUpdatedAt: string
  ledgerEntryAt?: string
  ledgerRank?: number
  dimensionsLwh?: string
  ups?: number
  pastingType?: string | null
  /** Die Master display label (pastingType + dyeType); preferred over `pastingType` in ledger. */
  masterType?: string | null
  dieMake?: 'local' | 'laser'
  dateOfManufacturing?: string | null
  similarMatches?: ToolingSimilarMatch[]
  typeMismatchMatches?: ToolingSimilarMatch[]
  hubConditionPoor?: boolean
}

function hubSearchMatch(q: string, parts: Array<string | null | undefined>): boolean {
  if (!q) return true
  const hay = parts.map((p) => String(p ?? '').toLowerCase()).join(' ')
  return hay.includes(q)
}

export function getFilteredToolingLedgerRows(
  rows: ToolingLedgerRow[],
  searchQuery: string,
  zoneFilter: string,
): ToolingLedgerRow[] {
  const q = searchQuery.trim().toLowerCase()
  return rows.filter((r) => {
    if (zoneFilter === 'maintenance_needed') {
      if (r.kind !== 'die' || !r.hubConditionPoor) return false
    } else if (zoneFilter && r.zoneKey !== zoneFilter) {
      return false
    }
    const dieParts =
      r.kind === 'die'
        ? [
            r.displayCode,
            r.title,
            r.specSummary,
            r.zoneLabel,
            r.dimensionsLwh,
            r.pastingType,
            r.masterType,
            r.dieMake,
          ]
        : [r.displayCode, r.title, r.specSummary, r.zoneLabel]
    if (!hubSearchMatch(q, dieParts)) {
      return false
    }
    return true
  })
}

export const TOOLING_LEDGER_ZONE_OPTIONS_DIES: { value: string; label: string }[] = [
  { value: '', label: 'All zones' },
  { value: 'incoming_triage', label: 'Incoming Triage' },
  { value: 'outside_vendor', label: 'Outside Vendor' },
  { value: 'live_inventory', label: 'Live Inventory' },
  { value: 'custody_floor', label: 'Custody Floor' },
  { value: 'on_machine', label: 'On machine floor' },
  { value: 'maintenance_needed', label: 'Maintenance needed' },
]

export const TOOLING_LEDGER_ZONE_OPTIONS_BLOCKS: { value: string; label: string }[] = [
  { value: '', label: 'All zones' },
  { value: 'incoming_triage', label: 'Incoming Triage' },
  { value: 'engraving_queue', label: 'In-House Engraving' },
  { value: 'live_inventory', label: 'Live Inventory' },
  { value: 'custody_floor', label: 'Custody Floor' },
  { value: 'on_machine', label: 'On machine floor' },
]

function formatDom(iso: string | null | undefined): string {
  if (!iso?.trim()) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return format(d, 'MMM d, yyyy')
}

export function ToolingHubLedgerTable({
  rows,
  searchQuery,
  zoneFilter,
  onOpenAudit,
  hubMode,
  onDieDataChanged,
  dieMakeDisabled,
}: {
  rows: ToolingLedgerRow[]
  searchQuery: string
  zoneFilter: string
  onOpenAudit: (ctx: ToolingHubAuditContext) => void
  hubMode: 'dies' | 'blocks'
  onDieDataChanged?: () => void
  dieMakeDisabled?: boolean
}) {
  const filtered = getFilteredToolingLedgerRows(rows, searchQuery, zoneFilter)
  const [similarModal, setSimilarModal] = useState<{
    sourceLabel: string
    sourceDieType?: string
    variant: 'similar' | 'type_mismatch'
    matches: SimilarDieMatch[]
  } | null>(null)

  function openAuditForDie(
    r: ToolingLedgerRow,
    dimensionsTitle: string,
  ) {
    onOpenAudit({
      tool: 'die',
      id: r.id,
      zoneLabel: r.zoneLabel,
      displayCode: r.displayCode,
      title: dimensionsTitle,
      specSummary: r.specSummary,
      units: r.units,
    })
  }

  if (hubMode === 'blocks') {
    return (
      <div className="overflow-x-auto rounded-xl border border-zinc-700 bg-zinc-950">
        <table className="min-w-[800px] w-full text-left text-sm border-collapse">
          <thead>
            <tr className="border-b border-zinc-700 text-[10px] uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-2 font-semibold whitespace-nowrap">Code</th>
              <th className="px-3 py-2 font-semibold min-w-[140px]">Title</th>
              <th className="px-3 py-2 font-semibold whitespace-nowrap">Zone</th>
              <th className="px-3 py-2 font-semibold text-right tabular-nums w-[1%]">Units</th>
              <th className="px-3 py-2 font-semibold min-w-[200px]">Specs</th>
              <th className="px-3 py-2 font-semibold whitespace-nowrap">Time in zone</th>
              <th className="px-3 py-2 font-semibold min-w-[160px]">Last action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-500">
                  No rows match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const at = r.lastStatusUpdatedAt
                const d = at ? new Date(at) : null
                const timeInZone =
                  d && !Number.isNaN(d.getTime())
                    ? formatDistanceToNow(d, { addSuffix: true })
                    : '—'
                const lastLine = hubLastActionLine(at) ?? '—'
                return (
                  <tr
                    key={`${r.kind}-${r.id}`}
                    className="border-b border-zinc-800/80 hover:bg-zinc-900/50"
                  >
                    <td className="px-3 py-2 font-mono text-amber-200/90 text-xs whitespace-nowrap">
                      {r.displayCode}
                    </td>
                    <td className="px-3 py-2 min-w-0">
                      <button
                        type="button"
                        onClick={() =>
                          onOpenAudit({
                            tool: r.kind,
                            id: r.id,
                            zoneLabel: r.zoneLabel,
                            displayCode: r.displayCode,
                            title: r.title,
                            specSummary: r.specSummary,
                            units: r.units,
                          })
                        }
                        className="text-left text-blue-400 hover:text-blue-300 hover:underline font-medium truncate max-w-[220px] block text-xs"
                      >
                        {r.title}
                      </button>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${r.zoneBadgeClass}`}
                      >
                        {r.zoneLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-zinc-300 tabular-nums font-semibold whitespace-nowrap">
                      {r.units}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-zinc-400 leading-snug">
                      {r.specSummary}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400 whitespace-nowrap tabular-nums">
                      {timeInZone}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-zinc-500 leading-snug max-w-[220px]">
                      {lastLine}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-zinc-700 bg-zinc-950">
        <table className="min-w-[1100px] w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-zinc-700 text-[10px] uppercase tracking-wide text-zinc-500">
              <th className="px-2 py-2 font-semibold whitespace-nowrap w-[1%]">#</th>
              <th className="px-2 py-2 font-semibold min-w-[100px]">L×W×H</th>
              <th className="px-2 py-2 font-semibold text-right tabular-nums w-[1%]">UPS</th>
              <th className="px-2 py-2 font-semibold min-w-[88px]">Master type</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Make</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Match</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">DOM</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Zone</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap w-[1%]">Flags</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Time in zone</th>
              <th className="px-2 py-2 font-semibold min-w-[140px]">Last action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-zinc-500 text-sm">
                  No rows match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((r, idx) => {
                const at = r.lastStatusUpdatedAt
                const d = at ? new Date(at) : null
                const timeInZone =
                  d && !Number.isNaN(d.getTime())
                    ? formatDistanceToNow(d, { addSuffix: true })
                    : '—'
                const lastLine = hubLastActionLine(at) ?? '—'
                const dimTitle = r.dimensionsLwh?.trim() || '—'
                const mismatchCount = r.kind === 'die' ? (r.typeMismatchMatches?.length ?? 0) : 0
                const hasTypeMismatch = r.kind === 'die' && mismatchCount > 0
                const hasSimilar =
                  r.kind === 'die' &&
                  !hasTypeMismatch &&
                  Array.isArray(r.similarMatches) &&
                  r.similarMatches.length > 0
                const rank = idx + 1

                return (
                  <tr
                    key={`${r.kind}-${r.id}`}
                    className="border-b border-zinc-800/80 hover:bg-zinc-900/50"
                  >
                    <td className="px-2 py-1.5 text-zinc-500 tabular-nums font-mono text-[11px]">
                      {rank}
                    </td>
                    <td className="px-2 py-1.5 min-w-0">
                      {r.kind === 'die' ? (
                        <button
                          type="button"
                          onClick={() => openAuditForDie(r, dimTitle)}
                          className="text-left text-blue-400 hover:text-blue-300 hover:underline font-semibold truncate max-w-[140px] block text-xs"
                        >
                          {dimTitle}
                        </button>
                      ) : (
                        <span className="text-zinc-500">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right text-zinc-300 tabular-nums font-semibold whitespace-nowrap">
                      {r.kind === 'die' ? (r.ups ?? '—') : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-[11px] text-zinc-300 max-w-[100px] truncate">
                      {r.kind === 'die' ? r.masterType?.trim() || '—' : '—'}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {r.kind === 'die' && r.dieMake ? (
                        <DieMakeSwitcher
                          dyeId={r.id}
                          value={r.dieMake}
                          disabled={dieMakeDisabled}
                          onPersisted={() => onDieDataChanged?.()}
                        />
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {r.kind === 'die' && hasTypeMismatch ? (
                        <button
                          type="button"
                          onClick={() =>
                            setSimilarModal({
                              sourceLabel: r.displayCode,
                              sourceDieType: r.masterType?.trim() || undefined,
                              variant: 'type_mismatch',
                              matches: r.typeMismatchMatches ?? [],
                            })
                          }
                          className="text-red-400 hover:text-red-300 font-bold text-[11px] uppercase tracking-wide"
                        >
                          Type mismatch
                        </button>
                      ) : r.kind === 'die' && hasSimilar ? (
                        <button
                          type="button"
                          onClick={() =>
                            setSimilarModal({
                              sourceLabel: r.displayCode,
                              variant: 'similar',
                              matches: r.similarMatches ?? [],
                            })
                          }
                          className="text-amber-500 hover:text-amber-400 font-bold text-[11px] uppercase tracking-wide"
                        >
                          Similar
                        </button>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-[11px] text-zinc-400 whitespace-nowrap tabular-nums">
                      {r.kind === 'die' ? formatDom(r.dateOfManufacturing) : '—'}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${r.zoneBadgeClass}`}
                      >
                        {r.zoneLabel}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {r.hubConditionPoor ? (
                        <span className="inline-flex items-center rounded border border-red-600/70 bg-red-950/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-300 whitespace-nowrap">
                          Maintenance
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-[11px] text-zinc-400 whitespace-nowrap tabular-nums">
                      {timeInZone}
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-zinc-500 leading-snug max-w-[200px]">
                      {lastLine}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      <SimilarDiesModal
        open={!!similarModal}
        onClose={() => setSimilarModal(null)}
        sourceLabel={similarModal?.sourceLabel ?? ''}
        sourceDieType={similarModal?.sourceDieType}
        variant={similarModal?.variant ?? 'similar'}
        matches={similarModal?.matches ?? []}
      />
    </>
  )
}
