'use client'

import { formatDistanceToNow } from 'date-fns'
import { hubChannelRowsFromLabels } from '@/lib/hub-plate-card-ui'
import {
  HUB_PLATE_SIZE_OPTIONS,
  hubPlateSizeCardLine,
  type HubPlateSize,
} from '@/lib/plate-size'
import { hubLastActionLine } from '@/lib/hub-card-time'
import type { PlateHubAuditContext } from '@/components/hub/JobAuditModal'
import type { LedgerZoneKey } from '@/lib/plate-hub-ledger'
import { ledgerRowPlateVolume } from '@/lib/hub-zone-metrics'

export type MasterLedgerRow = {
  entity: 'requirement' | 'plate'
  id: string
  jobId: string
  displayCode: string
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  poLineId: string | null
  zoneKey: LedgerZoneKey
  zoneLabel: string
  zoneBadgeClass: string
  plateSize: HubPlateSize | null
  plateColours: string[]
  coloursRequired: number
  platesInRackCount: number | null
  lastStatusUpdatedAt: string
  /** Plate requirement / plate store `createdAt` — Excel lead time only. */
  ledgerEntryAt?: string
  statusLabel: string
  partialRemake?: boolean
  custodySource?: 'ctp' | 'vendor' | 'rack'
}

function LedgerColourStrip({ labels }: { labels: string[] }) {
  const rows = hubChannelRowsFromLabels(labels)
  if (!rows.length) return <span className="text-xs text-zinc-500">—</span>
  return (
    <div className="flex flex-wrap items-center gap-1">
      {rows.map(({ key, dot, short, label }) => (
        <span key={key} className="inline-flex items-center gap-0.5" title={label}>
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${dot.bgClass} ${dot.ringClass}`}
          />
          <span className="text-[9px] font-semibold text-zinc-500">{short}</span>
        </span>
      ))}
    </div>
  )
}

function hubSearchMatch(q: string, parts: Array<string | null | undefined>): boolean {
  if (!q) return true
  const hay = parts.map((p) => String(p ?? '').toLowerCase()).join(' ')
  return hay.includes(q)
}

export function getFilteredMasterLedgerRows(
  rows: MasterLedgerRow[],
  searchQuery: string,
  zoneFilter: string,
  sizeFilter: string,
): MasterLedgerRow[] {
  const q = searchQuery.trim().toLowerCase()
  return rows.filter((r) => {
    if (zoneFilter && r.zoneKey !== zoneFilter) return false
    if (sizeFilter && String(r.plateSize ?? '') !== sizeFilter) return false
    if (
      !hubSearchMatch(q, [
        r.jobId,
        r.displayCode,
        r.cartonName,
        r.artworkCode,
        r.statusLabel,
        r.zoneLabel,
      ])
    ) {
      return false
    }
    return true
  })
}

export function MasterLedgerTable({
  rows,
  searchQuery,
  zoneFilter,
  sizeFilter,
  onOpenAudit,
}: {
  rows: MasterLedgerRow[]
  searchQuery: string
  zoneFilter: string
  sizeFilter: string
  onOpenAudit: (ctx: PlateHubAuditContext) => void
}) {
  const filtered = getFilteredMasterLedgerRows(rows, searchQuery, zoneFilter, sizeFilter)

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-700 bg-zinc-950">
      <table className="min-w-[920px] w-full text-left text-sm border-collapse">
        <thead>
          <tr className="border-b border-zinc-700 text-[10px] uppercase tracking-wide text-zinc-500">
            <th className="px-3 py-2 font-semibold whitespace-nowrap">Job ID</th>
            <th className="px-3 py-2 font-semibold min-w-[140px]">Carton</th>
            <th className="px-3 py-2 font-semibold whitespace-nowrap">Zone</th>
            <th className="px-3 py-2 font-semibold whitespace-nowrap text-right tabular-nums w-[1%]">
              Plate volume
            </th>
            <th className="px-3 py-2 font-semibold min-w-[160px]">Size &amp; colours</th>
            <th className="px-3 py-2 font-semibold whitespace-nowrap">Time in zone</th>
            <th className="px-3 py-2 font-semibold min-w-[180px]">Last action</th>
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
              const sizeLine = hubPlateSizeCardLine(r.plateSize)
              const vol = ledgerRowPlateVolume(r)
              return (
                <tr key={`${r.entity}-${r.id}`} className="border-b border-zinc-800/80 hover:bg-zinc-900/50">
                  <td className="px-3 py-2 font-mono text-amber-200/90 text-xs whitespace-nowrap">
                    {r.jobId}
                  </td>
                  <td className="px-3 py-2 min-w-0">
                    <button
                      type="button"
                      onClick={() =>
                        onOpenAudit({
                          entity: r.entity,
                          id: r.id,
                          zoneLabel: r.zoneLabel,
                          cartonName: r.cartonName,
                          artworkCode: r.artworkCode,
                          displayCode: r.displayCode,
                          poLineId: r.poLineId,
                          plateSize: r.plateSize,
                          plateColours: r.plateColours,
                          coloursRequired: r.coloursRequired,
                          platesInRackCount: r.platesInRackCount,
                          statusLabel: r.statusLabel,
                        })
                      }
                      className="text-left text-blue-400 hover:text-blue-300 hover:underline font-medium truncate max-w-[220px] block"
                    >
                      {r.cartonName}
                      {r.partialRemake ? (
                        <span className="text-rose-400 font-bold ml-1">(Remake)</span>
                      ) : null}
                    </button>
                    <p className="text-[10px] text-zinc-500 truncate mt-0.5">
                      AW: {r.artworkCode?.trim() || '—'}
                    </p>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${r.zoneBadgeClass}`}
                    >
                      {r.zoneLabel}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-zinc-300 tabular-nums font-semibold whitespace-nowrap">
                    {vol}
                  </td>
                  <td className="px-3 py-2">
                    <p className="text-[11px] text-zinc-300 mb-1">{sizeLine}</p>
                    <LedgerColourStrip labels={r.plateColours} />
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400 whitespace-nowrap tabular-nums">
                    {timeInZone}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-zinc-500 leading-snug max-w-[240px]">
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

export const LEDGER_ZONE_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All zones' },
  { value: 'incoming_triage', label: 'Incoming Triage' },
  { value: 'ctp_queue', label: 'CTP Queue' },
  { value: 'outside_vendor', label: 'Outside Vendor' },
  { value: 'live_inventory', label: 'Live Inventory' },
  { value: 'custody_floor', label: 'Custody Floor' },
]

export function LedgerSizeFilterOptions(): { value: string; label: string }[] {
  return [
    { value: '', label: 'All sizes' },
    ...HUB_PLATE_SIZE_OPTIONS.map((o) => ({ value: o.value, label: `${o.mm} mm` })),
  ]
}
