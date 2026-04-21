'use client'

import { useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import type { PastingStyle } from '@prisma/client'
import type { ToolingLedgerZoneKey } from '@/lib/tooling-hub-zones'
import { pastingStyleLabel } from '@/lib/pasting-style'
import { hubLastActionLine } from '@/lib/hub-card-time'
import type { ToolingHubAuditContext } from '@/components/hub/ToolingJobAuditModal'
import { DieMakeSwitcher } from '@/components/hub/die/DieMakeSwitcher'
import { SimilarDiesModal, type SimilarDieMatch } from '@/components/hub/die/SimilarDiesModal'
import { PastingStyleBadge } from '@/components/hub/PastingStyleBadge'
import { INDUSTRIAL_PRIORITY_ROW_CLASS } from '@/lib/industrial-priority-ui'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
} from '@/components/ui/EnterpriseTableShell'

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
  pastingStyle?: PastingStyle | null
  hubPastingNeedsMasterUpdate?: boolean
  /** Die Master display label (pasting emphasis). */
  masterType?: string | null
  dieMake?: 'local' | 'laser'
  dateOfManufacturing?: string | null
  similarMatches?: ToolingSimilarMatch[]
  typeMismatchMatches?: ToolingSimilarMatch[]
  hubConditionPoor?: boolean
  /** PO / director priority — sort to top + highlight. */
  industrialPriority?: boolean
  /** Die Hub — customers linked via carton work (deep search). */
  linkedCustomerNames?: string[]
  /** Emboss Hub — primary carton / product id for search (matches Die copy & masters). */
  linkedProductId?: string | null
  /** Emboss Hub — revision / asset version display. */
  versionDisplay?: string | null
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
  /** Die Hub: restrict to Lock Bottom or BSO when set. */
  pastingStyleFilter?: PastingStyle | null,
): ToolingLedgerRow[] {
  const q = searchQuery.trim().toLowerCase()
  const filtered = rows.filter((r) => {
    if (
      pastingStyleFilter &&
      r.kind === 'die' &&
      r.pastingStyle !== pastingStyleFilter
    ) {
      return false
    }
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
            pastingStyleLabel(r.pastingStyle),
            r.masterType,
            r.dieMake,
            ...(r.linkedCustomerNames ?? []),
          ]
        : [
            r.displayCode,
            r.title,
            r.linkedProductId,
            r.versionDisplay,
            r.specSummary,
            r.zoneLabel,
            ...(r.linkedCustomerNames ?? []),
          ]
    if (!hubSearchMatch(q, dieParts)) {
      return false
    }
    return true
  })
  return [...filtered].sort((a, b) => {
    const pa = a.industrialPriority === true ? 1 : 0
    const pb = b.industrialPriority === true ? 1 : 0
    if (pa !== pb) return pb - pa
    const ra = a.ledgerRank ?? 999999
    const rb = b.ledgerRank ?? 999999
    return ra - rb
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
  pastingStyleFilter,
  onOpenAudit,
  hubMode,
  onDieDataChanged,
  dieMakeDisabled,
}: {
  rows: ToolingLedgerRow[]
  searchQuery: string
  zoneFilter: string
  pastingStyleFilter?: PastingStyle | null
  onOpenAudit: (ctx: ToolingHubAuditContext) => void
  hubMode: 'dies' | 'blocks'
  onDieDataChanged?: () => void
  dieMakeDisabled?: boolean
}) {
  const filtered = getFilteredToolingLedgerRows(
    rows,
    searchQuery,
    zoneFilter,
    hubMode === 'dies' ? pastingStyleFilter : null,
  )
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
      <EnterpriseTableShell>
        <table className="min-w-[800px] w-full border-collapse text-left text-sm text-slate-900 dark:text-slate-50">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Code</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[140px]">Title</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Zone</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-right tabular-nums w-[1%]">Units</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[200px]">Specs</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Time in zone</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[160px]">Last action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
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
                const priorityRow = r.industrialPriority === true ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
                return (
                  <tr
                    key={`${r.kind}-${r.id}`}
                    className={`${enterpriseTrClass} border-b border-slate-200 dark:border-slate-800 ${priorityRow}`}
                  >
                    <td className="px-4 py-3 font-designing-queue text-xs font-medium whitespace-nowrap text-amber-800 dark:text-amber-200/90">
                      {r.displayCode}
                    </td>
                    <td className="px-4 py-3 min-w-0">
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
                        className="block max-w-[220px] truncate text-left text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        {r.title}
                      </button>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${r.zoneBadgeClass}`}
                      >
                        {r.zoneLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-slate-900 whitespace-nowrap dark:text-slate-300">
                      {r.units}
                    </td>
                    <td className="px-4 py-3 text-sm leading-snug text-slate-600 dark:text-slate-400">
                      {r.specSummary}
                    </td>
                    <td className="px-4 py-3 font-designing-queue text-xs tabular-nums text-slate-600 whitespace-nowrap dark:text-slate-400">
                      {timeInZone}
                    </td>
                    <td className="px-4 py-3 max-w-[220px] text-sm leading-snug text-slate-600 dark:text-slate-500">
                      {lastLine}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </EnterpriseTableShell>
    )
  }

  return (
    <>
      <EnterpriseTableShell>
        <table className="min-w-[1100px] w-full border-collapse text-left text-xs text-slate-900 dark:text-slate-50">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap w-[1%]">#</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[100px]">L×W×H</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-right tabular-nums w-[1%]">UPS</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[88px]">Master type</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Make</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Match</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">DOM</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Zone</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap w-[1%]">Flags</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Time in zone</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[140px]">Last action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
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
                const rank = r.ledgerRank ?? idx + 1
                const priorityRowDie = r.industrialPriority === true ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''

                return (
                  <tr
                    key={`${r.kind}-${r.id}`}
                    data-hub-die-id={r.kind === 'die' ? r.id : undefined}
                    data-hub-emboss-id={r.kind === 'emboss' ? r.id : undefined}
                    className={`${enterpriseTrClass} border-b border-slate-200 dark:border-slate-800 ${priorityRowDie}`}
                  >
                    <td className="px-4 py-3 font-designing-queue text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                      {rank}
                    </td>
                    <td className="px-4 py-3 min-w-0">
                      {r.kind === 'die' ? (
                        <button
                          type="button"
                          onClick={() => openAuditForDie(r, dimTitle)}
                          className="block max-w-[140px] truncate text-left text-xs font-semibold text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          {dimTitle}
                        </button>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-designing-queue text-sm font-semibold tabular-nums text-slate-900 whitespace-nowrap dark:text-slate-300">
                      {r.kind === 'die' ? (r.ups ?? '—') : '—'}
                    </td>
                    <td className="px-4 py-3 max-w-[140px] min-w-0 text-[11px] text-slate-700 dark:text-slate-300">
                      {r.kind === 'die' ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-1">
                            <PastingStyleBadge value={r.pastingStyle} />
                            {r.hubPastingNeedsMasterUpdate ? (
                              <span className="inline-flex items-center rounded border border-amber-500/70 bg-amber-50 px-1 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-900 whitespace-nowrap dark:bg-amber-950/50 dark:text-amber-200">
                                Master update
                              </span>
                            ) : null}
                          </div>
                          <span className="truncate text-slate-500 dark:text-slate-400">
                            {r.masterType?.trim() || '—'}
                          </span>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.kind === 'die' && r.dieMake ? (
                        <DieMakeSwitcher
                          dyeId={r.id}
                          value={r.dieMake}
                          disabled={dieMakeDisabled}
                          onPersisted={() => onDieDataChanged?.()}
                        />
                      ) : (
                        <span className="text-slate-500 dark:text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
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
                        <span className="text-slate-500 dark:text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-designing-queue text-[11px] tabular-nums text-slate-600 whitespace-nowrap dark:text-slate-400">
                      {r.kind === 'die' ? formatDom(r.dateOfManufacturing) : '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${r.zoneBadgeClass}`}
                      >
                        {r.zoneLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.hubConditionPoor ? (
                        <span className="inline-flex items-center rounded border border-red-600/70 bg-red-50 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-red-800 whitespace-nowrap dark:bg-red-950/50 dark:text-red-300">
                          Maintenance
                        </span>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-designing-queue text-[11px] tabular-nums text-slate-600 whitespace-nowrap dark:text-slate-400">
                      {timeInZone}
                    </td>
                    <td className="px-4 py-3 max-w-[200px] text-sm leading-snug text-slate-600 dark:text-slate-500">
                      {lastLine}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </EnterpriseTableShell>
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
