'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { format } from 'date-fns'
import { toast } from 'sonner'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { OperatorMasterCombobox } from '@/components/hub/OperatorMasterCombobox'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'
import {
  hubAddedToRackLabel,
  hubLastActionLine,
  hubMarkedReadyLabel,
  hubQueueAgeLabel,
  hubQueueStale,
} from '@/lib/hub-card-time'
import { DieMakeSwitcher } from '@/components/hub/die/DieMakeSwitcher'
import { DieTakeFromStockModal } from '@/components/hub/die/DieTakeFromStockModal'
import { DieTriageCard } from '@/components/hub/die/DieTriageCard'
import { SimilarDiesModal, type SimilarDieMatch } from '@/components/hub/die/SimilarDiesModal'
import { DIE_HUB_PASTING_TYPES } from '@/lib/die-hub-dimensions'
import type { PastingStyle } from '@prisma/client'
import { PO_MANUAL_PASTING_VALUES, pastingStyleLabel } from '@/lib/pasting-style'
import { PastingStyleBadge } from '@/components/hub/PastingStyleBadge'
import { calculateToolingZoneMetrics, toolingCardUnits } from '@/lib/tooling-hub-metrics'
import {
  DieMasterLedger,
  TOOLING_LEDGER_ZONE_OPTIONS_BLOCKS,
  TOOLING_LEDGER_ZONE_OPTIONS_DIES,
  getFilteredDieMasterLedgerRows,
  type DieMasterLedgerRow,
} from '@/components/hub/die/DieMasterLedger'
import { ToolingJobAuditModal, type ToolingHubAuditContext } from '@/components/hub/ToolingJobAuditModal'
import { TableExportMenu } from '@/components/hub/TableExportMenu'
import {
  toolingMasterLedgerExportColumns,
  toolingMasterLedgerExcelExtraColumns,
} from '@/lib/hub-ledger-export-columns'
import { CUSTODY_ON_FLOOR } from '@/lib/inventory-hub-custody'

function isDieHubSupervisorRole(role: string | undefined): boolean {
  if (!role?.trim()) return false
  const r = role.toLowerCase()
  return r.includes('admin') || r.includes('manager') || r.includes('supervisor')
}

const TOOLING_RETURN_SIZE_REASONS: {
  value: 'alternate_machine' | 'edge_damage' | 'prepress_error'
  label: string
}[] = [
  { value: 'alternate_machine', label: 'Resized for alternate machine assignment' },
  { value: 'edge_damage', label: 'Trimmed due to edge damage / wear' },
  { value: 'prepress_error', label: 'Pre-press layout error / Manual correction' },
]

const FALLBACK_HUB_OPERATOR_ID = '__hub_fallback_operator__'
const FALLBACK_HUB_OPERATOR_NAME = 'Anik Dua'

function resolveHubOperatorName(id: string, options: { id: string; name: string }[]): string {
  const o = options.find((x) => x.id === id)
  if (o?.name.trim()) return o.name.trim()
  if (id === FALLBACK_HUB_OPERATOR_ID) return FALLBACK_HUB_OPERATOR_NAME
  return ''
}

/** Board column title with filter-aware job count and physical units. */
function BoardZoneTitle({
  name,
  count,
  unitCount,
}: {
  name: string
  count: number
  unitCount: number
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400 flex flex-wrap items-baseline gap-x-1.5">
        <span>{name}</span>
        <span
          className={`tabular-nums font-bold ${
            count === 0 ? 'text-zinc-500' : 'text-amber-200/95'
          }`}
        >
          ({count})
        </span>
      </h2>
      <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold tabular-nums leading-tight shrink-0">
        {unitCount} units
      </p>
    </div>
  )
}

