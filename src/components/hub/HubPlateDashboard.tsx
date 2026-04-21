'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { IndustrialKpiTile } from '@/components/industrial/IndustrialKpiTile'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import { INDUSTRIAL_PRIORITY_ROW_CLASS } from '@/lib/industrial-priority-ui'
import { safeJsonParse, safeJsonParseArray, safeJsonStringify } from '@/lib/safe-json'
import {
  hubChannelRowsFromLabels,
  hubLivePlateBadgeCount,
  hubPlateBadgeCount,
  plateColourCanonicalKey,
  stripPlateColourDisplaySuffix,
} from '@/lib/hub-plate-card-ui'
import { PLATE_SCRAP_REASONS, type PlateScrapReasonCode } from '@/lib/plate-scrap-reasons'
import { hubLastActionLine } from '@/lib/hub-card-time'
import {
  PLATE_FIRST_ORIGIN_OPTIONS,
  defaultFirstOriginFromCustody,
  type PlateColourFirstOrigin,
} from '@/lib/hub-plate-origin'
import {
  HUB_PLATE_SIZE_OPTIONS,
  HUB_PLATE_SIZE_VALUES,
  hubPlateSizeCardLine,
  type HubPlateSize,
} from '@/lib/plate-size'
import { JobAuditModal, type PlateHubAuditContext } from '@/components/hub/JobAuditModal'
import {
  MasterLedgerTable,
  getFilteredMasterLedgerRows,
  LEDGER_ZONE_FILTER_OPTIONS,
  LedgerSizeFilterOptions,
  type MasterLedgerRow,
} from '@/components/hub/MasterLedgerTable'
import {
  calculateZoneMetrics,
  hubZonePlateVolumeCustodyCard,
  hubZonePlateVolumeInventoryCard,
  hubZonePlateVolumeShopfloorJob,
  hubZonePlateVolumeTriage,
  ledgerRowPlateVolume,
} from '@/lib/hub-zone-metrics'
import { TableExportMenu } from '@/components/hub/TableExportMenu'
import { PlateStarLedger } from '@/components/hub/PlateStarLedger'
import {
  PlateHubColourSwatch,
  PlateHubColourSwatchStrip,
} from '@/components/hub/PlateHubColourSwatch'
import {
  plateMasterLedgerExportColumns,
  plateMasterLedgerExcelExtraColumns,
} from '@/lib/hub-ledger-export-columns'

function ZoneCapacitySubheader({
  jobCount,
  plateCount,
}: {
  jobCount: number
  plateCount: number
}) {
  return (
    <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold tabular-nums leading-tight shrink-0">
      {jobCount} jobs · {plateCount} total plates
    </p>
  )
}

const RETURN_SIZE_MOD_REASONS: {
  value: 'alternate_machine' | 'edge_damage' | 'prepress_error'
  label: string
}[] = [
  { value: 'alternate_machine', label: 'Resized for alternate machine assignment' },
  { value: 'edge_damage', label: 'Trimmed due to edge damage / wear' },
  { value: 'prepress_error', label: 'Pre-press layout error / Manual correction' },
]

type TriageRow = {
  id: string
  poLineId?: string | null
  effectivePoLineId?: string | null
  poNumber?: string | null
  purchaseOrderId?: string | null
  poLinkHint?: 'linked' | 'missing_row' | 'manual'
  requirementCode: string
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  newPlatesNeeded: number
  status: string
  plateColours: string[]
  lastStatusUpdatedAt?: string
  plateSize?: HubPlateSize | null
  cartonMasterPlateSize?: HubPlateSize | null
  linkedCustomerNames?: string[]
  industrialPriority?: boolean
  ledgerEntryAt?: string
}

type CtpRow = {
  id: string
  poLineId?: string | null
  requirementCode: string
  jobCardId: string | null
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  plateColours: string[]
  status: string
  numberOfColours?: number
  newPlatesNeeded?: number
  partialRemake?: boolean
  lastStatusUpdatedAt?: string
  plateSize?: HubPlateSize | null
  poNumber?: string | null
  purchaseOrderId?: string | null
  linkedCustomerNames?: string[]
  industrialPriority?: boolean
  ledgerEntryAt?: string
  /** Canonical keys (`plateColourCanonicalKey`) dimmed on shop floor (still in `plateColours`). */
  shopfloorInactiveCanonicalKeys?: string[]
  shopfloorActiveColourCount?: number
}

type PlateCard = {
  id: string
  plateSetCode: string
  serialNumber?: string | null
  outputNumber?: string | null
  rackNumber?: string | null
  ups?: number | null
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  artworkId: string | null
  jobCardId: string | null
  slotNumber: string | null
  rackLocation: string | null
  status: string
  issuedTo: string | null
  issuedAt: string | null
  totalImpressions: number
  customer: { id: string; name: string } | null
  plateColours?: string[]
  numberOfColours?: number
  totalPlates?: number
  platesInRackCount?: number
  colourChannelNames?: string[]
  createdAt?: string
  lastStatusUpdatedAt?: string
  /** Resolved per-channel usage counts (C/M/Y/K/P1…) for star ledger */
  cycleData?: Record<string, number>
  plateSize?: HubPlateSize | null
}

type CustodyCard = {
  kind: 'requirement' | 'plate'
  id: string
  displayCode: string
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  plateColours: string[]
  colourChannelNames?: string[]
  platesInRackCount?: number
  custodySource: 'ctp' | 'vendor' | 'rack'
  serialNumber?: string | null
  rackNumber?: string | null
  rackLocation?: string | null
  ups?: number | null
  customer?: { id: string; name: string } | null
  numberOfColours?: number
  newPlatesNeeded?: number
  partialRemake?: boolean
  totalPlates?: number
  artworkId?: string | null
  jobCardId?: string | null
  slotNumber?: string | null
  lastStatusUpdatedAt?: string
  jobCardHub?: { key: string; badgeLabel: string } | null
  /** Canonical `SIZE_*` for planning / press matching */
  plateSize?: HubPlateSize | null
  /** Physical plate sets only — star ledger source */
  cycleData?: Record<string, number>
}

type CartonSearchHit = {
  id: string
  cartonName: string
  artworkCode: string | null
  customerId: string
  customer: { id: string; name: string }
  ups: number | null
  plateSize?: HubPlateSize | null
}

type DashboardPayload = {
  triage: TriageRow[]
  ctpQueue: CtpRow[]
  vendorQueue: CtpRow[]
  inventory: PlateCard[]
  custody: CustodyCard[]
  ledgerRows: MasterLedgerRow[]
}

function hubSearchMatch(
  q: string,
  parts: Array<string | null | undefined>,
): boolean {
  if (!q) return true
  const hay = parts.map((p) => String(p ?? '').toLowerCase()).join(' ')
  return hay.includes(q)
}

function plateStageHoursPlateHub(iso?: string | null): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 3_600_000
}

function sortPlatePrepRows<
  T extends { industrialPriority?: boolean; lastStatusUpdatedAt?: string | null },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const pa = a.industrialPriority === true ? 1 : 0
    const pb = b.industrialPriority === true ? 1 : 0
    if (pa !== pb) return pb - pa
    return plateStageHoursPlateHub(b.lastStatusUpdatedAt) - plateStageHoursPlateHub(a.lastStatusUpdatedAt)
  })
}

function PlateHubStageDays({ lastStatusUpdatedAt }: { lastStatusUpdatedAt?: string | null }) {
  const h = plateStageHoursPlateHub(lastStatusUpdatedAt)
  if (!lastStatusUpdatedAt || h <= 0) return null
  const days = h / 24
  const critical = h >= 24
  return (
    <p
      className={`text-[10px] font-semibold tabular-nums mt-0.5 ${
        critical ? 'text-rose-400 animate-industrial-age-pulse' : 'text-zinc-500'
      }`}
    >
      {days.toFixed(1)}d in stage
    </p>
  )
}

function normHubKey(s: string | null | undefined): string {
  return String(s ?? '').trim().toLowerCase()
}

function formatPlateCardRackLocation(p: PlateCard): string | null {
  const primary = p.rackLocation?.trim()
  if (primary) return primary
  const parts = [p.rackNumber?.trim(), p.slotNumber?.trim()].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  return null
}

/**
 * Checkbox keys / API payload must use `plate_store.colours[].name` when the dashboard
 * exposes parallel `colourChannelNames`; labels stay human-readable (`plateColours`).
 */
function stockPullChannelRows(p: PlateCard): { submitKey: string; displayLabel: string }[] {
  const labels = p.plateColours ?? []
  const rawNames = p.colourChannelNames ?? []
  if (rawNames.length > 0 && rawNames.length === labels.length) {
    return rawNames.map((submitKey, i) => ({
      submitKey,
      displayLabel: labels[i] ?? submitKey,
    }))
  }
  return labels.map((displayLabel) => ({
    submitKey: displayLabel,
    displayLabel,
  }))
}

function stockChannelCanonInSet(displayLabel: string, needed: Set<string>): boolean {
  const k = plateColourCanonicalKey(stripPlateColourDisplaySuffix(displayLabel))
  return Boolean(k && needed.has(k))
}

/** Stable CMYK-first ordering for merged rack colour labels (matches hub dot palette). */
function sortUnionStockLabels(labelSet: Set<string>): string[] {
  const unique = Array.from(labelSet).filter((s) => s.trim())
  if (!unique.length) return []
  const rows = hubChannelRowsFromLabels(unique)
  const rank = (short: string): number => {
    const order = ['C', 'M', 'Y', 'K', 'P1', 'P2', 'P3', 'P4'] as const
    const i = order.indexOf(short as (typeof order)[number])
    return i >= 0 ? i : 50
  }
  return [...rows]
    .sort((a, b) => {
      const d = rank(a.short) - rank(b.short)
      if (d !== 0) return d
      return stripPlateColourDisplaySuffix(a.label).localeCompare(
        stripPlateColourDisplaySuffix(b.label),
      )
    })
    .map((r) => r.label)
}

type TriageStockInfo = {
  matchCount: number
  labels: string[]
  locationLabel: string | null
}

function TriageInventoryStockLine({ stock }: { stock: TriageStockInfo }) {
  if (stock.matchCount === 0) {
    return <p className="text-xs text-gray-500 mt-1">Inventory: Not in stock</p>
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
      <span className="text-xs text-zinc-400 shrink-0">In rack:</span>
      {stock.labels.length > 0 ? (
        <PlateHubColourSwatchStrip labels={stock.labels} size="sm" className="inline-flex" />
      ) : null}
      {stock.locationLabel ? (
        <span className="text-xs text-zinc-500">({stock.locationLabel})</span>
      ) : null}
    </div>
  )
}

function sourceBadgeLabel(source: CustodyCard['custodySource']): string {
  if (source === 'ctp') return 'Source: In-house CTP'
  if (source === 'vendor') return 'Source: Vendor'
  return 'Source: Rack'
}

