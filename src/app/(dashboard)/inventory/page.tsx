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

function InventoryPageContent() {
  const searchParams = useSearchParams()
  const ledgerGsm = searchParams.get('ledgerGsm')?.trim() ?? ''
  const ledgerBoard = searchParams.get('ledgerBoard')?.trim() ?? ''
  const { data: session } = useSession()
  const [items, setItems] = useState<StockStateItem[]>([])
  const [alerts, setAlerts] = useState<StockStateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [paperLedger, setPaperLedger] = useState<{
    rows: PaperLedgerRow[]
    staleCapitalInr: number
  } | null>(null)
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
        fetch('/api/job-cards')
          .then((r) => r.json())
          .then((list) => setJobCards(Array.isArray(list) ? list : [])),
      ])
    } catch {
      /* noop */
    } finally {
      setLoading(false)
    }
  }, [debouncedHubPo, ledgerGsm, ledgerBoard, loadPaperLedger])

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedHubPo(hubSearchPo), 320)
    return () => window.clearTimeout(t)
  }, [hubSearchPo])

  useEffect(() => {
    void reloadAll()
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

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <section
        id="paper-ledger"
        className="mb-8 rounded-xl border border-ds-line/40 overflow-hidden bg-background text-ds-ink"
      >
        <div className="p-4 md:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-ds-warning">Warehouse hub — Paper pending issue</h2>
              <p className="text-xs text-ds-ink-faint mt-1 font-mono">
                Director priority stars sort to the top. Search customer PO # to trace batches. JetBrains mono for
                weights and PO numbers.
              </p>
              {(ledgerGsm || ledgerBoard) && (
                <p className={`text-xs text-ds-warning mt-2 ${ledgerMono}`}>
                  Job card deep link · GSM {ledgerGsm || '—'} · Board {ledgerBoard || '—'}
                </p>
              )}
            </div>
            <div className="rounded-lg border border-red-900/70 bg-red-950/50 px-4 py-3 shrink-0">
              <p className="text-xs uppercase tracking-wide text-red-300/90">Stale capital</p>
              <p className={`text-2xl text-red-200 ${ledgerMono}`}>
                {fmtVal(paperLedger?.staleCapitalInr ?? 0)}
              </p>
              <p className="text-xs text-ds-ink-faint mt-1">₹ value of sheets on hand &gt; 60 days</p>
            </div>
          </div>

          <label className="block mb-3 text-xs text-ds-ink-faint uppercase tracking-wide">
            Deep search — Customer PO #
            <input
              type="text"
              value={hubSearchPo}
              onChange={(e) => setHubSearchPo(e.target.value)}
              placeholder="e.g. CI-PO-2026-0001"
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
                  <th className="px-2 py-2 w-8">Pri</th>
                  <th className="px-3 py-2">Lot</th>
                  <th className="px-3 py-2">GSM</th>
                  <th className="px-3 py-2">Grade / type</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Gate date</th>
                  <th className="px-3 py-2">Age</th>
                  <th className="px-3 py-2">Value (est.)</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ds-card">
                {sortedPaperRows.map((row) => {
                  const priGlow = row.industrialPriority
                    ? 'shadow-[0_0_20px_rgba(251,146,60,0.35)] ring-1 ring-orange-500/50 bg-orange-950/15'
                    : ''
                  return (
                    <tr
                      key={row.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setDrawerRow(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setDrawerRow(row)
                        }
                      }}
                      className={`hover:bg-ds-main/80 cursor-pointer ${priGlow}`}
                    >
                      <td className="px-2 py-2 align-middle">
                        <Star
                          className={`h-4 w-4 ${
                            row.industrialPriority
                              ? 'text-orange-400 fill-orange-400 drop-shadow-[0_0_6px_rgba(251,146,60,0.9)]'
                              : 'text-neutral-700'
                          }`}
                          strokeWidth={row.industrialPriority ? 0 : 1.2}
                        />
                      </td>
                      <td className={`px-3 py-2 text-xs text-ds-ink ${ledgerMono}`}>{row.lotNumber ?? '—'}</td>
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{row.gsm}</td>
                      <td className="px-3 py-2 text-ds-ink-muted">
                        {(row.boardGrade ?? '').trim() || row.paperType}
                      </td>
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>
                        {row.qtySheets.toLocaleString('en-IN')}
                      </td>
                      <td className={`px-3 py-2 text-ds-ink-muted ${ledgerMono}`}>{row.receiptDate}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-2 tabular-nums ${ledgerMono}`}>
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${ageDotClass(row.ageBucket)}`}
                            title={ageLabel(row.ageBucket)}
                          />
                          {row.ageDays}d
                          <span className="text-xs text-ds-ink-faint">({ageLabel(row.ageBucket)})</span>
                        </span>
                      </td>
                      <td className={`px-3 py-2 text-ds-ink ${ledgerMono}`}>{fmtVal(row.valueInr)}</td>
                      <td className="px-3 py-2 text-xs text-ds-ink-faint">{row.status}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {sortedPaperRows.length === 0 && (
              <p className="p-6 text-center text-ds-ink-faint text-sm">
                No main-warehouse paper rows with quantity (or no match for this PO search).
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
            Goods receipt (GRN)
          </Link>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-700 text-red-200 text-sm">
          Reorder alert: {alerts.length} material(s) at or below reorder point.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-lg border-2 border-red-700/50 bg-red-900/20 p-4">
          <h2 className="font-semibold text-red-300 mb-2">Quarantine</h2>
          {items
            .filter((i) => i.qtyQuarantine > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1.5 flex flex-col gap-0.5">
                <span className="flex justify-between">
                  <span>{i.materialCode}</span>
                  <span>
                    {fmt(i.qtyQuarantine)} {i.unit}
                  </span>
                </span>
                <span className="text-red-200/80 text-xs">{fmtVal(i.valueQuarantine)}</span>
              </div>
            ))}
          {items.every((i) => i.qtyQuarantine === 0) && <p className="text-ds-ink-faint text-sm">None</p>}
        </div>
        <div className="rounded-lg border-2 border-green-700/50 bg-green-900/20 p-4">
          <h2 className="font-semibold text-green-300 mb-2">Available</h2>
          {items
            .filter((i) => i.qtyAvailable > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1.5 flex flex-col gap-0.5">
                <span className="flex justify-between">
                  <span>{i.materialCode}</span>
                  <span>
                    {fmt(i.qtyAvailable)} {i.unit}
                  </span>
                </span>
                <span className="text-green-200/80 text-xs">{fmtVal(i.valueAvailable)}</span>
              </div>
            ))}
          {items.every((i) => i.qtyAvailable === 0) && <p className="text-ds-ink-faint text-sm">None</p>}
        </div>
        <div className="rounded-lg border-2 border-ds-warning/30 bg-ds-warning/8 p-4">
          <h2 className="font-semibold text-ds-warning mb-2">Reserved / WIP</h2>
          {items
            .filter((i) => i.qtyReserved > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1.5 flex flex-col gap-0.5">
                <span className="flex justify-between">
                  <span>{i.materialCode}</span>
                  <span>
                    {fmt(i.qtyReserved)} {i.unit}
                  </span>
                </span>
                <span className="text-ds-warning/80 text-xs">{fmtVal(i.valueReserved)}</span>
              </div>
            ))}
          {items.every((i) => i.qtyReserved === 0) && <p className="text-ds-ink-faint text-sm">None</p>}
        </div>
        <div className="rounded-lg border-2 border-blue-700/50 bg-blue-900/20 p-4">
          <h2 className="font-semibold text-blue-300 mb-2">Finished Goods</h2>
          {items
            .filter((i) => i.qtyFg > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1.5 flex flex-col gap-0.5">
                <span className="flex justify-between">
                  <span>{i.materialCode}</span>
                  <span>
                    {fmt(i.qtyFg)} {i.unit}
                  </span>
                </span>
                <span className="text-blue-200/80 text-xs">{fmtVal(i.valueFg)}</span>
              </div>
            ))}
          {items.every((i) => i.qtyFg === 0) && <p className="text-ds-ink-faint text-sm">None</p>}
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
              <th className="px-4 py-2">FG</th>
              <th className="px-4 py-2">Reorder</th>
              <th className="px-4 py-2">Value (est)</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-line/40">
            {items.map((i) => {
              const totalVal = i.valueQuarantine + i.valueAvailable + i.valueReserved + i.valueFg
              return (
                <tr key={i.id} className="hover:bg-ds-elevated/50">
                  <td className={`px-4 py-2 ${ledgerMono}`}>{i.materialCode}</td>
                  <td className="px-4 py-2">{i.description}</td>
                  <td className="px-4 py-2">{i.unit}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmt(i.qtyQuarantine)}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmt(i.qtyAvailable)}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmt(i.qtyReserved)}</td>
                  <td className={`px-4 py-2 ${ledgerMono}`}>{fmt(i.qtyFg)}</td>
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
