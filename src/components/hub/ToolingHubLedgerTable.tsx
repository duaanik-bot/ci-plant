'use client'

import { formatDistanceToNow } from 'date-fns'
import { hubLastActionLine } from '@/lib/hub-card-time'
import type { ToolingLedgerZoneKey } from '@/lib/tooling-hub-zones'
import type { ToolingHubAuditContext } from '@/components/hub/ToolingJobAuditModal'

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
    if (zoneFilter && r.zoneKey !== zoneFilter) return false
    if (
      !hubSearchMatch(q, [r.displayCode, r.title, r.specSummary, r.zoneLabel])
    ) {
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
]

export const TOOLING_LEDGER_ZONE_OPTIONS_BLOCKS: { value: string; label: string }[] = [
  { value: '', label: 'All zones' },
  { value: 'incoming_triage', label: 'Incoming Triage' },
  { value: 'engraving_queue', label: 'In-House Engraving' },
  { value: 'live_inventory', label: 'Live Inventory' },
  { value: 'custody_floor', label: 'Custody Floor' },
]

export function ToolingHubLedgerTable({
  rows,
  searchQuery,
  zoneFilter,
  onOpenAudit,
}: {
  rows: ToolingLedgerRow[]
  searchQuery: string
  zoneFilter: string
  onOpenAudit: (ctx: ToolingHubAuditContext) => void
}) {
  const filtered = getFilteredToolingLedgerRows(rows, searchQuery, zoneFilter)

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
                      className="text-left text-blue-400 hover:text-blue-300 hover:underline font-medium truncate max-w-[220px] block"
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
                  <td className="px-3 py-2 text-[11px] text-zinc-400 leading-snug">{r.specSummary}</td>
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