function CustodySourcePill({ source }: { source: CustodyCard['custodySource'] }) {
  const tone =
    source === 'rack'
      ? 'border-emerald-800/60 bg-emerald-950/70 text-emerald-200/95'
      : source === 'vendor'
        ? 'border-violet-800/60 bg-violet-950/70 text-violet-200/95'
        : 'border-amber-800/60 bg-amber-950/70 text-amber-200/95'
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${tone}`}
    >
      {sourceBadgeLabel(source)}
    </span>
  )
}

function HubJobCardMetaLine({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-medium text-gray-300 opacity-90 whitespace-normal break-words leading-snug">
      {children}
    </p>
  )
}

function HubStarLedgerSection({
  labels,
  cycleData,
}: {
  labels: string[]
  cycleData: Record<string, number> | null | undefined
}) {
  const rows = hubChannelRowsFromLabels(labels)
  if (!rows.length) return null
  return (
    <div className="rounded-md bg-gray-900/40 px-2 py-1.5 border border-gray-800/60">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500 mb-0.5">
        Star ledger
      </p>
      <PlateStarLedger labels={labels} cycleData={cycleData} />
    </div>
  )
}

const HUB_CMYK_CHANNEL_LABEL = {
  C: 'Cyan',
  M: 'Magenta',
  Y: 'Yellow',
  K: 'Black',
} as const

function PlateCountBadge({ count }: { count: number }) {
  const n = Math.max(0, Math.min(99, count))
  return (
    <div
      className="pointer-events-none absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-amber-500 bg-zinc-950 text-[11px] font-extrabold text-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.3)] tabular-nums z-10"
      aria-label={`${n} plates`}
    >
      {n}
    </div>
  )
}

/** Compact pencil control to the left of the plate count badge (same vertical band — no extra card height). */
function ShopfloorPlateAdjustTrigger({
  onClick,
  disabled,
  title = 'Adjust plates',
}: {
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="absolute top-[0.4rem] right-[2.35rem] z-20 flex h-6 w-6 items-center justify-center rounded-md border border-zinc-600/70 bg-zinc-900/95 text-zinc-300 hover:border-amber-500/50 hover:text-amber-200 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
      title={title}
      aria-label={title}
    >
      <Pencil className="h-3 w-3 shrink-0" strokeWidth={2.25} />
    </button>
  )
}

function ColourChannelsRow({ labels }: { labels: string[] }) {
  return (
    <PlateHubColourSwatchStrip
      labels={labels}
      className="min-h-[1rem] flex flex-wrap gap-1 content-start"
    />
  )
}

function HubPlateSizeLine({ size }: { size: HubPlateSize | null | undefined }) {
  const line = hubPlateSizeCardLine(size)
  if (!line) return null
  return <HubJobCardMetaLine>{line}</HubJobCardMetaLine>
}

type ShopfloorSpecPatch = Partial<
  Pick<
    CtpRow,
    | 'plateSize'
    | 'plateColours'
    | 'shopfloorInactiveCanonicalKeys'
    | 'shopfloorActiveColourCount'
    | 'numberOfColours'
    | 'newPlatesNeeded'
  >
>

/** Read-only colour strip for CTP / vendor cards; skipped channels use ghost swatches. */
function ShopfloorQueueColourStrip({ job }: { job: CtpRow }) {
  const inactive = new Set(job.shopfloorInactiveCanonicalKeys ?? [])
  if (!job.plateColours.length) {
    return <span className="text-xs text-zinc-500">—</span>
  }
  return (
    <PlateHubColourSwatchStrip
      labels={job.plateColours}
      ghostCanonKeys={inactive}
      className="min-h-[1rem] flex flex-wrap gap-1 content-start"
    />
  )
}

function AdjustPlatesModal({
  job,
  onClose,
  mergePatch,
  savingDisabled,
}: {
  job: CtpRow | null
  onClose: () => void
  mergePatch: (jobId: string, patch: ShopfloorSpecPatch) => void
  savingDisabled: boolean
}) {
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const items = useMemo(() => {
    if (!job) return []
    const rows = hubChannelRowsFromLabels(job.plateColours)
    const out: {
      canon: string
      short: string
      label: string
    }[] = []
    const seen = new Set<string>()
    for (const r of rows) {
      const canon = plateColourCanonicalKey(stripPlateColourDisplaySuffix(r.label))
      if (!canon || seen.has(canon)) continue
      seen.add(canon)
      out.push({ canon, short: r.short, label: r.label })
    }
    return out
  }, [job])

  useEffect(() => {
    if (!job) return
    const inactive = new Set(job.shopfloorInactiveCanonicalKeys ?? [])
    const next: Record<string, boolean> = {}
    for (const it of items) {
      next[it.canon] = !inactive.has(it.canon)
    }
    setChecks(next)
    setReason('')
  }, [job, items])

  if (!job) return null

  const selectedCount = items.filter((it) => checks[it.canon]).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
      <div className="w-full max-w-md rounded-xl border border-amber-700/45 bg-zinc-950 p-4 space-y-3 max-h-[90vh] overflow-y-auto shadow-xl shadow-black/40">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Adjust plates</h3>
          <p className="text-zinc-500 text-xs mt-1 leading-snug">
            Select only the colors to be manufactured/ordered for this run.
          </p>
          <p className="text-xs font-mono text-amber-300 mt-2">{job.requirementCode}</p>
          <p className="text-sm text-foreground font-medium break-words whitespace-normal leading-snug">
            {job.cartonName}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-700 bg-background/50 p-2.5 space-y-1.5">
          {items.length === 0 ? (
            <p className="text-xs text-zinc-500">No colour channels on this job.</p>
          ) : (
            items.map((it) => (
              <label
                key={it.canon}
                className="flex items-center gap-2.5 text-sm text-zinc-200 cursor-pointer py-0.5"
              >
                <input
                  type="checkbox"
                  checked={checks[it.canon] ?? true}
                  onChange={(e) =>
                    setChecks((prev) => ({ ...prev, [it.canon]: e.target.checked }))
                  }
                  className="rounded border-zinc-600 shrink-0"
                />
                <span className="flex items-center gap-2 min-w-0 flex-1">
                  <PlateHubColourSwatch
                    short={it.short}
                    label={it.label}
                    ghost={!(checks[it.canon] ?? true)}
                  />
                  <span className="text-xs text-zinc-300 break-words whitespace-normal">{it.label}</span>
                </span>
              </label>
            ))
          )}
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-zinc-500 mb-1">
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Using existing stock / Job change"
            className="w-full px-2.5 py-1.5 rounded-md bg-background border border-zinc-600 text-foreground text-xs placeholder:text-zinc-600 resize-y min-h-[2.5rem]"
          />
        </div>
        <p className="text-[11px] text-zinc-500 leading-snug">
          {selectedCount < 1 ? (
            <span className="text-amber-200/90">
              At least one colour must stay selected. If none are needed, close this dialog and use{' '}
              <strong className="font-semibold">Send back to Triage</strong>.
            </span>
          ) : (
            <>
              <span className="text-zinc-400 font-semibold tabular-nums">{selectedCount}</span> of{' '}
              <span className="tabular-nums">{items.length}</span> channels will be manufactured
              (badge updates after save).
            </>
          )}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="px-3 py-2 rounded border border-zinc-600 text-zinc-300 text-sm"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              submitting || savingDisabled || items.length === 0 || selectedCount < 1
            }
            className="px-3 py-2 rounded bg-amber-600 hover:bg-amber-500 text-primary-foreground text-sm font-semibold disabled:opacity-45"
            onClick={() => {
              void (async () => {
                const activeCanonicalKeys = items
                  .filter((it) => checks[it.canon])
                  .map((it) => it.canon)
                if (activeCanonicalKeys.length < 1) {
                  toast.error(
                    'Select at least one colour — or use Send back to Triage if the job should not run.',
                  )
                  return
                }
                setSubmitting(true)
                try {
                  const r = await fetch(`/api/plate-requirements/${job.id}/shopfloor-spec`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: safeJsonStringify({
                      activeCanonicalKeys,
                      partialReason: reason.trim() || undefined,
                    }),
                  })
                  const t = await r.text()
                  const j = safeJsonParse<ShopfloorSpecPatch & { error?: string }>(t, {})
                  if (!r.ok) {
                    toast.error(j.error ?? 'Could not update plates')
                    return
                  }
                  mergePatch(job.id, {
                    plateColours: j.plateColours,
                    shopfloorInactiveCanonicalKeys: j.shopfloorInactiveCanonicalKeys,
                    shopfloorActiveColourCount: j.shopfloorActiveColourCount,
                    numberOfColours: j.numberOfColours,
                    newPlatesNeeded: j.newPlatesNeeded,
                  })
                  toast.success('Plate run updated')
                  onClose()
                } catch (err) {
                  console.error(err)
                  toast.error('Could not update plates')
                } finally {
                  setSubmitting(false)
                }
              })()
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function ShopfloorQueueSizeSelect({
  job,
  disabled,
  mergePatch,
}: {
  job: CtpRow
  disabled: boolean
  mergePatch: (jobId: string, patch: ShopfloorSpecPatch) => void
}) {
  const value = (job.plateSize ?? 'SIZE_560_670') as HubPlateSize
  return (
    <div className="mt-0.5 inline-flex items-baseline gap-1 flex-wrap max-w-full">
      <span className="text-xs font-medium text-zinc-400 shrink-0">Size:</span>
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const plateSize = e.target.value as HubPlateSize
          void (async () => {
            try {
              const r = await fetch(`/api/plate-requirements/${job.id}/shopfloor-spec`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: safeJsonStringify({ plateSize }),
              })
              const t = await r.text()
              const j = safeJsonParse<
                ShopfloorSpecPatch & { error?: string; plateSize?: HubPlateSize | null }
              >(t, {})
              if (!r.ok) {
                toast.error(j.error ?? 'Could not update size')
                return
              }
              mergePatch(job.id, {
                plateSize: (j.plateSize ?? plateSize) as HubPlateSize,
                plateColours: j.plateColours,
                shopfloorInactiveCanonicalKeys: j.shopfloorInactiveCanonicalKeys,
                shopfloorActiveColourCount: j.shopfloorActiveColourCount,
                numberOfColours: j.numberOfColours,
                newPlatesNeeded: j.newPlatesNeeded,
              })
            } catch (err) {
              console.error(err)
              toast.error('Could not update size')
            }
          })()
        }}
        aria-label="Plate sheet size (shop floor)"
        className="text-xs font-medium text-zinc-400 bg-transparent border-0 border-b border-dashed border-zinc-600/0 hover:border-zinc-500/60 hover:text-zinc-300 focus-visible:border-amber-500/70 focus-visible:text-zinc-200 focus:outline-none cursor-pointer py-0 pl-0 pr-5 -ml-0.5 max-w-[10rem] rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
        style={{ backgroundImage: 'none' }}
      >
        {HUB_PLATE_SIZE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value} className="bg-zinc-900 text-zinc-200">
            {opt.mm}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Inline size correction on incoming triage — persists before CTP / vendor dispatch. */
function TriageInlinePlateSize({
  row,
  disabled,
  onSizeChange,
}: {
  row: TriageRow
  disabled?: boolean
  onSizeChange: (requirementId: string, plateSize: HubPlateSize) => void
}) {
  const value = row.plateSize ?? row.cartonMasterPlateSize ?? 'SIZE_560_670'
  return (
    <div className="mt-0.5 inline-flex items-baseline gap-1 flex-wrap">
      <span className="text-xs font-medium text-zinc-400 shrink-0">Size:</span>
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => onSizeChange(row.id, e.target.value as HubPlateSize)}
        aria-label="Plate sheet size"
        className="text-xs font-medium text-zinc-400 bg-transparent border-0 border-b border-dashed border-zinc-600/0 hover:border-zinc-500/60 hover:text-zinc-300 focus-visible:border-amber-500/70 focus-visible:text-zinc-200 focus:outline-none cursor-pointer py-0.5 pl-0 pr-5 -ml-0.5 max-w-[10rem] rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
        style={{ backgroundImage: 'none' }}
      >
        {HUB_PLATE_SIZE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value} className="bg-zinc-900 text-zinc-200">
            {opt.mm}
          </option>
        ))}
      </select>
    </div>
  )
}

function HubPlateSizeSegmented({
  value,
  onChange,
  accent,
}: {
  value: HubPlateSize
  onChange: (v: HubPlateSize) => void
  accent: 'amber' | 'violet' | 'emerald'
}) {
  const on =
    accent === 'violet'
      ? 'bg-violet-600 border-violet-500 text-primary-foreground'
      : accent === 'emerald'
        ? 'bg-emerald-600 border-emerald-500 text-primary-foreground'
        : 'bg-amber-600 border-amber-500 text-primary-foreground'
  const off = 'text-zinc-400 hover:text-foreground hover:bg-zinc-800 border-transparent'
  return (
    <div
      className="flex rounded-lg border border-zinc-600 overflow-hidden p-0.5 bg-background/60"
      role="radiogroup"
      aria-label="Plate size"
    >
      {HUB_PLATE_SIZE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={`flex-1 px-1.5 py-1.5 text-center text-[10px] font-bold border rounded-md transition-colors ${
            value === opt.value ? on : off
          }`}
          onClick={() => onChange(opt.value)}
        >
          {opt.mm}
        </button>
      ))}
    </div>
  )
}

function HubLastActionFooter({ at }: { at: string | null | undefined }) {
  const line = hubLastActionLine(at)
  if (!line) return null
  return (
    <p className="mt-2 pt-2 border-t border-gray-800/70 text-[10px] text-gray-500 italic leading-tight">
      {line}
    </p>
  )
}

/** Clickable carton title — opens job audit modal. */
function HubCartonAuditTitle({
  children,
  onOpenAudit,
  className,
}: {
  children: ReactNode
  onOpenAudit: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onOpenAudit}
      className={`text-left cursor-pointer hover:underline transition-colors break-words whitespace-normal text-sm font-bold leading-snug tracking-tight text-blue-400 hover:text-blue-300 min-w-0 w-full block ${className ?? ''}`}
    >
      {children}
    </button>
  )
}

function JobCardStatusBadge({
  hub,
}: {
  hub: { key: string; badgeLabel: string } | null | undefined
}) {
  if (!hub) return null
  const tone =
    hub.key === 'printed'
      ? 'border-emerald-600/60 bg-emerald-950/50 text-emerald-200'
      : hub.key === 'planning'
        ? 'border-amber-600/60 bg-amber-950/50 text-amber-200'
        : 'border-sky-600/60 bg-sky-950/50 text-sky-200'
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${tone}`}
    >
      Status: {hub.badgeLabel}
    </span>
  )
}

function plateColourNamesForScrap(p: {
  plateColours?: string[] | null
  colourChannelNames?: string[] | null
}): string[] {
  if (p.colourChannelNames?.length) return p.colourChannelNames
  return (p.plateColours ?? []).map((x) => stripPlateColourDisplaySuffix(x)).filter(Boolean)
}

function safeReadDashboard(text: string): DashboardPayload | null {
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    return {
      triage: Array.isArray(o.triage) ? (o.triage as TriageRow[]) : [],
      ctpQueue: Array.isArray(o.ctpQueue) ? (o.ctpQueue as CtpRow[]) : [],
      vendorQueue: Array.isArray(o.vendorQueue) ? (o.vendorQueue as CtpRow[]) : [],
      inventory: Array.isArray(o.inventory) ? (o.inventory as PlateCard[]) : [],
      custody: Array.isArray(o.custody) ? (o.custody as CustodyCard[]) : [],
      ledgerRows: Array.isArray(o.ledgerRows) ? (o.ledgerRows as MasterLedgerRow[]) : [],
    }
  } catch {
    return null
  }
}

