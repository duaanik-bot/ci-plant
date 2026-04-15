'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { safeJsonParse, safeJsonParseArray, safeJsonStringify } from '@/lib/safe-json'
import {
  hubChannelRowsFromLabels,
  hubLivePlateBadgeCount,
  hubPlateBadgeCount,
  stripPlateColourDisplaySuffix,
} from '@/lib/hub-plate-card-ui'
import { PLATE_SCRAP_REASONS, type PlateScrapReasonCode } from '@/lib/plate-scrap-reasons'
import {
  hubAddedToRackLabel,
  hubMarkedReadyLabel,
  hubQueueAgeLabel,
  hubQueueStale,
} from '@/lib/hub-card-time'
import {
  PLATE_FIRST_ORIGIN_OPTIONS,
  defaultFirstOriginFromCustody,
  type PlateColourFirstOrigin,
} from '@/lib/hub-plate-origin'
import {
  HUB_PLATE_SIZE_OPTIONS,
  hubPlateSizeCardLine,
  type HubPlateSize,
} from '@/lib/plate-size'

type TriageRow = {
  id: string
  poLineId?: string | null
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
  reuseCyclesMax?: number
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
}

function hubSearchMatch(
  q: string,
  parts: Array<string | null | undefined>,
): boolean {
  if (!q) return true
  const hay = parts.map((p) => String(p ?? '').toLowerCase()).join(' ')
  return hay.includes(q)
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

type TriageStockInfo =
  | { matchCount: 0 }
  | { matchCount: number; labels: string[]; locationLabel: string | null }

function TriageStockColourDots({ labels }: { labels: string[] }) {
  if (!labels.length) return null
  const rows = hubChannelRowsFromLabels(labels)
  return (
    <span className="inline-flex items-center gap-1" aria-label={labels.join(', ')}>
      {rows.map(({ key, dot, label }) => (
        <span
          key={key}
          title={label}
          className={`inline-block h-3 w-3 rounded-full shrink-0 ${dot.bgClass} ${dot.ringClass}`}
        />
      ))}
    </span>
  )
}

function TriageInventoryStockLine({ stock }: { stock: TriageStockInfo }) {
  if (stock.matchCount === 0) {
    return <p className="text-xs text-gray-500 mt-1">Inventory: Not in stock</p>
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
      <span className="text-xs text-zinc-400">In rack:</span>
      {stock.labels.length > 0 ? <TriageStockColourDots labels={stock.labels} /> : null}
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

function ColourChannelsRow({ labels }: { labels: string[] }) {
  const rows = hubChannelRowsFromLabels(labels)
  if (!rows.length) {
    return <span className="text-xs text-zinc-500">—</span>
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-h-[1rem]" title={labels.join(' · ')}>
      {rows.map(({ key, dot, short, label }) => (
        <span key={key} className="inline-flex items-center gap-1" title={label}>
          <span
            className={`inline-block h-3 w-3 rounded-full shrink-0 ${dot.bgClass} ${dot.ringClass}`}
          />
          <span className="text-[10px] font-semibold text-zinc-400">{short}</span>
        </span>
      ))}
    </div>
  )
}

function HubPlateSizeLine({ size }: { size: HubPlateSize | null | undefined }) {
  const line = hubPlateSizeCardLine(size)
  if (!line) return null
  return <p className="text-xs font-medium text-zinc-400 leading-tight">{line}</p>
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
      ? 'bg-violet-600 border-violet-500 text-white'
      : accent === 'emerald'
        ? 'bg-emerald-600 border-emerald-500 text-white'
        : 'bg-amber-600 border-amber-500 text-white'
  const off = 'text-zinc-400 hover:text-white hover:bg-zinc-800 border-transparent'
  return (
    <div
      className="flex rounded-lg border border-zinc-600 overflow-hidden p-0.5 bg-black/60"
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

function HubStaleQueueTime({ at }: { at: string | null | undefined }) {
  const stale = hubQueueStale(at)
  const age = hubQueueAgeLabel(at)
  return (
    <p
      className={`mt-1.5 text-[10px] leading-tight ${
        stale ? 'text-red-400 font-medium' : 'text-zinc-500'
      }`}
    >
      Time in queue: {age}
    </p>
  )
}

function HubTriageTime({ at }: { at: string | null | undefined }) {
  return (
    <p className="mt-1.5 text-[10px] leading-tight text-zinc-500">
      Time in triage: {hubQueueAgeLabel(at)}
    </p>
  )
}

function HubRackAdded({ createdAt }: { createdAt: string | null | undefined }) {
  if (!createdAt) return null
  return (
    <p className="mt-1.5 text-[10px] leading-tight text-zinc-500">
      Added to rack: {hubAddedToRackLabel(createdAt)}
    </p>
  )
}

function HubCustodyReady({ at }: { at: string | null | undefined }) {
  return (
    <p className="mt-1.5 text-[10px] leading-tight text-zinc-500">
      Marked ready: {hubMarkedReadyLabel(at)}
    </p>
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

type MachineOpt = { id: string; machineCode: string; name: string }
type UserOpt = { id: string; name: string }

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
    }
  } catch {
    return null
  }
}

export default function HubPlateDashboard() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<DashboardPayload>({
    triage: [],
    ctpQueue: [],
    vendorQueue: [],
    inventory: [],
    custody: [],
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
    plateStoreId: string
    plateSetCode: string
    cartonName: string
    colourNames: string[]
    custodySource: CustodyCard['custodySource']
  } | null>(null)
  const [returnAuditPick, setReturnAuditPick] = useState<Record<string, boolean>>({})
  const [returnAuditOrigin, setReturnAuditOrigin] = useState<PlateColourFirstOrigin>('legacy_unknown')
  const [returnAuditStep, setReturnAuditStep] = useState<1 | 2>(1)

  const [ctpSearch, setCtpSearch] = useState('')
  const [vendorSearch, setVendorSearch] = useState('')
  const [invSearch, setInvSearch] = useState('')
  const [custSearch, setCustSearch] = useState('')

  const [stockModal, setStockModal] = useState<TriageRow | null>(null)
  const [stockPlateId, setStockPlateId] = useState('')
  const [stockRackSlot, setStockRackSlot] = useState('')

  const [addStockFieldErrors, setAddStockFieldErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

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

  const [emergencyTarget, setEmergencyTarget] = useState<CustodyCard | null>(null)
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])
  const [emergencyMachineId, setEmergencyMachineId] = useState('')
  const [emergencyOperatorId, setEmergencyOperatorId] = useState('')
  const [emergencyArtworkId, setEmergencyArtworkId] = useState('')
  const [emergencyJobCardId, setEmergencyJobCardId] = useState('')
  const [emergencySetNum, setEmergencySetNum] = useState('')

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try {
      const dRes = await fetch('/api/plate-hub/dashboard')
      const dText = await dRes.text()

      const parsed = safeReadDashboard(dText)
      if (!parsed) {
        toast.error('Unexpected dashboard response')
        setData({ triage: [], ctpQueue: [], vendorQueue: [], inventory: [], custody: [] })
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

  useEffect(() => {
    if (!emergencyTarget || emergencyTarget.kind !== 'plate') return
    void (async () => {
      try {
        const [mRes, uRes] = await Promise.all([fetch('/api/machines'), fetch('/api/users')])
        setMachines(safeJsonParseArray<MachineOpt>(await mRes.text(), []))
        setUsers(safeJsonParseArray<UserOpt>(await uRes.text(), []))
      } catch {
        setMachines([])
        setUsers([])
      }
      setEmergencyMachineId('')
      setEmergencyOperatorId('')
      setEmergencyArtworkId(String(emergencyTarget.artworkId ?? '').trim())
      setEmergencyJobCardId(String(emergencyTarget.jobCardId ?? '').trim())
      setEmergencySetNum(String(emergencyTarget.slotNumber ?? '').trim() || '01')
    })()
  }, [emergencyTarget])

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
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Recall failed')
        return
      }
      toast.success('Recalled to pre-press')
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

  async function receiveVendorToTriage(requirementId: string) {
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/vendor-received`, {
        method: 'POST',
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Receive failed')
        return
      }
      toast.success('Received — job back in incoming triage')
      await load()
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
    }
  }

  async function markPlateReadyRequirement(row: CtpRow, lane: 'ctp' | 'vendor') {
    const prev = data
    const nextCustody = custodyItemFromRequirement(row, lane)
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
        body: safeJsonStringify({ kind: 'requirement', id: row.id }),
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
    const returned = Object.entries(returnAuditPick)
      .filter(([, v]) => v)
      .map(([k]) => k)
    if (!returned.length) {
      toast.error('Select at least one plate returning to rack')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/plate-hub/return-to-rack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          plateStoreId: returnAuditModal.plateStoreId,
          returnedColourNames: returned,
          firstOrigin: returnAuditOrigin,
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

  async function submitEmergencyIssue() {
    if (!emergencyTarget || emergencyTarget.kind !== 'plate') return
    if (!emergencyMachineId.trim() || !emergencyOperatorId.trim()) {
      toast.error('Machine and operator are required')
      return
    }
    if (!emergencyArtworkId.trim() || !emergencyJobCardId.trim()) {
      toast.error('Artwork ID and job card ID are required for issue')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/plate-hub/emergency-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          plateStoreId: emergencyTarget.id,
          machineId: emergencyMachineId,
          operatorUserId: emergencyOperatorId,
          artworkId: emergencyArtworkId.trim(),
          jobCardId: emergencyJobCardId.trim(),
          setNumber: emergencySetNum.trim() || '01',
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Emergency issue failed')
      toast.success('Plate issued (bypass)')
      setEmergencyTarget(null)
      await load({ silent: true })
    } catch (e) {
      console.error(e)
      toast.error(e instanceof Error ? e.message : 'Emergency issue failed')
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
        map.set(row.id, { matchCount: 0 })
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
      if (locs.size === 1) locationLabel = [...locs][0]
      else if (locs.size > 1) locationLabel = `${[...locs][0]} +${locs.size - 1}`
      map.set(row.id, { matchCount: matches.length, labels, locationLabel })
    }
    return map
  }, [data.inventory, data.triage])

  const filteredCtp = useMemo(() => {
    const q = ctpSearch.trim().toLowerCase()
    return data.ctpQueue.filter((job) =>
      hubSearchMatch(q, [job.cartonName, job.artworkCode, job.requirementCode]),
    )
  }, [data.ctpQueue, ctpSearch])

  const filteredVendor = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase()
    return data.vendorQueue.filter((job) =>
      hubSearchMatch(q, [job.cartonName, job.artworkCode, job.requirementCode]),
    )
  }, [data.vendorQueue, vendorSearch])

  const filteredCustody = useMemo(() => {
    const q = custSearch.trim().toLowerCase()
    const list = data.custody
    if (!q) return list
    return list.filter((c) =>
      hubSearchMatch(q, [c.cartonName, c.artworkCode, c.displayCode]),
    )
  }, [data.custody, custSearch])

  function dispatchTriageToProduction(row: TriageRow, channel: 'inhouse_ctp' | 'outside_vendor') {
    const resolved = row.plateSize ?? row.cartonMasterPlateSize ?? null
    if (resolved) {
      void patchTriage(row.id, channel, undefined, resolved)
      return
    }
    setTriageSizeModal({ rowId: row.id, channel })
    setTriagePlateSizePick('SIZE_560_670')
  }

  async function patchTriage(
    id: string,
    channel: 'inhouse_ctp' | 'outside_vendor' | 'stock_available',
    rackSlot?: string,
    plateSize?: HubPlateSize,
  ) {
    if (!id?.trim()) {
      toast.error('Missing requirement id')
      return
    }
    setSaving(true)
    try {
      const body: Record<string, unknown> = { channel }
      if (channel === 'stock_available' && rackSlot?.trim()) body.rackSlot = rackSlot.trim()
      if (
        (channel === 'inhouse_ctp' || channel === 'outside_vendor') &&
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
      setStockPlateId('')
      setStockRackSlot('')
      setTriageSizeModal(null)
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Triage update failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100 p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <HubCategoryNav active="plates" />

        <header className="flex flex-col gap-1 border-b border-zinc-700 pb-4">
          <h1 className="text-2xl font-bold tracking-tight text-white">Plate Hub</h1>
          <p className="text-sm text-zinc-400">
            Preparation lanes → custody floor staging (mark ready). High-contrast layout for floor speed.
          </p>
        </header>

        {loading ? (
          <p className="text-zinc-500">Loading…</p>
        ) : (
          <>
            {/* ZONE 1 — Triage */}
            <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400 mb-2">Incoming triage</h2>
              <pre className="sr-only">Designer queue — AW / job codes</pre>
              <div className="space-y-3">
                {data.triage.length === 0 ? (
                  <p className="text-zinc-500 text-sm">No jobs awaiting triage.</p>
                ) : (
                  data.triage.map((row) => (
                    <div
                      key={row.id}
                      className="relative flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-3 rounded-lg border border-zinc-700 bg-black p-2 pr-12 lg:pr-14"
                    >
                      <PlateCountBadge
                        count={hubPlateBadgeCount({
                          totalPlates: row.newPlatesNeeded,
                          plateColours: row.plateColours,
                        })}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-amber-300 text-sm">{row.requirementCode}</p>
                        <p className="text-white font-medium truncate pr-1">{row.cartonName}</p>
                        <p className="text-zinc-400 text-xs mt-1">
                          Plates required:{' '}
                          <span className="text-white font-semibold">{row.newPlatesNeeded}</span>
                        </p>
                        <p className="text-xs text-zinc-400 mt-0.5">
                          AW: {row.artworkCode?.trim() || '—'}
                        </p>
                        <HubPlateSizeLine size={row.plateSize ?? row.cartonMasterPlateSize} />
                        <div className="mt-1">
                          <ColourChannelsRow labels={row.plateColours} />
                        </div>
                        <TriageInventoryStockLine
                          stock={triageRackStockById.get(row.id) ?? { matchCount: 0 }}
                        />
                        {row.lastStatusUpdatedAt ? (
                          <HubTriageTime at={row.lastStatusUpdatedAt} />
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => dispatchTriageToProduction(row, 'inhouse_ctp')}
                          className="px-3 py-2 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold disabled:opacity-50"
                        >
                          In-house CTP
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => {
                            setStockModal(row)
                            setStockPlateId('')
                            setStockRackSlot('')
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
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 lg:gap-6">
              {/* CTP */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 min-h-[280px] flex flex-col">
                <div className="flex flex-col gap-2 mb-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">CTP queue</h2>
                  <button
                    type="button"
                    onClick={() => {
                      resetManualCtpForm()
                      setManualCtpOpen(true)
                    }}
                    className="w-full px-3 py-2 rounded-md border border-amber-600/80 bg-amber-950/40 text-amber-100 text-xs font-bold hover:bg-amber-950/70"
                  >
                    + Manual CTP Request
                  </button>
                </div>
                <input
                  value={ctpSearch}
                  onChange={(e) => setCtpSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 overflow-y-auto max-h-[420px] pr-1 text-sm">
                  {filteredCtp.length === 0 ? (
                    <li className="text-zinc-500 text-sm">Empty.</li>
                  ) : (
                    filteredCtp.map((job) => (
                      <li
                        key={job.id}
                        className="relative rounded-lg border border-zinc-700 bg-black p-2 pr-10"
                      >
                        <PlateCountBadge
                          count={hubPlateBadgeCount({
                            numberOfColours: job.numberOfColours,
                            plateColours: job.plateColours,
                            totalPlates: job.newPlatesNeeded,
                          })}
                        />
                        <p className="font-mono text-amber-300 text-xs">{job.requirementCode}</p>
                        <p className="text-white font-semibold text-sm truncate mt-0.5 pr-1">
                          {job.cartonName}
                          {job.partialRemake ? (
                            <span className="text-rose-400 font-bold"> (Remake)</span>
                          ) : null}
                        </p>
                        <p className="text-xs text-zinc-400 mt-0.5">
                          AW: {job.artworkCode?.trim() || '—'}
                        </p>
                        <HubPlateSizeLine size={job.plateSize} />
                        <div className="mt-1">
                          <ColourChannelsRow labels={job.plateColours} />
                        </div>
                        <p className="text-xs text-zinc-400 mt-1 capitalize">
                          {job.status.replace(/_/g, ' ')}
                        </p>
                        <button
                          type="button"
                          className="mt-1.5 w-full px-2 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold"
                          onClick={() => void markPlateReadyRequirement(job, 'ctp')}
                        >
                          Mark plate ready
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void sendBackTriage(job.id)}
                          className="mt-1.5 w-full px-2 py-1.5 rounded border border-amber-700/80 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
                        >
                          Send back to Triage
                        </button>
                        <HubStaleQueueTime at={job.lastStatusUpdatedAt} />
                      </li>
                    ))
                  )}
                </ul>
              </section>

              {/* Outside vendor */}
              <section className="rounded-xl border-2 border-violet-900/80 bg-zinc-950 p-3 min-h-[280px] flex flex-col">
                <div className="flex flex-col gap-2 mb-1">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-violet-300">
                    Outside vendor
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      resetManualVendorForm()
                      setManualVendorOpen(true)
                    }}
                    className="w-full px-3 py-2 rounded-md border border-violet-500/80 bg-violet-950/40 text-violet-100 text-xs font-bold hover:bg-violet-950/70"
                  >
                    + Manual Vendor PO
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500 mb-2">Awaiting delivery · two-way decisions</p>
                <input
                  value={vendorSearch}
                  onChange={(e) => setVendorSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 overflow-y-auto max-h-[420px] pr-1 text-sm">
                  {filteredVendor.length === 0 ? (
                    <li className="text-zinc-500 text-sm">None at vendor.</li>
                  ) : (
                    filteredVendor.map((job) => (
                      <li
                        key={job.id}
                        className="relative rounded-lg border border-violet-800/50 bg-black p-2 pr-10"
                      >
                        <PlateCountBadge
                          count={hubPlateBadgeCount({
                            numberOfColours: job.numberOfColours,
                            plateColours: job.plateColours,
                            totalPlates: job.newPlatesNeeded,
                          })}
                        />
                        <p className="font-mono text-violet-200 text-xs">{job.requirementCode}</p>
                        <p className="text-white font-semibold text-sm truncate mt-0.5 pr-1">
                          {job.cartonName}
                          {job.partialRemake ? (
                            <span className="text-rose-400 font-bold"> (Remake)</span>
                          ) : null}
                        </p>
                        <p className="text-xs text-zinc-400 mt-0.5">
                          AW: {job.artworkCode?.trim() || '—'}
                        </p>
                        <HubPlateSizeLine size={job.plateSize} />
                        <div className="mt-1">
                          <ColourChannelsRow labels={job.plateColours} />
                        </div>
                        <p className="text-xs text-zinc-400 mt-1 capitalize">
                          {job.status.replace(/_/g, ' ')}
                        </p>
                        <button
                          type="button"
                          className="mt-1.5 w-full px-2 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold"
                          onClick={() => void markPlateReadyRequirement(job, 'vendor')}
                        >
                          Mark plate ready
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void receiveVendorToTriage(job.id)}
                          className="mt-1.5 w-full px-2 py-1.5 rounded bg-emerald-900/80 hover:bg-emerald-800 border border-emerald-700/60 text-emerald-100 text-xs font-semibold"
                        >
                          Received → Triage
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void sendVendorBackTriage(job.id)}
                          className="mt-1.5 w-full px-2 py-1.5 rounded border border-amber-700/80 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
                        >
                          Send back to Triage
                        </button>
                        <HubStaleQueueTime at={job.lastStatusUpdatedAt} />
                      </li>
                    ))
                  )}
                </ul>
              </section>

              {/* Inventory */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 min-h-[280px] flex flex-col">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400 mb-2">Live inventory</h2>
                <div className="flex flex-wrap gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => {
                      resetAddStockForm()
                      setAddStockOpen(true)
                    }}
                    className="px-3 py-2 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold"
                  >
                    + Add Plate Stock
                  </button>
                </div>
                <input
                  value={invSearch}
                  onChange={(e) => setInvSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 overflow-y-auto max-h-[420px] pr-1">
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
                          className="relative rounded-lg border border-zinc-800 bg-black p-2 pr-10"
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
                          {p.serialNumber ? (
                            <p className="text-zinc-400 text-xs font-mono">SN {p.serialNumber}</p>
                          ) : null}
                          <p className="text-white font-semibold text-sm truncate mt-0.5">{p.cartonName}</p>
                          <p className="text-xs text-zinc-400 mt-0.5">
                            AW: {p.artworkCode?.trim() || '—'}
                          </p>
                          <HubPlateSizeLine size={p.plateSize} />
                          <div className="mt-1">
                            <ColourChannelsRow labels={p.plateColours ?? []} />
                          </div>
                          {short > 0 ? (
                            <p className="text-xs font-bold text-red-500 mt-1">
                              ⚠️ Shortage: {short} Plates Missing
                            </p>
                          ) : null}
                          <p className="mt-1.5 text-sm font-semibold text-white leading-snug">
                            {locPrimary || '—'}
                          </p>
                          <p className="text-xs text-zinc-400 mt-0.5 uppercase tracking-wide">
                            Rack / slot
                            {p.ups != null && p.ups > 0 ? ` · UPS ${p.ups}` : ''}
                          </p>
                          <p className="text-[10px] text-zinc-500 mt-0.5 tabular-nums">
                            Max cycles: {p.reuseCyclesMax ?? 0}
                          </p>
                          <button
                            type="button"
                            className="mt-1.5 w-full py-1.5 rounded border border-rose-800/70 bg-rose-950/40 text-rose-100 text-[11px] font-semibold hover:bg-rose-950/70"
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
                            className="mt-1.5 w-full py-1.5 rounded border border-zinc-600 bg-zinc-900 text-zinc-200 text-[11px] font-semibold hover:bg-zinc-800"
                            onClick={() => setRemakePlate(p)}
                          >
                            Partial remake (CTP / vendor)
                          </button>
                          <button
                            type="button"
                            className="mt-1.5 w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold"
                            onClick={() => void markPlateReadyPlate(p)}
                          >
                            Mark plate ready
                          </button>
                          <HubRackAdded createdAt={p.createdAt} />
                        </li>
                      )
                    })
                  )}
                </ul>
              </section>

              {/* Custody */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 min-h-[280px] flex flex-col">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400 mb-0.5">
                  Custody floor
                </h2>
                <p className="text-[11px] text-zinc-500 mb-2">Staging · plates marked ready</p>
                <input
                  value={custSearch}
                  onChange={(e) => setCustSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 overflow-y-auto max-h-[420px] pr-1">
                  {filteredCustody.length === 0 ? (
                    <li className="text-zinc-500 text-sm">Nothing in staging.</li>
                  ) : (
                    filteredCustody.map((c) => (
                      <li
                        key={`${c.kind}-${c.id}`}
                        className={`relative rounded-lg bg-black p-2 pr-10 ${
                          c.kind === 'plate' && c.jobCardHub?.key === 'printed'
                            ? 'border border-emerald-600/70 shadow-[0_0_14px_rgba(16,185,129,0.12)]'
                            : 'border border-zinc-800'
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
                        <span className="inline-block px-1.5 py-0.5 rounded border border-emerald-700/60 bg-emerald-950/50 text-[10px] font-semibold text-emerald-200 mb-1">
                          {sourceBadgeLabel(c.custodySource)}
                        </span>
                        <p className="font-mono text-amber-300 text-xs">{c.displayCode}</p>
                        <p className="text-white font-semibold text-sm truncate mt-0.5 pr-1">
                          {c.cartonName}
                          {c.kind === 'requirement' && c.partialRemake ? (
                            <span className="text-rose-400 font-bold"> (Remake)</span>
                          ) : null}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
                          <span className="text-xs text-zinc-400">
                            AW: {c.artworkCode?.trim() || '—'}
                          </span>
                          <JobCardStatusBadge hub={c.jobCardHub} />
                        </div>
                        <HubPlateSizeLine size={c.plateSize} />
                        <div className="mt-1">
                          <ColourChannelsRow labels={c.plateColours} />
                        </div>
                        {c.kind === 'plate' ? (
                          <p className="text-xs text-zinc-400 mt-1">
                            {c.serialNumber ? `SN ${c.serialNumber}` : null}
                            {c.ups != null && c.ups > 0 ? ` · UPS ${c.ups}` : ''}
                          </p>
                        ) : null}
                        <div className="mt-1.5 flex flex-col gap-2">
                          {c.kind === 'plate' && plateColourNamesForScrap(c).length > 0 ? (
                            <button
                              type="button"
                              className={`w-full py-1.5 rounded text-white text-[11px] font-bold shadow-sm ${
                                c.jobCardHub?.key === 'printed'
                                  ? 'bg-emerald-500 hover:bg-emerald-400 ring-2 ring-emerald-300/40'
                                  : 'bg-emerald-700 hover:bg-emerald-600'
                              }`}
                              onClick={() =>
                                setReturnAuditModal({
                                  plateStoreId: c.id,
                                  plateSetCode: c.displayCode,
                                  cartonName: c.cartonName,
                                  colourNames: plateColourNamesForScrap(c),
                                  custodySource: c.custodySource,
                                })
                              }
                            >
                              Return to Rack
                            </button>
                          ) : null}
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
                            className="w-full py-1.5 rounded border-2 border-red-600/90 bg-gradient-to-b from-red-950/95 to-orange-950/90 text-orange-50 text-[11px] font-bold hover:from-red-900 hover:to-orange-900 shadow-[0_0_12px_rgba(220,38,38,0.25)]"
                            onClick={() => {
                              if (c.kind !== 'plate') {
                                toast.error(
                                  'Emergency issue applies to rack plate sets. This row is a CTP/vendor requirement — use Reverse / Undo or finish burning plates first.',
                                )
                                return
                              }
                              setEmergencyTarget(c)
                            }}
                          >
                            Emergency Issue (Bypass)
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
                          <HubCustodyReady at={c.lastStatusUpdatedAt} />
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

      {/* Add plate stock — master-linked */}
      {addStockOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-lg max-h-[90vh] rounded-xl border border-zinc-600 bg-zinc-950 flex flex-col shadow-2xl">
            <div className="p-4 pb-2 shrink-0 border-b border-zinc-800 z-20 relative">
            <h3 className="text-lg font-semibold text-white">Add plate stock</h3>
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
                  className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
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
                        className="w-full px-3 py-2 text-left text-sm text-white hover:bg-zinc-800 border-b border-zinc-800 last:border-0"
                        onClick={() => applyCartonSelection(hit)}
                      >
                        <span className="font-medium block truncate">{hit.cartonName}</span>
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
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
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
                  className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white disabled:opacity-50"
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
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Rack number
              <input
                value={addRackNumber}
                onChange={(e) => setAddRackNumber(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              No. of UPS
              <input
                value={addUps}
                onChange={(e) => setAddUps(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
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
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['C', stdC, setStdC],
                    ['M', stdM, setStdM],
                    ['Y', stdY, setStdY],
                    ['K', stdK, setStdK],
                  ] as const
                ).map(([label, on, setOn]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setOn(!on)}
                    className={`min-w-[2.5rem] px-3 py-2 rounded-md text-sm font-bold border ${
                      on
                        ? 'bg-amber-600 border-amber-500 text-white'
                        : 'bg-zinc-900 border-zinc-600 text-zinc-500'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPantoneOn(!pantoneOn)}
                  className={`px-3 py-2 rounded-md text-sm font-bold border ${
                    pantoneOn
                      ? 'bg-violet-700 border-violet-500 text-white'
                      : 'bg-zinc-900 border-zinc-600 text-zinc-500'
                  }`}
                >
                  Pantone
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
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                  />
                </label>
              ) : null}
            </div>
            <div className="rounded-lg border border-zinc-700 bg-black/50 px-3 py-2 flex items-center justify-between">
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
                className="px-3 py-2 rounded bg-emerald-600 text-white font-medium disabled:opacity-50"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Take from stock</h3>
            <p className="text-slate-400 text-sm">Link a plate set from rack to this job.</p>
            <label className="block text-sm text-zinc-300">
              Plate set
              <select
                value={stockPlateId}
                onChange={(e) => setStockPlateId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Select…</option>
                {data.inventory.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.plateSetCode} — {p.cartonName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              Rack slot (optional)
              <input
                value={stockRackSlot}
                onChange={(e) => setStockRackSlot(e.target.value)}
                placeholder="e.g. 2-3"
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="px-3 py-2 rounded border border-zinc-600 text-zinc-300" onClick={() => setStockModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || !stockPlateId.trim()}
                className="px-3 py-2 rounded bg-amber-600 text-white font-medium disabled:opacity-50"
                onClick={() => {
                  if (!stockModal?.id) {
                    toast.error('Missing requirement id')
                    return
                  }
                  void patchTriage(stockModal.id, 'stock_available', stockRackSlot)
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {triageSizeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-amber-700/50 bg-zinc-950 p-4 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Confirm plate size</h3>
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
                className="px-3 py-2 rounded bg-amber-600 text-white font-semibold disabled:opacity-50"
                onClick={() => {
                  if (!triageSizeModal) return
                  void patchTriage(
                    triageSizeModal.rowId,
                    triageSizeModal.channel,
                    undefined,
                    triagePlateSizePick,
                  )
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-lg max-h-[90vh] rounded-xl border border-zinc-600 bg-zinc-950 flex flex-col shadow-2xl">
            <div className="p-4 border-b border-zinc-800 shrink-0">
              <h3 className="text-lg font-semibold text-white">Manual CTP request</h3>
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
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
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
                          className="w-full px-3 py-2 text-left text-sm text-white hover:bg-zinc-800 border-b border-zinc-800 last:border-0"
                          onClick={() => {
                            setMCtpSelected(hit)
                            setMCtpQuery(hit.cartonName)
                            setMCtpResults([])
                            setMCtpPlateSize(hit.plateSize ?? 'SIZE_560_670')
                          }}
                        >
                          <span className="font-medium block truncate">{hit.cartonName}</span>
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
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ['C', mCtpC, setMCtpC],
                      ['M', mCtpM, setMCtpM],
                      ['Y', mCtpY, setMCtpY],
                      ['K', mCtpK, setMCtpK],
                    ] as const
                  ).map(([label, on, setOn]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setOn(!on)}
                      className={`min-w-[2.5rem] px-3 py-2 rounded-md text-sm font-bold border ${
                        on
                          ? 'bg-amber-600 border-amber-500 text-white'
                          : 'bg-zinc-900 border-zinc-600 text-zinc-500'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setMCtpPantone(!mCtpPantone)}
                    className={`px-3 py-2 rounded-md text-sm font-bold border ${
                      mCtpPantone
                        ? 'bg-violet-700 border-violet-500 text-white'
                        : 'bg-zinc-900 border-zinc-600 text-zinc-500'
                    }`}
                  >
                    Pantone
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
                      className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
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
                  className="px-3 py-2 rounded bg-amber-600 text-white font-semibold disabled:opacity-50"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-lg max-h-[90vh] rounded-xl border border-violet-600/60 bg-zinc-950 flex flex-col shadow-2xl">
            <div className="p-4 border-b border-zinc-800 shrink-0">
              <h3 className="text-lg font-semibold text-white">Manual vendor PO</h3>
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
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
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
                          className="w-full px-3 py-2 text-left text-sm text-white hover:bg-zinc-800 border-b border-zinc-800 last:border-0"
                          onClick={() => {
                            setMvSelected(hit)
                            setMvQuery(hit.cartonName)
                            setMvResults([])
                            setMvPlateSize(hit.plateSize ?? 'SIZE_560_670')
                          }}
                        >
                          <span className="font-medium block truncate">{hit.cartonName}</span>
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
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ['C', mvC, setMvC],
                      ['M', mvM, setMvM],
                      ['Y', mvY, setMvY],
                      ['K', mvK, setMvK],
                    ] as const
                  ).map(([label, on, setOn]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setOn(!on)}
                      className={`min-w-[2.5rem] px-3 py-2 rounded-md text-sm font-bold border ${
                        on
                          ? 'bg-violet-600 border-violet-400 text-white'
                          : 'bg-zinc-900 border-zinc-600 text-zinc-500'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setMvPantone(!mvPantone)}
                    className={`px-3 py-2 rounded-md text-sm font-bold border ${
                      mvPantone
                        ? 'bg-violet-700 border-violet-500 text-white'
                        : 'bg-zinc-900 border-zinc-600 text-zinc-500'
                    }`}
                  >
                    Pantone
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
                      className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
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
                  className="px-3 py-2 rounded bg-violet-600 text-white font-semibold disabled:opacity-50"
                  onClick={() => void submitManualVendorRequest()}
                >
                  Create vendor job
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scrap & damage — per channel */}
      {scrapModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-rose-800/50 bg-zinc-950 p-4 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold text-white">Scrap &amp; damage report</h3>
              <p className="text-zinc-500 text-xs mt-1">
                Step 1 — which plates are scrapped? Step 2 — reason. Counts update immediately.
              </p>
              <p className="text-xs font-mono text-amber-300 mt-2">{scrapModal.plateSetCode}</p>
              <p className="text-sm text-white font-medium truncate">{scrapModal.cartonName}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
                Step 1 — Which plate?
              </p>
              <div className="space-y-2 rounded-lg border border-zinc-700 bg-black/40 p-3">
                {scrapModal.colourNames.length === 0 ? (
                  <p className="text-xs text-zinc-500">No active channels on this set.</p>
                ) : (
                  scrapModal.colourNames.map((name) => (
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
                        className="rounded border-zinc-600"
                      />
                      <span className="flex items-center gap-2 min-w-0">
                        <ColourChannelsRow labels={[name]} />
                        <span className="truncate text-xs">{name}</span>
                      </span>
                    </label>
                  ))
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
                className="w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm"
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
                className="px-3 py-2 rounded bg-rose-700 text-white font-semibold disabled:opacity-50"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-emerald-800/50 bg-zinc-950 p-4 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold text-white">Return &amp; audit</h3>
              <p className="text-zinc-500 text-xs mt-1">
                Confirm which plates go back to live inventory. Unchecked channels are logged as not
                returned and follow the scrap workflow.
              </p>
              <p className="text-xs font-mono text-amber-300 mt-2">{returnAuditModal.plateSetCode}</p>
              <p className="text-sm text-white font-medium truncate">{returnAuditModal.cartonName}</p>
            </div>

            {returnAuditStep === 1 ? (
              <>
                <div>
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
                    Step 1 — Select plates safely returning to rack
                  </p>
                  <div className="space-y-2 rounded-lg border border-zinc-700 bg-black/40 p-3">
                    {returnAuditModal.colourNames.length === 0 ? (
                      <p className="text-xs text-zinc-500">No active channels on this set.</p>
                    ) : (
                      returnAuditModal.colourNames.map((name) => (
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
                            className="rounded border-zinc-600"
                          />
                          <span className="flex items-center gap-2 min-w-0">
                            <ColourChannelsRow labels={[name]} />
                            <span className="truncate text-xs">{name}</span>
                          </span>
                        </label>
                      ))
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
                      !returnAuditModal.colourNames.length ||
                      !Object.values(returnAuditPick).some(Boolean)
                    }
                    className="px-3 py-2 rounded bg-emerald-700 text-white font-semibold disabled:opacity-50"
                    onClick={() => {
                      if (!Object.values(returnAuditPick).some(Boolean)) {
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
                <div>
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
                    Step 2 — Confirm plate origin (for analytics)
                  </p>
                  <p className="text-[11px] text-zinc-500 mb-3">
                    Default follows custody source; override if needed for reporting accuracy.
                  </p>
                  <fieldset className="space-y-2 rounded-lg border border-zinc-700 bg-black/40 p-3">
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
                    disabled={saving}
                    className="px-3 py-2 rounded bg-emerald-600 text-white font-semibold disabled:opacity-50"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold text-white">Report damage / remake</h3>
              <p className="text-zinc-500 text-xs mt-1">
                Which plate is missing or damaged? The rack set stays; a new{' '}
                <span className="text-rose-400 font-semibold">(Remake)</span> job is created for only the
                selected colours.
              </p>
              <p className="text-sm text-amber-200/90 font-mono mt-2">{remakePlate.plateSetCode}</p>
              <p className="text-white text-sm font-medium truncate">{remakePlate.cartonName}</p>
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
              <div className="space-y-2 rounded-lg border border-zinc-700 bg-black/40 p-3">
                {Object.keys(remakePick).length === 0 ? (
                  <p className="text-xs text-zinc-500">No colour channels on this set.</p>
                ) : (
                  Object.keys(remakePick).map((name) => (
                    <label key={name} className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={remakePick[name] ?? false}
                        onChange={(e) =>
                          setRemakePick((prev) => ({ ...prev, [name]: e.target.checked }))
                        }
                        className="rounded border-zinc-600"
                      />
                      <span className="flex items-center gap-2 min-w-0">
                        <ColourChannelsRow labels={[name]} />
                        <span className="truncate text-xs text-zinc-300">{name}</span>
                      </span>
                    </label>
                  ))
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
                className="px-3 py-2 rounded bg-rose-800 text-white font-semibold disabled:opacity-50"
                onClick={() => void submitPartialRemake()}
              >
                Create partial request
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Emergency issue (bypass planning) */}
      {emergencyTarget && emergencyTarget.kind === 'plate' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-orange-700/50 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Emergency issue (bypass)</h3>
            <p className="text-zinc-500 text-xs">
              Issue this staged plate directly to the machine. Use for on-the-fly remakes or floor
              urgency.
            </p>
            <p className="text-sm font-mono text-amber-300">{emergencyTarget.displayCode}</p>
            <label className="block text-sm text-zinc-300">
              Machine
              <select
                value={emergencyMachineId}
                onChange={(e) => setEmergencyMachineId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Select…</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.machineCode} — {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              Operator
              <select
                value={emergencyOperatorId}
                onChange={(e) => setEmergencyOperatorId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Select…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              Artwork ID
              <input
                value={emergencyArtworkId}
                onChange={(e) => setEmergencyArtworkId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white font-mono text-sm"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Job card ID
              <input
                value={emergencyJobCardId}
                onChange={(e) => setEmergencyJobCardId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white font-mono text-sm"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Set #
              <input
                value={emergencySetNum}
                onChange={(e) => setEmergencySetNum(e.target.value)}
                placeholder="01"
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setEmergencyTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-gradient-to-b from-red-800 to-orange-800 text-white font-semibold disabled:opacity-50"
                onClick={() => void submitEmergencyIssue()}
              >
                Issue now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
