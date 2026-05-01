'use client'

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Star } from 'lucide-react'
import { toast } from 'sonner'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'

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
  }
  logs: Array<{
    id: string
    movementType: string
    qty: number
    refType: string | null
    refId: string | null
    createdAt: string
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
    jobCard: {
      id: string
      jobCardNumber: number
      status: string
      customerName: string
    }
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
  }>
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
  })
  const [paperLedgerSort, setPaperLedgerSort] = useState<'oldest' | 'newest'>('oldest')
  const [hubSearchPo, setHubSearchPo] = useState('')
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
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [materialDrawerRow, setMaterialDrawerRow] = useState<PaperWarehouseRow | null>(null)
  const [materialDrawerLoading, setMaterialDrawerLoading] = useState(false)
  const [materialDrawerData, setMaterialDrawerData] = useState<MaterialDetailPayload | null>(null)
  const [deepLinkOpenedMaterialId, setDeepLinkOpenedMaterialId] = useState<string | null>(null)

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
          }
        : { totalPhysical: 0, available: 0, reserved: 0, incoming: 0, shortage: 0, value: 0, ageingRisk: 0 },
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
        loadPaperWarehouse(hubSearchPo),
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
  }, [debouncedHubPo, hubSearchPo, ledgerGsm, ledgerBoard, loadPaperLedger, loadPaperWarehouse])

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

  if (loading) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  const fmtVal = (n: number) => `₹${fmt(n)}`

  function ageDotClass(bucket: PaperLedgerRow['ageBucket']) {
    if (bucket === 'fresh') return 'bg-emerald-500'
    if (bucket === 'mature') return 'bg-ds-warning'
    return 'bg-red-500 animate-pulse'
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
    if (!adjustReason.trim() || !adjustRemarks.trim()) {
      toast.error('Reason and remarks are required')
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
          reasonCode: adjustReason.trim(),
          remarks: adjustRemarks.trim(),
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

  async function openMaterialDrawer(row: PaperWarehouseRow) {
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

  const paperWarehouseOnlyMode = true
  if (paperWarehouseOnlyMode) {
    return (
      <div className="w-full px-4 py-3">
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            type="button"
            onClick={() => setAdjustOpen(true)}
            className="px-4 py-2 rounded-lg bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Adjust Stock
          </button>
          <Link
            href="/inventory/flow"
            className="px-4 py-2 rounded-lg bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Inventory Flow
          </Link>
          <Link
            href="/inventory/simulation"
            className="px-4 py-2 rounded-lg bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Live Simulation
          </Link>
          <Link
            href="/inventory/purchase-requisitions"
            className="px-4 py-2 rounded-lg bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Purchase Requisitions
          </Link>
          <Link
            href="/inventory/grn"
            className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm font-medium"
          >
            Add Stock (GRN)
          </Link>
        </div>
        <section
          id="paper-ledger"
          className="rounded-xl border border-ds-line/40 overflow-hidden bg-background text-ds-ink"
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
              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                <div className="rounded border border-ds-line/40 bg-background px-3 py-2">Total stock <div className={`${ledgerMono} text-sm text-ds-ink`}>{fmt(paperWarehouseKpi.totalPhysical)}</div></div>
                <div className="rounded border border-emerald-500/35 bg-emerald-500/10 px-3 py-2">Available <div className={`${ledgerMono} text-sm text-emerald-300`}>{fmt(paperWarehouseKpi.available)}</div></div>
                <div className="rounded border border-amber-500/35 bg-amber-500/10 px-3 py-2">Reserved <div className={`${ledgerMono} text-sm text-amber-300`}>{fmt(paperWarehouseKpi.reserved)}</div></div>
                <div className="rounded border border-sky-500/35 bg-sky-500/10 px-3 py-2">Incoming <div className={`${ledgerMono} text-sm text-sky-300`}>{fmt(paperWarehouseKpi.incoming)}</div></div>
                <div className="rounded border border-rose-500/35 bg-rose-500/10 px-3 py-2">Shortage <div className={`${ledgerMono} text-sm text-rose-300`}>{fmt(paperWarehouseKpi.shortage)}</div></div>
                <div className="rounded border border-ds-line/40 bg-background px-3 py-2">Inventory value <div className={`${ledgerMono} text-sm text-ds-ink`}>{fmtVal(paperWarehouseKpi.value)}</div></div>
                <div className="rounded border border-red-900/70 bg-red-950/50 px-3 py-2">Ageing risk <div className={`${ledgerMono} text-sm text-red-200`}>{fmtVal(paperWarehouseKpi.ageingRisk)}</div></div>
              </div>
            </div>

            <label className="block mb-3 text-xs text-ds-ink-faint uppercase tracking-wide">
              Search raw material
              <input
                type="text"
                value={hubSearchPo}
                onChange={(e) => setHubSearchPo(e.target.value)}
                placeholder="material code / board type / classification / size / gsm"
                className={`mt-1 w-full max-w-md rounded-lg border border-ds-line/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-ds-ink-faint ${ledgerMono}`}
              />
            </label>

            <div className="flex flex-wrap gap-2 mb-3">
              <button
                type="button"
                onClick={() => setPaperLedgerSort('oldest')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
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
                className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
                  paperLedgerSort === 'newest'
                    ? 'bg-ds-warning border-ds-warning text-primary-foreground'
                    : 'bg-background border-ds-line/50 text-ds-ink-muted hover:border-ds-line/50'
                }`}
              >
                Newest first
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-ds-line/40">
              <table className="w-full text-sm">
                <thead className="bg-background text-left border-b border-ds-line/40">
                  <tr className="text-ds-ink-muted text-xs uppercase tracking-wide">
                    <th className="px-3 py-2">Material code</th>
                    <th className="px-3 py-2">Board type</th>
                    <th className="px-3 py-2">Board classification</th>
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2">GSM</th>
                    <th className="px-3 py-2">Available</th>
                    <th className="px-3 py-2">Reserved</th>
                    <th className="px-3 py-2">Free stock</th>
                    <th className="px-3 py-2">Incoming</th>
                    <th className="px-3 py-2">Shortage</th>
                    <th className="px-3 py-2">Reorder</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ds-card">
                  {paperWarehouseRows.map((row) => (
                    <tr key={row.material_id} className="hover:bg-ds-main/40">
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.material_code}</td>
                      <td className="px-3 py-2 text-ds-ink-muted">
                        <button
                          type="button"
                          onClick={() => void openMaterialDrawer(row)}
                          className="underline underline-offset-2 hover:text-ds-ink"
                        >
                          {row.board_type_id ?? '-'}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-ds-ink-muted">{row.board_classification_id ?? '-'}</td>
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.size_display}</td>
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.gsm ?? '-'}</td>
                      <td className={`px-3 py-2 text-emerald-300 ${ledgerMono}`}>{fmt(row.available_sheets)}</td>
                      <td className={`px-3 py-2 text-amber-300 ${ledgerMono}`}>{fmt(row.reserved_sheets)}</td>
                      <td
                        className={`px-3 py-2 ${ledgerMono} ${
                          row.available_sheets - row.reserved_sheets > 0
                            ? 'text-emerald-300'
                            : row.available_sheets - row.reserved_sheets === 0
                              ? 'text-amber-300'
                              : 'text-rose-300'
                        }`}
                      >
                        {fmt(row.available_sheets - row.reserved_sheets)}
                      </td>
                      <td className={`px-3 py-2 text-sky-300 ${ledgerMono}`}>{fmt(row.incoming_sheets)}</td>
                      <td className={`px-3 py-2 text-rose-300 ${ledgerMono}`}>{fmt(row.shortage_sheets)}</td>
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{fmt(row.reorder_level)}</td>
                      <td className="px-3 py-2 text-xs text-ds-ink-faint">{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {paperWarehouseRows.length === 0 && (
                <p className="p-6 text-center text-ds-ink-faint text-sm">
                  No paper warehouse rows found.
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
            <div className={`flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs text-ds-ink-muted ${ledgerMono}`}>
              <div>
                <p className="text-xs uppercase tracking-wide text-ds-ink-faint">Material</p>
                <p className="text-sm text-ds-ink font-semibold">{materialDrawerData?.material.materialCode ?? materialDrawerRow.material_code}</p>
                <p className="text-ds-ink-faint">
                  {(materialDrawerData?.material.boardType ?? materialDrawerRow.board_type_id ?? '-') + ' · ' + (materialDrawerData?.material.gsm ?? materialDrawerRow.gsm ?? '-')}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-ds-ink-faint mb-1">Reserved by Jobs</p>
                {materialDrawerLoading ? (
                  <p className="text-ds-ink-faint">Loading…</p>
                ) : !materialDrawerData || materialDrawerData.reservations.length === 0 ? (
                  <p className="text-ds-ink-faint">No active reservations.</p>
                ) : (
                  <ul className="space-y-2">
                    {materialDrawerData.reservations.map((r) => (
                      <li key={r.id} className="rounded border border-ds-line/40 px-2 py-1.5">
                        <p className="text-ds-ink">
                          Job Card: {r.jobCard.id} · JC#{r.jobCard.jobCardNumber} · {r.jobCard.customerName}
                        </p>
                        <p className="text-ds-ink-faint">
                          {r.cartonName ?? 'Carton —'} {r.poNumber ? `· ${r.poNumber}` : ''}
                        </p>
                        <p className="text-ds-warning">
                          Reserved {r.reservedSheets.toLocaleString('en-IN')} / Required {r.requiredSheets.toLocaleString('en-IN')}
                        </p>
                        <p className="text-ds-ink-faint">Status: {r.jobCard.status || '-'}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-ds-ink-faint mb-1">Shortage priority</p>
                {materialDrawerLoading ? (
                  <p className="text-ds-ink-faint">Loading…</p>
                ) : !materialDrawerData || !Array.isArray(materialDrawerData.shortages) || materialDrawerData.shortages.length === 0 ? (
                  <p className="text-ds-ink-faint">No open shortages.</p>
                ) : (
                  <ul className="space-y-2">
                    {materialDrawerData.shortages.map((s) => (
                      <li key={s.id} className="rounded border border-ds-line/40 px-2 py-1.5">
                        <p className="text-ds-ink">
                          Job Card: {s.jobCardId} {s.jobCardNumber ? `· JC#${s.jobCardNumber}` : ''}
                        </p>
                        <p className="text-ds-ink-faint">
                          Required {Number(s.requiredQty || 0).toLocaleString('en-IN')} · Pending {Number(s.pendingShortage || 0).toLocaleString('en-IN')}
                        </p>
                        <p className={s.priority === 'urgent' ? 'text-rose-300' : 'text-amber-300'}>
                          Priority: {s.priority === 'urgent' ? 'Urgent' : 'Normal'}
                          {s.requiredByDate ? ` · Required by ${new Date(s.requiredByDate).toLocaleDateString('en-IN')}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-ds-ink-faint mb-1">Recent stock logs</p>
                {materialDrawerLoading ? (
                  <p className="text-ds-ink-faint">Loading…</p>
                ) : !materialDrawerData || materialDrawerData.logs.length === 0 ? (
                  <p className="text-ds-ink-faint">No stock logs found.</p>
                ) : (
                  <ul className="space-y-2">
                    {materialDrawerData.logs.map((log) => (
                      <li key={log.id} className="rounded border border-ds-line/40 px-2 py-1.5">
                        <p className="text-ds-ink">{log.movementType} · {log.qty.toLocaleString('en-IN')}</p>
                        <p className="text-ds-ink-faint">
                          {new Date(log.createdAt).toLocaleString()} · {log.refType ?? '—'} {log.refId ? `· ${log.refId.slice(0, 8)}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </SlideOverPanel>
      </div>
    )
  }

  return (
    <div className="w-full px-4 py-3">
      <section
        id="paper-ledger"
        className="mb-8 rounded-xl border border-ds-line/40 overflow-hidden bg-background text-ds-ink"
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
            <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
              <div className="rounded border border-ds-line/40 bg-background px-3 py-2">Total stock <div className={`${ledgerMono} text-sm text-ds-ink`}>{fmt(paperWarehouseKpi.totalPhysical)}</div></div>
              <div className="rounded border border-emerald-500/35 bg-emerald-500/10 px-3 py-2">Available <div className={`${ledgerMono} text-sm text-emerald-300`}>{fmt(paperWarehouseKpi.available)}</div></div>
              <div className="rounded border border-amber-500/35 bg-amber-500/10 px-3 py-2">Reserved <div className={`${ledgerMono} text-sm text-amber-300`}>{fmt(paperWarehouseKpi.reserved)}</div></div>
              <div className="rounded border border-sky-500/35 bg-sky-500/10 px-3 py-2">Incoming <div className={`${ledgerMono} text-sm text-sky-300`}>{fmt(paperWarehouseKpi.incoming)}</div></div>
              <div className="rounded border border-rose-500/35 bg-rose-500/10 px-3 py-2">Shortage <div className={`${ledgerMono} text-sm text-rose-300`}>{fmt(paperWarehouseKpi.shortage)}</div></div>
              <div className="rounded border border-ds-line/40 bg-background px-3 py-2">Inventory value <div className={`${ledgerMono} text-sm text-ds-ink`}>{fmtVal(paperWarehouseKpi.value)}</div></div>
              <div className="rounded border border-red-900/70 bg-red-950/50 px-3 py-2">Ageing risk <div className={`${ledgerMono} text-sm text-red-200`}>{fmtVal(paperWarehouseKpi.ageingRisk)}</div></div>
            </div>
          </div>

          <label className="block mb-3 text-xs text-ds-ink-faint uppercase tracking-wide">
            Search raw material
            <input
              type="text"
              value={hubSearchPo}
              onChange={(e) => setHubSearchPo(e.target.value)}
              placeholder="material code / board type / classification / size / gsm"
              className={`mt-1 w-full max-w-md rounded-lg border border-ds-line/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-ds-ink-faint ${ledgerMono}`}
            />
          </label>

          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              onClick={() => setPaperLedgerSort('oldest')}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
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
              className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
                paperLedgerSort === 'newest'
                  ? 'bg-ds-warning border-ds-warning text-primary-foreground'
                  : 'bg-background border-ds-line/50 text-ds-ink-muted hover:border-ds-line/50'
              }`}
            >
              Newest first
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-ds-line/40">
            <table className="w-full text-sm">
              <thead className="bg-background text-left border-b border-ds-line/40">
                <tr className="text-ds-ink-muted text-xs uppercase tracking-wide">
                  <th className="px-3 py-2">Material code</th>
                  <th className="px-3 py-2">Board type</th>
                  <th className="px-3 py-2">Board classification</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">GSM</th>
                  <th className="px-3 py-2">Available</th>
                  <th className="px-3 py-2">Reserved</th>
                  <th className="px-3 py-2">Free stock</th>
                  <th className="px-3 py-2">Incoming</th>
                  <th className="px-3 py-2">Shortage</th>
                  <th className="px-3 py-2">Reorder</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ds-card">
                {paperWarehouseRows.map((row) => (
                  <tr key={row.material_id} className="hover:bg-ds-main/40">
                    <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.material_code}</td>
                    <td className="px-3 py-2 text-ds-ink-muted">{row.board_type_id ?? '-'}</td>
                    <td className="px-3 py-2 text-ds-ink-muted">{row.board_classification_id ?? '-'}</td>
                    <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.size_display}</td>
                    <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.gsm ?? '-'}</td>
                    <td className={`px-3 py-2 text-emerald-300 ${ledgerMono}`}>{fmt(row.available_sheets)}</td>
                    <td className={`px-3 py-2 text-amber-300 ${ledgerMono}`}>{fmt(row.reserved_sheets)}</td>
                    <td
                      className={`px-3 py-2 ${ledgerMono} ${
                        row.available_sheets - row.reserved_sheets > 0
                          ? 'text-emerald-300'
                          : row.available_sheets - row.reserved_sheets === 0
                            ? 'text-amber-300'
                            : 'text-rose-300'
                      }`}
                    >
                      {fmt(row.available_sheets - row.reserved_sheets)}
                    </td>
                    <td className={`px-3 py-2 text-sky-300 ${ledgerMono}`}>{fmt(row.incoming_sheets)}</td>
                    <td className={`px-3 py-2 text-rose-300 ${ledgerMono}`}>{fmt(row.shortage_sheets)}</td>
                    <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{fmt(row.reorder_level)}</td>
                    <td className="px-3 py-2 text-xs text-ds-ink-faint">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {paperWarehouseRows.length === 0 && (
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
              <div className="rounded-lg border border-ds-warning/40 bg-ds-warning/8 p-3 space-y-1">
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
              <div className="rounded-lg border border-rose-700/50 bg-rose-950/30 p-3 text-rose-200 text-xs">
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

            <div className="rounded-lg border border-ds-line/50 bg-background p-3 space-y-3 ring-1 ring-ring/5">
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
                className="w-full rounded-md bg-ds-warning hover:bg-ds-warning py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
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
            className="px-4 py-2 rounded-lg bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Adjust Stock
          </button>
          <Link
            href="/inventory/flow"
            className="px-4 py-2 rounded-lg bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Inventory Flow
          </Link>
          <Link
            href="/inventory/simulation"
            className="px-4 py-2 rounded-lg bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Live Simulation
          </Link>
          <Link
            href="/inventory/purchase-requisitions"
            className="px-4 py-2 rounded-lg bg-ds-line/30 hover:bg-ds-line/40 text-foreground text-sm font-medium"
          >
            Purchase Requisitions
          </Link>
          <Link
            href="/inventory/grn"
            className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm font-medium"
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

      <section className="mt-8 rounded-xl border border-ds-line/40 bg-background">
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
