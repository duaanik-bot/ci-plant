'use client'

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Star, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import { ReservationsPanel } from './components/ReservationsPanel'

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

type PaperWarehouseRow = {
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
}

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
  const ledgerGsm = searchParams.get('ledgerGsm')?.trim() ?? ''
  const ledgerBoard = searchParams.get('ledgerBoard')?.trim() ?? ''
  const deepLinkMaterialId = searchParams.get('materialId')?.trim() ?? ''
  const { data: session } = useSession()
  const [items, setItems] = useState<StockStateItem[]>([])
  const [alerts, setAlerts] = useState<StockStateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [paperLedger, setPaperLedger] = useState<{
    rows: PaperLedgerRow[]
    staleCapitalInr: number
  } | null>(null)
  const [paperWarehouseRows, setPaperWarehouseRows] = useState<PaperWarehouseRow[]>([])
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
    return rows.filter((row) => {
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
  }, [paperSearch, paperWarehouseRows, warehouseKpiFilter, boardTypeFilter, gsmFilter, statusFilter, shortageOnly])

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
        <div className="rounded-ds-lg border border-ds-line/40 bg-background p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-ds-md border border-ds-line/30 bg-ds-elevated/30" />
            ))}
          </div>
          <div className="mt-4 h-10 animate-pulse rounded-ds-md border border-ds-line/30 bg-ds-elevated/30" />
          <div className="mt-3 h-64 animate-pulse rounded-ds-md border border-ds-line/30 bg-ds-elevated/30" />
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

  async function submitProcure() {
    if (!procureState || !procureShortageId) {
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
      const res = await fetch(`/api/material-shortages/${procureShortageId}/create-pr`, {
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

  const paperWarehouseOnlyMode = true
  const allRowsSelected =
    filteredPaperWarehouseRows.length > 0 &&
    filteredPaperWarehouseRows.every((r) => selectedMaterialIds.has(r.material_id))
  if (paperWarehouseOnlyMode) {
    return (
      <div className="w-full px-4 py-3">
        <section
          id="paper-ledger"
          className="rounded-ds-lg border border-ds-line/40 overflow-hidden bg-background text-ds-ink"
        >
          <div className="p-4 md:p-6">
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ds-warning">Paper Warehouse (Raw Materials)</h2>
                <p className="text-xs text-ds-ink-faint mt-1 font-mono">
                  Master-driven paper stock only. Reservation, incoming, and shortage are synchronized with Planning and PR.
                </p>
                {(ledgerGsm || ledgerBoard) && (
                  <p className={`text-xs text-ds-warning mt-2 ${ledgerMono}`}>
                    Job card deep link · GSM {ledgerGsm || '—'} · Board {ledgerBoard || '—'}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAdjustOpen(true)}
                  className="rounded-ds-md border border-ds-line/50 bg-background px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated/40"
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
                  className="rounded-ds-md border border-ds-line/50 bg-background px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated/40"
                >
                  Bulk Add/Remove
                </button>
                <Link
                  href="/inventory/flow"
                  className="rounded-ds-md border border-ds-line/50 bg-background px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated/40"
                >
                  Inventory Flow
                </Link>
                <Link
                  href="/inventory/purchase-requisitions"
                  className="rounded-ds-md border border-ds-line/50 bg-background px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated/40"
                >
                  Purchase Requisitions
                </Link>
                <Link
                  href="/inventory/grn"
                  className="rounded-ds-md bg-ds-warning px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-95"
                >
                  Add Stock (GRN)
                </Link>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6 mb-4">
              {[
                { key: 'shortage' as const, label: 'Shortage', value: fmt(paperWarehouseKpi.shortage), tone: 'border-[var(--error)]/45 bg-[var(--error-bg)] text-[var(--error)]' },
                { key: 'available' as const, label: 'Available', value: fmt(paperWarehouseKpi.available), tone: 'border-[var(--success)]/45 bg-[var(--success-bg)] text-[var(--success)]' },
                { key: 'reserved' as const, label: 'Reserved', value: fmt(paperWarehouseKpi.reserved), tone: 'border-[var(--warning)]/45 bg-[var(--warning-bg)] text-[var(--warning)]' },
                { key: 'free' as const, label: 'Free Stock', value: fmt(paperWarehouseKpi.freeStock), tone: 'border-cyan-500/45 bg-cyan-500/8 text-cyan-600' },
                { key: 'incoming' as const, label: 'Incoming', value: fmt(paperWarehouseKpi.incoming), tone: 'border-[var(--info)]/45 bg-[var(--info-bg)] text-[var(--info)]' },
                { key: 'all' as const, label: 'Total Stock', value: fmt(paperWarehouseKpi.totalPhysical), tone: 'border-ds-line/40 bg-ds-elevated/10 text-ds-ink' },
                { key: 'stale' as const, label: 'Stale', value: fmtVal(paperWarehouseKpi.staleStock), tone: 'border-[var(--error)]/45 bg-[var(--error-bg)] text-[var(--error)]' },
                { key: 'fast' as const, label: 'Fast-moving', value: fmt(paperWarehouseKpi.fastMoving), tone: 'border-[var(--success)]/45 bg-[var(--success-bg)] text-[var(--success)]' },
                { key: 'slow' as const, label: 'Slow-moving', value: fmt(paperWarehouseKpi.slowMoving), tone: 'border-ds-line/40 bg-ds-elevated/10 text-ds-ink' },
                { key: 'mismatch' as const, label: 'Incoming Mismatch', value: fmt(paperWarehouseKpi.incomingRequiredMismatch), tone: 'border-ds-warning/35 bg-ds-warning/10 text-ds-warning' },
                { key: 'all' as const, label: 'Inventory Value', value: fmtVal(paperWarehouseKpi.value), tone: 'border-ds-line/40 bg-ds-elevated/10 text-ds-ink' },
                { key: 'all' as const, label: 'Ageing Risk', value: fmtVal(paperWarehouseKpi.ageingRisk), tone: 'border-[var(--error)]/45 bg-[var(--error-bg)] text-[var(--error)]' },
              ].map((kpi, i) => (
                <button
                  key={`${kpi.label}-${i}`}
                  type="button"
                  onClick={() => setWarehouseKpiFilter((f) => (f === kpi.key ? 'all' : kpi.key))}
                  className={`h-16 rounded-ds-md border px-3 py-2 text-left shadow-sm transition hover:shadow ${kpi.tone} cursor-pointer`}
                >
                  <p className="text-[11px] uppercase tracking-wide text-ds-ink-muted">{kpi.label}</p>
                  <p className={`${ledgerMono} text-lg font-bold`}>{kpi.value}</p>
                </button>
              ))}
            </div>

            <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex w-full items-center gap-2 lg:max-w-3xl">
                <input
                  type="text"
                  value={paperSearch}
                  onChange={(e) => setPaperSearch(e.target.value)}
                  placeholder="Search by material code, board type, classification, size, GSM..."
                  className={`w-full rounded-ds-md border border-ds-line/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-ds-ink-faint ${ledgerMono}`}
                />
                <select
                  value={boardTypeFilter}
                  onChange={(e) => setBoardTypeFilter(e.target.value)}
                  className="w-36 rounded-ds-md border border-ds-line/50 bg-background px-2 py-2 text-xs text-ds-ink"
                >
                  <option value="all">Board Type</option>
                  {boardTypeFilterOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                <select
                  value={gsmFilter}
                  onChange={(e) => setGsmFilter(e.target.value)}
                  className="w-24 rounded-ds-md border border-ds-line/50 bg-background px-2 py-2 text-xs text-ds-ink"
                >
                  <option value="all">GSM</option>
                  {gsmFilterOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-28 rounded-ds-md border border-ds-line/50 bg-background px-2 py-2 text-xs text-ds-ink"
                >
                  <option value="all">Status</option>
                  {statusFilterOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                <label className="inline-flex items-center gap-1 rounded-ds-md border border-ds-line/50 bg-background px-2 py-2 text-xs text-ds-ink">
                  <input
                    type="checkbox"
                    checked={shortageOnly}
                    onChange={(e) => setShortageOnly(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Shortage only
                </label>
              </div>

              <button
                type="button"
                onClick={() => setPaperLedgerSort('oldest')}
                className={`rounded-ds-md px-3 py-1.5 text-xs font-medium border ${
                  paperLedgerSort === 'oldest'
                    ? 'bg-ds-warning border-ds-warning text-primary-foreground'
                    : 'bg-background border-ds-line/50 text-ds-ink-muted hover:border-ds-line/50'
                }`}
              >
                Oldest first
              </button>
              <button
                type="button"
                onClick={() => setPaperLedgerSort('newest')}
                className={`rounded-ds-md px-3 py-1.5 text-xs font-medium border ${
                  paperLedgerSort === 'newest'
                    ? 'bg-ds-warning border-ds-warning text-primary-foreground'
                    : 'bg-background border-ds-line/50 text-ds-ink-muted hover:border-ds-line/50'
                }`}
              >
                Newest first
              </button>
            </div>
            <div className="overflow-x-auto rounded-ds-md border border-ds-line/40 shadow-sm">
              <table className="w-full table-auto text-sm">
                <thead className="bg-background text-left border-b border-ds-line/40">
                  <tr className="text-ds-ink-muted text-[12px] uppercase tracking-wide">
                    <th className="px-3 py-2 w-10">
                      <input
                        type="checkbox"
                        checked={allRowsSelected}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedMaterialIds(new Set(filteredPaperWarehouseRows.map((r) => r.material_id)))
                          else setSelectedMaterialIds(new Set())
                        }}
                        className="h-4 w-4"
                      />
                    </th>
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2">Board classification</th>
                    <th className="px-3 py-2">GSM</th>
                    <th className="px-3 py-2">Material code</th>
                    <th className="px-3 py-2">Board type</th>
                    <th className="px-3 py-2 text-right">Available</th>
                    <th className="px-3 py-2 text-right">Reserved</th>
                    <th className="px-3 py-2 text-right">Free stock</th>
                    <th className="px-3 py-2 text-right">Days of Cover</th>
                    <th className="px-3 py-2 text-right">Incoming</th>
                    <th className="px-3 py-2 text-right">Shortage</th>
                    <th className="px-3 py-2 text-right">Reorder</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ds-card">
                  {filteredPaperWarehouseRows.map((row) => (
                    <tr key={row.material_id} className="min-h-[52px] bg-background hover:bg-ds-main/50">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedMaterialIds.has(row.material_id)}
                          onChange={(e) => {
                            setSelectedMaterialIds((prev) => {
                              const next = new Set(prev)
                              if (e.target.checked) next.add(row.material_id)
                              else next.delete(row.material_id)
                              return next
                            })
                          }}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>
                        <button
                          type="button"
                          onClick={() => void openMaterialDrawer(row, 'history')}
                          className="hover:underline hover:underline-offset-2"
                        >
                          {row.size_display || '-'}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-ds-ink-muted">{row.board_classification_id ?? '-'}</td>
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.gsm ?? '-'}</td>
                      <td className="px-3 py-2 text-ds-ink">
                        <button
                          type="button"
                          onClick={() => void openMaterialDrawer(row, 'history')}
                          className={`${ledgerMono} font-semibold text-ds-ink hover:underline hover:underline-offset-2`}
                        >
                          {row.material_code}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-ds-ink-muted">{row.board_type_id ?? '-'}</td>
                      <td className="px-3 py-2 text-right font-semibold text-[var(--success)]">
                        <button
                          type="button"
                          onClick={() => void openMaterialDrawer(row, 'available')}
                          className={`underline-offset-2 hover:underline ${ledgerMono}`}
                        >
                          {fmt(row.available_sheets)}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-[var(--warning)] tabular-nums">
                        {row.reserved_sheets > 0 ? (
                          <button
                            type="button"
                            onClick={() => setReservationsPanelMaterialId(row.material_id)}
                            className={`inline-flex items-center gap-1 underline-offset-2 hover:underline hover:text-ds-brand ${ledgerMono}`}
                          >
                            {fmt(row.reserved_sheets)}
                            <ChevronRight size={12} />
                          </button>
                        ) : (
                          <span className={`text-ds-ink-muted ${ledgerMono}`}>{fmt(row.reserved_sheets)}</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${ledgerMono} ${
                          row.available_sheets - row.reserved_sheets > 0
                            ? 'text-cyan-600'
                            : row.available_sheets - row.reserved_sheets === 0
                              ? 'text-[var(--warning)]'
                              : 'text-[var(--error)]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => void openMaterialDrawer(row, 'free')}
                          className="underline-offset-2 hover:underline"
                        >
                          {row.available_sheets - row.reserved_sheets < 0 ? (
                            <span className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)] px-1.5 py-0.5">
                              {fmt(row.available_sheets - row.reserved_sheets)}
                            </span>
                          ) : (
                            fmt(row.available_sheets - row.reserved_sheets)
                          )}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.daysOfCover === null ? (
                          <span className="text-ds-ink-muted" title="No completed-job consumption in last 30 days">—</span>
                        ) : (
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold tabular-nums ${
                              row.daysOfCover < 7
                                ? 'bg-ds-danger/15 text-ds-danger'
                                : row.daysOfCover < 30
                                ? 'bg-ds-warning/15 text-ds-warning'
                                : 'bg-ds-success/15 text-ds-success'
                            }`}
                          >
                            {row.daysOfCover}d
                          </span>
                        )}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold text-[var(--info)] ${ledgerMono}`}>{fmt(row.incoming_sheets)}</td>
                      <td className="px-3 py-2 text-right font-semibold text-[var(--error)]">
                        <button
                          type="button"
                          onClick={() => void openMaterialDrawer(row, 'shortage')}
                          className={`underline-offset-2 hover:underline ${ledgerMono}`}
                        >
                          {fmt(row.shortage_sheets)}
                        </button>
                      </td>
                      <td className={`px-3 py-2 text-right text-ds-ink ${ledgerMono}`}>{fmt(row.reorder_level)}</td>
                      <td className="px-3 py-2 text-xs">
                        {(() => {
                          const free = row.available_sheets - row.reserved_sheets
                          const statusClass =
                            row.status === 'leftover'
                              ? 'border-[var(--tooling,#7c3aed)]/45 bg-[var(--tooling-bg,rgba(124,58,237,0.12))] text-[var(--tooling,#7c3aed)]'
                              : row.shortage_sheets > 0
                              ? 'border-[var(--error)]/45 bg-[var(--error-bg)] text-[var(--error)]'
                              : free > 0
                                ? 'border-[var(--success)]/45 bg-[var(--success-bg)] text-[var(--success)]'
                                : 'border-[var(--warning)]/45 bg-[var(--warning-bg)] text-[var(--warning)]'
                          const statusLabel =
                            row.status === 'leftover'
                              ? 'leftover'
                              : row.shortage_sheets > 0
                              ? 'shortage'
                              : free > 0
                                ? 'healthy'
                                : 'watch'
                          return <span className={`rounded border px-1.5 py-0.5 font-semibold uppercase tracking-wide ${statusClass}`}>{statusLabel}</span>
                        })()}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="relative flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openAdjustForRow(row, 'add', 'available')}
                            className="rounded border border-[var(--success)]/45 bg-[var(--success-bg)] px-2 py-1 font-medium text-[var(--success)] hover:bg-[var(--success-bg)]"
                          >
                            + Add
                          </button>
                          <button
                            type="button"
                            onClick={() => setOpenActionMenuId((prev) => (prev === row.material_id ? null : row.material_id))}
                            className="rounded border border-[var(--warning)]/45 bg-[var(--warning-bg)] px-2 py-1 font-medium text-[var(--warning)] hover:bg-[var(--warning-bg)]"
                          >
                            ⋯
                          </button>
                          {row.open_pr_id ? (
                            <Link
                              href={`/inventory/purchase-requisitions?prId=${encodeURIComponent(row.open_pr_id)}`}
                              className="rounded border border-ds-brand/45 bg-ds-brand/10 px-2 py-1 font-medium text-ds-brand hover:bg-ds-brand/20"
                            >
                              View PR
                            </Link>
                          ) : row.shortage_sheets > 0 ? (
                            <button
                              type="button"
                              onClick={() => void openProcureModal(row)}
                              className="rounded border border-[var(--error)]/45 bg-[var(--error-bg)] px-2 py-1 font-medium text-[var(--error)] hover:bg-[var(--error-bg)]"
                            >
                              Procure
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled
                              className="cursor-not-allowed rounded border border-ds-line/40 bg-ds-elevated/10 px-2 py-1 text-ds-ink-faint"
                            >
                              Procure
                            </button>
                          )}
                          {openActionMenuId === row.material_id ? (
                            <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded border border-ds-line/40 bg-background p-1 shadow-lg">
                              <button type="button" onClick={() => { setOpenActionMenuId(null); openAdjustForRow(row, 'subtract', 'available') }} className="block w-full rounded px-2 py-1 text-left hover:bg-ds-elevated/40">Remove Stock</button>
                              <button type="button" onClick={() => { setOpenActionMenuId(null); void deletePaperRow(row) }} className="block w-full rounded px-2 py-1 text-left text-[var(--error)] hover:bg-[var(--error-bg)]">Delete row</button>
                              <button type="button" onClick={() => { setOpenActionMenuId(null); void openMaterialDrawer(row, 'history') }} className="block w-full rounded px-2 py-1 text-left hover:bg-ds-elevated/40">View History</button>
                              <button type="button" onClick={() => { setOpenActionMenuId(null); void openMaterialDrawer(row, 'reserved') }} className="block w-full rounded px-2 py-1 text-left hover:bg-ds-elevated/40">View Reservations</button>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredPaperWarehouseRows.length === 0 && (
                <p className="p-6 text-center text-ds-ink-faint text-sm">
                  No paper stock found.
                </p>
              )}
            </div>
          </div>
        </section>

        <SlideOverPanel
          title="Material details"
          isOpen={!!materialDrawerRow}
          onClose={() => {
            setMaterialDrawerRow(null)
            setMaterialDrawerData(null)
          }}
          widthClass="max-w-xl"
          backdropClassName="bg-background/60"
          panelClassName="border-l border-ds-line/40 bg-background shadow-2xl"
        >
          {materialDrawerRow ? (
            <div className={`flex h-full flex-col text-xs text-ds-ink-muted ${ledgerMono}`}>
              <div className="sticky top-0 z-10 border-b border-ds-line/40 bg-background px-4 py-3">
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
                <div className="grid grid-cols-2 gap-2 rounded border border-ds-line/40 bg-ds-elevated/20 p-2">
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
                  <p className="rounded border border-ds-line/40 bg-ds-elevated/20 px-2 py-1 text-ds-ink-faint">
                    {materialDrawerData.material.sourceTraceability}
                  </p>
                ) : null}
                {materialDrawerData?.material.leftoverMeta?.isLeftover ? (
                  <div className="rounded border border-ds-brand/30 bg-ds-brand/5 p-2">
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
                          <li key={r.id} className="rounded border border-ds-line/40 px-2 py-1.5">
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
                                className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40 disabled:opacity-40"
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
                                className="rounded border border-ds-warning/40 px-2 py-1 text-xs text-ds-warning hover:bg-ds-warning/10 disabled:opacity-40"
                              >
                                Release / Unreserve
                              </button>
                              {r.planningId ? (
                                <Link href={`/orders/planning?lineId=${encodeURIComponent(r.planningId)}`} className="rounded border border-ds-brand/40 px-2 py-1 text-xs text-ds-brand hover:bg-ds-brand/10">
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
                    <div className="rounded border border-ds-line/40 p-2 text-ds-ink-faint">
                      <p>Incoming: {fmt(materialDrawerRow.incoming_sheets)}</p>
                      <p>Free Stock: {fmt(materialDrawerRow.available_sheets - materialDrawerRow.reserved_sheets)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => toast.info('Open a planning line to reserve this stock.')}
                        className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
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
                        className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                      >
                        Adjust Stock
                      </button>
                      <button
                        type="button"
                        onClick={() => setMaterialDrawerView('history')}
                        className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
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
                          <li key={s.id} className="rounded border border-ds-line/40 px-2 py-1.5">
                            <p className="text-ds-ink">{s.planningId ? `PL#${s.planningId.slice(0, 8)}` : s.jobCardId} {s.jobCardNumber ? `· JC#${s.jobCardNumber}` : ''}</p>
                            <p className="text-ds-ink-faint">Pending {fmt(s.pendingShortage)} / Required {fmt(s.requiredQty)}</p>
                            <p className="text-ds-ink-faint">PR Status: {s.prStatus || '-'}</p>
                            <div className="mt-1 flex flex-wrap gap-2">
                              {s.prId ? (
                                <>
                                  <Link href={`/inventory/purchase-requisitions?prId=${encodeURIComponent(s.prId)}`} className="rounded border border-ds-brand/40 px-2 py-1 text-xs text-ds-brand hover:bg-ds-brand/10">View PR</Link>
                                  <button type="button" onClick={() => s.prId && (window.location.href = `/inventory/purchase-requisitions?prId=${encodeURIComponent(s.prId)}`)} className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40">Adjust PR</button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void generatePrFromDrawerShortage(s.id, s.pendingShortage)}
                                  className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)] px-2 py-1 text-xs text-[var(--error)] hover:bg-[var(--error-bg)]"
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
                  <div className="rounded border border-ds-line/40 bg-ds-elevated/20 p-2">
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
                        <li key={log.id} className="rounded border border-ds-line/40 px-2 py-1.5">
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
              <div className="sticky bottom-0 border-t border-ds-line/40 bg-background px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setMaterialDrawerView('history')}
                    className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                  >
                    Show full history
                  </button>
                  <Link
                    href="/inventory"
                    className="rounded border border-ds-brand/35 bg-ds-brand/10 px-2 py-1 text-xs text-ds-brand hover:bg-ds-brand/20"
                  >
                    Open Warehouse
                  </Link>
                </div>
              </div>
            </div>
          ) : null}
        </SlideOverPanel>

        <SlideOverPanel
          title="Adjust warehouse stock"
          isOpen={adjustOpen}
          onClose={() => setAdjustOpen(false)}
          widthClass="max-w-md"
        >
          <div className="space-y-3 px-1 text-sm">
            <div className="inline-flex rounded-ds-md border border-ds-line/50 bg-background p-1">
              <button
                type="button"
                onClick={() => setAdjustMode('single')}
                className={`rounded px-2.5 py-1.5 text-xs ${adjustMode === 'single' ? 'bg-ds-warning text-primary-foreground' : 'text-ds-ink-muted'}`}
              >
                Single entry
              </button>
              <button
                type="button"
                onClick={() => setAdjustMode('bulk')}
                className={`rounded px-2.5 py-1.5 text-xs ${adjustMode === 'bulk' ? 'bg-ds-warning text-primary-foreground' : 'text-ds-ink-muted'}`}
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
                    className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
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
                      className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
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
                      className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
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
                    className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
                  />
                </label>
                <label className="block text-xs text-ds-ink-faint">
                  Reason code
                  <input
                    type="text"
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                    className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
                    placeholder="e.g. count_correction"
                  />
                </label>
                <label className="block text-xs text-ds-ink-faint">
                  Remarks
                  <textarea
                    value={adjustRemarks}
                    onChange={(e) => setAdjustRemarks(e.target.value)}
                    className="mt-1 min-h-[90px] w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
                  />
                </label>
                <button
                  type="button"
                  disabled={adjustSubmitting}
                  onClick={() => void submitAdjust()}
                  className="w-full rounded bg-ds-warning px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
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
                  className="min-h-[180px] w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
                />
                <button
                  type="button"
                  disabled={bulkAdjustSubmitting}
                  onClick={() => void submitBulkAdjust()}
                  className="w-full rounded bg-ds-warning px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {bulkAdjustSubmitting ? 'Processing…' : 'Run bulk update'}
                </button>
              </>
            )}
          </div>
        </SlideOverPanel>
      </div>
    )
  }

  return (
    <div className="w-full px-4 py-3">
      <section
        id="paper-ledger"
        className="mb-8 rounded-ds-lg border border-ds-line/40 overflow-hidden bg-background text-ds-ink"
      >
        <div className="p-4 md:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-ds-warning">Paper Warehouse (Raw Materials)</h2>
              <p className="text-xs text-ds-ink-faint mt-1 font-mono">
                Master-driven paper stock only. Reservation, incoming, and shortage are synchronized with Planning and PR.
              </p>
              {(ledgerGsm || ledgerBoard) && (
                <p className={`text-xs text-ds-warning mt-2 ${ledgerMono}`}>
                  Job card deep link · GSM {ledgerGsm || '—'} · Board {ledgerBoard || '—'}
                </p>
              )}
            </div>
            <div className="flex flex-nowrap items-stretch gap-2 overflow-x-auto text-xs">
              <button type="button" onClick={() => setWarehouseKpiFilter((f) => (f === 'shortage' ? 'all' : 'shortage'))} className="min-w-[120px] rounded border border-[var(--error)]/45 bg-[var(--error-bg)] px-3 py-2 text-left">Shortage <div className={`${ledgerMono} text-sm font-bold text-[var(--error)]`}>{fmt(paperWarehouseKpi.shortage)}</div></button>
              <button type="button" onClick={() => setWarehouseKpiFilter((f) => (f === 'available' ? 'all' : 'available'))} className="min-w-[120px] rounded border border-[var(--success)]/45 bg-[var(--success-bg)] px-3 py-2 text-left">Available <div className={`${ledgerMono} text-sm font-bold text-[var(--success)]`}>{fmt(paperWarehouseKpi.available)}</div></button>
              <button type="button" onClick={() => setWarehouseKpiFilter((f) => (f === 'reserved' ? 'all' : 'reserved'))} className="min-w-[120px] rounded border border-[var(--warning)]/45 bg-[var(--warning-bg)] px-3 py-2 text-left">Reserved <div className={`${ledgerMono} text-sm font-bold text-[var(--warning)]`}>{fmt(paperWarehouseKpi.reserved)}</div></button>
              <button type="button" onClick={() => setWarehouseKpiFilter((f) => (f === 'incoming' ? 'all' : 'incoming'))} className="min-w-[120px] rounded border border-[var(--info)]/45 bg-[var(--info-bg)] px-3 py-2 text-left">Incoming <div className={`${ledgerMono} text-sm font-bold text-[var(--info)]`}>{fmt(paperWarehouseKpi.incoming)}</div></button>
              <button type="button" onClick={() => setWarehouseKpiFilter((f) => (f === 'free' ? 'all' : 'free'))} className="min-w-[120px] rounded border border-cyan-500/45 bg-cyan-500/10 px-3 py-2 text-left">Free Stock <div className={`${ledgerMono} text-sm font-bold text-cyan-700`}>{fmt(paperWarehouseKpi.freeStock)}</div></button>
              <div className="min-w-[120px] rounded border border-ds-line/40 bg-background px-3 py-2">Total stock <div className={`${ledgerMono} text-sm font-bold text-ds-ink`}>{fmt(paperWarehouseKpi.totalPhysical)}</div></div>
              <div className="min-w-[120px] rounded border border-ds-line/40 bg-background px-3 py-2">Inventory value <div className={`${ledgerMono} text-sm font-bold text-ds-ink`}>{fmtVal(paperWarehouseKpi.value)}</div></div>
              <div className="min-w-[120px] rounded border border-[var(--error)]/45 bg-[var(--error-bg)] px-3 py-2">Ageing risk <div className={`${ledgerMono} text-sm font-bold text-[var(--error)]`}>{fmtVal(paperWarehouseKpi.ageingRisk)}</div></div>
            </div>
          </div>

          <label className="block mb-3 text-xs text-ds-ink-faint uppercase tracking-wide">
            Search raw material
            <input
              type="text"
              value={paperSearch}
              onChange={(e) => setPaperSearch(e.target.value)}
              placeholder="material code / board type / classification / size / gsm"
              className={`mt-1 w-full max-w-md rounded-ds-md border border-ds-line/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-ds-ink-faint ${ledgerMono}`}
            />
          </label>

          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              onClick={() => setPaperLedgerSort('oldest')}
              className={`rounded-ds-md px-3 py-1.5 text-xs font-medium border ${
                paperLedgerSort === 'oldest'
                  ? 'bg-ds-warning border-ds-warning text-primary-foreground'
                  : 'bg-background border-ds-line/50 text-ds-ink-muted hover:border-ds-line/50'
              }`}
            >
              Oldest first
            </button>
            <button
              type="button"
              onClick={() => setPaperLedgerSort('newest')}
              className={`rounded-ds-md px-3 py-1.5 text-xs font-medium border ${
                paperLedgerSort === 'newest'
                  ? 'bg-ds-warning border-ds-warning text-primary-foreground'
                  : 'bg-background border-ds-line/50 text-ds-ink-muted hover:border-ds-line/50'
              }`}
            >
              Newest first
            </button>
          </div>
          <div className="overflow-x-auto rounded-ds-md border border-ds-line/40">
            <table className="w-full text-sm">
                <thead className="bg-background text-left border-b border-ds-line/40">
                <tr className="text-ds-ink-muted text-xs uppercase tracking-wide">
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Board classification</th>
                  <th className="px-3 py-2">GSM</th>
                  <th className="px-3 py-2">Material code</th>
                  <th className="px-3 py-2">Board type</th>
                  <th className="px-3 py-2">Available</th>
                  <th className="px-3 py-2">Reserved</th>
                  <th className="px-3 py-2">Free stock</th>
                  <th className="px-3 py-2">Days of Cover</th>
                  <th className="px-3 py-2">Incoming</th>
                  <th className="px-3 py-2">Shortage</th>
                  <th className="px-3 py-2">Reorder</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ds-card">
                {filteredPaperWarehouseRows.map((row) => (
                  <tr key={row.material_id} className="hover:bg-ds-main/50">
                    <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>
                      <button
                        type="button"
                        onClick={() => void openMaterialDrawer(row, 'history')}
                        className="underline underline-offset-2 hover:text-ds-ink"
                      >
                        {row.size_display || '-'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-ds-ink-muted">{row.board_classification_id ?? '-'}</td>
                    <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.gsm ?? '-'}</td>
                    <td className="px-3 py-2 text-ds-ink">
                      <button
                        type="button"
                        onClick={() => void openMaterialDrawer(row, 'history')}
                        className={`underline underline-offset-2 hover:text-ds-ink ${ledgerMono} font-semibold`}
                      >
                        {row.material_code}
                      </button>
                      <p className={`text-[10px] text-ds-ink-faint ${ledgerMono}`}>{row.material_id}</p>
                    </td>
                    <td className="px-3 py-2 text-ds-ink-muted">{row.board_type_id ?? '-'}</td>
                    <td className={`px-3 py-2 text-[var(--success)] font-semibold ${ledgerMono}`}>{fmt(row.available_sheets)}</td>
                    <td className="px-3 py-2 text-[var(--warning)] font-semibold tabular-nums">
                      {row.reserved_sheets > 0 ? (
                        <button
                          type="button"
                          onClick={() => setReservationsPanelMaterialId(row.material_id)}
                          className={`inline-flex items-center gap-1 underline-offset-2 hover:underline hover:text-ds-brand ${ledgerMono}`}
                        >
                          {fmt(row.reserved_sheets)}
                          <ChevronRight size={12} />
                        </button>
                      ) : (
                        <span className={`text-ds-ink-muted ${ledgerMono}`}>{fmt(row.reserved_sheets)}</span>
                      )}
                    </td>
                    <td
                      className={`px-3 py-2 ${ledgerMono} ${
                        row.available_sheets - row.reserved_sheets > 0
                          ? 'text-cyan-700'
                          : row.available_sheets - row.reserved_sheets === 0
                            ? 'text-[var(--warning)]'
                            : 'text-[var(--error)]'
                      }`}
                    >
                      {fmt(row.available_sheets - row.reserved_sheets)}
                    </td>
                    <td className="px-3 py-2">
                      {row.daysOfCover === null ? (
                        <span className="text-ds-ink-muted" title="No completed-job consumption in last 30 days">—</span>
                      ) : (
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold tabular-nums ${
                            row.daysOfCover < 7
                              ? 'bg-ds-danger/15 text-ds-danger'
                              : row.daysOfCover < 30
                              ? 'bg-ds-warning/15 text-ds-warning'
                              : 'bg-ds-success/15 text-ds-success'
                          }`}
                        >
                          {row.daysOfCover}d
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-[var(--info)] font-semibold ${ledgerMono}`}>{fmt(row.incoming_sheets)}</td>
                    <td className={`px-3 py-2 text-[var(--error)] font-semibold ${ledgerMono}`}>{fmt(row.shortage_sheets)}</td>
                    <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{fmt(row.reorder_level)}</td>
                    <td className="px-3 py-2 text-xs">
                      {(() => {
                        const free = row.available_sheets - row.reserved_sheets
                        const statusClass =
                          row.status === 'leftover'
                            ? 'text-[var(--tooling,#7c3aed)]'
                            : row.shortage_sheets > 0
                            ? 'text-[var(--error)]'
                            : free > 0
                              ? 'text-[var(--success)]'
                              : 'text-[var(--warning)]'
                        const statusLabel =
                          row.status === 'leftover'
                            ? 'leftover'
                            : row.shortage_sheets > 0
                            ? 'shortage'
                            : free > 0
                              ? 'healthy'
                              : 'watch'
                        return <span className={statusClass}>{statusLabel}</span>
                      })()}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.shortage_sheets > 0 ? (
                        <button
                          type="button"
                          onClick={() => void openProcureModal(row)}
                          className="rounded border border-[var(--error)]/45 bg-[var(--error-bg)] px-2 py-1 font-medium text-[var(--error)] hover:bg-[var(--error-bg)]"
                        >
                          Procure
                        </button>
                      ) : (
                        <span className="text-ds-ink-faint">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredPaperWarehouseRows.length === 0 && (
              <p className="p-6 text-center text-ds-ink-faint text-sm">
                No paper warehouse rows found.
              </p>
            )}
          </div>
        </div>
      </section>

      <SlideOverPanel
        title="Batch detail & issue"
        isOpen={!!drawerRow}
        onClose={() => setDrawerRow(null)}
        widthClass="max-w-md"
        backdropClassName="bg-background/60"
        panelClassName="border-l border-ds-line/40 bg-background shadow-2xl"
      >
        {drawerRow ? (
          <div className={`flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs text-ds-ink-muted ${ledgerMono}`}>
            <div>
              <p className="text-xs uppercase tracking-wide text-ds-ink-faint font-semibold">Lot / batch</p>
              <p className="text-sm font-semibold text-ds-ink mt-0.5">{drawerRow.lotNumber ?? drawerRow.id.slice(0, 8)}</p>
              <p className="text-ds-ink-faint">
                {drawerRow.gsm} gsm · {(drawerRow.boardGrade ?? '').trim() || drawerRow.paperType}
              </p>
              <p className="text-ds-warning mt-1">
                On hand: {drawerRow.qtySheets.toLocaleString('en-IN')} sheets
                {drawerRow.estKgRemaining != null && (
                  <span className="text-ds-ink-muted"> · est. {drawerRow.estKgRemaining.toFixed(2)} kg</span>
                )}
              </p>
            </div>

            {drawerRow.totalIssuedToFloor > 0 && (
              <div className="rounded-ds-md border border-ds-warning/40 bg-ds-warning/8 p-3 space-y-1">
                <p className="text-xs uppercase text-ds-warning/90 font-semibold">Fragmented balance</p>
                <p className="text-ds-ink-muted">
                  Already issued to floor:{' '}
                  <span className="text-ds-warning">{drawerRow.totalIssuedToFloor.toLocaleString('en-IN')}</span> sh
                </p>
                <p className="text-ds-ink-faint text-xs">
                  Original batch (est.):{' '}
                  {(drawerRow.qtySheets + drawerRow.totalIssuedToFloor).toLocaleString('en-IN')} sh cumulative
                </p>
              </div>
            )}

            {drawerRow.suggestBalanceWriteOff && (
              <div className="rounded-ds-md border border-[var(--error)]/50 bg-[var(--error-bg)] p-3 text-[var(--error)] text-xs">
                Remaining est. weight is under 50 kg — consider a <strong>balance write-off</strong> to keep inventory
                clean.
              </div>
            )}

            <div>
              <p className="text-xs uppercase tracking-wide text-cyan-500/90 font-semibold mb-2">
                Material genealogy
              </p>
              {genealogyLoading ? (
                <p className="text-ds-ink-faint">Loading trail…</p>
              ) : genealogy?.steps?.length ? (
                <ol className="space-y-2 border-l border-ds-line/50 pl-3">
                  {genealogy.steps.map((s, i) => (
                    <li key={`${s.stage}-${i}`} className="text-xs">
                      <span className="text-ds-ink-faint">{s.stage}</span>
                      <div className="text-ds-ink font-medium">{s.mono ?? s.label}</div>
                      <div className="text-ds-ink-faint">{s.detail}</div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-ds-ink-faint">No linked mill PO trail for this spec (heuristic).</p>
              )}
            </div>

            {drawerRow.linkedCustomerPos.length > 0 && (
              <div>
                <p className="text-xs uppercase text-ds-ink-faint mb-1">Linked customer PO #</p>
                <p className="text-ds-ink">{drawerRow.linkedCustomerPos.join(' · ')}</p>
              </div>
            )}

            <div className="rounded-ds-md border border-ds-line/50 bg-background p-3 space-y-3 ring-1 ring-ring/5">
              <p className="text-xs uppercase tracking-wide text-ds-warning/90 font-semibold">Issue to floor</p>
              <p className="text-xs text-ds-ink-faint">
                Moves sheets from main warehouse to <strong className="text-ds-ink-muted">FLOOR</strong> stock (new split
                row). Operator: {operatorLabel}
              </p>
              <label className="block text-xs text-ds-ink-faint">
                Link to production job (optional)
                <input
                  type="text"
                  value={jobSearch}
                  onChange={(e) => setJobSearch(e.target.value)}
                  placeholder="Search JC# or customer…"
                  className="mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1.5 text-xs text-foreground"
                />
              </label>
              <select
                value={issueJobCardId}
                onChange={(e) => setIssueJobCardId(e.target.value)}
                className="w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs text-foreground"
              >
                <option value="">— Select job card —</option>
                {filteredJobCards.map((j) => (
                  <option key={j.id} value={j.id}>
                    JC#{j.jobCardNumber} {(j.customer?.name ?? '').trim()}
                  </option>
                ))}
              </select>
              <label className="block text-xs text-ds-ink-faint">
                Quantity (sheets)
                <input
                  type="number"
                  min={1}
                  max={drawerRow.qtySheets}
                  value={issueQty}
                  onChange={(e) => setIssueQty(e.target.value)}
                  className="mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1.5 text-xs text-foreground"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-ds-ink-muted">
                <input
                  type="checkbox"
                  checked={issueHighPri}
                  onChange={(e) => setIssueHighPri(e.target.checked)}
                  className="rounded border-ds-line/50"
                />
                High-priority issuance (director authorization audit)
              </label>
              <button
                type="button"
                disabled={issueSubmitting}
                onClick={() => void submitIssueToFloor()}
                className="w-full rounded-ds-sm bg-ds-warning hover:bg-ds-warning py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                {issueSubmitting ? 'Saving…' : 'Save — issue to floor'}
              </button>
            </div>
          </div>
        ) : null}
      </SlideOverPanel>

      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-ds-warning">Stock States</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAdjustOpen(true)}
            className="px-4 py-2 rounded-ds-md bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Adjust Stock
          </button>
          <Link
            href="/inventory/flow"
            className="px-4 py-2 rounded-ds-md bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Inventory Flow
          </Link>
          <Link
            href="/inventory/simulation"
            className="px-4 py-2 rounded-ds-md bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Live Simulation
          </Link>
          <Link
            href="/inventory/purchase-requisitions"
            className="px-4 py-2 rounded-ds-md bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Purchase Requisitions
          </Link>
          <Link
            href="/inventory/grn"
            className="px-4 py-2 rounded-ds-md bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm font-medium"
          >
            Add Stock (GRN)
          </Link>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ds-elevated text-left">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Description</th>
              <th className="px-4 py-2">Unit</th>
              <th className="px-4 py-2">Quarantine</th>
              <th className="px-4 py-2">Available</th>
              <th className="px-4 py-2">Reserved</th>
              <th className="px-4 py-2">Reorder</th>
              <th className="px-4 py-2">Value (est)</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-line/40">
            {items.map((i) => {
              const totalVal = i.valueQuarantine + i.valueAvailable + i.valueReserved
              return (
                <tr key={i.id} className="hover:bg-ds-elevated/50">
                  <td className={`px-4 py-2 ${ledgerMono}`}>{i.materialCode}</td>
                  <td className="px-4 py-2">{i.description}</td>
                  <td className="px-4 py-2">{i.unit}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmt(i.qtyQuarantine)}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmt(i.qtyAvailable)}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmt(i.qtyReserved)}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmt(i.reorderPoint)}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmtVal(totalVal)}</td>
                  <td className="px-4 py-2">
                    {i.qtyQuarantine > 0 && (
                      <Link href={`/inventory/release/${i.id}`} className="text-ds-warning hover:underline text-xs">
                        Release
                      </Link>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <section className="mt-8 rounded-ds-lg border border-ds-line/40 bg-background">
        <div className="border-b border-ds-line/40 px-4 py-3">
          <h2 className="text-sm font-semibold text-ds-warning">Recent stock movements</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-background text-left border-b border-ds-line/40">
              <tr className="text-ds-ink-muted text-xs uppercase tracking-wide">
                <th className="px-3 py-2">At</th>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Ref</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ds-card">
              {activityRows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-xs text-ds-ink-faint">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <p className={`text-ds-ink ${ledgerMono}`}>{r.materialCode}</p>
                    <p className="text-xs text-ds-ink-faint">{r.materialDescription}</p>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.movementType}</td>
                  <td className={`px-3 py-2 ${ledgerMono}`}>{r.qty.toLocaleString('en-IN')}</td>
                  <td className="px-3 py-2 text-xs text-ds-ink-faint">{r.refType ?? '—'}</td>
                  <td className="px-3 py-2">
                    {r.movementType === 'adjust' && String(r.refType ?? '').startsWith('manual_adjust_') ? (
                      <button
                        type="button"
                        onClick={() => void reverseMovement(r.id)}
                        className="rounded border border-ds-line/50 px-2 py-1 text-xs hover:bg-ds-main"
                      >
                        Reverse
                      </button>
                    ) : (
                      <span className="text-xs text-ds-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
              <div className="grid grid-cols-2 gap-2 rounded border border-ds-line/30 bg-ds-elevated/20 p-2">
                <div><span className="text-ds-ink-muted">Material</span><p className={ledgerMono}>{procureState.materialCode}</p></div>
                <div><span className="text-ds-ink-muted">Board Type</span><p>{procureState.boardType || '-'}</p></div>
                <div><span className="text-ds-ink-muted">Size</span><p className={ledgerMono}>{procureState.size || '-'}</p></div>
                <div><span className="text-ds-ink-muted">GSM</span><p className={ledgerMono}>{procureState.gsm ?? '-'}</p></div>
              </div>
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
                  className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
                >
                  {procureState.shortages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.planningId ? `PL#${s.planningId.slice(0, 8)}` : `JC#${s.jobCardNumber ?? '-'}`} · shortage {fmt(s.pendingShortage)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-ds-ink-faint">
                PR Qty
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={procurePrQty}
                  onChange={(e) => setProcurePrQty(e.target.value)}
                  className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-ds-ink-muted">
                <input
                  type="checkbox"
                  checked={procureBuffer}
                  onChange={(e) => setProcureBuffer(e.target.checked)}
                  className="rounded border-ds-line/50"
                />
                Add 10% buffer
              </label>
              {procureError ? (
                <div className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)] px-2 py-1 text-[var(--error)]">{procureError}</div>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded border border-ds-line/50 px-3 py-1.5 text-xs"
                  onClick={() => setProcureOpen(false)}
                  disabled={procureBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-ds-warning px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
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
          <label className="block text-xs text-ds-ink-faint">
            Material
            <select
              value={adjustMaterialId}
              onChange={(e) => setAdjustMaterialId(e.target.value)}
              className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
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
                className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
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
                className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
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
              className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
            />
          </label>
          <label className="block text-xs text-ds-ink-faint">
            Reason code
            <input
              type="text"
              value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
              className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
              placeholder="e.g. count_correction"
            />
          </label>
          <label className="block text-xs text-ds-ink-faint">
            Remarks
            <textarea
              value={adjustRemarks}
              onChange={(e) => setAdjustRemarks(e.target.value)}
              className="mt-1 min-h-[90px] w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
            />
          </label>
          <button
            type="button"
            disabled={adjustSubmitting}
            onClick={() => void submitAdjust()}
            className="w-full rounded bg-ds-warning px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {adjustSubmitting ? 'Saving...' : 'Save adjustment'}
          </button>
        </div>
      </SlideOverPanel>

      <SlideOverPanel
        title="Release Reservation"
        isOpen={releaseOpen}
        onClose={() => {
          if (releaseBusy) return
          setReleaseOpen(false)
          setReleaseError(null)
        }}
        widthClass="max-w-md"
      >
        <div className="space-y-3 px-1 text-sm">
          {!releaseState ? (
            <p className="text-xs text-ds-ink-faint">No reservation selected.</p>
          ) : (
            <>
              <div className="rounded border border-ds-line/40 bg-ds-elevated/20 p-2 text-xs">
                <p className="text-ds-ink">Material: {releaseState.materialCode}</p>
                <p className="text-ds-ink-faint">Current reserved: {fmt(releaseState.currentReserved)}</p>
                <p className="text-ds-ink-faint">Required sheets: {fmt(releaseState.requiredSheets)}</p>
              </div>
              <label className="block text-xs text-ds-ink-faint">
                Release qty (partial/full)
                <input
                  type="number"
                  min={0}
                  step="0.001"
                  value={releaseQtyInput}
                  onChange={(e) => setReleaseQtyInput(e.target.value)}
                  className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-2 text-xs"
                />
              </label>
              <div className="rounded border border-ds-line/40 bg-ds-elevated/20 p-2 text-xs text-ds-ink-faint">
                <p>Available after release: {fmt((materialDrawerRow?.available_sheets || 0) + Math.max(0, Number(releaseQtyInput || 0)))}</p>
                <p>Shortage after release: {fmt(Math.max(0, releaseState.requiredSheets - Math.max(0, releaseState.currentReserved - Math.max(0, Number(releaseQtyInput || 0)))))}</p>
              </div>
              {releaseError ? (
                <p className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)] px-2 py-1 text-xs text-[var(--error)]">{releaseError}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={releaseBusy}
                  onClick={() => {
                    setReleaseOpen(false)
                    setReleaseError(null)
                  }}
                  className="flex-1 rounded border border-ds-line/50 px-3 py-2 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={releaseBusy}
                  onClick={() => void confirmReleaseFromDrawer()}
                  className="flex-1 rounded bg-ds-warning px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {releaseBusy ? 'Releasing…' : 'Confirm Release'}
                </button>
              </div>
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
