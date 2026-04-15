'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'
import {
  hubAddedToRackLabel,
  hubMarkedReadyLabel,
  hubQueueAgeLabel,
  hubQueueStale,
} from '@/lib/hub-card-time'
import { calculateToolingZoneMetrics, toolingCardUnits } from '@/lib/tooling-hub-metrics'
import {
  ToolingHubLedgerTable,
  TOOLING_LEDGER_ZONE_OPTIONS_BLOCKS,
  TOOLING_LEDGER_ZONE_OPTIONS_DIES,
  getFilteredToolingLedgerRows,
  type ToolingLedgerRow,
} from '@/components/hub/ToolingHubLedgerTable'
import { ToolingJobAuditModal, type ToolingHubAuditContext } from '@/components/hub/ToolingJobAuditModal'
import { TableExportMenu } from '@/components/hub/TableExportMenu'
import {
  toolingMasterLedgerExportColumns,
  toolingMasterLedgerExcelExtraColumns,
} from '@/lib/hub-ledger-export-columns'

const TOOLING_RETURN_SIZE_REASONS: {
  value: 'alternate_machine' | 'edge_damage' | 'prepress_error'
  label: string
}[] = [
  { value: 'alternate_machine', label: 'Resized for alternate machine assignment' },
  { value: 'edge_damage', label: 'Trimmed due to edge damage / wear' },
  { value: 'prepress_error', label: 'Pre-press layout error / Manual correction' },
]

function ZoneCapacitySubheader({
  jobCount,
  unitCount,
}: {
  jobCount: number
  unitCount: number
}) {
  return (
    <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold tabular-nums leading-tight shrink-0">
      {jobCount} jobs · {unitCount} units
    </p>
  )
}

type JobCardHub = { key: string; badgeLabel: string }

type DieRow = {
  id: string
  kind: 'die'
  displayCode: string
  title: string
  ups: number
  dimensionsLabel: string
  sheetSize: string | null
  materialLabel: string
  location: string | null
  knifeHeightMm: number | null
  impressionCount: number
  reuseCount: number
  currentStock: number
  custodyStatus: string
  lastStatusUpdatedAt: string
  createdAt: string
  jobCardHub: JobCardHub | null
}

type EmbossRow = {
  id: string
  kind: 'emboss'
  displayCode: string
  title: string
  typeLabel: string
  materialLabel: string
  blockSize: string | null
  storageLocation: string | null
  impressionCount: number
  reuseCount: number
  custodyStatus: string
  lastStatusUpdatedAt: string
  createdAt: string
  jobCardHub: JobCardHub | null
}

type ToolRow = DieRow | EmbossRow

type DashboardPayload = {
  tool: 'dies' | 'blocks'
  triage: ToolRow[]
  prep: ToolRow[]
  inventory: ToolRow[]
  custody: ToolRow[]
  ledgerRows: ToolingLedgerRow[]
}

type MachineOpt = { id: string; machineCode: string; name: string }
type UserOpt = { id: string; name: string }