/** Table view — per-zone die counts (search + pasting only; not zone dropdown). */
function DieHubZoneSummaryBar({
  triage,
  outsideVendor,
  liveInventory,
  custodyInUse,
}: {
  triage: number
  outsideVendor: number
  liveInventory: number
  custodyInUse: number
}) {
  const Card = ({
    label,
    count,
    dotClass,
    borderClass,
  }: {
    label: string
    count: number
    dotClass: string
    borderClass: string
  }) => (
    <div
      className={`flex-1 min-w-[132px] rounded-lg border ${borderClass} bg-zinc-950/95 px-3 py-2.5 flex items-center gap-2.5`}
    >
      <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dotClass}`} aria-hidden />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-zinc-400 font-semibold leading-tight">
          {label}
        </p>
        <p
          className={`text-lg font-bold tabular-nums leading-tight ${
            count === 0 ? 'text-zinc-500' : 'text-white'
          }`}
        >
          ({count})
        </p>
      </div>
    </div>
  )

  return (
    <div
      className="relative z-10 mb-1 flex flex-wrap gap-2 rounded-xl border border-zinc-700 bg-zinc-950/95 backdrop-blur-sm px-3 py-3 shadow-[0_4px_24px_rgba(0,0,0,0.35)]"
      role="region"
      aria-label="Zone summary"
    >
      <Card
        label="Triage"
        count={triage}
        dotClass="bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.55)]"
        borderClass="border-amber-600/55"
      />
      <Card
        label="Outside vendor"
        count={outsideVendor}
        dotClass="bg-violet-500 shadow-[0_0_10px_rgba(167,139,250,0.5)]"
        borderClass="border-violet-500/55"
      />
      <Card
        label="Live inventory"
        count={liveInventory}
        dotClass="bg-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.45)]"
        borderClass="border-emerald-600/55"
      />
      <Card
        label="Custody floor (in-use)"
        count={custodyInUse}
        dotClass="bg-sky-500 shadow-[0_0_10px_rgba(56,189,248,0.5)]"
        borderClass="border-sky-600/55"
      />
    </div>
  )
}

type JobCardHub = { key: string; badgeLabel: string }

type MasterOperator = { id: string; name: string }

type DieRow = {
  id: string
  kind: 'die'
  displayCode: string
  title: string
  ups: number
  dimensionsLabel: string
  dimensionsLwh: string
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
  ledgerRank: number
  pastingStyle: PastingStyle | null
  /** Triage-only hint from API — legacy / SPECIAL / unset pasting. */
  hubPastingNeedsMasterUpdate?: boolean
  masterType?: string | null
  hubConditionPoor?: boolean
  /** Die Hub maintenance flag after a Poor return (isolated from Plate/PO). */
  hubDieHubPoorFlag?: boolean
  hubPoorReportedBy?: string | null
  dieMake: 'local' | 'laser'
  dateOfManufacturing: string | null
  similarMatches: SimilarDieMatch[]
  typeMismatchMatches?: SimilarDieMatch[]
  hubCustodySource?: string | null
  hubTriageHoldReason?: string | null
  issuedOperator?: string | null
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
  triageManualEntry?: boolean
  triageAwReference?: string | null
  triageBlockDimensions?: string | null
  hubConditionPoor?: boolean
  issuedOperator?: string | null
}

type ToolRow = DieRow | EmbossRow

type DashboardPayload = {
  tool: 'dies' | 'blocks'
  triage: ToolRow[]
  prep: ToolRow[]
  inventory: ToolRow[]
  custody: ToolRow[]
  ledgerRows: DieMasterLedgerRow[]
}

type MachineOpt = { id: string; machineCode: string; name: string }

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
  const { data: session } = useSession()
  const searchParams = useSearchParams()
  const focusDieId = searchParams.get('focusDie')?.trim() || null
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
  const focusDieFlippedToTable = useRef(false)
  const [ledgerSearch, setLedgerSearch] = useState('')
  const [ledgerZoneFilter, setLedgerZoneFilter] = useState('')
  /** Die Hub only — Lock Bottom / BSO narrows board, table, and zone summary. */
  const [dieHubPastingFilter, setDieHubPastingFilter] = useState<'' | 'LOCK_BOTTOM' | 'BSO'>('')
  const [toolingAudit, setToolingAudit] = useState<ToolingHubAuditContext | null>(null)

  const [returnModal, setReturnModal] = useState<ToolRow | null>(null)
  const [returnDieCarton, setReturnDieCarton] = useState('')
  const [returnDieSheet, setReturnDieSheet] = useState('')
  const [returnEmbossSize, setReturnEmbossSize] = useState('')
  const [returnSizeReason, setReturnSizeReason] = useState<
    '' | 'alternate_machine' | 'edge_damage' | 'prepress_error'
  >('')
  const [returnSizeRemarks, setReturnSizeRemarks] = useState('')
  const [returnOperatorMasterId, setReturnOperatorMasterId] = useState('')
  const [returnCondition, setReturnCondition] = useState<'Good' | 'Fair' | 'Poor'>('Good')

  const [masterOperators, setMasterOperators] = useState<MasterOperator[]>([])
  const [floorOperatorId, setFloorOperatorId] = useState('')

  const [issueDieId, setIssueDieId] = useState<string | null>(null)
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [issueMachineId, setIssueMachineId] = useState('')
  const [issueOperatorMasterId, setIssueOperatorMasterId] = useState('')

  const [reverseRowId, setReverseRowId] = useState<string | null>(null)
  const [reverseOperatorMasterId, setReverseOperatorMasterId] = useState('')

  const [manualDieOpen, setManualDieOpen] = useState(false)
  const [manualDieTarget, setManualDieTarget] = useState<'vendor' | 'live_inventory'>('vendor')
  const [mdNumber, setMdNumber] = useState('')
  const [mdCartonSize, setMdCartonSize] = useState('')
  const [mdSheetSize, setMdSheetSize] = useState('')
  const [mdUps, setMdUps] = useState('1')
  const [mdMaterial, setMdMaterial] = useState('Laser')
  const [mdPastingType, setMdPastingType] = useState<PastingStyle>(DIE_HUB_PASTING_TYPES[0])
  const [mdDieMake, setMdDieMake] = useState<'local' | 'laser'>('local')
  const [similarDieBoardModal, setSimilarDieBoardModal] = useState<{
    sourceLabel: string
    sourceDieType?: string
    variant: 'similar' | 'type_mismatch'
    matches: SimilarDieMatch[]
  } | null>(null)
  const [dieStockModal, setDieStockModal] = useState<DieRow | null>(null)

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
    focusDieFlippedToTable.current = false
  }, [focusDieId])

  useEffect(() => {
    if (mode !== 'dies' || !focusDieId || loading) return
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-hub-die-id="${focusDieId}"]`)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.classList.add('ring-2', 'ring-amber-500/60', 'ring-offset-2', 'ring-offset-black')
        window.setTimeout(() => {
          el.classList.remove('ring-2', 'ring-amber-500/60', 'ring-offset-2', 'ring-offset-black')
        }, 2400)
        return
      }
      if (hubView === 'board' && !focusDieFlippedToTable.current) {
        focusDieFlippedToTable.current = true
        setHubView('table')
      }
    }, 400)
    return () => window.clearTimeout(t)
  }, [mode, focusDieId, loading, data, hubView])

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/operator-master?activeOnly=1')
        const t = await r.text()
        const j = safeJsonParse<{ operators?: MasterOperator[] } | MasterOperator[]>(t, {})
        const rawList = Array.isArray(j) ? j : j.operators
        const list = Array.isArray(rawList) ? rawList : []
        setMasterOperators(list)
        const anik = list.find((o) => o.name.trim() === FALLBACK_HUB_OPERATOR_NAME)
        setFloorOperatorId((prev) => {
          if (prev && list.some((o) => o.id === prev)) return prev
          if (anik) return anik.id
          if (list[0]) return list[0].id
          return FALLBACK_HUB_OPERATOR_ID
        })
      } catch {
        setMasterOperators([])
        setFloorOperatorId(FALLBACK_HUB_OPERATOR_ID)
      }
    })()
  }, [])

  const operatorOptionsForUi = useMemo(
    () =>
      masterOperators.length > 0
        ? masterOperators
        : [{ id: FALLBACK_HUB_OPERATOR_ID, name: FALLBACK_HUB_OPERATOR_NAME }],
    [masterOperators],
  )

  const effectiveFloorOperatorName = useMemo(() => {
    const n = resolveHubOperatorName(floorOperatorId, operatorOptionsForUi).trim()
    return n || FALLBACK_HUB_OPERATOR_NAME
  }, [floorOperatorId, operatorOptionsForUi])

  useEffect(() => {
    if (!issueDieId) return
    void (async () => {
      try {
        const mRes = await fetch('/api/machines')
        setMachines(safeJsonParse<MachineOpt[]>(await mRes.text(), []))
      } catch {
        setMachines([])
      }
      setIssueMachineId('')
      setIssueOperatorMasterId(floorOperatorId)
    })()
  }, [issueDieId, floorOperatorId])

  useEffect(() => {
    if (!reverseRowId) return
    setReverseOperatorMasterId(floorOperatorId)
  }, [reverseRowId, floorOperatorId])

  const filterRows = (list: ToolRow[], q: string) => {
    const s = q.trim().toLowerCase()
    if (!s) return list
    return list.filter((r) => {
      const hay =
        r.kind === 'die'
          ? [
              r.displayCode,
              r.title,
              r.materialLabel,
              r.dimensionsLwh,
              r.dimensionsLabel,
              pastingStyleLabel(r.pastingStyle),
              r.masterType,
              r.dieMake,
            ]
              .join(' ')
              .toLowerCase()
          : [r.displayCode, r.title, r.typeLabel].join(' ').toLowerCase()
      return hay.includes(s)
    })
  }

  const applyDieHubPastingBoard = useCallback(
    (rows: ToolRow[]) => {
      if (mode !== 'dies' || !dieHubPastingFilter) return rows
      const f = dieHubPastingFilter as PastingStyle
      return rows.filter((r) => r.kind === 'die' && r.pastingStyle === f)
    },
    [mode, dieHubPastingFilter],
  )

  const triageF = useMemo(
    () => applyDieHubPastingBoard(filterRows(data?.triage ?? [], triageSearch)),
    [data?.triage, triageSearch, applyDieHubPastingBoard],
  )
  const prepF = useMemo(
    () => applyDieHubPastingBoard(filterRows(data?.prep ?? [], prepSearch)),
    [data?.prep, prepSearch, applyDieHubPastingBoard],
  )
  const invF = useMemo(
    () => applyDieHubPastingBoard(filterRows(data?.inventory ?? [], invSearch)),
    [data?.inventory, invSearch, applyDieHubPastingBoard],
  )
  const custF = useMemo(
    () => applyDieHubPastingBoard(filterRows(data?.custody ?? [], custSearch)),
    [data?.custody, custSearch, applyDieHubPastingBoard],
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

  const custodyInUseCount = useMemo(
    () => custF.filter((r) => r.custodyStatus === CUSTODY_ON_FLOOR).length,
    [custF],
  )

  const ledgerZoneOptions =
    mode === 'dies' ? TOOLING_LEDGER_ZONE_OPTIONS_DIES : TOOLING_LEDGER_ZONE_OPTIONS_BLOCKS

  const ledgerPastingArg =
    mode === 'dies' && dieHubPastingFilter
      ? (dieHubPastingFilter as PastingStyle)
      : undefined

  const filteredLedgerRows = useMemo(
    () =>
      getFilteredDieMasterLedgerRows(
        data?.ledgerRows ?? [],
        ledgerSearch,
        ledgerZoneFilter,
        ledgerPastingArg,
      ),
    [data?.ledgerRows, ledgerSearch, ledgerZoneFilter, ledgerPastingArg],
  )

  /** Search + pasting only — used for zone summary bar (not zone dropdown). */
  const ledgerRowsForZoneSummary = useMemo(
    () =>
      getFilteredDieMasterLedgerRows(
        data?.ledgerRows ?? [],
        ledgerSearch,
        '',
        ledgerPastingArg,
      ),
    [data?.ledgerRows, ledgerSearch, ledgerPastingArg],
  )

  const dieHubZoneSummary = useMemo(() => {
    if (mode !== 'dies') return null
    const rows = ledgerRowsForZoneSummary.filter((r) => r.kind === 'die')
    const count = (keys: string[]) =>
      rows.filter((r) => keys.includes(r.zoneKey)).length
    return {
      triage: count(['incoming_triage']),
      outsideVendor: count(['outside_vendor']),
      liveInventory: count(['live_inventory']),
      custodyInUse: count(['on_machine']),
    }
  }, [ledgerRowsForZoneSummary, mode])
  const toolingLedgerExportColumns = useMemo(() => toolingMasterLedgerExportColumns(), [])
  const toolingLedgerExcelExtraColumns = useMemo(() => toolingMasterLedgerExcelExtraColumns(), [])
  const toolingLedgerExportFilterSummary = useMemo(() => {
    const parts: string[] = []
    if (ledgerZoneFilter) {
      const o = ledgerZoneOptions.find((x) => x.value === ledgerZoneFilter)
      parts.push(o ? `Zone: ${o.label}` : `Zone: ${ledgerZoneFilter}`)
    }
    if (ledgerSearch.trim()) parts.push(`Search: "${ledgerSearch.trim()}"`)
    if (mode === 'dies' && dieHubPastingFilter) {
      parts.push(`Pasting: ${pastingStyleLabel(dieHubPastingFilter as PastingStyle)}`)
    }
    return parts
  }, [ledgerZoneFilter, ledgerSearch, ledgerZoneOptions, mode, dieHubPastingFilter])
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
    setReturnOperatorMasterId(floorOperatorId)
    setReturnCondition('Good')
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
    const returnName =
      resolveHubOperatorName(returnOperatorMasterId, operatorOptionsForUi).trim() ||
      effectiveFloorOperatorName.trim()
    if (!returnName) {
      toast.error('Select the operator who performed the return')
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
      body.returnOperatorName = returnName
      body.returnCondition = returnCondition
      const r = await fetch('/api/tooling-hub/return-to-rack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify(body),
      })
      const t = await r.text()
      const j = safeJsonParse<{
        error?: string
        poorConditionAlert?: boolean
        poorConditionMeta?: { displayCode: string; operatorName: string }
      }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Return failed')
      toast.success('Returned to live inventory')
      if (
        j.poorConditionAlert &&
        j.poorConditionMeta &&
        isDieHubSupervisorRole(session?.user?.role)
      ) {
        toast.error(
          `Tooling Alert: Die #${j.poorConditionMeta.displayCode} returned in Poor condition by ${j.poorConditionMeta.operatorName}.`,
          { duration: 12_000 },
        )
      }
      setReturnModal(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Return failed')
    } finally {
      setSaving(false)
    }
  }

  async function runTransition(body: Record<string, unknown>, msg: string) {
    const actorName = effectiveFloorOperatorName.trim()
    if (!actorName) {
      toast.error('Select the floor operator (toolbar above)')
      return
    }
    setSaving(true)
    try {
      await postTransition({ ...body, actorName })
      toast.success(msg)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitDieTakeFromStock(inventoryDyeId: string) {
    if (!dieStockModal) return
    setSaving(true)
    try {
      const r = await fetch('/api/tooling-hub/dies/take-from-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          triageDyeId: dieStockModal.id,
          inventoryDyeId,
          actorName: effectiveFloorOperatorName.trim() || undefined,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Take from stock failed')
        return
      }
      toast.success('Custody floor — die pulled from rack; triage archived')
      setDieStockModal(null)
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Take from stock failed')
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
          pastingStyle: mdPastingType,
          dieMake: mdDieMake,
          hubDestination: manualDieTarget,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Failed')
      toast.success(
        manualDieTarget === 'live_inventory'
          ? 'Die added — Live inventory'
          : 'Die added — Outside vendor',
      )
      setManualDieOpen(false)
      setManualDieTarget('vendor')
      setMdNumber('')
      setMdCartonSize('')
      setMdSheetSize('')
      setMdUps('1')
      setMdMaterial('Laser')
      setMdPastingType(DIE_HUB_PASTING_TYPES[0])
      setMdDieMake('local')
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

  async function postReverseLast(rowId: string, actorName: string) {
    const actor = actorName.trim()
    if (!actor) {
      toast.error('Select the operator performing the reverse')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/tooling-hub/reverse-last', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ tool: toolKind, id: rowId, actorName: actor }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string; returnedToTechnicalSpecs?: boolean }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Reverse failed')
      if (j.returnedToTechnicalSpecs) {
        toast.success('Job returned to Technical Specs.')
      } else {
        toast.success('Last hub action undone')
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reverse failed')
    } finally {
      setSaving(false)
    }
  }

  async function confirmReverseLast() {
    if (!reverseRowId) return
    const actor =
      resolveHubOperatorName(reverseOperatorMasterId, operatorOptionsForUi).trim() ||
      effectiveFloorOperatorName.trim()
    if (!actor) {
      toast.error('Select the operator undoing this action')
      return
    }
    await postReverseLast(reverseRowId, actor)
    setReverseRowId(null)
  }

  async function submitTriageHold(dyeId: string, onHold: boolean, reason?: string) {
    const actorName = effectiveFloorOperatorName.trim()
    if (!actorName) {
      toast.error('Select the floor operator (toolbar above)')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/tooling-hub/dies/triage-hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          dyeId,
          onHold,
          reason: onHold ? reason : null,
          actorName,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Hold update failed')
      toast.success(onHold ? 'Triage on-hold' : 'Hold released')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Hold update failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitManualDieLink(triageDyeId: string, inventoryDyeId: string) {
    const actorName = effectiveFloorOperatorName.trim()
    if (!actorName) {
      toast.error('Select the floor operator (toolbar above)')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/tooling-hub/dies/manual-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ triageDyeId, inventoryDyeId, actorName }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Manual link failed')
      toast.success('Manual link — rack die sent to custody')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Manual link failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitMaintenanceComplete(dyeId: string) {
    const actorName = effectiveFloorOperatorName.trim()
    if (!actorName) {
      toast.error('Select the floor operator (toolbar above)')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/tooling-hub/dies/maintenance-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ dyeId, actorName }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Maintenance update failed')
      toast.success('Maintenance complete — condition reset to Good')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Maintenance update failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitIssueToMachine() {
    if (!issueDieId) return
    if (!issueMachineId) {
      toast.error('Machine is required')
      return
    }
    const opName =
      resolveHubOperatorName(issueOperatorMasterId, operatorOptionsForUi).trim() ||
      effectiveFloorOperatorName.trim()
    if (!opName) {
      toast.error('Select the operator issuing the tool')
      return
    }
    setSaving(true)
    try {
      const path =
        mode === 'dies'
          ? `/api/inventory-hub/dies/${issueDieId}/issue`
          : `/api/inventory-hub/emboss-blocks/${issueDieId}/issue`
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          machineId: issueMachineId,
          operatorName: opName,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Issue failed')
      toast.success('Issued to machine')
      setIssueDieId(null)
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
      const head =
        r.pastingStyle != null
          ? `Type: ${pastingStyleLabel(r.pastingStyle)} · `
          : ''
      return `${head}UPS ${r.ups} · ${r.dimensionsLwh} · ${r.materialLabel}`
    }
    return `${r.typeLabel} · ${r.materialLabel}${r.blockSize ? ` · ${r.blockSize}` : ''}${
      r.triageAwReference ? ` · AW ${r.triageAwReference}` : ''
    }`
  }

  function zoneLabelForBoard(z: 'triage' | 'prep' | 'inventory' | 'custody'): string {
    if (z === 'triage') return 'Incoming triage'
    if (z === 'inventory') return 'Live inventory'
    if (z === 'custody') return 'Custody floor'
    return mode === 'dies' ? 'Outside vendor' : 'In-house engraving'
  }

  function renderSpecs(r: ToolRow, zone: 'triage' | 'prep' | 'inventory' | 'custody') {
    if (r.kind === 'die') {
      return (
        <>
          <div className="mt-1 space-y-0.5 text-[11px] font-medium text-zinc-400 leading-tight">
            <p className="flex flex-wrap items-center gap-1.5">
              <span>Type:</span>
              <PastingStyleBadge value={r.pastingStyle} />
              {zone === 'triage' && r.hubPastingNeedsMasterUpdate ? (
                <span className="inline-flex items-center rounded border border-amber-500/80 bg-amber-950/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200">
                  Master update
                </span>
              ) : null}
            </p>
            <p>
              Die type (master):{' '}
              <span className="text-zinc-300">{r.masterType?.trim() || '—'}</span>
            </p>
            <p className="text-[10px] text-zinc-500">
              Material: <span className="text-zinc-400">{r.materialLabel}</span>
            </p>
            {r.location ? (
              <p className="text-[10px] text-zinc-500">Rack: {r.location}</p>
            ) : null}
          </div>
          <details className="mt-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1">
            <summary className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 cursor-pointer select-none">
              Technical data
            </summary>
            <div className="mt-1 space-y-0.5 text-[10px] text-zinc-400">
              <p>Sheet: {r.sheetSize?.trim() || '—'}</p>
              <p className="tabular-nums">UPS: {r.ups}</p>
            </div>
          </details>
        </>
      )
    }
    return (
      <div className="mt-1 space-y-0.5 text-xs font-medium text-zinc-400">
        {zone === 'triage' && r.triageAwReference ? (
          <p>
            AW: <span className="text-zinc-200">{r.triageAwReference}</span>
          </p>
        ) : null}
        {zone === 'triage' && r.triageBlockDimensions ? (
          <p>
            Block / sheet: <span className="text-zinc-200">{r.triageBlockDimensions}</span>
          </p>
        ) : null}
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
    const custodyInUse = zone === 'custody' && r.custodyStatus === CUSTODY_ON_FLOOR
    const liClass = `rounded-lg border bg-black p-2 overflow-visible ${
      custodyInUse
        ? 'border-2 border-blue-500 hub-tool-in-use-pulse'
        : zone === 'custody' && r.jobCardHub?.key === 'printed'
          ? 'border-emerald-600/70 shadow-[0_0_12px_rgba(16,185,129,0.12)]'
          : 'border-zinc-800'
    }`

    if (r.kind === 'die') {
      const mismatch = r.typeMismatchMatches ?? []
      const hasTypeMismatch = mismatch.length > 0
      const hasSimilar = !hasTypeMismatch && r.similarMatches.length > 0
      const dimTitle = r.dimensionsLwh || r.dimensionsLabel
      return (
        <li key={`${r.kind}-${r.id}`} data-hub-die-id={r.id} className={liClass}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 border border-zinc-700 text-[10px] font-mono font-bold text-zinc-500"
                title="Row #"
              >
                #{r.ledgerRank}
              </span>
              <span className="font-mono text-[10px] text-amber-300/90 truncate">{r.displayCode}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                disabled={saving}
                title="Undo last hub action"
                className="text-[10px] font-bold uppercase tracking-wide text-amber-200/90 border border-amber-700/60 rounded px-1.5 py-0.5 hover:bg-amber-950/50 disabled:opacity-50 whitespace-nowrap"
                onClick={() => setReverseRowId(r.id)}
              >
                ↺ Reverse
              </button>
              {hasTypeMismatch ? (
                <button
                  type="button"
                  onClick={() =>
                    setSimilarDieBoardModal({
                      sourceLabel: r.displayCode,
                      sourceDieType: r.masterType?.trim() || undefined,
                      variant: 'type_mismatch',
                      matches: mismatch,
                    })
                  }
                  className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-red-400 border border-red-600/60 rounded px-1.5 py-0.5 hover:bg-red-950/40"
                >
                  Type mismatch
                </button>
              ) : hasSimilar ? (
                <button
                  type="button"
                  onClick={() =>
                    setSimilarDieBoardModal({
                      sourceLabel: r.displayCode,
                      variant: 'similar',
                      matches: r.similarMatches,
                    })
                  }
                  className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-amber-500 border border-amber-600/60 rounded px-1.5 py-0.5 hover:bg-amber-950/50"
                >
                  Similar
                </button>
              ) : null}
            </div>
          </div>
          <p className="text-[11px] text-zinc-500 truncate mt-1" title={r.title}>
            {r.title}
          </p>
          {r.hubConditionPoor ? (
            <p className="mt-1 text-[9px] font-bold uppercase tracking-wider text-red-400 border border-red-700/60 rounded px-1.5 py-0.5 w-fit">
              Poor condition
            </p>
          ) : null}
          <button
            type="button"
            className="text-left w-full text-blue-400 hover:text-blue-300 hover:underline font-semibold text-sm mt-0.5 truncate"
            onClick={() =>
              setToolingAudit({
                tool: 'die',
                id: r.id,
                zoneLabel: zoneLabelForBoard(zone),
                displayCode: r.displayCode,
                title: dimTitle,
                specSummary: toolingSpecSummaryLine(r),
                units: toolingCardUnits(r),
              })
            }
          >
            {dimTitle}
          </button>
          {zone === 'custody' ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
              <JobCardStatusBadge hub={r.jobCardHub} />
              {r.hubCustodySource === 'rack' ? (
                <span className="inline-flex items-center rounded border border-zinc-500 bg-zinc-900 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-zinc-300">
                  Source: Rack
                </span>
              ) : null}
            </div>
          ) : null}
          {zone === 'custody' && r.custodyStatus === CUSTODY_ON_FLOOR && r.issuedOperator?.trim() ? (
            <p className="mt-1 text-[11px] text-sky-300/95 font-medium">
              👤 Issued to: {r.issuedOperator.trim()}
            </p>
          ) : null}
          {renderSpecs(r, zone)}
          <div className="mt-1.5">
            <DieMakeSwitcher
              dyeId={r.id}
              value={r.dieMake}
              disabled={saving}
              onPersisted={() => void load()}
            />
          </div>
          {r.dateOfManufacturing ? (
            <p className="text-[9px] text-zinc-500 mt-1 tabular-nums">
              Mfg: {format(new Date(r.dateOfManufacturing), 'MMM d, yyyy')}
            </p>
          ) : null}
          <p className="text-[10px] text-zinc-600 mt-1 leading-tight">
            {hubLastActionLine(r.lastStatusUpdatedAt) ?? '—'}
          </p>
          {zone === 'prep' ? (
            <>
              <button
                type="button"
                disabled={saving}
                className="mt-1.5 w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
                onClick={() =>
                  void runTransition({ action: 'mark_ready', tool: toolKind, id: r.id }, 'Marked ready')
                }
              >
                Mark ready
              </button>
              {mode === 'dies' ? (
                <button
                  type="button"
                  disabled={saving}
                  className="mt-1.5 w-full py-1.5 rounded border border-emerald-600/80 bg-emerald-950/30 text-emerald-100 text-[11px] font-semibold hover:bg-emerald-950/50 disabled:opacity-50"
                  onClick={() =>
                    void runTransition(
                      { action: 'vendor_to_live_inventory', tool: 'die', id: r.id },
                      'Received into live inventory',
                    )
                  }
                >
                  Push to live inventory
                </button>
              ) : null}
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
                className="mt-1.5 w-full py-1.5 rounded border border-orange-600/80 bg-orange-950/40 text-orange-100 text-[11px] font-semibold hover:bg-orange-950/60 disabled:opacity-50"
                onClick={() =>
                  void runTransition(
                    { action: 'inventory_to_custody_floor', tool: toolKind, id: r.id },
                    'Sent to custody floor',
                  )
                }
              >
                Push to custody floor
              </button>
              <HubRackAdded createdAt={r.createdAt} />
            </>
          ) : null}
          {zone === 'custody' ? (
            <div className="mt-1.5 flex flex-col gap-2">
              {custodyInUse ? (
                <p className="text-[10px] font-bold uppercase tracking-wide text-blue-400">In use on press</p>
              ) : null}
              {r.custodyStatus !== 'on_floor' ? (
                <>
                  {r.hubConditionPoor ? (
                    <p className="flex items-start gap-1.5 text-[10px] font-medium text-amber-300/95 leading-snug">
                      <span className="shrink-0" aria-hidden>
                        ⚠️
                      </span>
                      <span>
                        {r.hubDieHubPoorFlag && r.hubPoorReportedBy?.trim()
                          ? `Tool reported in Poor condition by ${r.hubPoorReportedBy.trim()}.`
                          : 'This die is in Poor condition — maintenance recommended.'}
                      </span>
                    </p>
                  ) : null}
                  <button
                    type="button"
                    disabled={saving}
                    className="w-full py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white text-[11px] font-bold shadow-sm disabled:opacity-50"
                    onClick={() => setIssueDieId(r.id)}
                  >
                    Issue to machine
                  </button>
                </>
              ) : null}
              {r.hubConditionPoor ? (
                <button
                  type="button"
                  disabled={saving}
                  className="w-full py-1.5 rounded border border-amber-600/80 bg-amber-950/50 text-amber-100 text-[11px] font-semibold hover:bg-amber-950/70 disabled:opacity-50"
                  onClick={() => void submitMaintenanceComplete(r.id)}
                >
                  Maintenance complete
                </button>
              ) : null}
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
              <HubCustodyReady at={r.lastStatusUpdatedAt} />
            </div>
          ) : null}
        </li>
      )
    }

    return (
      <li key={`${r.kind}-${r.id}`} className={liClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <p className="font-mono text-amber-300 text-xs">{r.displayCode}</p>
            {zone === 'triage' && r.triageManualEntry ? (
              <span className="inline-flex items-center rounded border border-amber-600/60 bg-amber-950/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200">
                Manual Entry
              </span>
            ) : null}
          </div>
          <button
            type="button"
            disabled={saving}
            title="Undo last hub action"
            className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-amber-200/90 border border-amber-700/60 rounded px-1.5 py-0.5 hover:bg-amber-950/50 disabled:opacity-50 whitespace-nowrap"
            onClick={() => setReverseRowId(r.id)}
          >
            ↺ Reverse
          </button>
        </div>
        <button
          type="button"
          className="text-left w-full text-white font-semibold text-sm truncate mt-0.5 pr-1 hover:text-blue-300 hover:underline"
          onClick={() =>
            setToolingAudit({
              tool: 'emboss',
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
        {r.hubConditionPoor ? (
          <p className="mt-1 text-[9px] font-bold uppercase tracking-wider text-red-400 border border-red-700/60 rounded px-1.5 py-0.5 w-fit">
            Poor condition
          </p>
        ) : null}
        {zone === 'custody' ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
            <JobCardStatusBadge hub={r.jobCardHub} />
          </div>
        ) : null}
        {zone === 'custody' && r.custodyStatus === CUSTODY_ON_FLOOR && r.issuedOperator?.trim() ? (
          <p className="mt-1 text-[11px] text-sky-300/95 font-medium">
            👤 Issued to: {r.issuedOperator.trim()}
          </p>
        ) : null}
        {renderSpecs(r, zone)}
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
              className="mt-1.5 w-full py-1.5 rounded border border-orange-600/80 bg-orange-950/40 text-orange-100 text-[11px] font-semibold hover:bg-orange-950/60 disabled:opacity-50"
              onClick={() =>
                void runTransition(
                  { action: 'inventory_to_custody_floor', tool: toolKind, id: r.id },
                  'Sent to custody floor',
                )
              }
            >
              Push to custody floor
            </button>
            <HubRackAdded createdAt={r.createdAt} />
          </>
        ) : null}
        {zone === 'custody' ? (
          <div className="mt-1.5 flex flex-col gap-2">
            {custodyInUse ? (
              <p className="text-[10px] font-bold uppercase tracking-wide text-blue-400">In use on press</p>
            ) : null}
            {r.custodyStatus !== 'on_floor' ? (
              <button
                type="button"
                disabled={saving}
                title={
                  r.hubConditionPoor
                    ? 'Poor condition — confirm operator when issuing; maintenance still recommended'
                    : undefined
                }
                className="w-full py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white text-[11px] font-bold shadow-sm disabled:opacity-50"
                onClick={() => setIssueDieId(r.id)}
              >
                Issue to machine
              </button>
            ) : null}
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
              <div className="mt-3 flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 max-w-xl">
                <div className="flex-1 min-w-[200px]">
                  <OperatorMasterCombobox
                    label="Floor operator (zone moves)"
                    value={floorOperatorId}
                    onChange={setFloorOperatorId}
                    options={operatorOptionsForUi}
                    disabled={saving}
                  />
                </div>
                {mode === 'dies' ? (
                  <Link
                    href="/hub/dies/settings"
                    className="text-xs font-bold uppercase tracking-wide text-amber-400 hover:text-amber-300 border border-amber-700/50 rounded-lg px-3 py-2 shrink-0"
                  >
                    Staff settings
                  </Link>
                ) : null}
              </div>
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
            {mode === 'dies' && dieHubZoneSummary ? (
              <DieHubZoneSummaryBar
                triage={dieHubZoneSummary.triage}
                outsideVendor={dieHubZoneSummary.outsideVendor}
                liveInventory={dieHubZoneSummary.liveInventory}
                custodyInUse={dieHubZoneSummary.custodyInUse}
              />
            ) : null}
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
                {mode === 'dies' ? (
                  <label className="block min-w-[160px]">
                    <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                      Pasting style
                    </span>
                    <select
                      value={dieHubPastingFilter}
                      onChange={(e) =>
                        setDieHubPastingFilter(e.target.value as '' | 'LOCK_BOTTOM' | 'BSO')
                      }
                      className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm"
                    >
                      <option value="">All</option>
                      {PO_MANUAL_PASTING_VALUES.map((p) => (
                        <option key={p} value={p}>
                          {pastingStyleLabel(p)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
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
              <div className="flex flex-wrap gap-2 items-center shrink-0">
                {mode === 'dies' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setManualDieTarget('live_inventory')
                      setManualDieOpen(true)
                    }}
                    className="px-3 py-2 rounded-md border border-emerald-600/80 bg-emerald-950/40 text-emerald-100 text-xs font-bold hover:bg-emerald-950/70 whitespace-nowrap"
                  >
                    + Add Die
                  </button>
                ) : null}
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
            </div>
            <DieMasterLedger
              rows={data.ledgerRows}
              searchQuery={ledgerSearch}
              zoneFilter={ledgerZoneFilter}
              pastingStyleFilter={ledgerPastingArg}
              onOpenAudit={setToolingAudit}
              hubMode={mode}
              onDieDataChanged={() => void load()}
              dieMakeDisabled={saving}
            />
          </div>
        ) : (
          <>
            {mode === 'dies' ? (
              <div className="rounded-lg border border-zinc-700 bg-zinc-950/90 px-3 py-2.5 mb-4 flex flex-col sm:flex-row sm:items-end gap-3 sm:justify-between">
                <label className="block min-w-[200px] max-w-md flex-1">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                    Pasting style filter
                  </span>
                  <select
                    value={dieHubPastingFilter}
                    onChange={(e) =>
                      setDieHubPastingFilter(e.target.value as '' | 'LOCK_BOTTOM' | 'BSO')
                    }
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm"
                  >
                    <option value="">All</option>
                    {PO_MANUAL_PASTING_VALUES.map((p) => (
                      <option key={p} value={p}>
                        {pastingStyleLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-[11px] text-zinc-500 sm:pb-2">
                  Column counts and table zone summary use this filter with each zone&apos;s search.
                </p>
              </div>
            ) : null}
            <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3">
              <div className="mb-2 min-w-0">
                <BoardZoneTitle
                  name="Incoming triage"
                  count={triageF.length}
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
                  triageF.map((r) =>
                    mode === 'dies' && r.kind === 'die' ? (
                      <DieTriageCard
                        key={`${r.kind}-${r.id}`}
                        r={r}
                        saving={saving}
                        specs={renderSpecs(r, 'triage')}
                        onOpenAudit={() =>
                          setToolingAudit({
                            tool: 'die',
                            id: r.id,
                            zoneLabel: zoneLabelForBoard('triage'),
                            displayCode: r.displayCode,
                            title: r.dimensionsLwh || r.dimensionsLabel,
                            specSummary: toolingSpecSummaryLine(r),
                            units: toolingCardUnits(r),
                          })
                        }
                        onRouteToVendor={() =>
                          void runTransition(
                            { action: 'triage_to_prep', tool: toolKind, id: r.id },
                            'Sent to vendor lane',
                          )
                        }
                        onTakeFromStock={() => setDieStockModal(r)}
                        onManualLink={(inventoryDyeId) => void submitManualDieLink(r.id, inventoryDyeId)}
                        onTriageHold={(placeOnHold, reason) =>
                          void submitTriageHold(r.id, placeOnHold, reason)
                        }
                        onReverse={() => setReverseRowId(r.id)}
                        onSimilarClick={() => {
                          const mm = r.typeMismatchMatches ?? []
                          if (mm.length) {
                            setSimilarDieBoardModal({
                              sourceLabel: r.displayCode,
                              sourceDieType: r.masterType?.trim() || undefined,
                              variant: 'type_mismatch',
                              matches: mm,
                            })
                          } else {
                            setSimilarDieBoardModal({
                              sourceLabel: r.displayCode,
                              variant: 'similar',
                              matches: r.similarMatches,
                            })
                          }
                        }}
                      />
                    ) : (
                      renderCard(r, 'triage')
                    ),
                  )
                )}
              </ul>
            </section>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6 xl:min-h-[min(70vh,calc(100vh-14rem))] xl:items-stretch">
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-3 flex flex-col min-h-[260px] xl:min-h-0 xl:h-full">
                <div className="flex flex-col gap-2 mb-2 min-w-0">
                  <div className="min-w-0">
                    <BoardZoneTitle
                      name={prepHeading}
                      count={prepF.length}
                      unitCount={prepMetrics.unitCount}
                    />
                  </div>
                  <p className="text-[11px] text-zinc-500">{prepSub}</p>
                  {mode === 'dies' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setManualDieTarget('vendor')
                        setManualDieOpen(true)
                      }}
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
                <div className="flex flex-col gap-2 mb-2 min-w-0">
                  <div className="min-w-0">
                    <BoardZoneTitle
                      name="Live inventory"
                      count={invF.length}
                      unitCount={invMetrics.unitCount}
                    />
                  </div>
                  {mode === 'dies' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setManualDieTarget('live_inventory')
                        setManualDieOpen(true)
                      }}
                      className="w-full px-3 py-2 rounded-md border border-emerald-600/80 bg-emerald-950/40 text-emerald-100 text-xs font-bold hover:bg-emerald-950/70"
                    >
                      + Add Die
                    </button>
                  ) : null}
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
                  <BoardZoneTitle
                    name="Custody floor"
                    count={custF.length}
                    unitCount={custMetrics.unitCount}
                  />
                  <p className="text-[10px] font-bold uppercase tracking-wider text-blue-400/90 tabular-nums">
                    {custodyInUseCount} active on press
                  </p>
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

      <SimilarDiesModal
        open={!!similarDieBoardModal}
        onClose={() => setSimilarDieBoardModal(null)}
        sourceLabel={similarDieBoardModal?.sourceLabel ?? ''}
        sourceDieType={similarDieBoardModal?.sourceDieType}
        variant={similarDieBoardModal?.variant ?? 'similar'}
        matches={similarDieBoardModal?.matches ?? []}
      />

      <DieTakeFromStockModal
        triageDyeId={dieStockModal?.id ?? null}
        saving={saving}
        onClose={() => setDieStockModal(null)}
        onConfirm={(inventoryDyeId) => submitDieTakeFromStock(inventoryDyeId)}
      />

      {returnModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="ci-hub-modal-panel max-w-md max-h-[90vh]">
            <h3 className="ci-hub-modal-title">Return to live inventory</h3>
            <p className="text-[11px] text-zinc-500 leading-snug">
              Confirm rack return. If you change dimensions vs. the master record, select a reason (same
              policy as Plate Hub).
            </p>
            <OperatorMasterCombobox
              label="Operator (who returned it)"
              value={returnOperatorMasterId}
              onChange={setReturnOperatorMasterId}
              options={operatorOptionsForUi}
              disabled={saving}
            />
            <div>
              <span className="block text-sm text-zinc-300 mb-1">Condition</span>
              <div className="flex rounded-lg border border-zinc-600 overflow-hidden p-0.5 bg-black/40">
                {(['Good', 'Fair', 'Poor'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setReturnCondition(c)}
                    className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                      returnCondition === c
                        ? c === 'Poor'
                          ? 'bg-red-900/80 text-red-100'
                          : 'bg-amber-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
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
                className="ci-btn-save-industrial disabled:opacity-50"
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
          <div className="ci-hub-modal-panel max-w-md">
            <h3 className="ci-hub-modal-title">
              {manualDieTarget === 'live_inventory' ? 'Add die — Live inventory' : 'Manual vendor PO (die)'}
            </h3>
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
            <label className="block text-sm text-zinc-300">
              Pasting type
              <select
                value={mdPastingType}
                onChange={(e) => setMdPastingType(e.target.value as PastingStyle)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                {DIE_HUB_PASTING_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {pastingStyleLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              Initial make
              <select
                value={mdDieMake}
                onChange={(e) => setMdDieMake(e.target.value as 'local' | 'laser')}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="local">Local</option>
                <option value="laser">Laser</option>
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => {
                  setManualDieOpen(false)
                  setManualDieTarget('vendor')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="ci-btn-save-industrial disabled:opacity-50"
                onClick={() => void submitManualDie()}
              >
                {manualDieTarget === 'live_inventory' ? 'Add to rack' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {manualEmbossOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="ci-hub-modal-panel max-w-md">
            <h3 className="ci-hub-modal-title">Manual in-house request</h3>
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
                className="ci-btn-save-industrial disabled:opacity-50"
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
          <div className="ci-hub-modal-panel max-w-md border-rose-900/50">
            <h3 className="ci-hub-modal-title text-rose-200/95 border-rose-900/40">Scrap / damage</h3>
            <p className="text-[11px] text-zinc-500 leading-snug">Record why this tool is removed from active inventory.</p>
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

      {reverseRowId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="ci-hub-modal-panel max-w-md border-amber-900/40">
            <h3 className="ci-hub-modal-title">Reverse last hub action</h3>
            <p className="text-[11px] text-zinc-500 leading-snug">
              Who is undoing this step? Pick a name from Operator Master — this is stored on the audit log.
            </p>
            <OperatorMasterCombobox
              label="Operator"
              value={reverseOperatorMasterId}
              onChange={setReverseOperatorMasterId}
              options={operatorOptionsForUi}
              disabled={saving}
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setReverseRowId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="ci-btn-save-industrial disabled:opacity-50"
                onClick={() => void confirmReverseLast()}
              >
                Confirm reverse
              </button>
            </div>
          </div>
        </div>
      )}

      {issueDieId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="ci-hub-modal-panel max-w-md border-sky-900/35">
            <h3 className="ci-hub-modal-title">Issue to machine</h3>
            <p className="text-[11px] text-zinc-500 leading-snug">
              Select press and operator. Names come from Operator Master (Die Hub staff settings).
            </p>
            <label className="block text-sm text-zinc-300">
              Machine
              <select
                value={issueMachineId}
                onChange={(e) => setIssueMachineId(e.target.value)}
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
            <OperatorMasterCombobox
              label="Operator"
              value={issueOperatorMasterId}
              onChange={setIssueOperatorMasterId}
              options={operatorOptionsForUi}
              disabled={saving}
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setIssueDieId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || !issueMachineId}
                className="ci-btn-save-industrial disabled:opacity-50"
                onClick={() => void submitIssueToMachine()}
              >
                Issue to machine
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
