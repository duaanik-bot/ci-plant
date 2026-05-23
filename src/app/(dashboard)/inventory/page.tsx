'use client'

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Star, ChevronRight } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import { ReservationsPanel } from './components/ReservationsPanel'
import { cn } from '@/lib/cn'
import { computeRag } from '@/lib/procurement-rag'
import { WarehouseKpiStrip } from './components/WarehouseKpiStrip'
import { StockTab } from './components/StockTab'
import { OpenPosTab } from './components/OpenPosTab'
import { IncomingTab } from './components/IncomingTab'
import { ReportsTab } from './components/ReportsTab'
import { MaterialDrawer } from './components/MaterialDrawer'

const ledgerMono = 'font-designing-queue tabular-nums tracking-tight'

type GenealogyStep = { stage: string; label: string; detail: string; mono?: string }

type PaperLedgerRow = {
  id: string
  lotNumber: string | null
  paperType: string
  boardGrade: string | null
  gsm: number
  qtySheets: number
  ratePerSheet: number | null
  valueInr: number
  receiptDate: string
  ageDays: number
  ageBucket: 'fresh' | 'mature' | 'stale'
  status: string
  location: string | null
  industrialPriority: boolean
  totalIssuedToFloor: number
  linkedCustomerPos: string[]
  isMainWarehouse: boolean
  estKgRemaining: number | null
  suggestBalanceWriteOff: boolean
}

export type PaperWarehouseRow = {
  material_id: string
  material_code: string
  board_type_id: string | null
  board_classification_id: string | null
  length: number | null
  width: number | null
  gsm: number | null
  size_display: string
  available_sheets: number
  reserved_sheets: number
  incoming_sheets: number
  shortage_sheets: number
  reorder_level: number
  packet_weight: number
  status: string
  est_value_inr: number
  age_days: number
  ageing_risk: 'low' | 'medium' | 'high'
  open_pr_id?: string | null
  open_pr_status?: string | null
  daysOfCover: number | null
  hasOpenPo?: boolean
}

type WarehouseSortKey =
  | 'size_display'
  | 'board_classification_id'
  | 'gsm'
  | 'material_code'
  | 'board_type_id'
  | 'available_sheets'
  | 'reserved_sheets'
  | 'free'
  | 'daysOfCover'
  | 'incoming_sheets'
  | 'shortage_sheets'
  | 'reorder_level'
  | 'status'

type StockStateItem = {
  id: string
  materialCode: string
  description: string
  unit: string
  qtyQuarantine: number
  qtyAvailable: number
  qtyReserved: number
  qtyFg: number
  reorderPoint: number
  valueQuarantine: number
  valueAvailable: number
  valueReserved: number
  valueFg: number
}

type JobCardOpt = { id: string; jobCardNumber: number; customer?: { name: string } }
type ActivityRow = {
  id: string
  materialId: string
  materialCode: string
  materialDescription: string
  unit: string
  movementType: string
  qty: number
  refType: string | null
  refId: string | null
  userId: string | null
  createdAt: string
}

type MaterialDetailPayload = {
  material: {
    id: string
    materialCode: string
    description: string
    boardType: string | null
    boardClassification: string | null
    gsm: number | null
    sheetLength: number | null
    sheetWidth: number | null
    sourceTraceability?: string | null
    leftoverMeta?: {
      isLeftover: boolean
      sourceMaterialId: string | null
      sourcePlanningId: string | null
      sourceJobCardId: string | null
      sourceParentSize: string | null
      leftoverSize: string | null
      cutSizeUsed: string | null
      remarks: string | null
    } | null
  }
  logs: Array<{
    id: string
    movementType: string
    qty: number
    refType: string | null
    refId: string | null
    createdAt: string
    reservationContext?: {
      planningId: string | null
      cartonName: string | null
      poNumber: string | null
      jobCard: {
        id: string
        jobCardNumber: number
        status: string
        customerName: string
      } | null
    } | null
  }>
  reservations: Array<{
    id: string
    planningId: string | null
    cartonName: string | null
    poNumber: string | null
    requiredSheets: number
    reservedSheets: number
    shortageSheets: number
    status: string
    reservedAt?: string | null
    jobCard: {
      id: string
      jobCardNumber: number
      status: string
      customerName: string
    } | null
  }>
  shortages: Array<{
    id: string
    jobCardId: string
    jobCardNumber: number | null
    planningId: string | null
    requiredQty: number
    pendingShortage: number
    requiredByDate: string | null
    priority: 'urgent' | 'normal'
    status: string | null
    prId?: string | null
    prStatus?: string | null
  }>
}

type ProcureModalState = {
  mode: 'shortage' | 'manual'
  materialId: string
  materialCode: string
  boardType: string | null
  size: string
  gsm: number | null
  shortages: Array<{
    id: string
    planningId: string | null
    jobCardNumber: number | null
    pendingShortage: number
    requiredByDate: string | null
  }>
}

type ReleaseModalState = {
  planningId: string
  materialId: string
  materialCode: string
  reservationId: string | null
  requiredSheets: number
  currentReserved: number
}

function InventoryPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const ledgerGsm = searchParams.get('ledgerGsm')?.trim() ?? ''
  const ledgerBoard = searchParams.get('ledgerBoard')?.trim() ?? ''
  const deepLinkMaterialId = searchParams.get('materialId')?.trim() ?? ''
  const warehouseTab = (searchParams.get('warehouseTab') ?? 'stock') as 'stock' | 'open-pos' | 'incoming' | 'reports'

  function setWarehouseTab(tab: 'stock' | 'open-pos' | 'incoming' | 'reports') {
    const params = new URLSearchParams(searchParams.toString())
    params.set('warehouseTab', tab)
    router.replace(`?${params.toString()}`, { scroll: false })
  }
  const { data: session } = useSession()
  const [items, setItems] = useState<StockStateItem[]>([])
  const [alerts, setAlerts] = useState<StockStateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [paperLedger, setPaperLedger] = useState<{
    rows: PaperLedgerRow[]
    staleCapitalInr: number
  } | null>(null)
  const [paperWarehouseRows, setPaperWarehouseRows] = useState<PaperWarehouseRow[]>([])
  const [warehouseSort, setWarehouseSort] = useState<{ key: WarehouseSortKey; dir: 'asc' | 'desc' } | null>(null)
  const [paperWarehouseKpi, setPaperWarehouseKpi] = useState({
    totalPhysical: 0,
    available: 0,
    reserved: 0,
    incoming: 0,
    shortage: 0,
    value: 0,
    ageingRisk: 0,
    freeStock: 0,
    staleStock: 0,
    fastMoving: 0,
    slowMoving: 0,
    incomingRequiredMismatch: 0,
  })
  const [warehouseKpiFilter, setWarehouseKpiFilter] = useState<'all' | 'shortage' | 'available' | 'reserved' | 'incoming' | 'free' | 'stale' | 'fast' | 'slow' | 'mismatch'>('all')
  const [paperLedgerSort, setPaperLedgerSort] = useState<'oldest' | 'newest'>('oldest')
  const [hubSearchPo, setHubSearchPo] = useState('')
  const [paperSearch, setPaperSearch] = useState('')
  const [boardTypeFilter, setBoardTypeFilter] = useState('all')
  const [gsmFilter, setGsmFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [shortageOnly, setShortageOnly] = useState(false)
  const [debouncedHubPo, setDebouncedHubPo] = useState('')
  const [drawerRow, setDrawerRow] = useState<PaperLedgerRow | null>(null)
  const [genealogy, setGenealogy] = useState<{ steps: GenealogyStep[] } | null>(null)
  const [genealogyLoading, setGenealogyLoading] = useState(false)
  const [issueJobCardId, setIssueJobCardId] = useState('')
  const [issueQty, setIssueQty] = useState('')
  const [issueHighPri, setIssueHighPri] = useState(false)
  const [issueSubmitting, setIssueSubmitting] = useState(false)
  const [jobCards, setJobCards] = useState<JobCardOpt[]>([])
  const [jobSearch, setJobSearch] = useState('')
  const [activityRows, setActivityRows] = useState<ActivityRow[]>([])
  const [adjustMaterialId, setAdjustMaterialId] = useState('')
  const [adjustQty, setAdjustQty] = useState('')
  const [adjustDirection, setAdjustDirection] = useState<'add' | 'subtract'>('add')
  const [adjustBucket, setAdjustBucket] = useState<'quarantine' | 'available' | 'reserved' | 'fg'>('available')
  const [adjustReason, setAdjustReason] = useState('')
  const [adjustRemarks, setAdjustRemarks] = useState('')
  const [adjustSubmitting, setAdjustSubmitting] = useState(false)
  const [adjustMode, setAdjustMode] = useState<'single' | 'bulk'>('single')
  const [bulkAdjustInput, setBulkAdjustInput] = useState('')
  const [bulkAdjustSubmitting, setBulkAdjustSubmitting] = useState(false)
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<Set<string>>(new Set())
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [materialDrawerRow, setMaterialDrawerRow] = useState<PaperWarehouseRow | null>(null)
  const [reservationsPanelMaterialId, setReservationsPanelMaterialId] = useState<string | null>(null)
  const [materialDrawerLoading, setMaterialDrawerLoading] = useState(false)
  const [materialDrawerData, setMaterialDrawerData] = useState<MaterialDetailPayload | null>(null)
  const [materialDrawerView, setMaterialDrawerView] = useState<'history' | 'reserved' | 'available' | 'shortage' | 'free'>('history')
  const [deepLinkOpenedMaterialId, setDeepLinkOpenedMaterialId] = useState<string | null>(null)
  const [procureOpen, setProcureOpen] = useState(false)
  const [procureBusy, setProcureBusy] = useState(false)
  const [procureError, setProcureError] = useState<string | null>(null)
  const [procureState, setProcureState] = useState<ProcureModalState | null>(null)
  const [procureShortageId, setProcureShortageId] = useState('')
  const [procurePrQty, setProcurePrQty] = useState('')
  const [procureBuffer, setProcureBuffer] = useState(false)
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [releaseState, setReleaseState] = useState<ReleaseModalState | null>(null)
  const [releaseQtyInput, setReleaseQtyInput] = useState('')

  const loadPaperLedger = useCallback(
    async (opts: { customerPo: string; gsm?: string; board?: string }) => {
      const params = new URLSearchParams()
      if (opts.customerPo.trim()) params.set('customerPo', opts.customerPo.trim())
      if (opts.gsm?.trim()) params.set('gsm', opts.gsm.trim())
      if (opts.board?.trim()) params.set('board', opts.board.trim())
      const qs = params.toString()
      const res = await fetch(`/api/inventory/paper-ledger${qs ? `?${qs}` : ''}`)
      const ledger = await res.json()
      if (ledger && Array.isArray(ledger.rows)) {
        setPaperLedger({
          rows: ledger.rows as PaperLedgerRow[],
          staleCapitalInr: Number(ledger.staleCapitalInr) || 0,
        })
      } else {
        setPaperLedger({ rows: [], staleCapitalInr: 0 })
      }
    },
    [],
  )

  const loadPaperWarehouse = useCallback(async (q: string) => {
    const res = await fetch(`/api/inventory/paper-warehouse${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
    const data = await res.json().catch(() => ({}))
    setPaperWarehouseRows(Array.isArray(data?.rows) ? (data.rows as PaperWarehouseRow[]) : [])
    setPaperWarehouseKpi(
      data?.kpi && typeof data.kpi === 'object'
        ? {
            totalPhysical: Number(data.kpi.totalPhysical) || 0,
            available: Number(data.kpi.available) || 0,
            reserved: Number(data.kpi.reserved) || 0,
            incoming: Number(data.kpi.incoming) || 0,
            shortage: Number(data.kpi.shortage) || 0,
            value: Number(data.kpi.value) || 0,
            ageingRisk: Number(data.kpi.ageingRisk) || 0,
            freeStock: Number(data.kpi.freeStock) || 0,
            staleStock: Number(data.kpi.staleStock) || 0,
            fastMoving: Number(data.kpi.fastMoving) || 0,
            slowMoving: Number(data.kpi.slowMoving) || 0,
            incomingRequiredMismatch: Number(data.kpi.incomingRequiredMismatch) || 0,
          }
        : {
            totalPhysical: 0,
            available: 0,
            reserved: 0,
            incoming: 0,
            shortage: 0,
            value: 0,
            ageingRisk: 0,
            freeStock: 0,
            staleStock: 0,
            fastMoving: 0,
            slowMoving: 0,
            incomingRequiredMismatch: 0,
          },
    )
  }, [])

  const reloadAll = useCallback(async () => {
    setLoading(true)
    try {
      await Promise.all([
        fetch('/api/inventory/stock-states')
          .then((r) => r.json())
          .then((states) => setItems(Array.isArray(states) ? states : [])),
        fetch('/api/inventory/alerts')
          .then((r) => r.json())
          .then((al) => setAlerts(Array.isArray(al) ? al : [])),
        loadPaperLedger({
          customerPo: debouncedHubPo,
          gsm: ledgerGsm,
          board: ledgerBoard,
        }),
        loadPaperWarehouse(''),
        fetch('/api/job-cards')
          .then((r) => r.json())
          .then((list) => setJobCards(Array.isArray(list) ? list : [])),
        fetch('/api/inventory/activity-log?limit=40')
          .then((r) => r.json())
          .then((rows) => setActivityRows(Array.isArray(rows) ? rows : [])),
      ])
    } catch {
      /* noop */
    } finally {
      setLoading(false)
    }
  }, [debouncedHubPo, ledgerGsm, ledgerBoard, loadPaperLedger, loadPaperWarehouse])

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedHubPo(hubSearchPo), 320)
    return () => window.clearTimeout(t)
  }, [hubSearchPo])

  useEffect(() => {
    void reloadAll()
  }, [reloadAll])

  useEffect(() => {
    const onRefresh = () => {
      void reloadAll()
    }
    window.addEventListener('inventory:refresh', onRefresh)
    return () => window.removeEventListener('inventory:refresh', onRefresh)
  }, [reloadAll])

  useEffect(() => {
    const onPri = () =>
      void loadPaperLedger({
        customerPo: debouncedHubPo,
        gsm: ledgerGsm,
        board: ledgerBoard,
      })
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [debouncedHubPo, ledgerGsm, ledgerBoard, loadPaperLedger])

  useEffect(() => {
    if (!deepLinkMaterialId) return
    if (deepLinkOpenedMaterialId === deepLinkMaterialId) return
    if (!paperWarehouseRows.length) return
    const row = paperWarehouseRows.find((r) => r.material_id === deepLinkMaterialId)
    if (!row) return
    setDeepLinkOpenedMaterialId(deepLinkMaterialId)
    void openMaterialDrawer(row)
  }, [deepLinkMaterialId, deepLinkOpenedMaterialId, paperWarehouseRows])

  useEffect(() => {
    if (!drawerRow) {
      setGenealogy(null)
      setIssueQty('')
      setIssueJobCardId('')
      setIssueHighPri(false)
      return
    }
    setGenealogyLoading(true)
    fetch(`/api/inventory/paper-warehouse/${drawerRow.id}/genealogy`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.steps) setGenealogy({ steps: data.steps as GenealogyStep[] })
        else setGenealogy(null)
      })
      .catch(() => setGenealogy(null))
      .finally(() => setGenealogyLoading(false))
  }, [drawerRow?.id])

  const sortedPaperRows = useMemo(() => {
    if (!paperLedger?.rows.length) return []
    const pending = paperLedger.rows.filter((r) => r.isMainWarehouse)
    const r = [...pending]
    r.sort((a, b) => {
      const pa = a.industrialPriority ? 1 : 0
      const pb = b.industrialPriority ? 1 : 0
      if (pa !== pb) return pb - pa
      if (paperLedgerSort === 'oldest') {
        return a.receiptDate.localeCompare(b.receiptDate) || a.ageDays - b.ageDays
      }
      return b.receiptDate.localeCompare(a.receiptDate) || b.ageDays - a.ageDays
    })
    return r
  }, [paperLedger, paperLedgerSort])

  const filteredPaperWarehouseRows = useMemo(() => {
    const q = paperSearch.trim().toLowerCase()
    const rows = paperWarehouseRows.filter((row) => {
      const hay = [
        row.size_display || '',
        row.board_classification_id || '',
        row.gsm == null ? '' : String(row.gsm),
        row.material_code || '',
        row.material_id || '',
        row.board_type_id || '',
        String(row.available_sheets),
        String(row.reserved_sheets),
        String(row.incoming_sheets),
        String(row.shortage_sheets),
        String(row.reorder_level),
        row.status || '',
      ]
        .join(' ')
        .toLowerCase()
      if (q && !hay.includes(q)) return false
      if (boardTypeFilter !== 'all' && (row.board_type_id || '') !== boardTypeFilter) return false
      if (gsmFilter !== 'all' && String(row.gsm ?? '') !== gsmFilter) return false
      if (statusFilter !== 'all' && (row.status || '').toLowerCase() !== statusFilter) return false
      if (shortageOnly && Number(row.shortage_sheets || 0) <= 0) return false
      return true
    })
    const kpiFiltered = rows.filter((row) => {
      const free = Number(row.available_sheets || 0) - Number(row.reserved_sheets || 0)
      if (warehouseKpiFilter === 'shortage') return Number(row.shortage_sheets || 0) > 0
      if (warehouseKpiFilter === 'available') return Number(row.available_sheets || 0) > 0
      if (warehouseKpiFilter === 'reserved') return Number(row.reserved_sheets || 0) > 0
      if (warehouseKpiFilter === 'incoming') return Number(row.incoming_sheets || 0) > 0
      if (warehouseKpiFilter === 'free') return free > 0
      if (warehouseKpiFilter === 'stale') return Number(row.age_days || 0) > 180
      if (warehouseKpiFilter === 'fast') return Number(row.packet_weight || 0) > 0
      if (warehouseKpiFilter === 'slow') return Number(row.packet_weight || 0) <= 0
      if (warehouseKpiFilter === 'mismatch') return Number(row.shortage_sheets || 0) > Number(row.incoming_sheets || 0)
      return true
    })
    if (!warehouseSort) return kpiFiltered
    const { key, dir } = warehouseSort
    const factor = dir === 'asc' ? 1 : -1
    return [...kpiFiltered].sort((a, b) => {
      const av = warehouseSortValue(a, key)
      const bv = warehouseSortValue(b, key)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor
      return String(av).localeCompare(String(bv)) * factor
    })
  }, [paperSearch, paperWarehouseRows, warehouseKpiFilter, boardTypeFilter, gsmFilter, statusFilter, shortageOnly, warehouseSort])

  const ragCounts = useMemo(() => {
    const counts = { green: 0, amber: 0, red: 0 }
    for (const row of filteredPaperWarehouseRows) {
      const rag = computeRag({
        shortage_sheets: Number(row.shortage_sheets),
        open_pr_id: row.open_pr_id ?? null,
        open_pr_status: row.open_pr_status ?? null,
        hasOpenPo: row.hasOpenPo ?? false,
      })
      counts[rag]++
    }
    return counts
  }, [filteredPaperWarehouseRows])

  function warehouseSortValue(row: PaperWarehouseRow, key: WarehouseSortKey): number | string {
    switch (key) {
      case 'free':
        return Number(row.available_sheets || 0) - Number(row.reserved_sheets || 0)
      case 'gsm':
        return row.gsm ?? Number.NEGATIVE_INFINITY
      case 'daysOfCover':
        return row.daysOfCover ?? Number.NEGATIVE_INFINITY
      case 'available_sheets':
        return Number(row.available_sheets || 0)
      case 'reserved_sheets':
        return Number(row.reserved_sheets || 0)
      case 'incoming_sheets':
        return Number(row.incoming_sheets || 0)
      case 'shortage_sheets':
        return Number(row.shortage_sheets || 0)
      case 'reorder_level':
        return Number(row.reorder_level || 0)
      case 'size_display':
        return (row.size_display || '').toLowerCase()
      case 'board_classification_id':
        return (row.board_classification_id || '').toLowerCase()
      case 'material_code':
        return (row.material_code || '').toLowerCase()
      case 'board_type_id':
        return (row.board_type_id || '').toLowerCase()
      case 'status':
        return (row.status || '').toLowerCase()
    }
  }

  function toggleWarehouseSort(key: WarehouseSortKey) {
    setWarehouseSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }

  const sortTh = (label: string, key: WarehouseSortKey, align: 'left' | 'right' = 'left') => {
    const active = warehouseSort?.key === key
    return (
      <th className={`px-3 py-2 ${align === 'right' ? 'text-right' : ''}`}>
        <button
          type="button"
          onClick={() => toggleWarehouseSort(key)}
          className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-ds-ink ${active ? 'text-ds-ink font-semibold' : ''}`}
        >
          {label}
          <span className="text-[10px] leading-none opacity-70">{active ? (warehouseSort?.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
        </button>
      </th>
    )
  }

  const boardTypeFilterOptions = useMemo(
    () =>
      Array.from(new Set(paperWarehouseRows.map((r) => r.board_type_id || '').filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [paperWarehouseRows],
  )

  const gsmFilterOptions = useMemo(
    () =>
      Array.from(
        new Set(
          paperWarehouseRows
            .map((r) => (r.gsm == null ? '' : String(r.gsm)))
            .filter(Boolean),
        ),
      ).sort((a, b) => Number(a) - Number(b)),
    [paperWarehouseRows],
  )

  const statusFilterOptions = useMemo(
    () =>
      Array.from(new Set(paperWarehouseRows.map((r) => (r.status || '').toLowerCase()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [paperWarehouseRows],
  )

  const filteredJobCards = useMemo(() => {
    const q = jobSearch.trim().toLowerCase()
    if (!q) return jobCards.slice(0, 80)
    return jobCards
      .filter(
        (j) =>
          String(j.jobCardNumber).includes(q) ||
          (j.customer?.name ?? '').toLowerCase().includes(q),
      )
      .slice(0, 80)
  }, [jobCards, jobSearch])

  async function submitIssueToFloor() {
    if (!drawerRow) return
    const qty = parseInt(issueQty.trim(), 10)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Enter a valid quantity')
      return
    }
    if (qty > drawerRow.qtySheets) {
      toast.error(`Cannot exceed on-hand ${drawerRow.qtySheets} sheets`)
      return
    }
    setIssueSubmitting(true)
    try {
      const res = await fetch('/api/inventory/paper-issue-floor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paperWarehouseId: drawerRow.id,
          productionJobCardId: issueJobCardId.trim() || null,
          qtySheets: qty,
          highPriorityAuthorized: issueHighPri,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Issue failed')
      toast.success(j.highPriorityLogged ? 'Issued · high-priority audit logged' : 'Issued to floor stock')
      setDrawerRow(null)
      await reloadAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setIssueSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="w-full px-4 py-3">
        <div className="rounded-ds-lg bg-background p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-ds-md bg-ds-elevated/30" />
            ))}
          </div>
          <div className="mt-4 h-10 animate-pulse rounded-ds-md bg-ds-elevated/30" />
          <div className="mt-3 h-64 animate-pulse rounded-ds-md bg-ds-elevated/30" />
        </div>
      </div>
    )
  }

  const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  const fmtVal = (n: number) => `₹${fmt(n)}`

  function ageDotClass(bucket: PaperLedgerRow['ageBucket']) {
    if (bucket === 'fresh') return 'bg-[var(--success-bg)]'
    if (bucket === 'mature') return 'bg-ds-warning'
    return 'bg-[var(--error-bg)] animate-pulse'
  }

  function ageLabel(bucket: PaperLedgerRow['ageBucket']) {
    if (bucket === 'fresh') return 'Fresh'
    if (bucket === 'mature') return 'Mature'
    return 'Stale'
  }

  const operatorLabel = session?.user?.name?.trim() || 'Operator'

  async function submitAdjust() {
    const qty = Number(adjustQty)
    if (!adjustMaterialId) {
      toast.error('Select material first')
      return
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Enter valid quantity')
      return
    }
    setAdjustSubmitting(true)
    try {
      const res = await fetch('/api/inventory/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialId: adjustMaterialId,
          qty,
          direction: adjustDirection,
          bucket: adjustBucket,
          ...(adjustReason.trim() ? { reasonCode: adjustReason.trim() } : {}),
          ...(adjustRemarks.trim() ? { remarks: adjustRemarks.trim() } : {}),
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Adjustment failed')
      toast.success('Stock adjusted')
      setAdjustOpen(false)
      setAdjustQty('')
      setAdjustReason('')
      setAdjustRemarks('')
      await reloadAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Adjustment failed')
    } finally {
      setAdjustSubmitting(false)
    }
  }

  function openAdjustForRow(
    row: PaperWarehouseRow,
    direction: 'add' | 'subtract' = 'add',
    bucket: 'quarantine' | 'available' | 'reserved' | 'fg' = 'available',
  ) {
    setAdjustMode('single')
    setAdjustMaterialId(row.material_id)
    setAdjustDirection(direction)
    setAdjustBucket(bucket)
    setAdjustQty('')
    setAdjustReason('')
    setAdjustRemarks('')
    setAdjustOpen(true)
  }

  async function submitBulkAdjust() {
    const lines = bulkAdjustInput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length === 0) {
      toast.error('Add at least one bulk entry')
      return
    }

    const materialByCode = new Map(items.map((i) => [i.materialCode.trim().toLowerCase(), i.id]))
    let success = 0
    const failures: string[] = []
    setBulkAdjustSubmitting(true)
    try {
      for (let idx = 0; idx < lines.length; idx += 1) {
        const raw = lines[idx]!
        const parts = raw.split(',').map((p) => p.trim())
        if (parts.length < 4) {
          failures.push(`Line ${idx + 1}: use at least 4 fields`)
          continue
        }
        const [materialToken, qtyToken, directionToken, bucketToken, reasonCode, remarks] = parts
        const qty = Number(qtyToken)
        const direction = directionToken?.toLowerCase() === 'subtract' ? 'subtract' : directionToken?.toLowerCase() === 'add' ? 'add' : null
        const bucket = ['quarantine', 'available', 'reserved', 'fg'].includes((bucketToken || '').toLowerCase())
          ? (bucketToken!.toLowerCase() as 'quarantine' | 'available' | 'reserved' | 'fg')
          : null
        const materialId = materialToken && materialToken.length > 30
          ? materialToken
          : materialByCode.get((materialToken || '').toLowerCase())

        if (!materialId) {
          failures.push(`Line ${idx + 1}: material not found (${materialToken || '-'})`)
          continue
        }
        if (!Number.isFinite(qty) || qty <= 0 || !direction || !bucket) {
          failures.push(`Line ${idx + 1}: invalid qty/direction/bucket`)
          continue
        }

        const res = await fetch('/api/inventory/adjust', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            materialId,
            qty,
            direction,
            bucket,
            ...(reasonCode ? { reasonCode } : {}),
            ...(remarks ? { remarks } : {}),
          }),
        })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) {
          failures.push(`Line ${idx + 1}: ${payload.error || 'failed'}`)
          continue
        }
        success += 1
      }

      if (success > 0) {
        toast.success(`Bulk stock update complete: ${success} successful`)
        await reloadAll()
      }
      if (failures.length > 0) {
        toast.error(`Bulk update had ${failures.length} failed line(s). Check format/errors.`)
        console.warn('[inventory/bulk-adjust/failures]', failures)
      } else if (success > 0) {
        setBulkAdjustInput('')
        setAdjustOpen(false)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk adjustment failed')
    } finally {
      setBulkAdjustSubmitting(false)
    }
  }

  async function reverseMovement(id: string) {
    const remarks = window.prompt('Reverse remarks (required):', 'Reverse wrong entry')
    if (!remarks || remarks.trim().length < 3) return
    try {
      const res = await fetch('/api/inventory/reverse-movement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ movementId: id, remarks: remarks.trim() }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Reverse failed')
      toast.success('Movement reversed')
      await reloadAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reverse failed')
    }
  }

  async function openMaterialDrawer(
    row: PaperWarehouseRow,
    view: 'history' | 'reserved' | 'available' | 'shortage' | 'free' = 'history',
  ) {
    setMaterialDrawerView(view)
    setMaterialDrawerRow(row)
    setMaterialDrawerData(null)
    setMaterialDrawerLoading(true)
    try {
      const res = await fetch(`/api/inventory/paper-warehouse/${row.material_id}/details`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to load material details')
      setMaterialDrawerData(data as MaterialDetailPayload)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load material details')
    } finally {
      setMaterialDrawerLoading(false)
    }
  }

  async function adjustReservationFromDrawer(args: {
    planningId: string
    materialId: string
    requiredSheets: number
    currentReserved: number
  }) {
    const nextValue = window.prompt('Target reserve qty for this planning line:', String(Math.max(0, args.currentReserved)))
    if (nextValue == null) return
    const target = Number(nextValue)
    if (!Number.isFinite(target) || target < 0) {
      toast.error('Invalid reserve qty')
      return
    }
    try {
      const res = await fetch(`/api/planning/po-lines/${releaseState.planningId}/reservation-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adjust',
          materialId: args.materialId,
          requiredSheets: Math.max(0, Math.floor(args.requiredSheets)),
          targetReserveQty: Math.max(0, target),
          prImpactAction: 'reduce',
        }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((out as { message?: string }).message || 'Adjust failed')
      toast.success('Reservation adjusted')
      await reloadAll()
      if (materialDrawerRow) await openMaterialDrawer(materialDrawerRow, materialDrawerView)
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Adjust failed')
    }
  }

  async function releaseReservationFromDrawer(args: {
    planningId: string
    materialId: string
    requiredSheets: number
    currentReserved: number
    materialCode?: string
    reservationId?: string
  }) {
    setReleaseError(null)
    setReleaseState({
      planningId: args.planningId,
      materialId: args.materialId,
      materialCode: args.materialCode || args.materialId,
      reservationId: args.reservationId ?? null,
      requiredSheets: Math.max(0, args.requiredSheets),
      currentReserved: Math.max(0, args.currentReserved),
    })
    setReleaseQtyInput(String(Math.max(0, args.currentReserved)))
    setReleaseOpen(true)
  }

  async function confirmReleaseFromDrawer() {
    if (!releaseState) return
    const releaseQty = Number(releaseQtyInput)
    if (!Number.isFinite(releaseQty) || releaseQty <= 0 || releaseQty > releaseState.currentReserved) {
      setReleaseError('Release qty must be > 0 and <= current reserved qty')
      return
    }
    setReleaseBusy(true)
    setReleaseError(null)
    try {
      const res = await fetch(`/api/planning/po-lines/${releaseState.planningId}/reservation-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'release',
          materialId: releaseState.materialId,
          requiredSheets: Math.max(0, Math.floor(releaseState.requiredSheets)),
          releaseQty: Math.max(0, releaseQty),
          prImpactAction: 'reduce',
        }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((out as { message?: string }).message || 'Release failed')
      toast.success('Reservation released')
      setReleaseOpen(false)
      await reloadAll()
      if (materialDrawerRow) await openMaterialDrawer(materialDrawerRow, materialDrawerView)
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      setReleaseError(e instanceof Error ? e.message : 'Release failed')
      toast.error(e instanceof Error ? e.message : 'Release failed')
    } finally {
      setReleaseBusy(false)
    }
  }

  async function generatePrFromDrawerShortage(shortageId: string, defaultQty: number) {
    const qtyInput = window.prompt('PR qty for this shortage:', String(Math.max(0, defaultQty)))
    if (qtyInput == null) return
    const qty = Number(qtyInput)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Invalid PR qty')
      return
    }
    try {
      const res = await fetch(`/api/material-shortages/${shortageId}/create-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prQty: qty }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((out as { error?: string }).error || 'PR action failed')
      toast.success((out as { reused?: boolean }).reused ? 'Existing PR reused' : 'PR created')
      await reloadAll()
      if (materialDrawerRow) await openMaterialDrawer(materialDrawerRow, materialDrawerView)
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'PR action failed')
    }
  }

  async function openProcureModal(row: PaperWarehouseRow) {
    setProcureError(null)
    try {
      if (!row.material_id) {
        toast.error('Material id missing')
        return
      }
      if (Number(row.shortage_sheets || 0) <= 0) {
        toast.error('No shortage available for PR')
        return
      }
      if (row.open_pr_id) {
        toast.info('PR already exists')
        window.location.href = `/inventory/purchase-requisitions?prId=${encodeURIComponent(row.open_pr_id)}`
        return
      }
      const res = await fetch(`/api/inventory/paper-warehouse/${row.material_id}/details`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to load shortage details')
      const payload = data as MaterialDetailPayload
      const shortages = (payload.shortages || [])
        .filter((s) => Number(s.pendingShortage) > 0)
        .map((s) => ({
          id: s.id,
          planningId: s.planningId,
          jobCardNumber: s.jobCardNumber,
          pendingShortage: Number(s.pendingShortage) || 0,
          requiredByDate: s.requiredByDate,
        }))
      if (shortages.length === 0) {
        toast.error('No open shortages linked to this material')
        return
      }
      const first = shortages[0]
      setProcureState({
        mode: 'shortage',
        materialId: row.material_id,
        materialCode: row.material_code,
        boardType: row.board_type_id ?? null,
        size: row.size_display,
        gsm: row.gsm ?? null,
        shortages,
      })
      setProcureShortageId(first?.id || '')
      setProcurePrQty(String(Math.max(0, Number(first?.pendingShortage || 0))))
      setProcureBuffer(false)
      setProcureOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load shortage details')
    }
  }

  function openManualProcureModal(row: PaperWarehouseRow) {
    setProcureError(null)
    if (!row.material_id) {
      toast.error('Material id missing')
      return
    }
    if (row.open_pr_id) {
      toast.info('PR already exists')
      window.location.href = `/inventory/purchase-requisitions?prId=${encodeURIComponent(row.open_pr_id)}`
      return
    }
    setProcureState({
      mode: 'manual',
      materialId: row.material_id,
      materialCode: row.material_code,
      boardType: row.board_type_id ?? null,
      size: row.size_display,
      gsm: row.gsm ?? null,
      shortages: [],
    })
    setProcureShortageId('')
    setProcurePrQty('')
    setProcureBuffer(false)
    setProcureOpen(true)
  }

  async function submitProcure() {
    if (!procureState) {
      setProcureError('Nothing to procure')
      return
    }
    if (procureState.mode === 'shortage' && !procureShortageId) {
      setProcureError('Select shortage first')
      return
    }
    const baseQty = Math.max(0, Number(procurePrQty || 0))
    const qty = procureBuffer ? Math.ceil(baseQty * 1.1) : baseQty
    if (!Number.isFinite(qty) || qty <= 0) {
      setProcureError('PR Qty must be greater than 0')
      return
    }
    setProcureBusy(true)
    setProcureError(null)
    try {
      const res =
        procureState.mode === 'manual'
          ? await fetch(`/api/inventory/paper-warehouse/${procureState.materialId}/create-pr`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ qty }),
            })
          : await fetch(`/api/material-shortages/${procureShortageId}/create-pr`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prQty: qty }),
            })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to generate PR')
      const payload = data as { purchaseRequestId?: string; reused?: boolean; message?: string }
      if (payload.reused) {
        toast.success('Existing PR reused')
      } else {
        toast.success(`PR created for ${qty.toLocaleString('en-IN')} sheets`)
      }
      setProcureOpen(false)
      await reloadAll()
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to generate PR'
      setProcureError(msg)
      console.error('[planning-reservation-control]', { scope: 'paper-warehouse-procure', shortageId: procureShortageId, msg })
      toast.error(msg)
    } finally {
      setProcureBusy(false)
    }
  }

  async function deletePaperRow(row: PaperWarehouseRow) {
    const first = window.confirm(
      `Delete paper row for ${row.material_code}?\nThis removes the warehouse row permanently.`,
    )
    if (!first) return
    const token = window.prompt(`Second confirmation: type DELETE ${row.material_code} to continue.`)
    if (token !== `DELETE ${row.material_code}`) {
      toast.error('Delete cancelled: confirmation token mismatch')
      return
    }
    try {
      const res = await fetch(`/api/inventory/paper-warehouse/${row.material_id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Delete failed')
      toast.success('Paper warehouse row deleted')
      setSelectedMaterialIds((prev) => {
        const next = new Set(prev)
        next.delete(row.material_id)
        return next
      })
      await reloadAll()
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }


  return (
      <div className="w-full px-4 py-3">
        <section
          id="paper-ledger"
          className="rounded-ds-lg overflow-hidden bg-background text-ds-ink shadow-ds-depth-sm"
        >
          <div className="p-4 md:p-6">
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-[var(--brand-primary)]">Paper Warehouse (Raw Materials)</h2>
                <p className="text-xs text-ds-ink-faint mt-1 font-mono">
                  Master-driven paper stock only. Reservation, incoming, and shortage are synchronized with Planning and PR.
                </p>
                {(ledgerGsm || ledgerBoard) && (
                  <p className={`text-xs text-[var(--brand-primary)] mt-2 ${ledgerMono}`}>
                    Job card deep link · GSM {ledgerGsm || '—'} · Board {ledgerBoard || '—'}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAdjustOpen(true)}
                  className="rounded-ds-md bg-ds-elevated px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated/80"
                >
                  Adjust Stock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedMaterialIds.size === 0) {
                      toast.error('Select at least one row')
                      return
                    }
                    const lines = filteredPaperWarehouseRows
                      .filter((r) => selectedMaterialIds.has(r.material_id))
                      .map((r) => `${r.material_code}, 0, add, available, , `)
                      .join('\n')
                    setAdjustMode('bulk')
                    setBulkAdjustInput(lines)
                    setAdjustOpen(true)
                  }}
                  className="rounded-ds-md bg-ds-elevated px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated/80"
                >
                  Bulk Add/Remove
                </button>
                <Link
                  href="/inventory/flow"
                  className="rounded-ds-md bg-ds-elevated px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated/80"
                >
                  Inventory Flow
                </Link>
                <Link
                  href="/inventory/purchase-requisitions"
                  className="rounded-ds-md bg-ds-elevated px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated/80"
                >
                  Purchase Requisitions
                </Link>
                <Link
                  href="/inventory/grn"
                  className="rounded-ds-md bg-[var(--brand-primary)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Add Stock (GRN)
                </Link>
              </div>
            </div>

            <WarehouseKpiStrip
              ragCounts={ragCounts}
              incomingKgThisWeek={0}
              openPoValueInr={0}
              avgDaysOfCover={
                filteredPaperWarehouseRows.filter((r) => r.daysOfCover != null).length > 0
                  ? filteredPaperWarehouseRows.reduce((s, r) => s + (r.daysOfCover ?? 0), 0) /
                    filteredPaperWarehouseRows.filter((r) => r.daysOfCover != null).length
                  : null
              }
              onFilterRed={() => setWarehouseTab('stock')}
              onFilterAmber={() => setWarehouseTab('stock')}
              onSwitchToOpenPos={() => setWarehouseTab('open-pos')}
              onSwitchToIncoming={() => setWarehouseTab('incoming')}
            />

            {/* Warehouse tab navigation */}
            <div className="flex gap-0 mb-4">
              {(['stock', 'open-pos', 'incoming', 'reports'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setWarehouseTab(tab)}
                  className={cn(
                    'pb-2 pr-6 text-sm font-medium transition-colors',
                    warehouseTab === tab
                      ? 'border-b-2 border-ds-primary text-ds-ink'
                      : 'text-ds-ink-muted hover:text-ds-ink',
                  )}
                >
                  {tab === 'stock' ? 'Stock' : tab === 'open-pos' ? 'Open POs' : tab === 'incoming' ? 'Incoming' : 'Reports'}
                </button>
              ))}
            </div>

            {warehouseTab === 'stock' && (
              <StockTab
                rows={filteredPaperWarehouseRows}
                onRowClick={(row) => setMaterialDrawerRow(row)}
              />
            )}
            {warehouseTab === 'open-pos' && <OpenPosTab />}
            {warehouseTab === 'incoming' && <IncomingTab />}
            {warehouseTab === 'reports' && <ReportsTab />}

          </div>
        </section>

        <MaterialDrawer
          row={materialDrawerRow}
          isOpen={!!materialDrawerRow}
          onClose={() => setMaterialDrawerRow(null)}
          onPrCreated={() => { void reloadAll() }}
          onPoCreated={() => { void reloadAll() }}
        />

        {/* Legacy material details panel — kept hidden for JSX balance; replaced by MaterialDrawer above */}
        <SlideOverPanel
          title="Material details (legacy)"
          isOpen={false}
          onClose={() => {
            setMaterialDrawerRow(null)
            setMaterialDrawerData(null)
          }}
          widthClass="max-w-xl"
        >
          {materialDrawerRow ? (
            <div className={`flex h-full flex-col text-xs text-ds-ink-muted ${ledgerMono}`}>
              <div className="sticky top-0 z-10 bg-background px-4 py-3">
                <p className="text-xs uppercase tracking-wide text-ds-ink-faint">
                  {materialDrawerView === 'reserved'
                    ? 'Reserved Stock'
                    : materialDrawerView === 'available'
                      ? 'Available Stock'
                      : materialDrawerView === 'shortage'
                        ? 'Shortage'
                        : materialDrawerView === 'free'
                          ? 'Free Stock'
                          : 'Material History'}
                </p>
                <p className="text-sm font-semibold text-ds-ink">{materialDrawerData?.material.materialCode ?? materialDrawerRow.material_code}</p>
              </div>
              <div className="flex-1 overflow-y-auto space-y-4 px-4 py-3">
                <div className="grid grid-cols-2 gap-2 rounded bg-ds-elevated/20 p-2">
                  <div><span className="text-ds-ink-muted">Material Code</span><p className="font-semibold text-ds-ink">{materialDrawerData?.material.materialCode ?? materialDrawerRow.material_code}</p></div>
                  <div><span className="text-ds-ink-muted">Board Type</span><p className="text-ds-ink">{materialDrawerData?.material.boardType ?? materialDrawerRow.board_type_id ?? '-'}</p></div>
                  <div><span className="text-ds-ink-muted">Classification</span><p className="text-ds-ink">{materialDrawerData?.material.boardClassification ?? materialDrawerRow.board_classification_id ?? '-'}</p></div>
                  <div><span className="text-ds-ink-muted">GSM</span><p className="text-ds-ink">{String(materialDrawerData?.material.gsm ?? materialDrawerRow.gsm ?? '-')}</p></div>
                  <div><span className="text-ds-ink-muted">Available</span><p className="font-semibold text-[var(--success)]">{fmt(materialDrawerRow.available_sheets)}</p></div>
                  <div><span className="text-ds-ink-muted">Reserved</span><p className="font-semibold text-[var(--warning)]">{fmt(materialDrawerRow.reserved_sheets)}</p></div>
                  <div><span className="text-ds-ink-muted">Shortage</span><p className="font-semibold text-[var(--error)]">{fmt(materialDrawerRow.shortage_sheets)}</p></div>
                  <div><span className="text-ds-ink-muted">Free Stock</span><p className={`font-semibold ${(materialDrawerRow.available_sheets - materialDrawerRow.reserved_sheets) < 0 ? 'text-[var(--error)]' : 'text-cyan-700'}`}>{fmt(materialDrawerRow.available_sheets - materialDrawerRow.reserved_sheets)}</p></div>
                </div>
                {materialDrawerData?.material.sourceTraceability ? (
                  <p className="rounded bg-ds-elevated/20 px-2 py-1 text-ds-ink-faint">
                    {materialDrawerData.material.sourceTraceability}
                  </p>
                ) : null}
                {materialDrawerData?.material.leftoverMeta?.isLeftover ? (
                  <div className="rounded bg-[var(--brand-bg-soft)] p-2">
                    <p className="text-xs uppercase tracking-wide text-ds-brand">Leftover Stock</p>
                    <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                      <div><span className="text-ds-ink-faint">Source Planning</span><p className="text-ds-ink">{materialDrawerData.material.leftoverMeta.sourcePlanningId || '-'}</p></div>
                      <div><span className="text-ds-ink-faint">Source Job</span><p className="text-ds-ink">{materialDrawerData.material.leftoverMeta.sourceJobCardId || '-'}</p></div>
                      <div><span className="text-ds-ink-faint">Original Parent</span><p className="text-ds-ink">{materialDrawerData.material.leftoverMeta.sourceParentSize || '-'}</p></div>
                      <div><span className="text-ds-ink-faint">Leftover Size</span><p className="text-ds-ink">{materialDrawerData.material.leftoverMeta.leftoverSize || '-'}</p></div>
                      <div><span className="text-ds-ink-faint">Cut Size Used</span><p className="text-ds-ink">{materialDrawerData.material.leftoverMeta.cutSizeUsed || '-'}</p></div>
                      <div><span className="text-ds-ink-faint">Source Material</span><p className="text-ds-ink">{materialDrawerData.material.leftoverMeta.sourceMaterialId || '-'}</p></div>
                    </div>
                    {materialDrawerData.material.leftoverMeta.remarks ? (
                      <p className="mt-1 text-ds-ink-faint">Remarks: {materialDrawerData.material.leftoverMeta.remarks}</p>
                    ) : null}
                  </div>
                ) : null}

                {materialDrawerView === 'reserved' ? (
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-ds-ink-faint">Reserved by planning/job rows</p>
                    {materialDrawerLoading ? (
                      <p className="text-ds-ink-faint">Loading…</p>
                    ) : !materialDrawerData || materialDrawerData.reservations.length === 0 ? (
                      <p className="text-ds-ink-faint">No active reservations.</p>
                    ) : (
                      <ul className="space-y-2">
                        {materialDrawerData.reservations.map((r) => (
                          <li key={r.id} className="rounded px-2 py-1.5">
                            <p className="text-ds-ink">
                              {(r.planningId ? `PL#${r.planningId.slice(0, 8)}` : '-')}{r.jobCard?.jobCardNumber ? ` · JC#${r.jobCard.jobCardNumber}` : ''}
                            </p>
                            <p className="text-ds-ink-faint">{r.cartonName || '-'} {r.poNumber ? `· ${r.poNumber}` : ''}</p>
                            <p className="font-semibold text-[var(--warning)]">Reserved {fmt(r.reservedSheets)} · Date {r.reservedAt ? new Date(r.reservedAt).toLocaleDateString('en-IN') : '-'}</p>
                            <p className="text-ds-ink-faint">Status: {r.jobCard?.status || r.status || '-'}</p>
                            <div className="mt-1 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={!r.planningId}
                                onClick={() => r.planningId && void adjustReservationFromDrawer({
                                  planningId: r.planningId,
                                  materialId: materialDrawerRow.material_id,
                                  requiredSheets: r.requiredSheets,
                                  currentReserved: r.reservedSheets,
                                })}
                                className="rounded px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40 disabled:opacity-40"
                              >
                                Adjust Reservation
                              </button>
                              <button
                                type="button"
                                disabled={!r.planningId}
                                onClick={() => r.planningId && void releaseReservationFromDrawer({
                                  planningId: r.planningId,
                                  materialId: materialDrawerRow.material_id,
                                  materialCode: materialDrawerRow.material_code,
                                  reservationId: r.id,
                                  requiredSheets: r.requiredSheets,
                                  currentReserved: r.reservedSheets,
                                })}
                                className="rounded bg-[var(--warning-bg)] px-2 py-1 text-xs text-ds-warning hover:bg-ds-warning/10 disabled:opacity-40"
                              >
                                Release / Unreserve
                              </button>
                              {r.planningId ? (
                                <Link href={`/orders/planning?lineId=${encodeURIComponent(r.planningId)}`} className="rounded bg-[var(--brand-bg-soft)] px-2 py-1 text-xs text-ds-brand hover:bg-ds-brand/10">
                                  View Planning / Job
                                </Link>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                {materialDrawerView === 'available' ? (
                  <div className="space-y-2">
                    <p className="text-xs uppercase tracking-wide text-ds-ink-faint">Available stock guidance</p>
                    <div className="rounded bg-ds-elevated/20 p-2 text-ds-ink-faint">
                      <p>Incoming: {fmt(materialDrawerRow.incoming_sheets)}</p>
                      <p>Free Stock: {fmt(materialDrawerRow.available_sheets - materialDrawerRow.reserved_sheets)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => toast.info('Open a planning line to reserve this stock.')}
                        className="rounded px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                      >
                        Reserve for Planning
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAdjustMode('single')
                          setAdjustMaterialId(materialDrawerRow.material_id)
                          setAdjustBucket('available')
                          setAdjustDirection('add')
                          setAdjustOpen(true)
                        }}
                        className="rounded bg-ds-elevated px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                      >
                        Adjust Stock
                      </button>
                      <button
                        type="button"
                        onClick={() => setMaterialDrawerView('history')}
                        className="rounded bg-ds-elevated px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                      >
                        View History
                      </button>
                    </div>
                  </div>
                ) : null}

                {materialDrawerView === 'shortage' ? (
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-ds-ink-faint">Shortage by planning/job</p>
                    {materialDrawerLoading ? (
                      <p className="text-ds-ink-faint">Loading…</p>
                    ) : !materialDrawerData || materialDrawerData.shortages.length === 0 ? (
                      <p className="text-ds-ink-faint">No open shortages.</p>
                    ) : (
                      <ul className="space-y-2">
                        {materialDrawerData.shortages.map((s) => (
                          <li key={s.id} className="rounded px-2 py-1.5">
                            <p className="text-ds-ink">{s.planningId ? `PL#${s.planningId.slice(0, 8)}` : s.jobCardId} {s.jobCardNumber ? `· JC#${s.jobCardNumber}` : ''}</p>
                            <p className="text-ds-ink-faint">Pending {fmt(s.pendingShortage)} / Required {fmt(s.requiredQty)}</p>
                            <p className="text-ds-ink-faint">PR Status: {s.prStatus || '-'}</p>
                            <div className="mt-1 flex flex-wrap gap-2">
                              {s.prId ? (
                                <>
                                  <Link href={`/inventory/purchase-requisitions?prId=${encodeURIComponent(s.prId)}`} className="rounded px-2 py-1 text-xs text-ds-brand hover:bg-ds-brand/10">View PR</Link>
                                  <button type="button" onClick={() => s.prId && (window.location.href = `/inventory/purchase-requisitions?prId=${encodeURIComponent(s.prId)}`)} className="rounded px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40">Adjust PR</button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void generatePrFromDrawerShortage(s.id, s.pendingShortage)}
                                  className="rounded bg-[var(--error-bg)] px-2 py-1 text-xs text-[var(--error)] hover:bg-[var(--error-bg)]"
                                >
                                  Generate PR
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                {materialDrawerView === 'free' ? (
                  <div className="rounded bg-ds-elevated/20 p-2">
                    <p className="text-ds-ink">Free stock = Available - Reserved = {fmt(materialDrawerRow.available_sheets - materialDrawerRow.reserved_sheets)}</p>
                    {(materialDrawerRow.available_sheets - materialDrawerRow.reserved_sheets) < 0 ? (
                      <p className="mt-1 text-[var(--error)]">
                        Negative free stock means more stock is reserved than currently available.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-ds-ink-faint">Recent stock logs</p>
                  {materialDrawerLoading ? (
                    <p className="text-ds-ink-faint">Loading…</p>
                  ) : !materialDrawerData || materialDrawerData.logs.length === 0 ? (
                    <p className="text-ds-ink-faint">No stock logs found.</p>
                  ) : (
                    <ul className="space-y-2">
                      {materialDrawerData.logs.slice(0, 20).map((log) => (
                        <li key={log.id} className="rounded px-2 py-1.5">
                          <p className="text-ds-ink">{log.movementType} · {log.qty.toLocaleString('en-IN')}</p>
                          {log.reservationContext ? (
                            <div className="mt-0.5 space-y-0.5 text-ds-ink-faint">
                              <p>
                                {(log.reservationContext.planningId ? `PL#${log.reservationContext.planningId.slice(0, 8)}` : '-')}
                                {log.reservationContext.jobCard?.jobCardNumber ? ` · JC#${log.reservationContext.jobCard.jobCardNumber}` : ''}
                                {log.reservationContext.poNumber ? ` · PO ${log.reservationContext.poNumber}` : ''}
                              </p>
                              <p>
                                {log.reservationContext.cartonName || '-'}
                                {log.reservationContext.jobCard?.customerName ? ` · ${log.reservationContext.jobCard.customerName}` : ''}
                                {log.reservationContext.jobCard?.status ? ` · ${log.reservationContext.jobCard.status}` : ''}
                              </p>
                            </div>
                          ) : null}
                          <p className="text-ds-ink-faint">
                            {new Date(log.createdAt).toLocaleString()} · {log.refType ?? '—'} {log.refId ? `· ${log.refId.slice(0, 8)}` : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="sticky bottom-0 bg-background px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setMaterialDrawerView('history')}
                    className="rounded px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                  >
                    Show full history
                  </button>
                  <Link
                    href="/inventory"
                    className="rounded bg-ds-brand/10 px-2 py-1 text-xs text-ds-brand hover:bg-ds-brand/20"
                  >
                    Open Warehouse
                  </Link>
                </div>
              </div>
            </div>
          ) : null}
        </SlideOverPanel>

        <SlideOverPanel
          title="Generate Purchase Request"
          isOpen={procureOpen}
          onClose={() => setProcureOpen(false)}
          widthClass="max-w-md"
        >
          <div className="space-y-3 px-1 text-xs text-ds-ink">
            {!procureState ? (
              <p className="text-ds-ink-faint">-</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 rounded bg-ds-elevated/20 p-2">
                  <div><span className="text-ds-ink-muted">Material</span><p className={ledgerMono}>{procureState.materialCode}</p></div>
                  <div><span className="text-ds-ink-muted">Board Type</span><p>{procureState.boardType || '-'}</p></div>
                  <div><span className="text-ds-ink-muted">Size</span><p className={ledgerMono}>{procureState.size || '-'}</p></div>
                  <div><span className="text-ds-ink-muted">GSM</span><p className={ledgerMono}>{procureState.gsm ?? '-'}</p></div>
                </div>
                {procureState.mode === 'manual' ? (
                  <p className="rounded bg-[var(--brand-bg-soft)] px-2 py-1.5 text-ds-brand">
                    Manual reorder — raises a Purchase Requisition not tied to any job shortage.
                  </p>
                ) : (
                  <label className="block text-xs text-ds-ink-faint">
                    Shortage reference
                    <select
                      value={procureShortageId}
                      onChange={(e) => {
                        const id = e.target.value
                        setProcureShortageId(id)
                        const hit = procureState.shortages.find((s) => s.id === id)
                        if (hit) setProcurePrQty(String(Math.max(0, hit.pendingShortage)))
                      }}
                      className="mt-1 w-full rounded bg-background px-2 py-2 text-xs"
                    >
                      {procureState.shortages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.planningId ? `PL#${s.planningId.slice(0, 8)}` : `JC#${s.jobCardNumber ?? '-'}`} · shortage {fmt(s.pendingShortage)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="block text-xs text-ds-ink-faint">
                  PR Qty
                  <input
                    type="number"
                    min={0}
                    step="1"
                    value={procurePrQty}
                    onChange={(e) => setProcurePrQty(e.target.value)}
                    className="mt-1 w-full rounded bg-background px-2 py-2 text-xs"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-ds-ink-muted">
                  <input
                    type="checkbox"
                    checked={procureBuffer}
                    onChange={(e) => setProcureBuffer(e.target.checked)}
                    className="rounded"
                  />
                  Add 10% buffer
                </label>
                {procureError ? (
                  <div className="rounded bg-[var(--error-bg)] px-2 py-1 text-[var(--error)]">{procureError}</div>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="rounded px-3 py-1.5 text-xs"
                    onClick={() => setProcureOpen(false)}
                    disabled={procureBusy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded bg-[var(--brand-primary)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                    onClick={() => void submitProcure()}
                    disabled={procureBusy}
                  >
                    {procureBusy ? 'Generating…' : 'Generate PR'}
                  </button>
                </div>
              </>
            )}
          </div>
        </SlideOverPanel>

        <SlideOverPanel
          title="Adjust warehouse stock"
          isOpen={adjustOpen}
          onClose={() => setAdjustOpen(false)}
          widthClass="max-w-md"
        >
          <div className="space-y-3 px-1 text-sm">
            <div className="inline-flex rounded-ds-md bg-background p-1">
              <button
                type="button"
                onClick={() => setAdjustMode('single')}
                className={`rounded px-2.5 py-1.5 text-xs ${adjustMode === 'single' ? 'bg-[var(--brand-primary)] text-white' : 'text-ds-ink-muted'}`}
              >
                Single entry
              </button>
              <button
                type="button"
                onClick={() => setAdjustMode('bulk')}
                className={`rounded px-2.5 py-1.5 text-xs ${adjustMode === 'bulk' ? 'bg-[var(--brand-primary)] text-white' : 'text-ds-ink-muted'}`}
              >
                Bulk entries
              </button>
            </div>

            {adjustMode === 'single' ? (
              <>
                <label className="block text-xs text-ds-ink-faint">
                  Material
                  <select
                    value={adjustMaterialId}
                    onChange={(e) => setAdjustMaterialId(e.target.value)}
                    className="mt-1 w-full rounded bg-background px-2 py-2 text-xs"
                  >
                    <option value="">Select material</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.materialCode} - {i.description}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-ds-ink-faint">
                    Direction
                    <select
                      value={adjustDirection}
                      onChange={(e) => setAdjustDirection(e.target.value as 'add' | 'subtract')}
                      className="mt-1 w-full rounded bg-background px-2 py-2 text-xs"
                    >
                      <option value="add">Add (+)</option>
                      <option value="subtract">Subtract (-)</option>
                    </select>
                  </label>
                  <label className="block text-xs text-ds-ink-faint">
                    Bucket
                    <select
                      value={adjustBucket}
                      onChange={(e) =>
                        setAdjustBucket(
                          e.target.value as 'quarantine' | 'available' | 'reserved' | 'fg',
                        )
                      }
                      className="mt-1 w-full rounded bg-background px-2 py-2 text-xs"
                    >
                      <option value="quarantine">Quarantine</option>
                      <option value="available">Available</option>
                      <option value="reserved">Reserved</option>
                      <option value="fg">FG</option>
                    </select>
                  </label>
                </div>
                <label className="block text-xs text-ds-ink-faint">
                  Qty
                  <input
                    type="number"
                    min={0.001}
                    step="0.001"
                    value={adjustQty}
                    onChange={(e) => setAdjustQty(e.target.value)}
                    className="mt-1 w-full rounded bg-background px-2 py-2 text-xs"
                  />
                </label>
                <label className="block text-xs text-ds-ink-faint">
                  Reason code
                  <input
                    type="text"
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                    className="mt-1 w-full rounded bg-background px-2 py-2 text-xs"
                    placeholder="e.g. count_correction"
                  />
                </label>
                <label className="block text-xs text-ds-ink-faint">
                  Remarks
                  <textarea
                    value={adjustRemarks}
                    onChange={(e) => setAdjustRemarks(e.target.value)}
                    className="mt-1 min-h-[90px] w-full rounded bg-background px-2 py-2 text-xs"
                  />
                </label>
                <button
                  type="button"
                  disabled={adjustSubmitting}
                  onClick={() => void submitAdjust()}
                  className="w-full rounded bg-[var(--brand-primary)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {adjustSubmitting ? 'Saving...' : 'Save adjustment'}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-ds-ink-faint">
                  One line per entry: <span className={ledgerMono}>materialCode or materialId, qty, add|subtract, available|reserved|quarantine|fg, [reasonCode], [remarks]</span>
                </p>
                <textarea
                  value={bulkAdjustInput}
                  onChange={(e) => setBulkAdjustInput(e.target.value)}
                  placeholder={`TEST-MAT-123, 100, add, available, trial_load, Trial load opening stock\nTEST-MAT-123, 20, subtract, available`}
                  className="min-h-[180px] w-full rounded bg-background px-2 py-2 text-xs"
                />
                <button
                  type="button"
                  disabled={bulkAdjustSubmitting}
                  onClick={() => void submitBulkAdjust()}
                  className="w-full rounded bg-[var(--brand-primary)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {bulkAdjustSubmitting ? 'Processing…' : 'Run bulk update'}
                </button>
              </>
            )}
          </div>
        </SlideOverPanel>
        <ReservationsPanel
          materialId={reservationsPanelMaterialId}
          open={reservationsPanelMaterialId !== null}
          onClose={() => setReservationsPanelMaterialId(null)}
          onRefresh={() => loadPaperWarehouse('')}
        />
      </div>
    )
}

export default function InventoryPage() {
  return (
    <Suspense
      fallback={
        <div className="p-4 max-w-6xl mx-auto text-ds-ink-muted bg-background min-h-[30vh]">Loading warehouse…</div>
      }
    >
      <InventoryPageContent />
    </Suspense>
  )
}