function JobCardStatusBadge({ hub }: { hub: JobCardHub | null | undefined }) {
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

function HubStaleTime({ at }: { at: string | null | undefined }) {
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

async function postTransition(body: Record<string, unknown>) {
  const r = await fetch('/api/tooling-hub/transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: safeJsonStringify(body),
  })
  const t = await r.text()
  const j = safeJsonParse<{ error?: string }>(t, {})
  if (!r.ok) throw new Error(j.error ?? 'Request failed')
}

export default function HubToolingKanbanDashboard({ mode }: { mode: 'dies' | 'blocks' }) {
  const tool = mode === 'dies' ? 'dies' : 'blocks'
  const toolKind = mode === 'dies' ? 'die' : 'emboss'

  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [saving, setSaving] = useState(false)

  const [triageSearch, setTriageSearch] = useState('')
  const [prepSearch, setPrepSearch] = useState('')
  const [invSearch, setInvSearch] = useState('')
  const [custSearch, setCustSearch] = useState('')

  const [scrapId, setScrapId] = useState<string | null>(null)
  const [scrapReason, setScrapReason] = useState('')

  const [hubView, setHubView] = useState<'board' | 'table'>('board')
  const [ledgerSearch, setLedgerSearch] = useState('')
  const [ledgerZoneFilter, setLedgerZoneFilter] = useState('')
  const [toolingAudit, setToolingAudit] = useState<ToolingHubAuditContext | null>(null)

  const [returnModal, setReturnModal] = useState<ToolRow | null>(null)
  const [returnDieCarton, setReturnDieCarton] = useState('')
  const [returnDieSheet, setReturnDieSheet] = useState('')
  const [returnEmbossSize, setReturnEmbossSize] = useState('')
  const [returnSizeReason, setReturnSizeReason] = useState<
    '' | 'alternate_machine' | 'edge_damage' | 'prepress_error'
  >('')
  const [returnSizeRemarks, setReturnSizeRemarks] = useState('')

  const [emergencyId, setEmergencyId] = useState<string | null>(null)
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])
  const [emergencyMachineId, setEmergencyMachineId] = useState('')
  const [emergencyOperatorId, setEmergencyOperatorId] = useState('')

  const [manualDieOpen, setManualDieOpen] = useState(false)
  const [mdNumber, setMdNumber] = useState('')
  const [mdCartonSize, setMdCartonSize] = useState('')
  const [mdSheetSize, setMdSheetSize] = useState('')
  const [mdUps, setMdUps] = useState('1')
  const [mdMaterial, setMdMaterial] = useState('Laser')

  const [manualEmbossOpen, setManualEmbossOpen] = useState(false)
  const [meCode, setMeCode] = useState('')
  const [meType, setMeType] = useState('Blind Emboss')
  const [meMaterial, setMeMaterial] = useState('Magnesium')
  const [meSize, setMeSize] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/tooling-hub/dashboard?tool=${tool}`)
      const t = await r.text()
      const parsed = safeJsonParse<DashboardPayload | null>(t, null)
      if (!parsed || parsed.tool !== tool) {
        toast.error('Unexpected dashboard response')
        setData({ tool, triage: [], prep: [], inventory: [], custody: [], ledgerRows: [] })
      } else {
        setData({
          ...parsed,
          ledgerRows: Array.isArray(parsed.ledgerRows) ? parsed.ledgerRows : [],
        })
      }
      if (!r.ok) {
        const err = safeJsonParse<{ error?: string }>(t, {})
        toast.error(err.error ?? `Load failed (${r.status})`)
      }
    } catch (e) {
      console.error(e)
      toast.error('Failed to load hub')
    } finally {
      setLoading(false)
    }
  }, [tool])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!emergencyId) return
    void (async () => {
      try {
        const [mRes, uRes] = await Promise.all([fetch('/api/machines'), fetch('/api/users')])
        setMachines(safeJsonParse<MachineOpt[]>(await mRes.text(), []))
        setUsers(safeJsonParse<UserOpt[]>(await uRes.text(), []))
      } catch {
        setMachines([])
        setUsers([])
      }
      setEmergencyMachineId('')
      setEmergencyOperatorId('')
    })()
  }, [emergencyId])

  const filterRows = (list: ToolRow[], q: string) => {
    const s = q.trim().toLowerCase()
    if (!s) return list
    return list.filter((r) => {
      const hay = [r.displayCode, r.title, r.kind === 'die' ? r.materialLabel : r.typeLabel]
        .join(' ')
        .toLowerCase()
      return hay.includes(s)
    })
  }

  const triageF = useMemo(
    () => filterRows(data?.triage ?? [], triageSearch),
    [data?.triage, triageSearch],
  )
  const prepF = useMemo(() => filterRows(data?.prep ?? [], prepSearch), [data?.prep, prepSearch])
  const invF = useMemo(
    () => filterRows(data?.inventory ?? [], invSearch),
    [data?.inventory, invSearch],
  )
  const custF = useMemo(
    () => filterRows(data?.custody ?? [], custSearch),
    [data?.custody, custSearch],
  )

  const triageMetrics = useMemo(
    () => calculateToolingZoneMetrics(triageF, toolingCardUnits),
    [triageF],
  )
  const prepMetrics = useMemo(
    () => calculateToolingZoneMetrics(prepF, toolingCardUnits),
    [prepF],
  )
  const invMetrics = useMemo(
    () => calculateToolingZoneMetrics(invF, toolingCardUnits),
    [invF],
  )
  const custMetrics = useMemo(
    () => calculateToolingZoneMetrics(custF, toolingCardUnits),
    [custF],
  )

  const ledgerZoneOptions =
    mode === 'dies' ? TOOLING_LEDGER_ZONE_OPTIONS_DIES : TOOLING_LEDGER_ZONE_OPTIONS_BLOCKS

  const filteredLedgerRows = useMemo(
    () => getFilteredToolingLedgerRows(data?.ledgerRows ?? [], ledgerSearch, ledgerZoneFilter),
    [data?.ledgerRows, ledgerSearch, ledgerZoneFilter],
  )
  const toolingLedgerExportColumns = useMemo(() => toolingMasterLedgerExportColumns(), [])
  const toolingLedgerExcelExtraColumns = useMemo(() => toolingMasterLedgerExcelExtraColumns(), [])
  const toolingLedgerExportFilterSummary = useMemo(() => {
    const parts: string[] = []
    if (ledgerZoneFilter) {
      const o = ledgerZoneOptions.find((x) => x.value === ledgerZoneFilter)
      parts.push(o ? `Zone: ${o.label}` : `Zone: ${ledgerZoneFilter}`)
    }
    if (ledgerSearch.trim()) parts.push(`Search: "${ledgerSearch.trim()}"`)
    return parts
  }, [ledgerZoneFilter, ledgerSearch, ledgerZoneOptions])
  const filteredLedgerSummary = useMemo(() => {
    const units = filteredLedgerRows.reduce((s, r) => s + (r.units ?? 1), 0)
    return { jobs: filteredLedgerRows.length, units }
  }, [filteredLedgerRows])

  function openReturnModal(r: ToolRow) {
    setReturnModal(r)
    if (r.kind === 'die') {
      setReturnDieCarton(r.dimensionsLabel === '—' ? '' : r.dimensionsLabel)
      setReturnDieSheet(r.sheetSize ?? '')
    } else {
      setReturnEmbossSize(r.blockSize ?? '')
    }
    setReturnSizeReason('')
    setReturnSizeRemarks('')
  }

  async function submitReturnToRack() {
    if (!returnModal) return
    const origDieCarton =
      returnModal.kind === 'die'
        ? returnModal.dimensionsLabel === '—'
          ? ''
          : returnModal.dimensionsLabel
        : ''
    const origDieSheet = returnModal.kind === 'die' ? returnModal.sheetSize ?? '' : ''
    const origEmbossSize = returnModal.kind === 'emboss' ? returnModal.blockSize ?? '' : ''

    const nextDieCarton = returnDieCarton.trim()
    const nextDieSheet = returnDieSheet.trim()
    const nextEmboss = returnEmbossSize.trim()

    const sizeChanged =
      returnModal.kind === 'die'
        ? nextDieCarton !== origDieCarton.trim() || nextDieSheet !== origDieSheet.trim()
        : nextEmboss !== origEmbossSize.trim()

    if (sizeChanged && !returnSizeReason) {
      toast.error('Select a reason when changing dimensions on return')
      return
    }

    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        tool: returnModal.kind === 'die' ? 'die' : 'emboss',
        id: returnModal.id,
      }
      if (returnModal.kind === 'die') {
        body.targetCartonSize = nextDieCarton
        body.targetSheetSize = nextDieSheet
      } else {
        body.targetBlockSize = nextEmboss || undefined
      }
      if (returnSizeReason) {
        body.sizeModificationReason = returnSizeReason
        if (returnSizeRemarks.trim()) body.sizeModificationRemarks = returnSizeRemarks.trim()
      }
      const r = await fetch('/api/tooling-hub/return-to-rack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify(body),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Return failed')
      toast.success('Returned to live inventory')
      setReturnModal(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Return failed')
    } finally {
      setSaving(false)
    }
  }

  async function runTransition(body: Record<string, unknown>, msg: string) {
    setSaving(true)
    try {
      await postTransition(body)
      toast.success(msg)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitManualDie() {
    const n = parseInt(mdNumber, 10)
    if (!Number.isFinite(n) || n < 1) {
      toast.error('Valid dye # required')
      return
    }
    if (!mdCartonSize.trim()) {
      toast.error('Carton / dimensions label required')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/tooling-hub/dies/manual-vendor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          dyeNumber: n,
          cartonSize: mdCartonSize.trim(),
          sheetSize: mdSheetSize.trim() || undefined,
          ups: mdUps.trim() ? parseInt(mdUps, 10) : undefined,
          dieMaterial: mdMaterial.trim() || undefined,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Failed')
      toast.success('Die added — Outside vendor')
      setManualDieOpen(false)
      setMdNumber('')
      setMdCartonSize('')
      setMdSheetSize('')
      setMdUps('1')
      setMdMaterial('Laser')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitManualEmboss() {
    if (!meCode.trim() || !meType.trim()) {
      toast.error('Block code and type required')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/tooling-hub/emboss/manual-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          blockCode: meCode.trim(),
          blockType: meType.trim(),
          blockMaterial: meMaterial.trim() || undefined,
          blockSize: meSize.trim() || undefined,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Failed')
      toast.success('Block queued — In-house engraving')
      setManualEmbossOpen(false)
      setMeCode('')
      setMeType('Blind Emboss')
      setMeMaterial('Magnesium')
      setMeSize('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitEmergency() {
    if (!emergencyId) return
    if (!emergencyMachineId || !emergencyOperatorId) {
      toast.error('Machine and operator required')
      return
    }
    setSaving(true)
    try {
      const path =
        mode === 'dies'
          ? `/api/inventory-hub/dies/${emergencyId}/issue`
          : `/api/inventory-hub/emboss-blocks/${emergencyId}/issue`
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          machineId: emergencyMachineId,
          operatorUserId: emergencyOperatorId,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Issue failed')
      toast.success('Issued (bypass)')
      setEmergencyId(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Issue failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitScrap() {
    if (!scrapId || scrapReason.trim().length < 3) {
      toast.error('Enter a scrap reason')
      return
    }
    await runTransition(
      { action: 'scrap', tool: toolKind, id: scrapId, reason: scrapReason.trim() },
      'Scrapped',
    )
    setScrapId(null)
    setScrapReason('')
  }

  function toolingSpecSummaryLine(r: ToolRow): string {
    if (r.kind === 'die') {
      return `UPS ${r.ups} · ${r.dimensionsLabel} · ${r.materialLabel}`
    }
    return `${r.typeLabel} · ${r.materialLabel}${r.blockSize ? ` · ${r.blockSize}` : ''}`
  }

  function zoneLabelForBoard(z: 'triage' | 'prep' | 'inventory' | 'custody'): string {
    if (z === 'triage') return 'Incoming triage'
    if (z === 'inventory') return 'Live inventory'
    if (z === 'custody') return 'Custody floor'
    return mode === 'dies' ? 'Outside vendor' : 'In-house engraving'
  }

  function renderSpecs(r: ToolRow) {
    if (r.kind === 'die') {
      return (
        <div className="mt-1 space-y-0.5 text-xs font-medium text-zinc-400">
          <p>
            Ups: <span className="text-zinc-300">{r.ups}</span>
          </p>
          <p>
            Dimensions: <span className="text-zinc-300">{r.dimensionsLabel}</span>
            {r.sheetSize ? (
              <span className="text-zinc-500"> · Sheet {r.sheetSize}</span>
            ) : null}
          </p>
          <p>
            Material: <span className="text-zinc-300">{r.materialLabel}</span>
          </p>
          {r.location ? (
            <p className="text-[10px] text-zinc-500">Rack: {r.location}</p>
          ) : null}
        </div>
      )
    }
    return (
      <div className="mt-1 space-y-0.5 text-xs font-medium text-zinc-400">
        <p>
          Type: <span className="text-zinc-300">{r.typeLabel}</span>
        </p>
        <p>
          Material: <span className="text-zinc-300">{r.materialLabel}</span>
        </p>
        {r.blockSize ? (
          <p>
            Size: <span className="text-zinc-300">{r.blockSize}</span>
          </p>
        ) : null}
        {r.storageLocation ? (
          <p className="text-[10px] text-zinc-500">Rack: {r.storageLocation}</p>
        ) : null}
      </div>
    )
  }

  function renderCard(
    r: ToolRow,
    zone: 'triage' | 'prep' | 'inventory' | 'custody',
  ) {
    return (
      <li
        key={`${r.kind}-${r.id}`}
        className={`rounded-lg border bg-black p-2 ${
          zone === 'custody' && r.jobCardHub?.key === 'printed'
            ? 'border-emerald-600/70 shadow-[0_0_12px_rgba(16,185,129,0.12)]'
            : 'border-zinc-800'
        }`}
      >
        <p className="font-mono text-amber-300 text-xs">{r.displayCode}</p>
        <button
          type="button"
          className="text-left w-full text-white font-semibold text-sm truncate mt-0.5 pr-1 hover:text-blue-300 hover:underline"
          onClick={() =>
            setToolingAudit({
              tool: r.kind === 'die' ? 'die' : 'emboss',
              id: r.id,
              zoneLabel: zoneLabelForBoard(zone),
              displayCode: r.displayCode,
              title: r.title,
              specSummary: toolingSpecSummaryLine(r),
              units: toolingCardUnits(r),
            })
          }
        >
          {r.title}
        </button>
        {zone === 'custody' ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
            <JobCardStatusBadge hub={r.jobCardHub} />
          </div>
        ) : null}
        {renderSpecs(r)}
        {zone === 'triage' ? (
          <>
            <button
              type="button"
              disabled={saving}
              className="mt-1.5 w-full py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold disabled:opacity-50"
              onClick={() =>
                void runTransition(
                  { action: 'triage_to_prep', tool: toolKind, id: r.id },
                  mode === 'dies' ? 'Sent to vendor lane' : 'Sent to engraving queue',
                )
              }
            >
              {mode === 'dies' ? 'Route to outside vendor' : 'Route to in-house queue'}
            </button>
            <HubTriageTime at={r.lastStatusUpdatedAt} />
          </>
        ) : null}
        {zone === 'prep' ? (
          <>
            <button
              type="button"
              disabled={saving}
              className="mt-1.5 w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
              onClick={() => void runTransition({ action: 'mark_ready', tool: toolKind, id: r.id }, 'Marked ready')}
            >
              Mark ready
            </button>
            <HubStaleTime at={r.lastStatusUpdatedAt} />
          </>
        ) : null}
        {zone === 'inventory' ? (
          <>
            <p className="text-[10px] font-medium text-zinc-400 mt-1 tabular-nums">
              Reuse cycles: {r.reuseCount ?? 0}
            </p>
            <button
              type="button"
              disabled={saving}
              className="mt-1.5 w-full py-1.5 rounded border border-zinc-600 bg-zinc-900 text-zinc-200 text-[11px] font-semibold hover:bg-zinc-800 disabled:opacity-50"
              onClick={() =>
                void runTransition({ action: 'push_to_triage', tool: toolKind, id: r.id }, 'Sent to triage')
              }
            >
              Push to incoming triage
            </button>
            <HubRackAdded createdAt={r.createdAt} />
          </>
        ) : null}
        {zone === 'custody' ? (
          <div className="mt-1.5 flex flex-col gap-2">
            <button
              type="button"
              disabled={saving}
              className={`w-full py-1.5 rounded text-white text-[11px] font-bold shadow-sm ${
                r.jobCardHub?.key === 'printed'
                  ? 'bg-emerald-500 hover:bg-emerald-400 ring-2 ring-emerald-300/40'
                  : 'bg-emerald-700 hover:bg-emerald-600'
              }`}
              onClick={() => openReturnModal(r)}
            >
              Return to rack
            </button>
            <button
              type="button"
              className="w-full py-1.5 rounded border border-rose-800/70 bg-rose-950/40 text-rose-100 text-[11px] font-semibold hover:bg-rose-950/70"
              onClick={() => {
                setScrapId(r.id)
                setScrapReason('')
              }}
            >
              Scrap / Report Damage
            </button>
            <button
              type="button"
              className="w-full py-1.5 rounded border-2 border-red-600/90 bg-gradient-to-b from-red-950/95 to-orange-950/90 text-orange-50 text-[11px] font-bold hover:from-red-900 hover:to-orange-900"
              onClick={() => setEmergencyId(r.id)}
            >
              Emergency Issue (Bypass)
            </button>
            <button
              type="button"
              className="w-full py-1.5 rounded border border-amber-800/80 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
              onClick={() =>
                void runTransition({ action: 'reverse_staging', tool: toolKind, id: r.id }, 'Reversed')
              }
            >
              Reverse / Undo
            </button>
            <HubCustodyReady at={r.lastStatusUpdatedAt} />
          </div>
        ) : null}
      </li>
    )
  }

  const title = mode === 'dies' ? 'Die Hub' : 'Emboss Block Hub'
  const navActive = mode === 'dies' ? 'dies' : 'blocks'
  const prepHeading = mode === 'dies' ? 'Outside vendor' : 'In-house engraving'
  const prepSub =
    mode === 'dies' ? 'Awaiting die from vendor · mark ready when received' : 'Internal queue · mark ready when complete'

  return (
    <div className="min-h-screen bg-black text-zinc-100 p-4 md:p-6">
      <div className="max-w-[1400px] mx-auto space-y-6">
        <HubCategoryNav active={navActive} />

        <header className="flex flex-col gap-3 border-b border-zinc-700 pb-4">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight text-white">{title}</h1>
              <p className="text-sm text-zinc-400 mt-1">
                Preparation lanes → custody staging. High-contrast layout for floor speed.
              </p>
            </div>
            <div
              className="flex rounded-lg border border-zinc-600 overflow-hidden p-0.5 bg-black/60 shrink-0"
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
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
              >
                Board view
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={hubView === 'table'}
                onClick={() => setHubView('table')}
                className={`px-3 py-2 rounded-md text-xs font-bold transition-colors ${
                  hubView === 'table'
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
              >
                Table view
              </button>
            </div>
          </div>
        </header>

        {loading || !data ? (
          <p className="text-zinc-500">Loading…</p>
        ) : hubView === 'table' ? (
          <div className="space-y-4">
            <div
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold tabular-nums"
              role="status"
            >
              <span className="text-zinc-300">
                Showing {filteredLedgerSummary.jobs}{' '}
                {filteredLedgerSummary.jobs === 1 ? 'job' : 'jobs'}
              </span>
              <span className="text-zinc-600 mx-1">·</span>
              <span>{filteredLedgerSummary.units} total units across selected filters</span>
            </div>
            <div className="flex flex-col lg:flex-row flex-wrap gap-3 lg:items-end lg:justify-between">
              <div className="flex flex-col lg:flex-row flex-wrap gap-3 lg:items-end flex-1 min-w-0">
                <label className="block flex-1 min-w-[200px]">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                    Search
                  </span>
                  <input
                    value={ledgerSearch}
                    onChange={(e) => setLedgerSearch(e.target.value)}
                    placeholder="Code, title, specs, zone…"
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                  />
                </label>
                <label className="block min-w-[180px]">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                    Zone
                  </span>
                  <select
                    value={ledgerZoneFilter}
                    onChange={(e) => setLedgerZoneFilter(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm"
                  >
                    {ledgerZoneOptions.map((o) => (
                      <option key={o.value || 'all'} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <TableExportMenu
                rows={filteredLedgerRows}
                columns={toolingLedgerExportColumns}
                excelOnlyColumns={toolingLedgerExcelExtraColumns}
                fileBase={mode === 'dies' ? 'die-hub-master-ledger' : 'emboss-hub-master-ledger'}
                reportTitle={mode === 'dies' ? 'Die Hub — Master ledger' : 'Emboss Hub — Master ledger'}
                sheetName={mode === 'dies' ? 'Die Hub' : 'Emboss Hub'}
                filterSummary={toolingLedgerExportFilterSummary}
                className="shrink-0"
              />
            </div>
            <ToolingHubLedgerTable
              rows={data.ledgerRows}
              searchQuery={ledgerSearch}
              zoneFilter={ledgerZoneFilter}
              onOpenAudit={setToolingAudit}
            />
          </div>
        ) : (
          <>
            <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3">
              <div className="flex flex-col gap-1 mb-2 min-w-0">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                  Incoming triage
                </h2>
                <ZoneCapacitySubheader
                  jobCount={triageMetrics.jobCount}
                  unitCount={triageMetrics.unitCount}
                />
              </div>
              <input
                value={triageSearch}
                onChange={(e) => setTriageSearch(e.target.value)}
                placeholder="Search…"
                className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
              />
              <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 max-h-[min(26rem,calc(100vh-14rem))] xl:max-h-none">
                {triageF.length === 0 ? (
                  <li className="text-zinc-500 text-sm">No jobs awaiting triage.</li>
                ) : (
                  triageF.map((r) => renderCard(r, 'triage'))
                )}
              </ul>
            </section>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6 xl:min-h-[min(70vh,calc(100vh-14rem))] xl:items-stretch">
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 flex flex-col min-h-[260px] xl:min-h-0 xl:h-full">
                <div className="flex flex-col gap-2 mb-2 min-w-0">
                  <div className="flex flex-col gap-1 min-w-0">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                      {prepHeading}
                    </h2>
                    <ZoneCapacitySubheader
                      jobCount={prepMetrics.jobCount}
                      unitCount={prepMetrics.unitCount}
                    />
                  </div>
                  <p className="text-[11px] text-zinc-500">{prepSub}</p>
                  {mode === 'dies' ? (
                    <button
                      type="button"
                      onClick={() => setManualDieOpen(true)}
                      className="w-full px-3 py-2 rounded-md border border-violet-500/80 bg-violet-950/40 text-violet-100 text-xs font-bold hover:bg-violet-950/70"
                    >
                      + Manual Vendor PO
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setManualEmbossOpen(true)}
                      className="w-full px-3 py-2 rounded-md border border-amber-600/80 bg-amber-950/40 text-amber-100 text-xs font-bold hover:bg-amber-950/70"
                    >
                      + Manual Request
                    </button>
                  )}
                </div>
                <input
                  value={prepSearch}
                  onChange={(e) => setPrepSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 text-sm max-h-[min(26rem,calc(100vh-14rem))] xl:max-h-none">
                  {prepF.length === 0 ? (
                    <li className="text-zinc-500 text-sm">Empty.</li>
                  ) : (
                    prepF.map((r) => renderCard(r, 'prep'))
                  )}
                </ul>
              </section>

              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 flex flex-col min-h-[260px] xl:min-h-0 xl:h-full">
                <div className="flex flex-col gap-1 mb-2 min-w-0">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                    Live inventory
                  </h2>
                  <ZoneCapacitySubheader
                    jobCount={invMetrics.jobCount}
                    unitCount={invMetrics.unitCount}
                  />
                </div>
                <input
                  value={invSearch}
                  onChange={(e) => setInvSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 text-sm max-h-[min(26rem,calc(100vh-14rem))] xl:max-h-none">
                  {invF.length === 0 ? (
                    <li className="text-zinc-500 text-sm">No tools in rack.</li>
                  ) : (
                    invF.map((r) => renderCard(r, 'inventory'))
                  )}
                </ul>
              </section>

              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 flex flex-col min-h-[260px] xl:min-h-0 xl:h-full">
                <div className="flex flex-col gap-1 mb-0.5 min-w-0">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
                    Custody floor
                  </h2>
                  <ZoneCapacitySubheader
                    jobCount={custMetrics.jobCount}
                    unitCount={custMetrics.unitCount}
                  />
                </div>
                <p className="text-[11px] text-zinc-500 mb-2">Staging · tools marked ready</p>
                <input
                  value={custSearch}
                  onChange={(e) => setCustSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 text-sm max-h-[min(26rem,calc(100vh-14rem))] xl:max-h-none">
                  {custF.length === 0 ? (
                    <li className="text-zinc-500 text-sm">Nothing in staging.</li>
                  ) : (
                    custF.map((r) => renderCard(r, 'custody'))
                  )}
                </ul>
              </section>
            </div>
          </>
        )}
      </div>

      <ToolingJobAuditModal context={toolingAudit} onClose={() => setToolingAudit(null)} />

      {returnModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-emerald-700/50 bg-zinc-950 p-4 space-y-3 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white">Return to live inventory</h3>
            <p className="text-xs text-zinc-500">
              Confirm rack return. If you change dimensions vs. the master record, select a reason (same
              policy as Plate Hub).
            </p>
            {returnModal.kind === 'die' ? (
              <>
                <label className="block text-sm text-zinc-300">
                  Dimensions (carton / die outline)
                  <input
                    value={returnDieCarton}
                    onChange={(e) => setReturnDieCarton(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                  />
                </label>
                <label className="block text-sm text-zinc-300">
                  Sheet size
                  <input
                    value={returnDieSheet}
                    onChange={(e) => setReturnDieSheet(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                  />
                </label>
              </>
            ) : (
              <label className="block text-sm text-zinc-300">
                Block size
                <input
                  value={returnEmbossSize}
                  onChange={(e) => setReturnEmbossSize(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                />
              </label>
            )}
            {(() => {
              const origDieCarton =
                returnModal.kind === 'die'
                  ? returnModal.dimensionsLabel === '—'
                    ? ''
                    : returnModal.dimensionsLabel
                  : ''
              const origDieSheet = returnModal.kind === 'die' ? returnModal.sheetSize ?? '' : ''
              const origEmboss = returnModal.kind === 'emboss' ? returnModal.blockSize ?? '' : ''
              const changed =
                returnModal.kind === 'die'
                  ? returnDieCarton.trim() !== origDieCarton.trim() ||
                    returnDieSheet.trim() !== origDieSheet.trim()
                  : returnEmbossSize.trim() !== origEmboss.trim()
              return changed ? (
                <div className="space-y-2 rounded-lg border border-amber-800/50 bg-amber-950/20 p-3">
                  <p className="text-xs font-semibold text-amber-200">Size change on return</p>
                  <label className="block text-sm text-zinc-300">
                    Reason <span className="text-red-400">*</span>
                    <select
                      value={returnSizeReason}
                      onChange={(e) =>
                        setReturnSizeReason(
                          e.target.value as '' | 'alternate_machine' | 'edge_damage' | 'prepress_error',
                        )
                      }
                      className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                    >
                      <option value="">Select…</option>
                      {TOOLING_RETURN_SIZE_REASONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm text-zinc-300">
                    Remarks (optional)
                    <textarea
                      value={returnSizeRemarks}
                      onChange={(e) => setReturnSizeRemarks(e.target.value)}
                      rows={2}
                      className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm"
                    />
                  </label>
                </div>
              ) : null
            })()}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setReturnModal(null)}
                disabled={saving}
              >
                Cancel
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
          </div>
        </div>
      ) : null}

      {manualDieOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Manual vendor PO (die)</h3>
            <label className="block text-sm text-zinc-300">
              Dye #
              <input
                value={mdNumber}
                onChange={(e) => setMdNumber(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                inputMode="numeric"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Dimensions / carton label (L × W × H or master ref)
              <input
                value={mdCartonSize}
                onChange={(e) => setMdCartonSize(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Sheet size (optional)
              <input
                value={mdSheetSize}
                onChange={(e) => setMdSheetSize(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              UPS
              <input
                value={mdUps}
                onChange={(e) => setMdUps(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                inputMode="numeric"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Material / die type
              <input
                value={mdMaterial}
                onChange={(e) => setMdMaterial(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                placeholder="Laser, Wood, Steel Rule…"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setManualDieOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-violet-600 text-white font-semibold disabled:opacity-50"
                onClick={() => void submitManualDie()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {manualEmbossOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Manual in-house request</h3>
            <label className="block text-sm text-zinc-300">
              Block code
              <input
                value={meCode}
                onChange={(e) => setMeCode(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Type (Blind / Foil / …)
              <input
                value={meType}
                onChange={(e) => setMeType(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Material
              <input
                value={meMaterial}
                onChange={(e) => setMeMaterial(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Block size (optional)
              <input
                value={meSize}
                onChange={(e) => setMeSize(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setManualEmbossOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-amber-600 text-white font-semibold disabled:opacity-50"
                onClick={() => void submitManualEmboss()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {scrapId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-rose-800/50 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Scrap / damage</h3>
            <p className="text-xs text-zinc-500">Record why this tool is removed from active inventory.</p>
            <textarea
              value={scrapReason}
              onChange={(e) => setScrapReason(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm"
              placeholder="e.g. Knife dull, wood warped, rubber worn…"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => {
                  setScrapId(null)
                  setScrapReason('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || scrapReason.trim().length < 3}
                className="px-3 py-2 rounded bg-rose-700 text-white font-semibold disabled:opacity-50"
                onClick={() => void submitScrap()}
              >
                Confirm scrap
              </button>
            </div>
          </div>
        </div>
      )}

      {emergencyId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-red-700/50 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Emergency issue (bypass)</h3>
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
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setEmergencyId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-red-700 text-white font-semibold disabled:opacity-50"
                onClick={() => void submitEmergency()}
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
