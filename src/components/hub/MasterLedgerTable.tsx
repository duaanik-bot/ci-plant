'use client'

import { formatDistanceToNow } from 'date-fns'
import { PlateHubColourSwatchStrip } from '@/components/hub/PlateHubColourSwatch'
import {
  HUB_PLATE_SIZE_OPTIONS,
  hubPlateSizeCardLine,
  type HubPlateSize,
} from '@/lib/plate-size'
import { hubLastActionLine } from '@/lib/hub-card-time'
import type { PlateHubAuditContext } from '@/components/hub/JobAuditModal'
import type { LedgerZoneKey } from '@/lib/plate-hub-ledger'
import { ledgerRowPlateVolume } from '@/lib/hub-zone-metrics'
import { INDUSTRIAL_PRIORITY_ROW_CLASS } from '@/lib/industrial-priority-ui'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
} from '@/components/ui/EnterpriseTableShell'

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
  industrialPriority?: boolean
  linkedCustomerNames?: string[]
  poNumber?: string | null
}

function stageAgeHours(iso: string | undefined): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 3_600_000
}

function PlateStageDaysCell({ lastStatusUpdatedAt }: { lastStatusUpdatedAt: string | undefined }) {
  const h = stageAgeHours(lastStatusUpdatedAt)
  if (!lastStatusUpdatedAt || h <= 0) return <span className="text-sm text-ds-ink-faint dark:text-ds-ink-muted">—</span>
  const days = h / 24
  const critical = h >= 24
  return (
    <span
      className={`font-designing-queue text-sm font-medium tabular-nums ${
        critical ? 'text-[var(--error)] animate-industrial-age-pulse' : 'text-ds-ink-faint dark:text-ds-ink-muted'
      }`}
      title="Days since last status update in this zone"
    >
      {days.toFixed(1)}d
    </span>
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
  const filtered = rows.filter((r) => {
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
        r.poLineId,
        r.poNumber,
        ...(r.linkedCustomerNames ?? []),
      ])
    ) {
      return false
    }
    return true
  })
  return [...filtered].sort((a, b) => {
    const pa = a.industrialPriority === true ? 1 : 0
    const pb = b.industrialPriority === true ? 1 : 0
    if (pa !== pb) return pb - pa
    return stageAgeHours(b.lastStatusUpdatedAt) - stageAgeHours(a.lastStatusUpdatedAt)
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
    <EnterpriseTableShell>
      <table className="min-w-[920px] w-full border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink">
        <thead className={enterpriseTheadClass}>
          <tr>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Job ID</th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[140px]">Carton</th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Zone</th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-right tabular-nums w-[1%]">
              Plate volume
            </th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[160px]">Size &amp; colours</th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Days in stage</th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">Time in zone</th>
            <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider min-w-[180px]">Last action</th>
          </tr>
        </thead>
        <tbody className={enterpriseTbodyClass}>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-8 text-center text-sm text-ds-ink-faint dark:text-ds-ink-muted">
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
              const pri = r.industrialPriority === true ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
              return (
                <tr
                  key={`${r.entity}-${r.id}`}
                  className={`${enterpriseTrClass} border-b border-neutral-200 dark:border-ds-line/40 ${pri}`}
                >
                  <td className="px-4 py-3 font-designing-queue text-xs font-medium whitespace-nowrap text-ds-warning dark:text-ds-warning">
                    {r.jobId}
                  </td>
                  <td className="px-4 py-3 min-w-0">
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
                      className="block w-full max-w-md min-w-0 break-words whitespace-normal text-left text-sm font-bold leading-snug tracking-tight text-[var(--brand-primary)] hover:opacity-90 hover:underline"
                    >
                      {r.cartonName}
                      {r.partialRemake ? (
                        <span className="ml-1 font-bold text-[var(--error)]">(Remake)</span>
                      ) : null}
                    </button>
                    <p className="mt-0.5 break-words text-xs font-medium text-ds-ink-faint whitespace-normal dark:text-ds-ink-muted">
                      AW: {r.artworkCode?.trim() || '—'}
                      {r.poLineId ? (
                        <>
                          <span className="text-ds-ink-muted"> · </span>
                          PO: {r.poLineId}
                        </>
                      ) : null}
                    </p>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${r.zoneBadgeClass}`}
                    >
                      {r.zoneLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-neutral-900 whitespace-nowrap dark:text-ds-ink-muted">
                    {vol}
                  </td>
                  <td className="px-4 py-3">
                    <p className="mb-1 break-words text-sm text-neutral-700 whitespace-normal dark:text-ds-ink-muted">
                      {sizeLine}
                    </p>
                    <PlateHubColourSwatchStrip
                      labels={r.plateColours}
                      size="sm"
                      className="flex flex-wrap gap-1 content-start"
                    />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <PlateStageDaysCell lastStatusUpdatedAt={r.lastStatusUpdatedAt} />
                  </td>
                  <td className="px-4 py-3 font-designing-queue text-xs tabular-nums text-ds-ink-faint whitespace-nowrap dark:text-ds-ink-muted">
                    {timeInZone}
                  </td>
                  <td className="px-4 py-3 max-w-[240px] break-words text-sm leading-snug text-ds-ink-faint whitespace-normal dark:text-ds-ink-faint">
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