export default function HubPlateDashboard() {
  const [loading, setLoading] = useState(true)
  const [jobAudit, setJobAudit] = useState<PlateHubAuditContext | null>(null)
  const [data, setData] = useState<DashboardPayload>({
    triage: [],
    ctpQueue: [],
    vendorQueue: [],
    inventory: [],
    custody: [],
    ledgerRows: [],
  })
  const [addStockOpen, setAddStockOpen] = useState(false)
  const [addCartonQuery, setAddCartonQuery] = useState('')
  const [addCartonResults, setAddCartonResults] = useState<CartonSearchHit[]>([])
  const [addCartonLoading, setAddCartonLoading] = useState(false)
  const [addSelectedCarton, setAddSelectedCarton] = useState<CartonSearchHit | null>(null)
  const [addAwCode, setAddAwCode] = useState('')
  const [addSerial, setAddSerial] = useState('')
  const [addAutoSerial, setAddAutoSerial] = useState(true)
  const [addOutputNumber, setAddOutputNumber] = useState('')
  const [addRackNumber, setAddRackNumber] = useState('')
  const [addUps, setAddUps] = useState('')
  const [addArtworkId, setAddArtworkId] = useState('')
  const [stdC, setStdC] = useState(true)
  const [stdM, setStdM] = useState(true)
  const [stdY, setStdY] = useState(true)
  const [stdK, setStdK] = useState(true)
  const [pantoneOn, setPantoneOn] = useState(false)
  const [pantoneCount, setPantoneCount] = useState(1)
  const cartonSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mCtpSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mvSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [manualVendorOpen, setManualVendorOpen] = useState(false)
  const [mvQuery, setMvQuery] = useState('')
  const [mvResults, setMvResults] = useState<CartonSearchHit[]>([])
  const [mvLoading, setMvLoading] = useState(false)
  const [mvSelected, setMvSelected] = useState<CartonSearchHit | null>(null)
  const [mvC, setMvC] = useState(true)
  const [mvM, setMvM] = useState(true)
  const [mvY, setMvY] = useState(true)
  const [mvK, setMvK] = useState(true)
  const [mvPantone, setMvPantone] = useState(false)
  const [mvPantoneN, setMvPantoneN] = useState(1)

  const [scrapModal, setScrapModal] = useState<{
    plateStoreId: string
    plateSetCode: string
    cartonName: string
    colourNames: string[]
  } | null>(null)
  const [scrapChannelPick, setScrapChannelPick] = useState<Record<string, boolean>>({})
  const [scrapReasonCode, setScrapReasonCode] = useState<PlateScrapReasonCode | ''>('')

  const [returnAuditModal, setReturnAuditModal] = useState<{
    kind: 'plate' | 'requirement'
    plateStoreId?: string
    requirementId?: string
    plateSetCode: string
    cartonName: string
    colourNames: string[]
    custodySource: CustodyCard['custodySource']
    plateSize?: HubPlateSize | null
  } | null>(null)
  const [returnAuditPick, setReturnAuditPick] = useState<Record<string, boolean>>({})
  const [returnAuditOrigin, setReturnAuditOrigin] = useState<PlateColourFirstOrigin>('legacy_unknown')
  const [returnAuditStep, setReturnAuditStep] = useState<1 | 2>(1)
  const [returnSizePick, setReturnSizePick] = useState<HubPlateSize>('SIZE_560_670')
  const [returnSizeOriginal, setReturnSizeOriginal] = useState<HubPlateSize>('SIZE_560_670')
  const [returnSizeModReason, setReturnSizeModReason] = useState<
    '' | 'alternate_machine' | 'edge_damage' | 'prepress_error'
  >('')
  const [returnSizeRemarks, setReturnSizeRemarks] = useState('')

  const [triageSearch, setTriageSearch] = useState('')
  const [ctpSearch, setCtpSearch] = useState('')
  const [vendorSearch, setVendorSearch] = useState('')
  const [invSearch, setInvSearch] = useState('')
  const [custSearch, setCustSearch] = useState('')

  const [hubView, setHubView] = useState<'board' | 'table'>('board')
  const [ledgerZoneFilter, setLedgerZoneFilter] = useState('')
  const [ledgerSizeFilter, setLedgerSizeFilter] = useState('')
  const [ledgerSearch, setLedgerSearch] = useState('')
  const ledgerSizeOptions = useMemo(() => LedgerSizeFilterOptions(), [])

  const [stockModal, setStockModal] = useState<TriageRow | null>(null)
  /** Per plate-store id → per submitKey checkbox */
  const [stockBatchPick, setStockBatchPick] = useState<Record<string, Record<string, boolean>>>({})

  const [adjustPlatesJob, setAdjustPlatesJob] = useState<CtpRow | null>(null)

  const [addStockFieldErrors, setAddStockFieldErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const mergeQueueJobPatch = useCallback((jobId: string, patch: ShopfloorSpecPatch) => {
    setData((d) => ({
      ...d,
      ctpQueue: d.ctpQueue.map((j) => (j.id === jobId ? { ...j, ...patch } : j)),
      vendorQueue: d.vendorQueue.map((j) => (j.id === jobId ? { ...j, ...patch } : j)),
      ledgerRows: d.ledgerRows.map((r) => {
        if (r.entity !== 'requirement' || r.id !== jobId) return r
        if (r.zoneKey !== 'ctp_queue' && r.zoneKey !== 'outside_vendor') return r
        const nextColours = patch.plateColours ?? r.plateColours
        const nextVol =
          patch.shopfloorActiveColourCount !== undefined
            ? patch.shopfloorActiveColourCount
            : r.coloursRequired
        return {
          ...r,
          plateColours: nextColours,
          coloursRequired: nextVol,
        }
      }),
    }))
  }, [])

  const [manualCtpOpen, setManualCtpOpen] = useState(false)
  const [mCtpQuery, setMCtpQuery] = useState('')
  const [mCtpResults, setMCtpResults] = useState<CartonSearchHit[]>([])
  const [mCtpLoading, setMCtpLoading] = useState(false)
  const [mCtpSelected, setMCtpSelected] = useState<CartonSearchHit | null>(null)
  const [mCtpC, setMCtpC] = useState(true)
  const [mCtpM, setMCtpM] = useState(true)
  const [mCtpY, setMCtpY] = useState(true)
  const [mCtpK, setMCtpK] = useState(true)
  const [mCtpPantone, setMCtpPantone] = useState(false)
  const [mCtpPantoneN, setMCtpPantoneN] = useState(1)
  const [mCtpPlateSize, setMCtpPlateSize] = useState<HubPlateSize>('SIZE_560_670')
  const [mvPlateSize, setMvPlateSize] = useState<HubPlateSize>('SIZE_560_670')
  const [addStockPlateSize, setAddStockPlateSize] = useState<HubPlateSize>('SIZE_560_670')
  const [triageSizeModal, setTriageSizeModal] = useState<{
    rowId: string
    channel: 'inhouse_ctp' | 'outside_vendor'
  } | null>(null)
  const [triagePlateSizePick, setTriagePlateSizePick] = useState<HubPlateSize>('SIZE_560_670')

  const [remakePlate, setRemakePlate] = useState<PlateCard | null>(null)
  const [remakeLane, setRemakeLane] = useState<'inhouse_ctp' | 'outside_vendor'>('inhouse_ctp')
  const [remakePick, setRemakePick] = useState<Record<string, boolean>>({})

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try {
      const dRes = await fetch('/api/plate-hub/dashboard')
      const dText = await dRes.text()

      const parsed = safeReadDashboard(dText)
      if (!parsed) {
        toast.error('Unexpected dashboard response')
        setData({
          triage: [],
          ctpQueue: [],
          vendorQueue: [],
          inventory: [],
          custody: [],
          ledgerRows: [],
        })
      } else {
        setData(parsed)
      }
      if (!dRes.ok) {
        try {
          const err = safeJsonParse<{ error?: string }>(dText, {})
          toast.error(err.error ?? `Dashboard load failed (${dRes.status})`)
        } catch {
          toast.error(`Dashboard load failed (${dRes.status})`)
        }
      }
    } catch (e) {
      console.error(e)
      toast.error('Failed to load plate hub')
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onPri = () => void load({ silent: true })
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [load])

  const plateIntelKpis = useMemo(() => {
    if (!data) {
      return { active: 0, pending: 0, bottlenecks: 0, leadDays: 0, priLedger: 0 }
    }
    const prep = [...data.triage, ...data.ctpQueue, ...data.vendorQueue]
    const active = prep.length
    const pending = data.triage.length
    const bottlenecks = prep.filter((r) => plateStageHoursPlateHub(r.lastStatusUpdatedAt) > 24).length
    const leadHours =
      prep.length === 0
        ? 0
        : prep.reduce(
            (s, r) =>
              s +
              plateStageHoursPlateHub(
                (r as { ledgerEntryAt?: string }).ledgerEntryAt ?? r.lastStatusUpdatedAt,
              ),
            0,
          ) / prep.length
    return {
      active,
      pending,
      bottlenecks,
      leadDays: leadHours / 24,
      priLedger: data.ledgerRows.filter((r) => r.industrialPriority === true).length,
    }
  }, [data])

  useEffect(() => {
    if (!addStockOpen) return
    const q = addCartonQuery.trim()
    if (q.length < 2) {
      setAddCartonResults([])
      return
    }
    if (cartonSearchTimerRef.current) clearTimeout(cartonSearchTimerRef.current)
    cartonSearchTimerRef.current = setTimeout(() => {
      void (async () => {
        setAddCartonLoading(true)
        try {
          const r = await fetch(`/api/plate-hub/cartons-search?q=${encodeURIComponent(q)}`)
          const list = safeJsonParseArray<CartonSearchHit>(await r.text(), [])
          setAddCartonResults(Array.isArray(list) ? list : [])
        } catch {
          setAddCartonResults([])
        } finally {
          setAddCartonLoading(false)
        }
      })()
    }, 300)
    return () => {
      if (cartonSearchTimerRef.current) clearTimeout(cartonSearchTimerRef.current)
    }
  }, [addStockOpen, addCartonQuery])

  useEffect(() => {
    if (!manualCtpOpen) return
    const q = mCtpQuery.trim()
    if (q.length < 2) {
      setMCtpResults([])
      return
    }
    if (mCtpSearchTimerRef.current) clearTimeout(mCtpSearchTimerRef.current)
    mCtpSearchTimerRef.current = setTimeout(() => {
      void (async () => {
        setMCtpLoading(true)
        try {
          const r = await fetch(`/api/plate-hub/cartons-search?q=${encodeURIComponent(q)}`)
          const list = safeJsonParseArray<CartonSearchHit>(await r.text(), [])
          setMCtpResults(Array.isArray(list) ? list : [])
        } catch {
          setMCtpResults([])
        } finally {
          setMCtpLoading(false)
        }
      })()
    }, 300)
    return () => {
      if (mCtpSearchTimerRef.current) clearTimeout(mCtpSearchTimerRef.current)
    }
  }, [manualCtpOpen, mCtpQuery])

  useEffect(() => {
    if (!manualVendorOpen) return
    const q = mvQuery.trim()
    if (q.length < 2) {
      setMvResults([])
      return
    }
    if (mvSearchTimerRef.current) clearTimeout(mvSearchTimerRef.current)
    mvSearchTimerRef.current = setTimeout(() => {
      void (async () => {
        setMvLoading(true)
        try {
          const r = await fetch(`/api/plate-hub/cartons-search?q=${encodeURIComponent(q)}`)
          const list = safeJsonParseArray<CartonSearchHit>(await r.text(), [])
          setMvResults(Array.isArray(list) ? list : [])
        } catch {
          setMvResults([])
        } finally {
          setMvLoading(false)
        }
      })()
    }, 300)
    return () => {
      if (mvSearchTimerRef.current) clearTimeout(mvSearchTimerRef.current)
    }
  }, [manualVendorOpen, mvQuery])

  useEffect(() => {
    if (!scrapModal) return
    const next: Record<string, boolean> = {}
    for (const n of scrapModal.colourNames) next[n] = false
    setScrapChannelPick(next)
    setScrapReasonCode('')
  }, [scrapModal])

  useEffect(() => {
    if (!returnAuditModal) return
    const next: Record<string, boolean> = {}
    for (const n of returnAuditModal.colourNames) next[n] = true
    setReturnAuditPick(next)
    setReturnAuditOrigin(defaultFirstOriginFromCustody(returnAuditModal.custodySource))
    setReturnAuditStep(1)
    const ps = returnAuditModal.plateSize
    const orig =
      ps && (HUB_PLATE_SIZE_VALUES as readonly string[]).includes(ps) ? ps : 'SIZE_560_670'
    setReturnSizeOriginal(orig)
    setReturnSizePick(orig)
    setReturnSizeModReason('')
    setReturnSizeRemarks('')
  }, [returnAuditModal])

  useEffect(() => {
    if (!remakePlate) return
    const names = remakePlate.colourChannelNames?.length
      ? remakePlate.colourChannelNames
      : remakePlate.plateColours ?? []
    const next: Record<string, boolean> = {}
    for (const n of names) next[n] = false
    setRemakePick(next)
  }, [remakePlate])

  const addStockTotalPlates = useMemo(() => {
    let n = 0
    if (stdC) n += 1
    if (stdM) n += 1
    if (stdY) n += 1
    if (stdK) n += 1
    if (pantoneOn) n += Math.max(0, Math.min(12, Math.floor(Number(pantoneCount) || 0)))
    return n
  }, [stdC, stdM, stdY, stdK, pantoneOn, pantoneCount])

  function resetAddStockForm() {
    setAddCartonQuery('')
    setAddCartonResults([])
    setAddSelectedCarton(null)
    setAddAwCode('')
    setAddSerial('')
    setAddAutoSerial(true)
    setAddOutputNumber('')
    setAddRackNumber('')
    setAddUps('')
    setAddArtworkId('')
    setStdC(true)
    setStdM(true)
    setStdY(true)
    setStdK(true)
    setPantoneOn(false)
    setPantoneCount(1)
    setAddStockFieldErrors({})
    setAddStockPlateSize('SIZE_560_670')
  }

  function applyCartonSelection(hit: CartonSearchHit) {
    setAddSelectedCarton(hit)
    setAddCartonQuery(hit.cartonName)
    setAddCartonResults([])
    setAddAwCode(hit.artworkCode?.trim() || '')
    setAddUps(hit.ups != null && hit.ups > 0 ? String(hit.ups) : '')
    setAddArtworkId('')
    setAddStockPlateSize(hit.plateSize ?? 'SIZE_560_670')
  }

  async function recallPrepress(requirementId: string) {
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/recall-prepress`, {
        method: 'POST',
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string; warning?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Recall failed')
        return
      }
      if (j.warning) {
        toast.warning(j.warning, { duration: 6500 })
      } else {
        toast.success('Recalled to pre-press')
      }
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function sendBackTriage(requirementId: string) {
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/send-back-triage`, {
        method: 'POST',
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Send back failed')
        return
      }
      toast.success('Sent back to triage')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function sendVendorBackTriage(requirementId: string) {
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/vendor-send-back-triage`, {
        method: 'POST',
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Send back failed')
        return
      }
      toast.success('Returned to triage (vendor path cleared)')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function patchIncomingTriagePlateSize(requirementId: string, plateSize: HubPlateSize) {
    if (!requirementId?.trim()) return
    let revertPlateSize: HubPlateSize | null | undefined
    let shouldPatch = false
    setData((prev) => {
      const row = prev.triage.find((r) => r.id === requirementId)
      if (!row || row.plateSize === plateSize) return prev
      revertPlateSize = row.plateSize
      shouldPatch = true
      return {
        ...prev,
        triage: prev.triage.map((r) =>
          r.id === requirementId ? { ...r, plateSize } : r,
        ),
      }
    })
    if (!shouldPatch) return

    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/plate-size`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ plateSize }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        setData((prev) => ({
          ...prev,
          triage: prev.triage.map((row) =>
            row.id === requirementId ? { ...row, plateSize: revertPlateSize ?? null } : row,
          ),
        }))
        toast.error(j.error ?? 'Could not update size')
        return
      }
      const mm = HUB_PLATE_SIZE_OPTIONS.find((o) => o.value === plateSize)?.mm ?? plateSize
      toast.success(`Size updated to ${mm}`, { duration: 2000 })
    } catch (e) {
      console.error(e)
      setData((prev) => ({
        ...prev,
        triage: prev.triage.map((row) =>
          row.id === requirementId ? { ...row, plateSize: revertPlateSize ?? null } : row,
        ),
      }))
      toast.error(e instanceof Error ? e.message : 'Could not update size')
    } finally {
      setSaving(false)
    }
  }

  function buildAddStockColours(): { name: string; type: string; status: 'new' }[] {
    const colours: { name: string; type: string; status: 'new' }[] = []
    if (stdC) colours.push({ name: 'Cyan', type: 'process', status: 'new' })
    if (stdM) colours.push({ name: 'Magenta', type: 'process', status: 'new' })
    if (stdY) colours.push({ name: 'Yellow', type: 'process', status: 'new' })
    if (stdK) colours.push({ name: 'Black', type: 'process', status: 'new' })
    if (pantoneOn) {
      const n = Math.max(1, Math.min(12, Math.floor(Number(pantoneCount) || 0)))
      for (let i = 1; i <= n; i += 1) {
        colours.push({ name: `Pantone ${i}`, type: 'pantone', status: 'new' })
      }
    }
    return colours
  }

  async function submitAddStock() {
    setAddStockFieldErrors({})
    if (!addSelectedCarton) {
      toast.error('Select a carton from the search results')
      return
    }
    const aw = addAwCode.trim()
    if (!aw) {
      toast.error('AW code is required')
      return
    }
    if (!addAutoSerial) {
      const sn = addSerial.trim()
      if (!sn) {
        toast.error('Serial number is required when auto-generate is off')
        setAddStockFieldErrors({ serialNumber: 'Required when auto-generate is off' })
        return
      }
    }
    const colours = buildAddStockColours()
    if (!colours.length) {
      toast.error('Select at least one colour (C/M/Y/K or Pantone)')
      return
    }
    let ups: number | null = null
    if (addUps.trim()) {
      const u = parseInt(addUps, 10)
      if (!Number.isFinite(u) || u < 1) {
        toast.error('No. of UPS must be a positive whole number')
        setAddStockFieldErrors({ ups: 'Must be a positive integer' })
        return
      }
      ups = u
    }

    setSaving(true)
    try {
      const r = await fetch('/api/plate-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          cartonName: addSelectedCarton.cartonName,
          artworkCode: aw,
          customerId: addSelectedCarton.customerId,
          cartonId: addSelectedCarton.id,
          artworkId: addArtworkId.trim() || null,
          autoGenerateSerial: addAutoSerial,
          serialNumber: addAutoSerial ? null : addSerial.trim(),
          outputNumber: addOutputNumber.trim() || null,
          rackNumber: addRackNumber.trim() || null,
          ups,
          numberOfColours: colours.length,
          colours,
          rackLocation: addRackNumber.trim() || null,
          plateSize: addStockPlateSize,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string; fields?: Record<string, string> }>(t, {})
      if (!r.ok) {
        if (j.fields && typeof j.fields === 'object') setAddStockFieldErrors(j.fields)
        const firstField =
          j.fields && typeof j.fields === 'object'
            ? Object.values(j.fields).find(Boolean)
            : undefined
        toast.error(
          firstField ||
            j.error ||
            (t.trim() && !t.trim().startsWith('{') ? t.slice(0, 120) : null) ||
            `Save failed (${r.status})`,
        )
        return
      }
      toast.success('Saved to rack')
      setAddStockOpen(false)
      resetAddStockForm()
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Save failed — check connection and try again')
    } finally {
      setSaving(false)
    }
  }

  function custodyItemFromRequirement(row: CtpRow, source: 'ctp' | 'vendor'): CustodyCard {
    const now = new Date().toISOString()
    return {
      kind: 'requirement',
      id: row.id,
      displayCode: row.requirementCode,
      cartonName: row.cartonName,
      artworkCode: row.artworkCode,
      artworkVersion: row.artworkVersion,
      plateColours: row.plateColours,
      custodySource: source,
      numberOfColours: row.numberOfColours,
      newPlatesNeeded: row.newPlatesNeeded,
      partialRemake: row.partialRemake,
      lastStatusUpdatedAt: now,
      jobCardId: row.jobCardId ?? null,
      jobCardHub: null,
      plateSize: row.plateSize ?? null,
    }
  }

  function custodyItemFromPlate(row: PlateCard): CustodyCard {
    const now = new Date().toISOString()
    return {
      kind: 'plate',
      id: row.id,
      displayCode: row.plateSetCode,
      cartonName: row.cartonName,
      artworkCode: row.artworkCode,
      artworkVersion: row.artworkVersion,
      plateColours: row.plateColours ?? [],
      colourChannelNames: row.colourChannelNames,
      platesInRackCount: row.platesInRackCount,
      custodySource: 'rack',
      serialNumber: row.serialNumber,
      rackNumber: row.rackNumber,
      rackLocation: row.rackLocation,
      ups: row.ups,
      customer: row.customer,
      numberOfColours: row.numberOfColours,
      totalPlates: row.totalPlates,
      artworkId: row.artworkId,
      jobCardId: row.jobCardId,
      slotNumber: row.slotNumber,
      lastStatusUpdatedAt: now,
      jobCardHub: null,
      plateSize: row.plateSize ?? null,
      cycleData: row.cycleData,
    }
  }

  async function markPlateReadyRequirement(row: CtpRow, lane: 'ctp' | 'vendor') {
    const inactive = new Set(row.shopfloorInactiveCanonicalKeys ?? [])
    const activePlateColours = row.plateColours.filter(
      (l) => !inactive.has(plateColourCanonicalKey(stripPlateColourDisplaySuffix(l))),
    )
    if (activePlateColours.length < 1) {
      toast.error('At least one colour must be active for burning')
      return
    }
    const mm =
      HUB_PLATE_SIZE_OPTIONS.find((o) => o.value === (row.plateSize ?? 'SIZE_560_670'))?.mm ??
      String(row.plateSize ?? '—')
    const confirmMsg = `Confirming ${activePlateColours.length} plates (${activePlateColours.join(', ')}) at ${mm} mm.`
    if (!window.confirm(confirmMsg)) return

    const prev = data
    const n = activePlateColours.length
    const slim: CtpRow = {
      ...row,
      plateColours: activePlateColours,
      numberOfColours: n,
      newPlatesNeeded: n,
      shopfloorInactiveCanonicalKeys: [],
      shopfloorActiveColourCount: n,
    }
    const nextCustody = custodyItemFromRequirement(slim, lane)
    setData((d) => ({
      ...d,
      ctpQueue: lane === 'ctp' ? d.ctpQueue.filter((j) => j.id !== row.id) : d.ctpQueue,
      vendorQueue: lane === 'vendor' ? d.vendorQueue.filter((j) => j.id !== row.id) : d.vendorQueue,
      custody: [nextCustody, ...d.custody],
    }))
    try {
      const r = await fetch('/api/plate-hub/mark-plate-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          kind: 'requirement',
          id: row.id,
          ...(row.plateSize ? { plateSize: row.plateSize } : {}),
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Mark ready failed')
      toast.success('Moved to custody floor')
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      setData(prev)
      toast.error(e instanceof Error ? e.message : 'Mark ready failed')
    }
  }

  async function markPlateReadyPlate(row: PlateCard) {
    const prev = data
    setData((d) => ({
      ...d,
      inventory: d.inventory.filter((p) => p.id !== row.id),
      custody: [custodyItemFromPlate(row), ...d.custody],
    }))
    try {
      const r = await fetch('/api/plate-hub/mark-plate-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ kind: 'plate', id: row.id }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Mark ready failed')
      toast.success('Moved to custody floor')
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      setData(prev)
      toast.error(e instanceof Error ? e.message : 'Mark ready failed')
    }
  }

  async function reverseCustodyItem(item: CustodyCard) {
    const prev = data
    if (item.kind === 'requirement') {
      const restored: CtpRow = {
        id: item.id,
        poLineId: null,
        requirementCode: item.displayCode,
        jobCardId: item.jobCardId ?? null,
        cartonName: item.cartonName,
        artworkCode: item.artworkCode,
        artworkVersion: item.artworkVersion,
        plateColours: item.plateColours,
        status:
          item.custodySource === 'vendor' ? 'awaiting_vendor_delivery' : 'ctp_internal_queue',
        numberOfColours: item.numberOfColours,
        newPlatesNeeded: item.newPlatesNeeded,
        partialRemake: item.partialRemake,
        lastStatusUpdatedAt: new Date().toISOString(),
        plateSize: item.plateSize ?? null,
        shopfloorInactiveCanonicalKeys: [],
        shopfloorActiveColourCount: Math.max(
          item.plateColours.length,
          item.newPlatesNeeded ?? 0,
          item.numberOfColours ?? 0,
        ),
      }
      setData((d) => ({
        ...d,
        custody: d.custody.filter((c) => c.id !== item.id),
        ctpQueue:
          item.custodySource === 'ctp' ? [restored, ...d.ctpQueue] : d.ctpQueue,
        vendorQueue:
          item.custodySource === 'vendor' ? [restored, ...d.vendorQueue] : d.vendorQueue,
      }))
    } else {
      const restoredPlate: PlateCard = {
        id: item.id,
        plateSetCode: item.displayCode,
        serialNumber: item.serialNumber,
        outputNumber: null,
        rackNumber: item.rackNumber,
        ups: item.ups,
        cartonName: item.cartonName,
        artworkCode: item.artworkCode,
        artworkVersion: item.artworkVersion,
        artworkId: item.artworkId ?? null,
        jobCardId: item.jobCardId ?? null,
        slotNumber: item.slotNumber ?? null,
        rackLocation: item.rackLocation,
        status: 'ready',
        issuedTo: null,
        issuedAt: null,
        totalImpressions: 0,
        customer: item.customer ?? null,
        plateColours: item.plateColours,
        colourChannelNames: item.colourChannelNames,
        platesInRackCount: item.platesInRackCount,
        numberOfColours: item.numberOfColours,
        totalPlates: item.totalPlates,
        lastStatusUpdatedAt: new Date().toISOString(),
        plateSize: item.plateSize ?? null,
      }
      setData((d) => ({
        ...d,
        custody: d.custody.filter((c) => c.id !== item.id),
        inventory: [restoredPlate, ...d.inventory],
      }))
    }
    try {
      const r = await fetch('/api/plate-hub/reverse-plate-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ kind: item.kind, id: item.id }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Reverse failed')
      toast.success('Returned to previous lane')
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      setData(prev)
      toast.error(e instanceof Error ? e.message : 'Reverse failed')
    }
  }

  function resetManualCtpForm() {
    setMCtpQuery('')
    setMCtpResults([])
    setMCtpSelected(null)
    setMCtpC(true)
    setMCtpM(true)
    setMCtpY(true)
    setMCtpK(true)
    setMCtpPantone(false)
    setMCtpPantoneN(1)
    setMCtpPlateSize('SIZE_560_670')
  }

  function resetManualVendorForm() {
    setMvQuery('')
    setMvResults([])
    setMvSelected(null)
    setMvC(true)
    setMvM(true)
    setMvY(true)
    setMvK(true)
    setMvPantone(false)
    setMvPantoneN(1)
    setMvPlateSize('SIZE_560_670')
  }

  async function submitManualCtpRequest() {
    if (!mCtpSelected) {
      toast.error('Select a carton')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/plate-hub/manual-ctp-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          cartonId: mCtpSelected.id,
          plateSize: mCtpPlateSize,
          stdC: mCtpC,
          stdM: mCtpM,
          stdY: mCtpY,
          stdK: mCtpK,
          pantoneOn: mCtpPantone,
          ...(mCtpPantone ? { pantoneCount: mCtpPantoneN } : {}),
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Request failed')
      toast.success('Manual CTP job created')
      setManualCtpOpen(false)
      resetManualCtpForm()
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      toast.error(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitManualVendorRequest() {
    if (!mvSelected) {
      toast.error('Select a carton')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/plate-hub/manual-vendor-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          cartonId: mvSelected.id,
          plateSize: mvPlateSize,
          stdC: mvC,
          stdM: mvM,
          stdY: mvY,
          stdK: mvK,
          pantoneOn: mvPantone,
          ...(mvPantone ? { pantoneCount: mvPantoneN } : {}),
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Request failed')
      toast.success('Manual vendor PO created')
      setManualVendorOpen(false)
      resetManualVendorForm()
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      toast.error(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitScrapPlateChannels() {
    if (!scrapModal) return
    const picked = Object.entries(scrapChannelPick)
      .filter(([, v]) => v)
      .map(([k]) => k)
    if (!picked.length) {
      toast.error('Select at least one plate channel to scrap')
      return
    }
    if (!scrapReasonCode) {
      toast.error('Select a scrap reason')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/plate-hub/scrap-plate-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          plateStoreId: scrapModal.plateStoreId,
          colourNames: picked,
          reasonCode: scrapReasonCode,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Scrap failed')
      toast.success('Scrap recorded')
      setScrapModal(null)
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      toast.error(e instanceof Error ? e.message : 'Scrap failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitReturnToRack() {
    if (!returnAuditModal) return
    const returned =
      returnAuditModal.colourNames.length === 0
        ? []
        : Object.entries(returnAuditPick)
            .filter(([, v]) => v)
            .map(([k]) => k)
    if (returnAuditModal.colourNames.length > 0 && !returned.length) {
      toast.error('Select at least one plate returning to rack')
      return
    }
    if (returnSizePick !== returnSizeOriginal && !returnSizeModReason) {
      toast.error('Select a reason for the size modification')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/plate-hub/return-to-rack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          ...(returnAuditModal.kind === 'plate'
            ? { plateStoreId: returnAuditModal.plateStoreId }
            : { requirementId: returnAuditModal.requirementId }),
          returnedColourNames: returned,
          firstOrigin: returnAuditOrigin,
          targetPlateSize: returnSizePick,
          ...(returnSizePick !== returnSizeOriginal
            ? {
                sizeModificationReason: returnSizeModReason,
                ...(returnSizeRemarks.trim()
                  ? { sizeModificationRemarks: returnSizeRemarks.trim() }
                  : {}),
              }
            : {}),
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Return failed')
      toast.success('Return to rack recorded')
      setReturnAuditModal(null)
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      toast.error(e instanceof Error ? e.message : 'Return failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitPartialRemake() {
    if (!remakePlate) return
    const missing = Object.entries(remakePick)
      .filter(([, v]) => v)
      .map(([k]) => k)
    if (!missing.length) {
      toast.error('Select at least one missing or damaged plate')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/plate-hub/partial-remake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          plateStoreId: remakePlate.id,
          lane: remakeLane,
          missingColourNames: missing,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Remake request failed')
      toast.success(
        remakeLane === 'inhouse_ctp' ? 'Partial remake sent to CTP' : 'Partial remake sent to vendor',
      )
      setRemakePlate(null)
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      toast.error(e instanceof Error ? e.message : 'Remake request failed')
    } finally {
      setSaving(false)
    }
  }

  const filteredInventory = useMemo(() => {
    const q = invSearch.trim().toLowerCase()
    const list = data.inventory
    if (!q) return list
    return list.filter(
      (p) =>
        p.plateSetCode.toLowerCase().includes(q) ||
        p.cartonName.toLowerCase().includes(q) ||
        (p.artworkCode?.toLowerCase().includes(q) ?? false) ||
        (p.serialNumber?.toLowerCase().includes(q) ?? false),
    )
  }, [data.inventory, invSearch])

  /** One-pass index: Live Inventory plate cards → triage row (carton name or AW code). */
  const stockModalPlateOptions = useMemo(() => {
    if (!stockModal) return []
    const jobAw = stockModal.artworkCode?.trim()
    if (jobAw) {
      const aw = normHubKey(stockModal.artworkCode)
      return data.inventory.filter((p) => normHubKey(p.artworkCode) === aw)
    }
    const carton = normHubKey(stockModal.cartonName)
    return data.inventory.filter((p) => normHubKey(p.cartonName) === carton)
  }, [stockModal, data.inventory])

  const jobNeededCanons = useMemo(() => {
    if (!stockModal) return new Set<string>()
    return new Set(
      stockModal.plateColours
        .map((l) => plateColourCanonicalKey(stripPlateColourDisplaySuffix(l)))
        .filter((k): k is string => Boolean(k)),
    )
  }, [stockModal])

  useEffect(() => {
    if (stockModal) setStockBatchPick({})
  }, [stockModal?.id])

  const stockBatchSelectionSummary = useMemo(() => {
    if (!stockModal) {
      return {
        selections: [] as { plateStoreId: string; colourNames: string[] }[],
        channelCount: 0,
        selectedCanonSet: new Set<string>(),
      }
    }
    const selections: { plateStoreId: string; colourNames: string[] }[] = []
    let channelCount = 0
    const selectedCanonSet = new Set<string>()
    for (const p of stockModalPlateOptions) {
      const picks = stockBatchPick[p.id]
      if (!picks) continue
      const names: string[] = []
      for (const { submitKey, displayLabel } of stockPullChannelRows(p)) {
        if (!picks[submitKey]) continue
        if (!stockChannelCanonInSet(displayLabel, jobNeededCanons)) continue
        const k = plateColourCanonicalKey(stripPlateColourDisplaySuffix(displayLabel))
        if (k) selectedCanonSet.add(k)
        names.push(submitKey)
      }
      if (names.length) {
        selections.push({ plateStoreId: p.id, colourNames: names })
        channelCount += names.length
      }
    }
    return { selections, channelCount, selectedCanonSet }
  }, [stockModal, stockModalPlateOptions, stockBatchPick, jobNeededCanons])

  const triageRackStockById = useMemo(() => {
    const inv = data.inventory
    const byCarton = new Map<string, PlateCard[]>()
    const byAw = new Map<string, PlateCard[]>()
    for (const p of inv) {
      const c = normHubKey(p.cartonName)
      if (c) {
        const arr = byCarton.get(c) ?? []
        arr.push(p)
        byCarton.set(c, arr)
      }
      const aw = p.artworkCode?.trim()
      if (aw) {
        const k = normHubKey(aw)
        const arr = byAw.get(k) ?? []
        arr.push(p)
        byAw.set(k, arr)
      }
    }
    const map = new Map<string, TriageStockInfo>()
    for (const row of data.triage) {
      const cartonKey = normHubKey(row.cartonName)
      const awKey = row.artworkCode?.trim() ? normHubKey(row.artworkCode) : ''
      const seen = new Set<string>()
      const matches: PlateCard[] = []
      for (const p of byCarton.get(cartonKey) ?? []) {
        if (!seen.has(p.id)) {
          seen.add(p.id)
          matches.push(p)
        }
      }
      if (awKey) {
        for (const p of byAw.get(awKey) ?? []) {
          if (!seen.has(p.id)) {
            seen.add(p.id)
            matches.push(p)
          }
        }
      }
      if (matches.length === 0) {
        map.set(row.id, { matchCount: 0, labels: [], locationLabel: null })
        continue
      }
      const labelSet = new Set<string>()
      const locs = new Set<string>()
      for (const p of matches) {
        for (const lab of p.plateColours ?? []) {
          const t = String(lab ?? '').trim()
          if (t) labelSet.add(t)
        }
        const loc = formatPlateCardRackLocation(p)
        if (loc) locs.add(loc)
      }
      const labels = sortUnionStockLabels(labelSet)
      let locationLabel: string | null = null
      const locArr = Array.from(locs)
      if (locArr.length === 1) locationLabel = locArr[0]
      else if (locArr.length > 1) locationLabel = `${locArr[0]} +${locArr.length - 1}`
      map.set(row.id, { matchCount: matches.length, labels, locationLabel })
    }
    return map
  }, [data.inventory, data.triage])

  const filteredTriageBoard = useMemo(() => {
    const q = triageSearch.trim().toLowerCase()
    let list = data.triage
    if (q) {
      list = data.triage.filter((row) =>
        hubSearchMatch(q, [
          row.cartonName,
          row.artworkCode,
          row.requirementCode,
          row.poNumber,
          ...(row.linkedCustomerNames ?? []),
        ]),
      )
    }
    return sortPlatePrepRows(list)
  }, [data.triage, triageSearch])

  const filteredCtp = useMemo(() => {
    const q = ctpSearch.trim().toLowerCase()
    let list = data.ctpQueue
    if (q) {
      list = data.ctpQueue.filter((job) =>
        hubSearchMatch(q, [
          job.cartonName,
          job.artworkCode,
          job.requirementCode,
          job.poNumber,
          ...(job.linkedCustomerNames ?? []),
        ]),
      )
    }
    return sortPlatePrepRows(list)
  }, [data.ctpQueue, ctpSearch])

  const filteredVendor = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase()
    let list = data.vendorQueue
    if (q) {
      list = data.vendorQueue.filter((job) =>
        hubSearchMatch(q, [
          job.cartonName,
          job.artworkCode,
          job.requirementCode,
          job.poNumber,
          ...(job.linkedCustomerNames ?? []),
        ]),
      )
    }
    return sortPlatePrepRows(list)
  }, [data.vendorQueue, vendorSearch])

  const filteredCustody = useMemo(() => {
    const q = custSearch.trim().toLowerCase()
    const list = data.custody
    if (!q) return list
    return list.filter((c) =>
      hubSearchMatch(q, [c.cartonName, c.artworkCode, c.displayCode]),
    )
  }, [data.custody, custSearch])

  const triageZoneMetrics = useMemo(
    () => calculateZoneMetrics(filteredTriageBoard, hubZonePlateVolumeTriage),
    [filteredTriageBoard],
  )
  const ctpZoneMetrics = useMemo(
    () => calculateZoneMetrics(filteredCtp, hubZonePlateVolumeShopfloorJob),
    [filteredCtp],
  )
  const vendorZoneMetrics = useMemo(
    () => calculateZoneMetrics(filteredVendor, hubZonePlateVolumeShopfloorJob),
    [filteredVendor],
  )
  const inventoryZoneMetrics = useMemo(
    () => calculateZoneMetrics(filteredInventory, hubZonePlateVolumeInventoryCard),
    [filteredInventory],
  )
  const custodyZoneMetrics = useMemo(
    () => calculateZoneMetrics(filteredCustody, hubZonePlateVolumeCustodyCard),
    [filteredCustody],
  )

  const filteredLedgerForSummary = useMemo(
    () =>
      getFilteredMasterLedgerRows(
        data.ledgerRows,
        ledgerSearch,
        ledgerZoneFilter,
        ledgerSizeFilter,
      ),
    [data.ledgerRows, ledgerSearch, ledgerZoneFilter, ledgerSizeFilter],
  )
  const plateLedgerExportColumns = useMemo(() => plateMasterLedgerExportColumns(), [])
  const plateLedgerExcelExtraColumns = useMemo(() => plateMasterLedgerExcelExtraColumns(), [])
  const plateLedgerExportFilterSummary = useMemo(() => {
    const parts: string[] = []
    if (ledgerZoneFilter) {
      const o = LEDGER_ZONE_FILTER_OPTIONS.find((x) => x.value === ledgerZoneFilter)
      parts.push(o ? `Zone: ${o.label}` : `Zone: ${ledgerZoneFilter}`)
    }
    if (ledgerSizeFilter) {
      const o = ledgerSizeOptions.find((x) => x.value === ledgerSizeFilter)
      parts.push(o ? `Plate size: ${o.label}` : `Plate size: ${ledgerSizeFilter}`)
    }
    if (ledgerSearch.trim()) parts.push(`Search: "${ledgerSearch.trim()}"`)
    return parts
  }, [ledgerZoneFilter, ledgerSizeFilter, ledgerSearch, ledgerSizeOptions])
  const ledgerFilteredTotals = useMemo(() => {
    let plates = 0
    for (const r of filteredLedgerForSummary) {
      plates += ledgerRowPlateVolume(r)
    }
    return { jobs: filteredLedgerForSummary.length, plates }
  }, [filteredLedgerForSummary])

  function dispatchTriageToProduction(row: TriageRow, channel: 'inhouse_ctp' | 'outside_vendor') {
    const resolved = row.plateSize ?? row.cartonMasterPlateSize ?? null
    if (resolved) {
      void patchTriage(row.id, channel, resolved)
      return
    }
    setTriageSizeModal({ rowId: row.id, channel })
    setTriagePlateSizePick('SIZE_560_670')
  }

  async function patchTriage(
    id: string,
    channel: 'inhouse_ctp' | 'outside_vendor' | 'stock_available',
    plateSize?: HubPlateSize,
  ) {
    if (!id?.trim()) {
      toast.error('Missing requirement id')
      return
    }
    setSaving(true)
    try {
      const body: Record<string, unknown> = { channel }
      if (
        (channel === 'inhouse_ctp' || channel === 'outside_vendor' || channel === 'stock_available') &&
        plateSize
      ) {
        body.plateSize = plateSize
      }
      const r = await fetch(`/api/plate-requirements/${id}/triage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify(body),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Triage update failed')
        return
      }
      toast.success('Updated')
      setStockModal(null)
      setStockBatchPick({})
      setTriageSizeModal(null)
      await load()
    } catch (e) {
      console.error(e)
      toast.error(
        e instanceof Error && e.message
          ? e.message
          : 'Triage update failed — check connection or try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function submitTakeFromStock() {
    if (!stockModal?.id) return
    const { selections, channelCount } = stockBatchSelectionSummary
    if (channelCount === 0 || selections.length === 0) {
      toast.error('Select at least one colour channel to pull from the rack')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/plate-hub/take-from-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          requirementId: stockModal.id,
          selections,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string; fulfilled?: boolean }>(t, {})
      if (!r.ok) {
        if (r.status === 409) {
          toast.error(j.error ?? 'Inventory changed — refresh and try again')
          await load({ silent: true })
          return
        }
        toast.error(j.error ?? `Failed to move inventory (${r.status})`)
        return
      }
      toast.success(
        j.fulfilled
          ? 'Moved to custody floor — triage job completed from rack'
          : 'Moved to custody floor — triage updated for remaining plates',
      )
      setStockModal(null)
      setStockBatchPick({})
      await load()
    } catch (e) {
      console.error(e)
      toast.error(
        e instanceof Error
          ? e.message
          : 'Failed to move inventory — network or server error.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-zinc-100 p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <HubCategoryNav active="plates" />

        <header className="flex flex-col gap-3 border-b border-zinc-700 pb-4">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Plate Hub</h1>
              <p className="text-sm text-zinc-400 mt-1">
                Preparation lanes → custody floor staging (mark ready). High-contrast layout for floor
                speed.
              </p>
            </div>
            <div
              className="flex rounded-lg border border-zinc-600 overflow-hidden p-0.5 bg-card/60 shrink-0"
              role="tablist"
              aria-label="Hub view"
            >
              <button
                type="button"
                role="tab"
                aria-selected={hubView === 'board'}
                onClick={() => setHubView('board')}
                className={`px-3 py-2 rounded-md text-xs font-bold transition-colors ${
                  hubView === 'board'
                    ? 'bg-amber-600 text-primary-foreground'
                    : 'text-zinc-400 hover:text-foreground hover:bg-zinc-800'
                }`}
              >
                📊 Board view
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={hubView === 'table'}
                onClick={() => setHubView('table')}
                className={`px-3 py-2 rounded-md text-xs font-bold transition-colors ${
                  hubView === 'table'
                    ? 'bg-amber-600 text-primary-foreground'
                    : 'text-zinc-400 hover:text-foreground hover:bg-zinc-800'
                }`}
              >
                ≡ Table view
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-4 pt-2">
            <IndustrialKpiTile
              label="Active (prep lanes)"
              value={plateIntelKpis.active}
              hint="Triage + CTP + vendor"
            />
            <IndustrialKpiTile label="Pending triage" value={plateIntelKpis.pending} hint="Awaiting channel" />
            <IndustrialKpiTile
              label="Bottlenecks >24h"
              value={plateIntelKpis.bottlenecks}
              hint="Stale status clock"
              valueClassName={plateIntelKpis.bottlenecks > 0 ? 'text-rose-300' : 'text-slate-100'}
            />
            <IndustrialKpiTile
              label="Avg lead (days)"
              value={plateIntelKpis.leadDays.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
              hint={`Ledger priority rows: ${plateIntelKpis.priLedger}`}
              valueClassName="text-amber-200/95"
            />
          </div>
        </header>

        {loading ? (
          <p className="text-zinc-500">Loading…</p>
        ) : hubView === 'table' ? (
          <div className="space-y-4">
            <div
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold tabular-nums"
              role="status"
            >
              <span className="text-zinc-300">
                Showing {ledgerFilteredTotals.jobs}{' '}
                {ledgerFilteredTotals.jobs === 1 ? 'job' : 'jobs'}
              </span>
              <span className="text-zinc-600 mx-1">·</span>
              <span>
                {ledgerFilteredTotals.plates} total plates across selected filters
              </span>
            </div>
            <div className="flex flex-col lg:flex-row flex-wrap gap-3 lg:items-end lg:justify-between">
              <div className="flex flex-col lg:flex-row flex-wrap gap-3 lg:items-end flex-1 min-w-0">
                <label className="block flex-1 min-w-[200px]">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                    Search (all columns)
                  </span>
                  <input
                    value={ledgerSearch}
                    onChange={(e) => setLedgerSearch(e.target.value)}
                    placeholder="Job ID, carton, AW code, zone…"
                    className="mt-1 w-full px-3 py-2 rounded-md bg-card border border-zinc-600 text-foreground text-sm placeholder:text-zinc-500"
                  />
                </label>
                <label className="block min-w-[180px]">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                    Zone
                  </span>
                  <select
                    value={ledgerZoneFilter}
                    onChange={(e) => setLedgerZoneFilter(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-card border border-zinc-600 text-foreground text-sm"
                  >
                    {LEDGER_ZONE_FILTER_OPTIONS.map((o) => (
                      <option key={o.value || 'all'} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block min-w-[160px]">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                    Plate size
                  </span>
                  <select
                    value={ledgerSizeFilter}
                    onChange={(e) => setLedgerSizeFilter(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-card border border-zinc-600 text-foreground text-sm"
                  >
                    {ledgerSizeOptions.map((o) => (
                      <option key={o.value || 'all-sz'} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <TableExportMenu
                rows={filteredLedgerForSummary}
                columns={plateLedgerExportColumns}
                excelOnlyColumns={plateLedgerExcelExtraColumns}
                fileBase="plate-hub-master-ledger"
                reportTitle="Plate Hub — Master ledger"
                sheetName="Plate Hub"
                filterSummary={plateLedgerExportFilterSummary}
                className="shrink-0"
              />
            </div>
            <MasterLedgerTable
              rows={data.ledgerRows}
              searchQuery={ledgerSearch}
              zoneFilter={ledgerZoneFilter}
              sizeFilter={ledgerSizeFilter}
              onOpenAudit={setJobAudit}
            />
          </div>
        ) : (
          <>
            {/* ZONE 1 — Triage */}
            <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3">
              <div className="flex flex-col gap-1 mb-2 min-w-0">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                  Incoming triage
                </h2>
                <ZoneCapacitySubheader
                  jobCount={triageZoneMetrics.jobCount}
                  plateCount={triageZoneMetrics.plateCount}
                />
              </div>
              <label className="block mb-2">
                <span className="sr-only">Search triage</span>
                <input
                  value={triageSearch}
                  onChange={(e) => setTriageSearch(e.target.value)}
                  placeholder="Customer, product, PO #, job code…"
                  className="w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground text-sm placeholder:text-zinc-500"
                />
              </label>
              <pre className="sr-only">Designer queue — AW / job codes</pre>
              <div className="space-y-3">
                {filteredTriageBoard.length === 0 ? (
                  <p className="text-zinc-500 text-sm">No jobs awaiting triage.</p>
                ) : (
                  filteredTriageBoard.map((row) => (
                    <div
                      key={row.id}
                      className={`relative flex flex-col gap-2 lg:flex-row lg:items-start lg:gap-3 rounded-lg border border-gray-800 bg-background p-3 overflow-hidden transition-colors hover:border-blue-500/50 ${
                        row.industrialPriority ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
                      }`}
                    >
                      <PlateCountBadge
                        count={hubPlateBadgeCount({
                          totalPlates: row.newPlatesNeeded,
                          plateColours: row.plateColours,
                        })}
                      />
                      <div className="flex-1 min-w-0 flex flex-col space-y-2 pr-10 lg:pr-11">
                        <p className="font-mono text-amber-300 text-sm">{row.requirementCode}</p>
                        <PlateHubStageDays lastStatusUpdatedAt={row.lastStatusUpdatedAt} />
                        <div className="min-w-0 w-full pr-8">
                          <HubCartonAuditTitle
                            onOpenAudit={() =>
                              setJobAudit({
                                entity: 'requirement',
                                id: row.id,
                                zoneLabel: 'Incoming triage',
                                cartonName: row.cartonName,
                                artworkCode: row.artworkCode,
                                displayCode: row.requirementCode,
                                poLineId: row.poLineId,
                                plateSize: row.plateSize ?? row.cartonMasterPlateSize ?? null,
                                plateColours: row.plateColours,
                                coloursRequired: Math.max(
                                  row.plateColours.length,
                                  row.newPlatesNeeded,
                                ),
                                platesInRackCount:
                                  triageRackStockById.get(row.id)?.matchCount ?? null,
                                statusLabel: row.status.replace(/_/g, ' '),
                              })
                            }
                          >
                            {row.cartonName}
                          </HubCartonAuditTitle>
                        </div>
                        <HubJobCardMetaLine>
                          Plates required:{' '}
                          <span className="text-foreground font-semibold tabular-nums">
                            {row.newPlatesNeeded}
                          </span>
                          {' · '}AW: {row.artworkCode?.trim() || '—'}
                          {row.purchaseOrderId && row.poNumber ? (
                            <>
                              {' · '}
                              <Link
                                href={`/orders/purchase-orders/${row.purchaseOrderId}`}
                                className="text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline font-medium"
                              >
                                PO {row.poNumber}
                              </Link>
                            </>
                          ) : row.poLinkHint === 'missing_row' ? (
                            <>
                              {' · '}
                              <span
                                className="inline-flex items-center text-amber-400/90 cursor-help select-none"
                                title="Linked PO line not found — may be deleted or archived"
                                aria-label="PO link broken"
                              >
                                ⚠️
                              </span>
                            </>
                          ) : row.poLinkHint === 'manual' ? (
                            <>
                              {' · '}
                              <span
                                className="inline-flex items-center text-zinc-500 cursor-help select-none"
                                title="No PO link - Manual Job"
                                aria-label="No PO link"
                              >
                                ⚠️
                              </span>
                            </>
                          ) : null}
                        </HubJobCardMetaLine>
                        <TriageInlinePlateSize
                          row={row}
                          disabled={saving}
                          onSizeChange={(id, ps) => void patchIncomingTriagePlateSize(id, ps)}
                        />
                        <div>
                          <ColourChannelsRow labels={row.plateColours} />
                        </div>
                        <TriageInventoryStockLine
                          stock={
                            triageRackStockById.get(row.id) ?? {
                              matchCount: 0,
                              labels: [],
                              locationLabel: null,
                            }
                          }
                        />
                        {row.lastStatusUpdatedAt ? (
                          <HubLastActionFooter at={row.lastStatusUpdatedAt} />
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => dispatchTriageToProduction(row, 'inhouse_ctp')}
                          className="px-3 py-2 rounded-md bg-amber-600 hover:bg-amber-500 text-primary-foreground text-sm font-semibold disabled:opacity-50"
                        >
                          In-house CTP
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => {
                            setStockModal(row)
                            setStockBatchPick({})
                          }}
                          className="px-3 py-2 rounded-md border border-zinc-500 bg-zinc-900 hover:bg-zinc-800 text-sm font-medium"
                        >
                          Take from stock
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => dispatchTriageToProduction(row, 'outside_vendor')}
                          className="px-3 py-2 rounded-md border border-zinc-600 text-zinc-300 hover:bg-zinc-900 text-sm"
                        >
                          Send to vendor
                        </button>
                        <button
                          type="button"
                          disabled={saving || row.status === 'plates_ready'}
                          title={
                            row.status === 'plates_ready'
                              ? 'Plates already marked ready — cannot recall'
                              : 'Send job back to designer queue'
                          }
                          onClick={() => void recallPrepress(row.id)}
                          className="px-3 py-2 rounded-md border border-rose-700/80 bg-rose-950/80 text-rose-100 hover:bg-rose-900 text-sm font-medium disabled:opacity-40"
                        >
                          Recall to Pre-Press
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Lanes: CTP · outside vendor · rack · custody */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 lg:gap-6 xl:min-h-[min(70vh,calc(100vh-14rem))] xl:items-stretch">
              {/* CTP */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 flex flex-col min-h-[280px] xl:min-h-0 xl:h-full">
                <div className="flex flex-col gap-2 mb-2 min-w-0">
                  <div className="flex flex-col gap-1 min-w-0">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                      CTP queue
                    </h2>
                    <ZoneCapacitySubheader
                      jobCount={ctpZoneMetrics.jobCount}
                      plateCount={ctpZoneMetrics.plateCount}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      resetManualCtpForm()
                      setManualCtpOpen(true)
                    }}
                    className="w-full px-3 py-2 rounded-md border border-amber-600/80 bg-amber-950/40 text-amber-100 text-xs font-bold hover:bg-amber-950/70 shrink-0"
                  >
                    + Manual CTP Request
                  </button>
                </div>
                <input
                  value={ctpSearch}
                  onChange={(e) => setCtpSearch(e.target.value)}
                  placeholder="Customer, product, PO #, job code…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 text-sm max-h-[min(26rem,calc(100vh-14rem))] xl:max-h-none">
                  {filteredCtp.length === 0 ? (
                    <li className="text-zinc-500 text-sm">Empty.</li>
                  ) : (
                    filteredCtp.map((job) => (
                      <li
                        key={job.id}
                        className={`relative flex flex-col space-y-2 rounded-lg border border-gray-800 bg-background p-3 overflow-hidden transition-colors hover:border-blue-500/50 pr-14 ${
                          job.industrialPriority ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
                        }`}
                      >
                        <ShopfloorPlateAdjustTrigger
                          disabled={saving}
                          onClick={() => setAdjustPlatesJob(job)}
                        />
                        <PlateCountBadge
                          count={
                            job.shopfloorActiveColourCount ??
                            hubPlateBadgeCount({
                              numberOfColours: job.numberOfColours,
                              plateColours: job.plateColours,
                              totalPlates: job.newPlatesNeeded,
                            })
                          }
                        />
                        <p className="font-mono text-amber-300 text-xs">{job.requirementCode}</p>
                        <PlateHubStageDays lastStatusUpdatedAt={job.lastStatusUpdatedAt} />
                        <div className="flex flex-wrap items-start gap-x-1 gap-y-0.5 min-w-0 w-full pr-8">
                          <HubCartonAuditTitle
                            className="!w-auto flex-1 min-w-0"
                            onOpenAudit={() => {
                              const inactive = new Set(job.shopfloorInactiveCanonicalKeys ?? [])
                              const activeOnly = job.plateColours.filter(
                                (l) =>
                                  !inactive.has(
                                    plateColourCanonicalKey(stripPlateColourDisplaySuffix(l)),
                                  ),
                              )
                              setJobAudit({
                                entity: 'requirement',
                                id: job.id,
                                zoneLabel: 'CTP queue',
                                cartonName: job.cartonName,
                                artworkCode: job.artworkCode,
                                displayCode: job.requirementCode,
                                poLineId: job.poLineId,
                                plateSize: job.plateSize ?? null,
                                plateColours: activeOnly.length ? activeOnly : job.plateColours,
                                coloursRequired:
                                  job.shopfloorActiveColourCount ??
                                  Math.max(
                                    job.plateColours.length,
                                    job.newPlatesNeeded ?? job.numberOfColours ?? 0,
                                  ),
                                platesInRackCount: null,
                                statusLabel: job.status.replace(/_/g, ' '),
                              })
                            }}
                          >
                            {job.cartonName}
                          </HubCartonAuditTitle>
                          {job.partialRemake ? (
                            <span className="text-rose-400 font-bold shrink-0 text-sm">(Remake)</span>
                          ) : null}
                        </div>
                        <HubJobCardMetaLine>
                          AW: {job.artworkCode?.trim() || '—'}
                          {job.poLineId ? (
                            <>
                              {' · '}PO line: {job.poLineId}
                            </>
                          ) : null}
                        </HubJobCardMetaLine>
                        <ShopfloorQueueSizeSelect
                          job={job}
                          disabled={saving}
                          mergePatch={mergeQueueJobPatch}
                        />
                        <div>
                          <ShopfloorQueueColourStrip job={job} />
                        </div>
                        <HubJobCardMetaLine>
                          <span className="capitalize">{job.status.replace(/_/g, ' ')}</span>
                        </HubJobCardMetaLine>
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            className="w-full px-2 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-primary-foreground text-xs font-semibold"
                            onClick={() => void markPlateReadyRequirement(job, 'ctp')}
                          >
                            Mark plate ready
                          </button>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void sendBackTriage(job.id)}
                            className="w-full px-2 py-1.5 rounded border border-amber-700/80 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
                          >
                            Send back to Triage
                          </button>
                        </div>
                        {job.lastStatusUpdatedAt ? (
                          <HubLastActionFooter at={job.lastStatusUpdatedAt} />
                        ) : null}
                      </li>
                    ))
                  )}
                </ul>
              </section>

              {/* Outside vendor */}
              <section className="rounded-xl border-2 border-violet-900/80 bg-zinc-950 p-3 flex flex-col min-h-[280px] xl:min-h-0 xl:h-full">
                <div className="flex flex-col gap-2 mb-1 min-w-0">
                  <div className="flex flex-col gap-1 min-w-0">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-violet-300">
                      Outside vendor
                    </h2>
                    <ZoneCapacitySubheader
                      jobCount={vendorZoneMetrics.jobCount}
                      plateCount={vendorZoneMetrics.plateCount}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      resetManualVendorForm()
                      setManualVendorOpen(true)
                    }}
                    className="w-full px-3 py-2 rounded-md border border-violet-500/80 bg-violet-950/40 text-violet-100 text-xs font-bold hover:bg-violet-950/70 shrink-0"
                  >
                    + Manual Vendor PO
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500 mb-2">Awaiting delivery · two-way decisions</p>
                <input
                  value={vendorSearch}
                  onChange={(e) => setVendorSearch(e.target.value)}
                  placeholder="Customer, product, PO #, job code…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 text-sm max-h-[min(26rem,calc(100vh-14rem))] xl:max-h-none">
                  {filteredVendor.length === 0 ? (
                    <li className="text-zinc-500 text-sm">None at vendor.</li>
                  ) : (
                    filteredVendor.map((job) => (
                      <li
                        key={job.id}
                        className={`relative flex flex-col space-y-2 rounded-lg border border-gray-800 bg-background p-3 overflow-hidden transition-colors hover:border-blue-500/50 pr-14 ${
                          job.industrialPriority ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
                        }`}
                      >
                        <ShopfloorPlateAdjustTrigger
                          disabled={saving}
                          onClick={() => setAdjustPlatesJob(job)}
                        />
                        <PlateCountBadge
                          count={
                            job.shopfloorActiveColourCount ??
                            hubPlateBadgeCount({
                              numberOfColours: job.numberOfColours,
                              plateColours: job.plateColours,
                              totalPlates: job.newPlatesNeeded,
                            })
                          }
                        />
                        <p className="font-mono text-violet-200 text-xs">{job.requirementCode}</p>
                        <PlateHubStageDays lastStatusUpdatedAt={job.lastStatusUpdatedAt} />
                        <div className="flex flex-wrap items-start gap-x-1 gap-y-0.5 min-w-0 w-full pr-8">
                          <HubCartonAuditTitle
                            className="!w-auto flex-1 min-w-0"
                            onOpenAudit={() => {
                              const inactive = new Set(job.shopfloorInactiveCanonicalKeys ?? [])
                              const activeOnly = job.plateColours.filter(
                                (l) =>
                                  !inactive.has(
                                    plateColourCanonicalKey(stripPlateColourDisplaySuffix(l)),
                                  ),
                              )
                              setJobAudit({
                                entity: 'requirement',
                                id: job.id,
                                zoneLabel: 'Outside vendor',
                                cartonName: job.cartonName,
                                artworkCode: job.artworkCode,
                                displayCode: job.requirementCode,
                                poLineId: job.poLineId,
                                plateSize: job.plateSize ?? null,
                                plateColours: activeOnly.length ? activeOnly : job.plateColours,
                                coloursRequired:
                                  job.shopfloorActiveColourCount ??
                                  Math.max(
                                    job.plateColours.length,
                                    job.newPlatesNeeded ?? job.numberOfColours ?? 0,
                                  ),
                                platesInRackCount: null,
                                statusLabel: job.status.replace(/_/g, ' '),
                              })
                            }}
                          >
                            {job.cartonName}
                          </HubCartonAuditTitle>
                          {job.partialRemake ? (
                            <span className="text-rose-400 font-bold shrink-0 text-sm">(Remake)</span>
                          ) : null}
                        </div>
                        <HubJobCardMetaLine>
                          AW: {job.artworkCode?.trim() || '—'}
                          {job.poLineId ? (
                            <>
                              {' · '}PO line: {job.poLineId}
                            </>
                          ) : null}
                        </HubJobCardMetaLine>
                        <ShopfloorQueueSizeSelect
                          job={job}
                          disabled={saving}
                          mergePatch={mergeQueueJobPatch}
                        />
                        <div>
                          <ShopfloorQueueColourStrip job={job} />
                        </div>
                        <HubJobCardMetaLine>
                          <span className="capitalize">{job.status.replace(/_/g, ' ')}</span>
                        </HubJobCardMetaLine>
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            className="w-full px-2 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-primary-foreground text-xs font-semibold"
                            onClick={() => void markPlateReadyRequirement(job, 'vendor')}
                          >
                            Receive &amp; Mark Ready
                          </button>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void sendVendorBackTriage(job.id)}
                            className="w-full px-2 py-1.5 rounded border border-amber-700/80 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
                          >
                            Send back to Triage
                          </button>
                        </div>
                        {job.lastStatusUpdatedAt ? (
                          <HubLastActionFooter at={job.lastStatusUpdatedAt} />
                        ) : null}
                      </li>
                    ))
                  )}
                </ul>
              </section>

              {/* Inventory */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 flex flex-col min-h-[280px] xl:min-h-0 xl:h-full">
                <div className="flex flex-col gap-1 mb-2 min-w-0">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                    Live inventory
                  </h2>
                  <ZoneCapacitySubheader
                    jobCount={inventoryZoneMetrics.jobCount}
                    plateCount={inventoryZoneMetrics.plateCount}
                  />
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => {
                      resetAddStockForm()
                      setAddStockOpen(true)
                    }}
                    className="px-3 py-2 rounded-md bg-emerald-700 hover:bg-emerald-600 text-primary-foreground text-xs font-bold"
                  >
                    + Add Plate Stock
                  </button>
                </div>
                <input
                  value={invSearch}
                  onChange={(e) => setInvSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 max-h-[min(26rem,calc(100vh-14rem))] xl:max-h-none">
                  {filteredInventory.length === 0 ? (
                    <li className="text-zinc-500 text-sm">No plates in rack.</li>
                  ) : (
                    filteredInventory.map((p) => {
                      const reqN = p.totalPlates ?? p.numberOfColours ?? 0
                      const actN = p.platesInRackCount ?? 0
                      const short = reqN > 0 && actN < reqN ? reqN - actN : 0
                      const locPrimary = [
                        p.rackNumber?.trim(),
                        p.rackLocation?.trim(),
                        p.slotNumber?.trim(),
                      ]
                        .filter(Boolean)
                        .join(' · ')
                      return (
                        <li
                          key={p.id}
                          className="relative flex flex-col space-y-2 rounded-lg border border-gray-800 bg-background p-3 overflow-hidden transition-colors hover:border-blue-500/50 pr-10"
                        >
                          <PlateCountBadge
                            count={hubLivePlateBadgeCount({
                              platesInRackCount: p.platesInRackCount,
                              numberOfColours: p.numberOfColours,
                              plateColours: p.plateColours,
                              totalPlates: p.totalPlates,
                            })}
                          />
                          <p className="font-mono text-amber-300 text-xs">{p.plateSetCode}</p>
                          <div className="min-w-0 w-full pr-8">
                            <HubCartonAuditTitle
                              onOpenAudit={() =>
                                setJobAudit({
                                  entity: 'plate',
                                  id: p.id,
                                  zoneLabel: 'Live inventory',
                                  cartonName: p.cartonName,
                                  artworkCode: p.artworkCode,
                                  displayCode: p.plateSetCode,
                                  poLineId: null,
                                  plateSize: p.plateSize ?? null,
                                  plateColours: p.plateColours ?? [],
                                  coloursRequired:
                                    p.numberOfColours ??
                                    p.plateColours?.length ??
                                    p.totalPlates ??
                                    0,
                                  platesInRackCount: p.platesInRackCount ?? null,
                                  statusLabel: p.status.replace(/_/g, ' '),
                                })
                              }
                            >
                              {p.cartonName}
                            </HubCartonAuditTitle>
                          </div>
                          <HubJobCardMetaLine>
                            AW: {p.artworkCode?.trim() || '—'}
                            {p.serialNumber ? (
                              <>
                                {' · '}
                                <span className="font-mono">SN {p.serialNumber}</span>
                              </>
                            ) : null}
                          </HubJobCardMetaLine>
                          <HubPlateSizeLine size={p.plateSize} />
                          <div>
                            <ColourChannelsRow labels={p.plateColours ?? []} />
                          </div>
                          {short > 0 ? (
                            <p className="text-xs font-bold text-red-500">
                              ⚠️ Shortage: {short} Plates Missing
                            </p>
                          ) : null}
                          <HubJobCardMetaLine>
                            <span className="text-foreground font-semibold">{locPrimary || '—'}</span>
                            <span className="text-zinc-500">
                              {' '}
                              · Rack / slot
                              {p.ups != null && p.ups > 0 ? ` · UPS ${p.ups}` : ''}
                            </span>
                          </HubJobCardMetaLine>
                          <HubStarLedgerSection
                            labels={p.plateColours ?? []}
                            cycleData={p.cycleData}
                          />
                          <div className="flex flex-col gap-2">
                            <button
                              type="button"
                              className="w-full py-1.5 rounded border border-rose-800/70 bg-rose-950/40 text-rose-100 text-[11px] font-semibold hover:bg-rose-950/70"
                              onClick={() =>
                                setScrapModal({
                                  plateStoreId: p.id,
                                  plateSetCode: p.plateSetCode,
                                  cartonName: p.cartonName,
                                  colourNames: plateColourNamesForScrap(p),
                                })
                              }
                            >
                              Scrap / Report Damage
                            </button>
                            <button
                              type="button"
                              className="w-full py-1.5 rounded border border-zinc-600 bg-zinc-900 text-zinc-200 text-[11px] font-semibold hover:bg-zinc-800"
                              onClick={() => setRemakePlate(p)}
                            >
                              Partial remake (CTP / vendor)
                            </button>
                            <button
                              type="button"
                              className="w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-primary-foreground text-xs font-semibold"
                              onClick={() => void markPlateReadyPlate(p)}
                            >
                              Mark plate ready
                            </button>
                          </div>
                          <HubLastActionFooter at={p.lastStatusUpdatedAt ?? p.createdAt} />
                        </li>
                      )
                    })
                  )}
                </ul>
              </section>

              {/* Custody */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 flex flex-col min-h-[280px] xl:min-h-0 xl:h-full">
                <div className="flex flex-col gap-1 mb-0.5 min-w-0">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                    Custody floor
                  </h2>
                  <ZoneCapacitySubheader
                    jobCount={custodyZoneMetrics.jobCount}
                    plateCount={custodyZoneMetrics.plateCount}
                  />
                </div>
                <p className="text-[11px] text-zinc-500 mb-2">Staging · plates marked ready</p>
                <input
                  value={custSearch}
                  onChange={(e) => setCustSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 max-h-[min(26rem,calc(100vh-14rem))] xl:max-h-none">
                  {filteredCustody.length === 0 ? (
                    <li className="text-zinc-500 text-sm">Nothing in staging.</li>
                  ) : (
                    filteredCustody.map((c) => (
                      <li
                        key={`${c.kind}-${c.id}`}
                        className={`relative flex flex-col space-y-2 rounded-lg bg-background p-3 overflow-hidden transition-colors hover:border-blue-500/50 pr-10 ${
                          c.kind === 'plate' && c.jobCardHub?.key === 'printed'
                            ? 'border border-emerald-600/70 shadow-[0_0_14px_rgba(16,185,129,0.12)]'
                            : 'border border-gray-800'
                        }`}
                      >
                        <PlateCountBadge
                          count={
                            c.kind === 'plate'
                              ? hubLivePlateBadgeCount({
                                  platesInRackCount: c.platesInRackCount,
                                  numberOfColours: c.numberOfColours,
                                  plateColours: c.plateColours,
                                  totalPlates: c.totalPlates,
                                })
                              : hubPlateBadgeCount({
                                  numberOfColours: c.numberOfColours,
                                  plateColours: c.plateColours,
                                  totalPlates: c.newPlatesNeeded,
                                })
                          }
                        />
                        <CustodySourcePill source={c.custodySource} />
                        <p className="font-mono text-amber-300 text-xs">{c.displayCode}</p>
                        <div className="flex flex-wrap items-start gap-x-1 gap-y-0.5 min-w-0 w-full pr-8">
                          <HubCartonAuditTitle
                            className="!w-auto flex-1 min-w-0"
                            onOpenAudit={() =>
                              setJobAudit({
                                entity: c.kind === 'requirement' ? 'requirement' : 'plate',
                                id: c.id,
                                zoneLabel: `Custody floor (${sourceBadgeLabel(c.custodySource)})`,
                                cartonName: c.cartonName,
                                artworkCode: c.artworkCode,
                                displayCode: c.displayCode,
                                poLineId: null,
                                plateSize: c.plateSize ?? null,
                                plateColours: c.plateColours,
                                coloursRequired: Math.max(
                                  c.plateColours.length,
                                  c.kind === 'requirement'
                                    ? (c.newPlatesNeeded ?? 0)
                                    : (c.numberOfColours ?? c.totalPlates ?? 0),
                                ),
                                platesInRackCount: c.platesInRackCount ?? null,
                                statusLabel: `Staging · ${sourceBadgeLabel(c.custodySource)}`,
                              })
                            }
                          >
                            {c.cartonName}
                          </HubCartonAuditTitle>
                          {c.kind === 'requirement' && c.partialRemake ? (
                            <span className="text-rose-400 font-bold shrink-0 text-sm">(Remake)</span>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <HubJobCardMetaLine>
                            AW: {c.artworkCode?.trim() || '—'}
                            {c.kind === 'plate' && c.serialNumber ? (
                              <>
                                {' · '}
                                <span className="font-mono">SN {c.serialNumber}</span>
                              </>
                            ) : null}
                            {c.kind === 'plate' && c.ups != null && c.ups > 0 ? (
                              <>
                                {' · '}UPS {c.ups}
                              </>
                            ) : null}
                          </HubJobCardMetaLine>
                          <JobCardStatusBadge hub={c.jobCardHub} />
                        </div>
                        <HubPlateSizeLine size={c.plateSize} />
                        <div>
                          <ColourChannelsRow labels={c.plateColours} />
                        </div>
                        {c.kind === 'plate' ? (
                          <HubStarLedgerSection
                            labels={c.plateColours}
                            cycleData={c.cycleData}
                          />
                        ) : null}
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            className={`w-full py-1.5 rounded text-foreground text-[11px] font-bold shadow-sm ${
                              c.jobCardHub?.key === 'printed'
                                ? 'bg-emerald-500 hover:bg-emerald-400 ring-2 ring-emerald-300/40'
                                : 'bg-emerald-700 hover:bg-emerald-600'
                            }`}
                            onClick={() =>
                              setReturnAuditModal({
                                kind: c.kind,
                                plateStoreId: c.kind === 'plate' ? c.id : undefined,
                                requirementId: c.kind === 'requirement' ? c.id : undefined,
                                plateSetCode: c.displayCode,
                                cartonName: c.cartonName,
                                colourNames: plateColourNamesForScrap(c),
                                custodySource: c.custodySource,
                                plateSize: c.plateSize ?? null,
                              })
                            }
                          >
                            Return to Rack
                          </button>
                          <button
                            type="button"
                            className="w-full py-1.5 rounded border border-rose-800/70 bg-rose-950/40 text-rose-100 text-[11px] font-semibold hover:bg-rose-950/70"
                            onClick={() => {
                              if (c.kind !== 'plate') {
                                toast.error(
                                  'Scrap applies to physical plate sets. Use Reverse / Undo to send this requirement back to CTP or vendor.',
                                )
                                return
                              }
                              const colourNames = plateColourNamesForScrap(c)
                              if (!colourNames.length) {
                                toast.error('No active plate channels on this set.')
                                return
                              }
                              setScrapModal({
                                plateStoreId: c.id,
                                plateSetCode: c.displayCode,
                                cartonName: c.cartonName,
                                colourNames,
                              })
                            }}
                          >
                            Scrap / Report Damage
                          </button>
                          <button
                            type="button"
                            className="w-full py-1.5 rounded border border-amber-800/80 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
                            onClick={() => void reverseCustodyItem(c)}
                          >
                            Reverse / Undo
                          </button>
                        </div>
                        {c.lastStatusUpdatedAt ? (
                          <HubLastActionFooter at={c.lastStatusUpdatedAt} />
                        ) : null}
                      </li>
                    ))
                  )}
                </ul>
              </section>
            </div>
          </>
        )}
      </div>

      <JobAuditModal context={jobAudit} onClose={() => setJobAudit(null)} />

      {/* Add plate stock — master-linked */}
      {addStockOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-lg max-h-[90vh] rounded-xl border border-zinc-600 bg-zinc-950 flex flex-col shadow-2xl">
            <div className="p-4 pb-2 shrink-0 border-b border-zinc-800 z-20 relative">
            <h3 className="text-lg font-semibold text-foreground">Add plate stock</h3>
            <p className="text-zinc-500 text-xs">
              Search carton master first — AW code and UPS fill from the selected carton. Edit before save.
            </p>
            <div className="relative mt-3">
              <label className="block text-sm text-zinc-300">
                Carton name
                <input
                  value={addCartonQuery}
                  onChange={(e) => {
                    const v = e.target.value
                    setAddCartonQuery(v)
                    if (addSelectedCarton && v.trim() !== addSelectedCarton.cartonName) {
                      setAddSelectedCarton(null)
                    }
                  }}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
                  placeholder="Type at least 2 characters…"
                  autoComplete="off"
                />
              </label>
              {addCartonLoading ? <p className="text-xs text-zinc-500 mt-1">Searching…</p> : null}
              {addCartonResults.length > 0 ? (
                <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-zinc-600 bg-zinc-900 shadow-lg">
                  {addCartonResults.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-zinc-800 border-b border-zinc-800 last:border-0"
                        onClick={() => applyCartonSelection(hit)}
                      >
                        <span className="font-medium block break-words whitespace-normal text-sm text-blue-400">
                          {hit.cartonName}
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          {hit.customer.name}
                          {hit.artworkCode ? ` · ${hit.artworkCode}` : ''}
                          {hit.ups != null && hit.ups > 0 ? ` · UPS ${hit.ups}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {addSelectedCarton ? (
              <p className="text-[11px] text-emerald-400/90">
                Linked: {addSelectedCarton.customer.name}
              </p>
            ) : (
              <p className="text-[11px] text-zinc-500">Pick a row above to link carton + customer.</p>
            )}
            </div>
            <div className="p-4 pt-3 space-y-3 overflow-y-auto flex-1 min-h-0">
            <label className="block text-sm text-zinc-300">
              AW code
              <input
                value={addAwCode}
                onChange={(e) => setAddAwCode(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
                placeholder="e.g. R234"
              />
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="block text-sm text-zinc-300 flex-1">
                Serial number
                <input
                  value={addSerial}
                  onChange={(e) => setAddSerial(e.target.value)}
                  disabled={addAutoSerial}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground disabled:opacity-50"
                  placeholder={addAutoSerial ? 'Auto-generated on save' : 'Enter serial'}
                />
                {addStockFieldErrors.serialNumber ? (
                  <span className="text-xs text-red-400">{addStockFieldErrors.serialNumber}</span>
                ) : null}
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300 pb-2 sm:pb-0 shrink-0 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={addAutoSerial}
                  onChange={(e) => {
                    setAddAutoSerial(e.target.checked)
                    if (e.target.checked) setAddSerial('')
                  }}
                  className="rounded border-zinc-600"
                />
                Auto-generate
              </label>
            </div>
            <label className="block text-sm text-zinc-300">
              Output number
              <span className="block text-[11px] text-zinc-500 font-normal mt-0.5">
                Also used as set / output reference in custody workflows.
              </span>
              <input
                value={addOutputNumber}
                onChange={(e) => setAddOutputNumber(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Rack number
              <input
                value={addRackNumber}
                onChange={(e) => setAddRackNumber(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              No. of UPS
              <input
                value={addUps}
                onChange={(e) => setAddUps(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
                placeholder="From dye / carton master"
                inputMode="numeric"
              />
              {addStockFieldErrors.ups ? (
                <span className="text-xs text-red-400">{addStockFieldErrors.ups}</span>
              ) : null}
            </label>
            <div>
              <p className="text-sm text-zinc-300 mb-2">
                Plate size <span className="text-red-400">*</span>
              </p>
              <HubPlateSizeSegmented
                value={addStockPlateSize}
                onChange={setAddStockPlateSize}
                accent="emerald"
              />
            </div>
            <div>
              <p className="text-sm text-zinc-300 mb-2">Colours on plate</p>
              <div className="flex flex-wrap gap-2 items-center">
                {(
                  [
                    ['C', stdC, setStdC],
                    ['M', stdM, setStdM],
                    ['Y', stdY, setStdY],
                    ['K', stdK, setStdK],
                  ] as const
                ).map(([ch, on, setOn]) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => setOn(!on)}
                    title={HUB_CMYK_CHANNEL_LABEL[ch]}
                    className={`rounded-md border p-0.5 flex items-center justify-center ${
                      on
                        ? 'border-amber-500/90 ring-1 ring-amber-500/35 shadow-sm'
                        : 'border-zinc-700'
                    }`}
                  >
                    <PlateHubColourSwatch
                      short={ch}
                      label={HUB_CMYK_CHANNEL_LABEL[ch]}
                      ghost={!on}
                    />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPantoneOn(!pantoneOn)}
                  title="Pantone / spot colours"
                  className={`rounded-md border p-0.5 flex items-center justify-center ${
                    pantoneOn
                      ? 'border-violet-500 ring-1 ring-violet-500/35'
                      : 'border-zinc-700'
                  }`}
                >
                  <PlateHubColourSwatch short="P1" label="Pantone" ghost={!pantoneOn} />
                </button>
              </div>
              {pantoneOn ? (
                <label className="block text-sm text-zinc-300 mt-3">
                  How many Pantones?
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={pantoneCount}
                    onChange={(e) => setPantoneCount(Number(e.target.value) || 1)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
                  />
                </label>
              ) : null}
            </div>
            <div className="rounded-lg border border-zinc-700 bg-background/50 px-3 py-2 flex items-center justify-between">
              <span className="text-sm text-zinc-400">Total plates required</span>
              <span className="text-lg font-bold text-amber-300 tabular-nums">{addStockTotalPlates}</span>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => {
                  setAddStockOpen(false)
                  resetAddStockForm()
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-emerald-600 text-primary-foreground font-medium disabled:opacity-50"
                onClick={() => void submitAddStock()}
              >
                Save to rack
              </button>
            </div>
            </div>
          </div>
        </div>
      )}

      {/* Stock modal */}
      {stockModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-3xl rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3 max-h-[90vh] flex flex-col">
            <h3 className="text-lg font-semibold text-foreground shrink-0">Take from stock</h3>
            <p className="text-slate-400 text-sm shrink-0">
              Pull channels from live inventory into custody floor (
              <span className="text-amber-200/90">Source: Rack</span>). Plate sets match this job’s{' '}
              {stockModal.artworkCode?.trim() ? 'AW code' : 'carton name'}.
            </p>
            {stockModalPlateOptions.length === 0 ? (
              <p className="text-sm text-rose-400 shrink-0">
                No matching plate sets in live inventory for this AW / carton.
              </p>
            ) : (
              <div className="overflow-auto rounded-lg border border-zinc-800 min-h-0">
                <table className="w-full text-[11px] border-collapse">
                  <thead className="sticky top-0 bg-zinc-950 z-[1]">
                    <tr className="text-left text-zinc-500 border-b border-zinc-800">
                      <th className="py-1 px-1 w-8 font-semibold uppercase tracking-wide">Sel</th>
                      <th className="py-1 px-1 font-semibold uppercase tracking-wide">Rack / slot</th>
                      <th className="py-1 px-1 font-semibold uppercase tracking-wide">Set ID</th>
                      <th className="py-1 px-1 font-semibold uppercase tracking-wide">Available</th>
                      <th className="py-1 px-1 font-semibold uppercase tracking-wide">Pull</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockModalPlateOptions.map((p) => {
                      const loc = formatPlateCardRackLocation(p) ?? '—'
                      const chRows = stockPullChannelRows(p)
                      const eligible = chRows.filter(({ displayLabel }) =>
                        stockChannelCanonInSet(displayLabel, jobNeededCanons),
                      )
                      const picks = stockBatchPick[p.id] ?? {}
                      const allOn =
                        eligible.length > 0 && eligible.every(({ submitKey }) => picks[submitKey])
                      return (
                        <tr key={p.id} className="border-b border-zinc-800/80 align-top">
                          <td className="py-1 px-1">
                            <input
                              type="checkbox"
                              className="rounded border-zinc-600"
                              checked={allOn}
                              disabled={eligible.length === 0}
                              onChange={(e) => {
                                const on = e.target.checked
                                setStockBatchPick((prev) => {
                                  const row = { ...(prev[p.id] ?? {}) }
                                  for (const { submitKey } of eligible) row[submitKey] = on
                                  return { ...prev, [p.id]: row }
                                })
                              }}
                              title="Select all channels needed for this job in this slot"
                            />
                          </td>
                          <td className="py-1 px-1 text-zinc-300 whitespace-nowrap">{loc}</td>
                          <td className="py-1 px-1 text-zinc-200 font-mono tabular-nums">
                            {p.plateSetCode}
                          </td>
                          <td className="py-1 px-1">
                            <PlateHubColourSwatchStrip
                              labels={p.plateColours ?? []}
                              size="sm"
                              className="gap-0.5"
                            />
                          </td>
                          <td className="py-1 px-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              {chRows.map(({ submitKey, displayLabel }) => {
                                const inJob = stockChannelCanonInSet(displayLabel, jobNeededCanons)
                                const rowsLbl = hubChannelRowsFromLabels([displayLabel])
                                const sw = rowsLbl[0]
                                return (
                                  <label
                                    key={submitKey}
                                    className={`inline-flex items-center gap-1 ${inJob ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}
                                  >
                                    <input
                                      type="checkbox"
                                      className="rounded border-zinc-600 shrink-0 scale-90"
                                      checked={!!picks[submitKey]}
                                      disabled={!inJob}
                                      onChange={(e) =>
                                        setStockBatchPick((prev) => ({
                                          ...prev,
                                          [p.id]: {
                                            ...(prev[p.id] ?? {}),
                                            [submitKey]: e.target.checked,
                                          },
                                        }))
                                      }
                                    />
                                    {sw ? (
                                      <PlateHubColourSwatch
                                        short={sw.short}
                                        label={sw.label}
                                        size="sm"
                                      />
                                    ) : (
                                      <span className="text-zinc-500">{displayLabel}</span>
                                    )}
                                  </label>
                                )
                              })}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="rounded-lg border border-zinc-700 bg-background/50 px-2 py-1.5 shrink-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 mb-1">
                Fulfillment status
              </p>
              <div className="flex flex-wrap items-center gap-1">
                {hubChannelRowsFromLabels(stockModal.plateColours).map((r) => {
                  const k = plateColourCanonicalKey(stripPlateColourDisplaySuffix(r.label))
                  const ok = Boolean(k && stockBatchSelectionSummary.selectedCanonSet.has(k))
                  return (
                    <span
                      key={r.key}
                      className={
                        ok
                          ? 'ring-2 ring-emerald-500/90 rounded-sm'
                          : 'opacity-40 grayscale rounded-sm'
                      }
                      title={r.label}
                    >
                      <PlateHubColourSwatch short={r.short} label={r.label} size="sm" />
                    </span>
                  )
                })}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1 shrink-0">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => {
                  setStockModal(null)
                  setStockBatchPick({})
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  saving ||
                  stockBatchSelectionSummary.channelCount === 0 ||
                  stockModalPlateOptions.length === 0
                }
                className="px-3 py-2 rounded bg-amber-600 text-primary-foreground font-medium disabled:opacity-50"
                onClick={() => void submitTakeFromStock()}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {triageSizeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-amber-700/50 bg-zinc-950 p-4 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Confirm plate size</h3>
              <p className="text-zinc-500 text-xs mt-1">
                No plate size is set on this requirement or the linked carton master. Pick the sheet size
                before sending to{' '}
                {triageSizeModal.channel === 'inhouse_ctp' ? 'in-house CTP' : 'outside vendor'}.
              </p>
            </div>
            <div>
              <p className="text-sm text-zinc-300 mb-2">
                Plate size <span className="text-red-400">*</span>
              </p>
              <HubPlateSizeSegmented
                value={triagePlateSizePick}
                onChange={setTriagePlateSizePick}
                accent="amber"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setTriageSizeModal(null)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-amber-600 text-primary-foreground font-semibold disabled:opacity-50"
                onClick={() => {
                  if (!triageSizeModal) return
                  void patchTriage(triageSizeModal.rowId, triageSizeModal.channel, triagePlateSizePick)
                }}
              >
                Confirm dispatch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual CTP — bypass triage */}
      {manualCtpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-lg max-h-[90vh] rounded-xl border border-zinc-600 bg-zinc-950 flex flex-col shadow-2xl">
            <div className="p-4 border-b border-zinc-800 shrink-0">
              <h3 className="text-lg font-semibold text-foreground">Manual CTP request</h3>
              <p className="text-zinc-500 text-xs mt-1">
                Bypass designer triage. Job drops straight into the CTP queue.
              </p>
              <div className="relative mt-3">
                <label className="block text-sm text-zinc-300">
                  Carton name
                  <input
                    value={mCtpQuery}
                    onChange={(e) => {
                      const v = e.target.value
                      setMCtpQuery(v)
                      if (mCtpSelected && v.trim() !== mCtpSelected.cartonName) {
                        setMCtpSelected(null)
                      }
                    }}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
                    placeholder="Type at least 2 characters…"
                    autoComplete="off"
                  />
                </label>
                {mCtpLoading ? <p className="text-xs text-zinc-500 mt-1">Searching…</p> : null}
                {mCtpResults.length > 0 ? (
                  <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-zinc-600 bg-zinc-900 shadow-lg">
                    {mCtpResults.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-zinc-800 border-b border-zinc-800 last:border-0"
                          onClick={() => {
                            setMCtpSelected(hit)
                            setMCtpQuery(hit.cartonName)
                            setMCtpResults([])
                            setMCtpPlateSize(hit.plateSize ?? 'SIZE_560_670')
                          }}
                        >
                          <span className="font-medium block break-words whitespace-normal text-sm text-blue-400">
                            {hit.cartonName}
                          </span>
                          <span className="text-[11px] text-zinc-400">
                            {hit.customer.name}
                            {hit.artworkCode ? ` · ${hit.artworkCode}` : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {mCtpSelected ? (
                <p className="text-[11px] text-emerald-400/90 mt-2">
                  Linked: {mCtpSelected.customer.name}
                </p>
              ) : (
                <p className="text-[11px] text-zinc-500 mt-2">Pick a carton from search results.</p>
              )}
            </div>
            <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
              <div>
                <p className="text-sm text-zinc-300 mb-2">
                  Plate size <span className="text-red-400">*</span>
                </p>
                <HubPlateSizeSegmented
                  value={mCtpPlateSize}
                  onChange={setMCtpPlateSize}
                  accent="amber"
                />
              </div>
              <div>
                <p className="text-sm text-zinc-300 mb-2">Colours to burn</p>
                <div className="flex flex-wrap gap-2 items-center">
                  {(
                    [
                      ['C', mCtpC, setMCtpC],
                      ['M', mCtpM, setMCtpM],
                      ['Y', mCtpY, setMCtpY],
                      ['K', mCtpK, setMCtpK],
                    ] as const
                  ).map(([ch, on, setOn]) => (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => setOn(!on)}
                      title={HUB_CMYK_CHANNEL_LABEL[ch]}
                      className={`rounded-md border p-0.5 flex items-center justify-center ${
                        on
                          ? 'border-amber-500/90 ring-1 ring-amber-500/35 shadow-sm'
                          : 'border-zinc-700'
                      }`}
                    >
                      <PlateHubColourSwatch
                        short={ch}
                        label={HUB_CMYK_CHANNEL_LABEL[ch]}
                        ghost={!on}
                      />
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setMCtpPantone(!mCtpPantone)}
                    title="Pantone / spot colours"
                    className={`rounded-md border p-0.5 flex items-center justify-center ${
                      mCtpPantone
                        ? 'border-violet-500 ring-1 ring-violet-500/35'
                        : 'border-zinc-700'
                    }`}
                  >
                    <PlateHubColourSwatch short="P1" label="Pantone" ghost={!mCtpPantone} />
                  </button>
                </div>
                {mCtpPantone ? (
                  <label className="block text-sm text-zinc-300 mt-3">
                    How many Pantones?
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={mCtpPantoneN}
                      onChange={(e) => setMCtpPantoneN(Number(e.target.value) || 1)}
                      className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
                    />
                  </label>
                ) : null}
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                  onClick={() => {
                    setManualCtpOpen(false)
                    resetManualCtpForm()
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving || !mCtpSelected}
                  className="px-3 py-2 rounded bg-amber-600 text-primary-foreground font-semibold disabled:opacity-50"
                  onClick={() => void submitManualCtpRequest()}
                >
                  Create CTP job
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manual vendor PO */}
      {manualVendorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-lg max-h-[90vh] rounded-xl border border-violet-600/60 bg-zinc-950 flex flex-col shadow-2xl">
            <div className="p-4 border-b border-zinc-800 shrink-0">
              <h3 className="text-lg font-semibold text-foreground">Manual vendor PO</h3>
              <p className="text-zinc-500 text-xs mt-1">
                Bypass triage. Job goes to Outside vendor (awaiting delivery).
              </p>
              <div className="relative mt-3">
                <label className="block text-sm text-zinc-300">
                  Carton name
                  <input
                    value={mvQuery}
                    onChange={(e) => {
                      const v = e.target.value
                      setMvQuery(v)
                      if (mvSelected && v.trim() !== mvSelected.cartonName) {
                        setMvSelected(null)
                      }
                    }}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
                    placeholder="Type at least 2 characters…"
                    autoComplete="off"
                  />
                </label>
                {mvLoading ? <p className="text-xs text-zinc-500 mt-1">Searching…</p> : null}
                {mvResults.length > 0 ? (
                  <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-zinc-600 bg-zinc-900 shadow-lg">
                    {mvResults.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-zinc-800 border-b border-zinc-800 last:border-0"
                          onClick={() => {
                            setMvSelected(hit)
                            setMvQuery(hit.cartonName)
                            setMvResults([])
                            setMvPlateSize(hit.plateSize ?? 'SIZE_560_670')
                          }}
                        >
                          <span className="font-medium block break-words whitespace-normal text-sm text-blue-400">
                            {hit.cartonName}
                          </span>
                          <span className="text-[11px] text-zinc-400">
                            {hit.customer.name}
                            {hit.artworkCode ? ` · ${hit.artworkCode}` : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {mvSelected ? (
                <p className="text-[11px] text-emerald-400/90 mt-2">
                  Linked: {mvSelected.customer.name}
                </p>
              ) : (
                <p className="text-[11px] text-zinc-500 mt-2">Pick a carton from search results.</p>
              )}
            </div>
            <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
              <div>
                <p className="text-sm text-zinc-300 mb-2">
                  Plate size <span className="text-red-400">*</span>
                </p>
                <HubPlateSizeSegmented
                  value={mvPlateSize}
                  onChange={setMvPlateSize}
                  accent="violet"
                />
              </div>
              <div>
                <p className="text-sm text-zinc-300 mb-2">Colours (vendor will supply)</p>
                <div className="flex flex-wrap gap-2 items-center">
                  {(
                    [
                      ['C', mvC, setMvC],
                      ['M', mvM, setMvM],
                      ['Y', mvY, setMvY],
                      ['K', mvK, setMvK],
                    ] as const
                  ).map(([ch, on, setOn]) => (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => setOn(!on)}
                      title={HUB_CMYK_CHANNEL_LABEL[ch]}
                      className={`rounded-md border p-0.5 flex items-center justify-center ${
                        on
                          ? 'border-violet-400 ring-1 ring-violet-500/35 shadow-sm'
                          : 'border-zinc-700'
                      }`}
                    >
                      <PlateHubColourSwatch
                        short={ch}
                        label={HUB_CMYK_CHANNEL_LABEL[ch]}
                        ghost={!on}
                      />
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setMvPantone(!mvPantone)}
                    title="Pantone / spot colours"
                    className={`rounded-md border p-0.5 flex items-center justify-center ${
                      mvPantone
                        ? 'border-violet-500 ring-1 ring-violet-500/35'
                        : 'border-zinc-700'
                    }`}
                  >
                    <PlateHubColourSwatch short="P1" label="Pantone" ghost={!mvPantone} />
                  </button>
                </div>
                {mvPantone ? (
                  <label className="block text-sm text-zinc-300 mt-3">
                    How many Pantones?
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={mvPantoneN}
                      onChange={(e) => setMvPantoneN(Number(e.target.value) || 1)}
                      className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground"
                    />
                  </label>
                ) : null}
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                  onClick={() => {
                    setManualVendorOpen(false)
                    resetManualVendorForm()
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving || !mvSelected}
                  className="px-3 py-2 rounded bg-violet-600 text-primary-foreground font-semibold disabled:opacity-50"
                  onClick={() => void submitManualVendorRequest()}
                >
                  Create vendor job
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <AdjustPlatesModal
        job={adjustPlatesJob}
        onClose={() => setAdjustPlatesJob(null)}
        mergePatch={mergeQueueJobPatch}
        savingDisabled={saving}
      />

      {/* Scrap & damage — per channel */}
      {scrapModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-rose-800/50 bg-zinc-950 p-4 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Scrap &amp; damage report</h3>
              <p className="text-zinc-500 text-xs mt-1">
                Step 1 — which plates are scrapped? Step 2 — reason. Counts update immediately.
              </p>
              <p className="text-xs font-mono text-amber-300 mt-2">{scrapModal.plateSetCode}</p>
              <p className="text-sm font-bold leading-snug tracking-tight text-blue-400 break-words whitespace-normal">
                {scrapModal.cartonName}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
                Step 1 — Which plate?
              </p>
              <div className="space-y-2 rounded-lg border border-zinc-700 bg-background/40 p-3">
                {scrapModal.colourNames.length === 0 ? (
                  <p className="text-xs text-zinc-500">No active channels on this set.</p>
                ) : (
                  scrapModal.colourNames.map((name) => {
                    const ch = hubChannelRowsFromLabels([name])[0]
                    return (
                      <label
                        key={name}
                        className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={scrapChannelPick[name] ?? false}
                          onChange={(e) =>
                            setScrapChannelPick((prev) => ({ ...prev, [name]: e.target.checked }))
                          }
                          className="rounded border-zinc-600 shrink-0"
                        />
                        <span className="flex items-center gap-2 min-w-0">
                          {ch ? (
                            <PlateHubColourSwatch short={ch.short} label={ch.label} />
                          ) : null}
                          <span className="text-xs break-words whitespace-normal">{name}</span>
                        </span>
                      </label>
                    )
                  })
                )}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
                Step 2 — Reason for scrapping?
              </p>
              <select
                value={scrapReasonCode}
                onChange={(e) => {
                  const v = e.target.value
                  setScrapReasonCode(v ? (v as PlateScrapReasonCode) : '')
                }}
                className="w-full px-3 py-2 rounded-md bg-background border border-zinc-600 text-foreground text-sm"
              >
                <option value="">Select reason…</option>
                {PLATE_SCRAP_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setScrapModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  saving ||
                  !scrapModal.colourNames.length ||
                  !Object.values(scrapChannelPick).some(Boolean) ||
                  !scrapReasonCode
                }
                className="px-3 py-2 rounded bg-rose-700 text-primary-foreground font-semibold disabled:opacity-50"
                onClick={() => void submitScrapPlateChannels()}
              >
                Confirm scrap
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Return to rack — custody audit */}
      {returnAuditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-emerald-800/50 bg-zinc-950 p-4 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Return &amp; audit</h3>
              <p className="text-zinc-500 text-xs mt-1">
                Confirm which plates go back to live inventory. Unchecked channels are logged as not
                returned and follow the scrap workflow.
              </p>
              <p className="text-xs font-mono text-amber-300 mt-2">{returnAuditModal.plateSetCode}</p>
              <p className="text-sm font-bold leading-snug tracking-tight text-blue-400 break-words whitespace-normal">
                {returnAuditModal.cartonName}
              </p>
            </div>

            {returnAuditStep === 1 ? (
              <>
                <div>
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
                    Step 1 — Select plates safely returning to rack
                  </p>
                  <div className="space-y-2 rounded-lg border border-zinc-700 bg-background/40 p-3">
                    {returnAuditModal.colourNames.length === 0 ? (
                      <p className="text-xs text-zinc-400 leading-snug">
                        No channel list on this card. On confirm, all active plates for this custody
                        row are returned to live inventory (same as selecting every channel).
                      </p>
                    ) : (
                      returnAuditModal.colourNames.map((name) => {
                        const ch = hubChannelRowsFromLabels([name])[0]
                        return (
                          <label
                            key={name}
                            className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={returnAuditPick[name] ?? false}
                              onChange={(e) =>
                                setReturnAuditPick((prev) => ({ ...prev, [name]: e.target.checked }))
                              }
                              className="rounded border-zinc-600 shrink-0"
                            />
                            <span className="flex items-center gap-2 min-w-0">
                              {ch ? (
                                <PlateHubColourSwatch short={ch.short} label={ch.label} />
                              ) : null}
                              <span className="text-xs break-words whitespace-normal">{name}</span>
                            </span>
                          </label>
                        )
                      })
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-2 leading-snug">
                    Any plate left unchecked is flagged for the scrap / damage workflow automatically.
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                    onClick={() => setReturnAuditModal(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      saving ||
                      (returnAuditModal.colourNames.length > 0 &&
                        !Object.values(returnAuditPick).some(Boolean))
                    }
                    className="px-3 py-2 rounded bg-emerald-700 text-primary-foreground font-semibold disabled:opacity-50"
                    onClick={() => {
                      if (
                        returnAuditModal.colourNames.length > 0 &&
                        !Object.values(returnAuditPick).some(Boolean)
                      ) {
                        toast.error('Select at least one plate returning to rack')
                        return
                      }
                      setReturnAuditStep(2)
                    }}
                  >
                    Next
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg border border-zinc-700 bg-background/40 p-2.5 space-y-2">
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
                    Verify plate dimensions
                  </p>
                  <p className="text-[11px] text-zinc-500 leading-snug">
                    Current:{' '}
                    <span className="text-zinc-300">
                      {HUB_PLATE_SIZE_OPTIONS.find((o) => o.value === returnSizeOriginal)?.mm ??
                        returnSizeOriginal}
                    </span>
                    . Toggle only if the physical plate was sheared or resized.
                  </p>
                  <HubPlateSizeSegmented
                    value={returnSizePick}
                    onChange={(v) => {
                      setReturnSizePick(v)
                      if (v === returnSizeOriginal) {
                        setReturnSizeModReason('')
                        setReturnSizeRemarks('')
                      }
                    }}
                    accent="emerald"
                  />
                  {returnSizePick !== returnSizeOriginal ? (
                    <div className="mt-2 pt-2 border-t border-zinc-700/80 space-y-2 transition-all">
                      <p className="text-xs font-semibold text-amber-200/90">
                        Reason for size modification?{' '}
                        <span className="text-red-400">*</span>
                      </p>
                      <fieldset className="space-y-1.5">
                        {RETURN_SIZE_MOD_REASONS.map((opt) => (
                          <label
                            key={opt.value}
                            className="flex items-start gap-2 text-sm text-zinc-200 cursor-pointer leading-tight"
                          >
                            <input
                              type="radio"
                              name="returnSizeModReason"
                              checked={returnSizeModReason === opt.value}
                              onChange={() => setReturnSizeModReason(opt.value)}
                              className="border-zinc-600 mt-0.5 shrink-0"
                            />
                            <span>{opt.label}</span>
                          </label>
                        ))}
                      </fieldset>
                      <label className="block text-[11px] text-zinc-400">
                        Remarks (optional)
                        <input
                          type="text"
                          value={returnSizeRemarks}
                          onChange={(e) => setReturnSizeRemarks(e.target.value)}
                          placeholder="e.g. Cut by Team B for Machine 2"
                          className="mt-1 w-full px-2 py-1.5 rounded-md bg-background border border-zinc-600 text-foreground text-sm placeholder:text-zinc-600"
                        />
                      </label>
                    </div>
                  ) : null}
                </div>

                <div>
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
                    Step 2 — Confirm plate origin (for analytics)
                  </p>
                  <p className="text-[11px] text-zinc-500 mb-3">
                    Default follows custody source; override if needed for reporting accuracy.
                  </p>
                  <fieldset className="space-y-2 rounded-lg border border-zinc-700 bg-background/40 p-3">
                    {PLATE_FIRST_ORIGIN_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer"
                      >
                        <input
                          type="radio"
                          name="returnAuditOrigin"
                          checked={returnAuditOrigin === opt.value}
                          onChange={() => setReturnAuditOrigin(opt.value)}
                          className="border-zinc-600"
                        />
                        {opt.label}
                      </label>
                    ))}
                  </fieldset>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                    onClick={() => setReturnAuditStep(1)}
                    disabled={saving}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={
                      saving ||
                      (returnSizePick !== returnSizeOriginal && !returnSizeModReason)
                    }
                    className="px-3 py-2 rounded bg-emerald-600 text-primary-foreground font-semibold disabled:opacity-50"
                    onClick={() => void submitReturnToRack()}
                  >
                    Confirm return
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Partial remake from live inventory */}
      {remakePlate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Report damage / remake</h3>
              <p className="text-zinc-500 text-xs mt-1">
                Which plate is missing or damaged? The rack set stays; a new{' '}
                <span className="text-rose-400 font-semibold">(Remake)</span> job is created for only the
                selected colours.
              </p>
              <p className="text-sm text-amber-200/90 font-mono mt-2">{remakePlate.plateSetCode}</p>
              <p className="text-sm font-bold leading-snug tracking-tight text-blue-400 break-words whitespace-normal">
                {remakePlate.cartonName}
              </p>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
                Send partial job to
              </legend>
              <label className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                <input
                  type="radio"
                  name="remakeLane"
                  checked={remakeLane === 'inhouse_ctp'}
                  onChange={() => setRemakeLane('inhouse_ctp')}
                  className="border-zinc-600"
                />
                In-house CTP queue
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                <input
                  type="radio"
                  name="remakeLane"
                  checked={remakeLane === 'outside_vendor'}
                  onChange={() => setRemakeLane('outside_vendor')}
                  className="border-zinc-600"
                />
                Outside vendor
              </label>
            </fieldset>
            <div>
              <p className="text-sm text-zinc-300 mb-2">Missing / damaged colours</p>
              <div className="space-y-2 rounded-lg border border-zinc-700 bg-background/40 p-3">
                {Object.keys(remakePick).length === 0 ? (
                  <p className="text-xs text-zinc-500">No colour channels on this set.</p>
                ) : (
                  Object.keys(remakePick).map((name) => {
                    const ch = hubChannelRowsFromLabels([name])[0]
                    return (
                      <label
                        key={name}
                        className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={remakePick[name] ?? false}
                          onChange={(e) =>
                            setRemakePick((prev) => ({ ...prev, [name]: e.target.checked }))
                          }
                          className="rounded border-zinc-600 shrink-0"
                        />
                        <span className="flex items-center gap-2 min-w-0">
                          {ch ? (
                            <PlateHubColourSwatch short={ch.short} label={ch.label} />
                          ) : null}
                          <span className="text-xs text-zinc-300 break-words whitespace-normal">{name}</span>
                        </span>
                      </label>
                    )
                  })
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setRemakePlate(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  saving ||
                  Object.keys(remakePick).length === 0 ||
                  !Object.values(remakePick).some(Boolean)
                }
                className="px-3 py-2 rounded bg-rose-800 text-primary-foreground font-semibold disabled:opacity-50"
                onClick={() => void submitPartialRemake()}
              >
                Create partial request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
