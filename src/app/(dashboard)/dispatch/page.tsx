'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Search, X, Truck, Package, CheckCircle2, Clock, ReceiptText, AlertTriangle } from 'lucide-react'
import { IndustrialModuleShell, industrialTableClassName } from '@/components/industrial/IndustrialModuleShell'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import {
  Badge,
  Button,
  CardSection,
  KpiTile,
  SectionLabel,
  StatusBadge,
} from '@/components/design-system'
import { PackingConfigEditor } from '@/components/industrial/PackingConfigEditor'
import {
  normalizePackingConfig,
  packingSummaryText,
  packingTotal,
  type PackingConfig,
} from '@/lib/dispatch-packing'

type ExistingDispatch = {
  id: string
  status: string
  qtyDispatched: number
  poQtySnapshot: number | null
  allowedQty: number | null
  excessQty: number
  packingConfig: PackingConfig
  totalPackedQty: number | null
  vehicleNumber: string | null
  driverName: string | null
  transportMode: string | null
  transporterName: string | null
  distanceKm: number | null
  ewayBillNumber: string | null
  ewayBillExpiry: string | null
  dispatchedAt: string | null
  podReceivedAt: string | null
  billingStatus: string
  billId: string | null
  shortExcessRecordId: string | null
}

type PoLineSummary = {
  id: string
  cartonName: string
  poNumber: string
  poQty: number
  tolerancePct: number
  allowedQty: number
  rate: number | null
  gstPct: number
  hsnCode: string | null
}

type DispatchRow = {
  jobCardId: string
  jobNumber: string
  customerId: string
  customerName: string
  productName: string
  qtyOrdered: number
  qtyProducedGood: number
  status: string
  dueDate: string
  poLine: PoLineSummary | null
  pastingPackingConfig: PackingConfig
  breachQty: number
  dispatchedQty: number
  existingDispatch: ExistingDispatch | null
}

type Customer = { id: string; name: string; address?: string | null; contactName?: string | null; contactPhone?: string | null }

const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready', pending_qa: 'Pending QA', qa_released: 'QA Released',
  dispatched: 'In Transit', pod_received: 'Delivered',
}

const BILLING_STATUS_LABELS: Record<string, string> = {
  not_sent: 'Not Sent', sent_to_billing: 'In Billing', billed: 'Billed', cancelled: 'Cancelled',
}

const DOCS = ['Tax Invoice', 'Delivery Challan / Packing List', 'E-Way Bill', 'Certificate of Analysis (CoA)', 'Quality Release Note']

function fmtDate(iso?: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}
function fmtDateTime(iso?: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
function isOverdue(due: string) { return new Date(due) < new Date() }

function toCsv(rows: Record<string, unknown>[]) {
  const keys = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s }, new Set<string>()))
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n')
}
function download(name: string, content: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([content], { type: 'text/csv' })), download: name })
  document.body.appendChild(a); a.click(); a.remove()
}

function InfoGrid({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <div className="text-ds-ink-muted">{label}</div>
          <div className="text-ds-ink">{value}</div>
        </div>
      ))}
    </div>
  )
}

export default function DispatchPage() {
  const qc = useQueryClient()
  const [customerId, setCustomerId] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')

  // Bulk selection — only rows already dispatched (have an existingDispatch with id) are selectable for billing.
  const [selectedDispatchIds, setSelectedDispatchIds] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const [row, setRow] = useState<DispatchRow | null>(null)
  const [qtyDispatched, setQtyDispatched] = useState(0)
  const [mode, setMode] = useState<'Road' | 'Air' | 'Sea' | 'Rail'>('Road')
  const [vehicle, setVehicle] = useState('')
  const [driver, setDriver] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [transporterName, setTransporterName] = useState('')
  const [distanceKm, setDistanceKm] = useState('')
  const [eway, setEway] = useState('')
  const [ewayExp, setEwayExp] = useState('')
  const [departure, setDeparture] = useState('')
  const [address, setAddress] = useState('')
  const [packing, setPacking] = useState<PackingConfig>([])
  const [docs, setDocs] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [podSaving, setPodSaving] = useState(false)
  const [pendingExcessConfirm, setPendingExcessConfirm] = useState<null | {
    poQty: number | null
    tolerancePct: number | null
    allowedQty: number | null
    qtyDispatched: number
    excessQty: number
  }>(null)

  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ['dispatch-customers'], queryFn: () => fetch('/api/customers').then((r) => r.json()) })
  const { data: list = [], isLoading, isFetching } = useQuery<DispatchRow[]>({
    queryKey: ['dispatch-ready'],
    queryFn: () => fetch('/api/dispatch').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const filtered = useMemo(() => {
    const fFrom = from ? new Date(from) : null
    const fTo = to ? new Date(to) : null
    if (fTo) fTo.setHours(23, 59, 59, 999)
    const ql = q.trim().toLowerCase()
    // Pushed (dispatched / pod_received) rows pin to the end so the queue stays
    // focused on actionable work, but completed work remains visible/trackable.
    const stageRank = (st: string) => (st === 'pod_received' ? 2 : st === 'dispatched' ? 1 : 0)
    return list
      .filter((r) => !customerId || r.customerId === customerId)
      .filter((r) => !statusFilter || (r.existingDispatch?.status ?? 'ready') === statusFilter)
      .filter((r) => { const d = new Date(r.dueDate); return (!fFrom || d >= fFrom) && (!fTo || d <= fTo) })
      .filter((r) => !ql || r.jobNumber.toLowerCase().includes(ql) || r.customerName.toLowerCase().includes(ql) || r.productName.toLowerCase().includes(ql))
      .sort((a, b) => {
        const ra = stageRank(a.existingDispatch?.status ?? 'ready')
        const rb = stageRank(b.existingDispatch?.status ?? 'ready')
        if (ra !== rb) return ra - rb
        // Within "pending" group: earliest due first.
        if (ra === 0) return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
        // Within "pushed" groups: most-recent dispatch first.
        const at = a.existingDispatch?.dispatchedAt ? new Date(a.existingDispatch.dispatchedAt).getTime() : 0
        const bt = b.existingDispatch?.dispatchedAt ? new Date(b.existingDispatch.dispatchedAt).getTime() : 0
        return bt - at
      })
  }, [list, customerId, statusFilter, from, to, q])

  // Eligible-for-billing = dispatched rows still in not_sent state. Drives bulk action.
  const eligibleForBilling = filtered.filter(
    (r) => r.existingDispatch && r.existingDispatch.billingStatus === 'not_sent',
  )

  const kpiReady = list.filter((r) => !r.existingDispatch || r.existingDispatch.status === 'ready').length
  const kpiTransit = list.filter((r) => r.existingDispatch?.status === 'dispatched').length
  const kpiDone = list.filter((r) => r.existingDispatch?.status === 'pod_received').length
  const kpiOverdue = list.filter((r) => isOverdue(r.dueDate) && r.existingDispatch?.status !== 'pod_received').length
  const kpiBreaches = list.filter((r) => r.breachQty > 0 && !r.existingDispatch).length

  function toggleSelect(dispatchId: string) {
    setSelectedDispatchIds((prev) => {
      const next = new Set(prev)
      if (next.has(dispatchId)) next.delete(dispatchId)
      else next.add(dispatchId)
      return next
    })
  }
  function toggleSelectAll() {
    setSelectedDispatchIds((prev) => {
      const ids = eligibleForBilling.map((r) => r.existingDispatch!.id)
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id))
      return allSelected ? new Set() : new Set(ids)
    })
  }

  async function sendToBilling() {
    if (selectedDispatchIds.size === 0) return
    setBulkBusy(true)
    try {
      const res = await fetch('/api/dispatch/send-to-billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dispatchIds: Array.from(selectedDispatchIds) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(json?.error ?? 'Send to billing failed'); return }
      toast.success(
        `${json.updated} dispatch${json.updated === 1 ? '' : 'es'} sent to billing${json.skipped ? ` · ${json.skipped} skipped` : ''}`,
        {
          action: {
            label: 'Open billing',
            onClick: () => window.open('/billing', '_self'),
          },
        },
      )
      setSelectedDispatchIds(new Set())
      await qc.invalidateQueries({ queryKey: ['dispatch-ready'] })
    } catch { toast.error('Network error') }
    finally { setBulkBusy(false) }
  }

  function openRow(r: DispatchRow) {
    setRow(r)
    const d = r.existingDispatch
    setQtyDispatched(d?.qtyDispatched || r.qtyProducedGood || r.qtyOrdered)
    setVehicle(d?.vehicleNumber ?? '')
    setDriver(d?.driverName ?? '')
    setDriverPhone('')
    setEway(d?.ewayBillNumber ?? '')
    setEwayExp(d?.ewayBillExpiry?.slice(0, 10) ?? '')
    setDeparture('')
    const allowedModes = ['Road', 'Air', 'Sea', 'Rail'] as const
    const persistedMode = d?.transportMode
    setMode(allowedModes.includes(persistedMode as typeof allowedModes[number]) ? (persistedMode as typeof allowedModes[number]) : 'Road')
    setTransporterName(d?.transporterName ?? '')
    setDistanceKm(d?.distanceKm != null ? String(d.distanceKm) : '')
    // Packing: prefer the existing dispatch's manifest, else fall back to what pasting captured.
    const seed = d?.packingConfig?.length
      ? d.packingConfig
      : r.pastingPackingConfig.length
        ? r.pastingPackingConfig
        : [{ boxes: 0, qtyPerBox: 0 }]
    setPacking(seed)
    setDocs({})
    setPendingExcessConfirm(null)
    const cust = customers.find((c) => c.id === r.customerId)
    setAddress(cust ? `${cust.name}${cust.address ? '\n' + cust.address : ''}` : '')
  }

  async function performDispatch(forceOverride: boolean) {
    if (!row) return
    if (!qtyDispatched || qtyDispatched <= 0) { toast.error('Enter qty to dispatch'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobCardId: row.jobCardId,
          qtyDispatched,
          vehicleNumber: vehicle || undefined,
          driverName: driver || undefined,
          transportMode: mode,
          transporterName: transporterName || undefined,
          distanceKm: distanceKm ? Number(distanceKm) : undefined,
          ewayBillNumber: eway || undefined,
          ewayBillExpiry: ewayExp || undefined,
          packingConfig: normalizePackingConfig(packing),
          acceptExcessOverride: forceOverride,
          // The bulk "Send for Billing" flow generates the real invoice; we no longer
          // create a draft bill on confirm so dispatches stay in not_sent → sent_to_billing → billed.
          createDraftBill: false,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 409 && json?.breach) {
        setPendingExcessConfirm(json.breach)
        return
      }
      if (!res.ok) { toast.error(json?.error ?? 'Dispatch failed'); return }
      if (json?.shortExcessRecordId) {
        toast.warning(
          `Dispatched with excess — ${row.customerName}. S&E record opened.`,
          {
            action: {
              label: 'Open S&E',
              onClick: () => window.open('/short-excess', '_self'),
            },
          },
        )
      } else {
        toast.success(`Dispatched ${qtyDispatched.toLocaleString('en-IN')} cartons — ${row.customerName}`)
      }
      setRow(null)
      setPendingExcessConfirm(null)
      await qc.invalidateQueries({ queryKey: ['dispatch-ready'] })
    } catch { toast.error('Network error') }
    finally { setSaving(false) }
  }

  async function confirmDispatch() {
    await performDispatch(false)
  }
  async function confirmDispatchWithExcess() {
    await performDispatch(true)
  }

  async function confirmPod() {
    if (!row?.existingDispatch?.id) return
    setPodSaving(true)
    try {
      const res = await fetch(`/api/dispatch/${row.existingDispatch.id}/pod`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        // Dispatch confirmation already creates the draft bill; POD is status-only here.
        body: JSON.stringify({ receivedAt: new Date().toISOString(), createDraftBill: false }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); toast.error(j?.error ?? 'Failed'); return }
      toast.success('POD confirmed — marked Delivered')
      setRow(null)
      await qc.invalidateQueries({ queryKey: ['dispatch-ready'] })
    } catch { toast.error('Network error') }
    finally { setPodSaving(false) }
  }

  const dispSt = row?.existingDispatch?.status ?? 'ready'
  const isDispatched = dispSt === 'dispatched' || dispSt === 'pod_received'

  function handleExportCsv() {
    const csv = toCsv(filtered.map((r) => ({
      jobNumber: r.jobNumber, product: r.productName, customer: r.customerName,
      poNumber: r.poLine?.poNumber ?? '',
      poQty: r.poLine?.poQty ?? '',
      tolerancePct: r.poLine?.tolerancePct ?? '',
      allowedQty: r.poLine?.allowedQty ?? '',
      qtyProduced: r.qtyProducedGood,
      qtyDispatched: r.existingDispatch?.qtyDispatched ?? 0,
      excessQty: r.existingDispatch?.excessQty ?? r.breachQty ?? 0,
      boxes: packingSummaryText(r.existingDispatch?.packingConfig?.length ? r.existingDispatch.packingConfig : r.pastingPackingConfig),
      vehicle: r.existingDispatch?.vehicleNumber ?? '', driver: r.existingDispatch?.driverName ?? '',
      ewayBill: r.existingDispatch?.ewayBillNumber ?? '',
      dueDate: r.dueDate.slice(0, 10),
      status: r.existingDispatch?.status ?? 'ready',
      billingStatus: r.existingDispatch?.billingStatus ?? 'not_sent',
    })))
    download(`dispatch-${new Date().toISOString().slice(0, 10)}.csv`, csv)
  }

  const drawerExcessLive = (() => {
    if (!row?.poLine) return null
    const allowed = row.poLine.allowedQty
    const excess = Math.max(0, qtyDispatched - allowed)
    return excess > 0 ? { allowed, excess } : null
  })()

  const drawerFooter = (
    <div className="flex items-center gap-2">
      {!isDispatched ? (
        pendingExcessConfirm ? (
          <Button
            variant="warning"
            className="flex-1 gap-2"
            onClick={confirmDispatchWithExcess}
            disabled={saving}
          >
            {saving ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <AlertTriangle className="h-4 w-4" />}
            {saving ? 'Saving…' : `Dispatch +${pendingExcessConfirm.excessQty.toLocaleString('en-IN')} Excess (S&E auto-open)`}
          </Button>
        ) : (
          <Button variant="primary" className="flex-1 gap-2" onClick={confirmDispatch} disabled={saving}>
            {saving ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Truck className="h-4 w-4" />}
            {saving ? 'Saving…' : 'Confirm Dispatch'}
          </Button>
        )
      ) : dispSt === 'dispatched' ? (
        <Button variant="success" className="flex-1 gap-2" onClick={confirmPod} disabled={podSaving}>
          {podSaving ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <CheckCircle2 className="h-4 w-4" />}
          {podSaving ? 'Saving…' : 'Confirm POD Received'}
        </Button>
      ) : (
        <div className="flex-1 rounded-ds-sm border border-[var(--success)]/30 bg-[var(--success-bg)] px-4 py-2.5 text-center text-sm font-medium text-[var(--success)]">
          ✓ Delivered — POD Recorded
        </div>
      )}
      <Button variant="secondary" onClick={() => setRow(null)}>Close</Button>
    </div>
  )

  return (
    <IndustrialModuleShell
      title="Dispatch Planning"
      subtitle={`Outbound logistics · auto-refresh 30s${isFetching ? ' · refreshing…' : ''}`}
      kpiRow={
        <>
          <KpiTile label="Ready to Ship" tone="warning" value={kpiReady} icon={<Package />} />
          <KpiTile label="In Transit" tone="info" value={kpiTransit} icon={<Truck />} />
          <KpiTile label="Delivered" tone="success" value={kpiDone} icon={<CheckCircle2 />} />
          <KpiTile label="Overdue" tone="danger" value={kpiOverdue} icon={<Clock />} />
          <KpiTile label="Excess (open)" tone="danger" value={kpiBreaches} icon={<AlertTriangle />} />
        </>
      }
      headerAction={
        <Button variant="secondary" onClick={handleExportCsv}>Export CSV</Button>
      }
    >
      {/* Filters */}
      <div className="ds-toolbar">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ds-ink-faint" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Job #, product or customer…"
            className="ds-input ds-toolbar-search pl-9"
          />
        </div>
        {q && (
          <Button variant="icon" aria-label="Clear search" onClick={() => setQ('')}>
            <X className="h-4 w-4" />
          </Button>
        )}
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="ds-input h-9 min-w-[150px] cursor-pointer py-1.5"
        >
          <option value="">All clients</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="ds-input h-9 min-w-[140px] cursor-pointer py-1.5"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="ds-input h-9 py-1.5"
        />
        <span className="text-xs text-ds-ink-faint">to</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="ds-input h-9 py-1.5"
        />
      </div>

      {/* Bulk action bar — appears when rows are selected */}
      {selectedDispatchIds.size > 0 && (
        <div className="my-3 flex items-center justify-between rounded-ds-md border border-[var(--brand-primary)]/30 bg-[var(--brand-bg-soft)] px-4 py-2.5">
          <div className="text-xs text-ds-ink">
            <span className="font-semibold tabular-nums">{selectedDispatchIds.size}</span>{' '}
            dispatch{selectedDispatchIds.size === 1 ? '' : 'es'} selected
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-xs"
              onClick={() => setSelectedDispatchIds(new Set())}
              disabled={bulkBusy}
            >
              Clear selection
            </Button>
            <Button
              variant="primary"
              className="gap-1.5 px-3 py-1.5 text-xs"
              onClick={sendToBilling}
              disabled={bulkBusy}
            >
              {bulkBusy ? (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <ReceiptText className="h-3.5 w-3.5" />
              )}
              Send for Billing
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      {isLoading ? <div className="py-12 text-center text-sm text-ds-ink-muted">Loading…</div> : (
        <div className={industrialTableClassName()}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--bg-elevated)]">
              <tr className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-muted">
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all eligible dispatches"
                    checked={
                      eligibleForBilling.length > 0 &&
                      eligibleForBilling.every((r) => selectedDispatchIds.has(r.existingDispatch!.id))
                    }
                    onChange={toggleSelectAll}
                    disabled={eligibleForBilling.length === 0}
                    className="h-3.5 w-3.5 rounded"
                  />
                </th>
                <th className="px-3 py-2.5">Job #</th>
                <th className="px-3 py-2.5">Product / Carton</th>
                <th className="px-3 py-2.5">Client</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">PO #</th>
                <th className="px-3 py-2.5 text-right">PO Qty</th>
                <th className="hidden px-3 py-2.5 text-right lg:table-cell">Allowed</th>
                <th className="px-3 py-2.5 text-right">Produced</th>
                <th className="px-3 py-2.5 text-right">Dispatched</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">Boxes</th>
                <th className="hidden px-3 py-2.5 xl:table-cell">Vehicle #</th>
                <th className="hidden px-3 py-2.5 xl:table-cell">E-Way Bill</th>
                <th className="px-3 py-2.5">Due Date</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Billing</th>
                <th className="px-3 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.map((r) => {
                const st = r.existingDispatch?.status ?? 'ready'
                const overdue = isOverdue(r.dueDate) && st !== 'pod_received'
                const pushed = st === 'dispatched' || st === 'pod_received'
                const bSt = r.existingDispatch?.billingStatus ?? 'not_sent'
                const selectable = !!r.existingDispatch && bSt === 'not_sent'
                const selected = r.existingDispatch ? selectedDispatchIds.has(r.existingDispatch.id) : false
                const breach =
                  (r.existingDispatch?.excessQty ?? 0) > 0 ||
                  (!r.existingDispatch && r.breachQty > 0)
                const breachAmount = r.existingDispatch?.excessQty ?? r.breachQty
                const boxes = r.existingDispatch?.packingConfig?.length
                  ? r.existingDispatch.packingConfig
                  : r.pastingPackingConfig
                return (
                  <tr
                    key={r.jobCardId}
                    className={`transition-colors hover:bg-[var(--bg-muted)] ${pushed ? 'bg-emerald-500/10' : ''} ${selected ? 'bg-[var(--brand-bg-soft)]' : ''}`}
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.jobNumber} for billing`}
                        checked={selected}
                        onChange={() => r.existingDispatch && toggleSelect(r.existingDispatch.id)}
                        disabled={!selectable}
                        className="h-3.5 w-3.5 rounded disabled:cursor-not-allowed disabled:opacity-30"
                      />
                    </td>
                    <td className="px-3 py-2.5"><span className="font-mono text-xs font-medium text-[var(--brand-primary)]">{r.jobNumber}</span></td>
                    <td className="max-w-[180px] px-3 py-2.5"><span className="block truncate text-xs font-medium text-ds-ink">{r.productName}</span></td>
                    <td className="px-3 py-2.5 text-xs text-ds-ink">{r.customerName}</td>
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-ds-ink-muted lg:table-cell">{r.poLine?.poNumber ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink-muted">
                      {(r.poLine?.poQty ?? r.qtyOrdered).toLocaleString('en-IN')}
                    </td>
                    <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink-muted lg:table-cell">
                      {r.poLine ? r.poLine.allowedQty.toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      <span className={r.qtyProducedGood >= r.qtyOrdered ? 'font-medium text-[var(--success)]' : 'font-medium text-[var(--warning)]'}>
                        {r.qtyProducedGood.toLocaleString('en-IN')}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      {r.existingDispatch
                        ? <span className="font-semibold text-ds-ink">{r.existingDispatch.qtyDispatched.toLocaleString('en-IN')}</span>
                        : <span className="text-ds-ink-faint">—</span>}
                      {breach && (
                        <Badge tone="danger" className="ml-1 px-1 py-0 text-[9px]">
                          +{breachAmount.toLocaleString('en-IN')}
                        </Badge>
                      )}
                    </td>
                    <td className="hidden max-w-[160px] px-3 py-2.5 text-[11px] text-ds-ink-muted lg:table-cell">
                      <span className="block truncate" title={packingSummaryText(boxes)}>
                        {packingSummaryText(boxes)}
                      </span>
                    </td>
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-ds-ink-muted xl:table-cell">{r.existingDispatch?.vehicleNumber ?? '—'}</td>
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-ds-ink-muted xl:table-cell">{r.existingDispatch?.ewayBillNumber ?? '—'}</td>
                    <td className="px-3 py-2.5 text-xs">
                      <span className={overdue ? 'font-medium text-[var(--error)]' : 'text-ds-ink-muted'}>{fmtDate(r.dueDate)}</span>
                      {overdue && <Badge tone="danger" className="ml-1 px-1 py-0 text-[9px]">LATE</Badge>}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={STATUS_LABELS[st] ?? st} />
                    </td>
                    <td className="px-3 py-2.5">
                      {r.existingDispatch ? (
                        <Badge
                          tone={
                            bSt === 'billed' ? 'success'
                            : bSt === 'sent_to_billing' ? 'info'
                            : bSt === 'cancelled' ? 'danger'
                            : 'neutral'
                          }
                          className="px-1.5 py-0 text-[10px]"
                        >
                          {BILLING_STATUS_LABELS[bSt] ?? bSt}
                        </Badge>
                      ) : (
                        <span className="text-[10px] text-ds-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        variant="warning"
                        className="px-2.5 py-1 text-xs"
                        onClick={() => openRow(r)}
                      >
                        {st === 'dispatched' ? 'POD' : st === 'pod_received' ? 'View' : 'Dispatch'} →
                      </Button>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={16} className="px-3 py-12 text-center text-sm text-ds-ink-faint">{q ? `No jobs matching "${q}"` : 'No jobs ready for dispatch.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Dispatch drawer */}
      <SlideOverPanel
        isOpen={!!row}
        onClose={() => setRow(null)}
        title={row ? `${row.jobNumber} · Dispatch` : ''}
        headerMeta={row ? `${row.customerName} · ${row.productName}` : undefined}
        footer={drawerFooter}
      >
        {row && (
          <div className="space-y-3">
            {/* PO context */}
            {row.poLine && (
              <div className="space-y-3 rounded-ds-md border border-[var(--brand-primary)]/25 bg-[var(--brand-bg-soft)] px-4 py-3.5">
                <SectionLabel accent>Customer PO</SectionLabel>
                <InfoGrid rows={[
                  ['PO Number', <span key="pn" className="font-mono">{row.poLine.poNumber}</span>],
                  ['PO Qty', <span key="pq" className="tabular-nums">{row.poLine.poQty.toLocaleString('en-IN')}</span>],
                  ['Tolerance', <span key="tp" className="tabular-nums">{row.poLine.tolerancePct}%</span>],
                  ['Max Allowed', <span key="al" className="font-semibold tabular-nums text-ds-ink">{row.poLine.allowedQty.toLocaleString('en-IN')}</span>],
                ]} />
              </div>
            )}

            {/* Production summary */}
            <div className="space-y-3 rounded-ds-md border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3.5">
              <SectionLabel>Production</SectionLabel>
              <InfoGrid rows={[
                ['Qty Produced (good)', <span key="qp" className={`font-semibold tabular-nums ${row.qtyProducedGood >= (row.poLine?.poQty ?? row.qtyOrdered) ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>{row.qtyProducedGood.toLocaleString('en-IN')}</span>],
                ['Due Date', <span key="dd" className={isOverdue(row.dueDate) && dispSt !== 'pod_received' ? 'font-medium text-[var(--error)]' : ''}>{fmtDate(row.dueDate)}</span>],
                ['Status', <StatusBadge key="st" status={STATUS_LABELS[dispSt] ?? dispSt} />],
              ]} />
            </div>

            {/* Existing dispatch record */}
            {row.existingDispatch && (
              <CardSection title="Dispatch Record">
                <InfoGrid rows={[
                  ['Qty Dispatched', <span key="qd" className="font-semibold tabular-nums text-ds-ink">{row.existingDispatch.qtyDispatched.toLocaleString('en-IN')}</span>],
                  ['Allowed Qty', row.existingDispatch.allowedQty != null ? <span key="aq" className="tabular-nums">{row.existingDispatch.allowedQty.toLocaleString('en-IN')}</span> : '—'],
                  ['Excess', row.existingDispatch.excessQty > 0 ? <span key="ex" className="font-semibold tabular-nums text-[var(--error)]">+{row.existingDispatch.excessQty.toLocaleString('en-IN')}</span> : '0'],
                  ['Total Packed', row.existingDispatch.totalPackedQty != null ? <span key="tp" className="tabular-nums">{row.existingDispatch.totalPackedQty.toLocaleString('en-IN')}</span> : '—'],
                  ['Box Manifest', <span key="bx" className="text-xs">{packingSummaryText(row.existingDispatch.packingConfig)}</span>],
                  ['Vehicle #', <span key="vn" className="font-mono">{row.existingDispatch.vehicleNumber ?? '—'}</span>],
                  ['Driver', row.existingDispatch.driverName ?? '—'],
                  ['Transporter', row.existingDispatch.transporterName ?? '—'],
                  ['Distance (km)', row.existingDispatch.distanceKm != null ? <span key="km" className="tabular-nums">{row.existingDispatch.distanceKm}</span> : '—'],
                  ['E-Way Bill', <span key="eb" className="font-mono">{row.existingDispatch.ewayBillNumber ?? '—'}</span>],
                  ['Dispatched At', fmtDateTime(row.existingDispatch.dispatchedAt)],
                  ['Billing', <Badge key="bs" tone={row.existingDispatch.billingStatus === 'billed' ? 'success' : row.existingDispatch.billingStatus === 'sent_to_billing' ? 'info' : 'neutral'} className="px-1.5 py-0 text-[10px]">{BILLING_STATUS_LABELS[row.existingDispatch.billingStatus] ?? row.existingDispatch.billingStatus}</Badge>],
                  ...(row.existingDispatch.shortExcessRecordId ? [['S&E Record', <a key="se" href="/short-excess" className="font-mono text-[var(--brand-primary)] hover:underline">Open →</a>] as [string, React.ReactNode]] : []),
                  ...(row.existingDispatch.podReceivedAt ? [['POD Received', <span key="pod" className="font-medium text-[var(--success)]">{fmtDateTime(row.existingDispatch.podReceivedAt)}</span>] as [string, React.ReactNode]] : []),
                ]} />
              </CardSection>
            )}

            {/* Tolerance breach banner (live, on the editing form) */}
            {!isDispatched && drawerExcessLive && (
              <div className="flex items-start gap-2 rounded-ds-md border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2.5 text-xs">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
                <div className="space-y-0.5">
                  <div className="font-semibold text-[var(--warning)]">
                    Dispatch qty exceeds tolerance band by{' '}
                    <span className="tabular-nums">{drawerExcessLive.excess.toLocaleString('en-IN')}</span>
                  </div>
                  <div className="text-ds-ink-muted">
                    Allowed (PO + tolerance): {drawerExcessLive.allowed.toLocaleString('en-IN')}. Confirming will auto-open a Short & Excess record for review.
                  </div>
                </div>
              </div>
            )}
            {pendingExcessConfirm && (
              <div className="flex items-start gap-2 rounded-ds-md border border-[var(--error)]/40 bg-[var(--error-bg)] px-3 py-2.5 text-xs">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--error)]" />
                <div className="space-y-0.5">
                  <div className="font-semibold text-[var(--error)]">Confirmation required</div>
                  <div className="text-ds-ink">
                    Dispatching {pendingExcessConfirm.qtyDispatched.toLocaleString('en-IN')} exceeds allowed{' '}
                    {pendingExcessConfirm.allowedQty?.toLocaleString('en-IN') ?? '—'}. Re-click below to dispatch with override; an S&E record will be auto-opened for{' '}
                    {pendingExcessConfirm.excessQty.toLocaleString('en-IN')} cartons.
                  </div>
                </div>
              </div>
            )}

            {/* Documents checklist */}
            <CardSection title="Dispatch Documents">
              <div className="space-y-2">
                {DOCS.map((doc) => (
                  <label key={doc} className="flex cursor-pointer select-none items-center gap-2.5 text-xs text-ds-ink">
                    <input
                      type="checkbox"
                      checked={!!docs[doc]}
                      onChange={(e) => setDocs((prev) => ({ ...prev, [doc]: e.target.checked }))}
                      className="h-3.5 w-3.5 shrink-0 rounded"
                    />
                    <span className={docs[doc] ? 'text-ds-ink-muted line-through' : ''}>{doc}</span>
                  </label>
                ))}
              </div>
            </CardSection>

            {/* Dispatch form — only when not yet dispatched */}
            {!isDispatched && (
              <CardSection title="Packing Manifest">
                <PackingConfigEditor
                  value={packing}
                  onChange={setPacking}
                  referenceQty={qtyDispatched}
                  referenceLabel="Qty to Dispatch"
                />
                <div className="mt-2 flex items-center justify-between text-[11px]">
                  <span className="text-ds-ink-faint">Pre-filled from Pasting</span>
                  <button
                    type="button"
                    className="text-[var(--brand-primary)] hover:underline"
                    onClick={() => setQtyDispatched(packingTotal(packing))}
                  >
                    Sync Qty to manifest total
                  </button>
                </div>
              </CardSection>
            )}

            {!isDispatched && (
              <CardSection title="Dispatch Details">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">Transport Mode</label>
                    <select
                      value={mode}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === 'Road' || v === 'Air' || v === 'Sea' || v === 'Rail') setMode(v)
                      }}
                      className="ds-input cursor-pointer"
                    >
                      <option value="Road">Road</option>
                      <option value="Air">Air</option>
                      <option value="Sea">Sea</option>
                      <option value="Rail">Rail</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">Qty to Dispatch *</label>
                    <input
                      type="number"
                      min={1}
                      value={qtyDispatched || ''}
                      onChange={(e) => {
                        setQtyDispatched(Number(e.target.value))
                        setPendingExcessConfirm(null)
                      }}
                      className="ds-input tabular-nums"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">Vehicle Number</label>
                    <input
                      value={vehicle}
                      onChange={(e) => setVehicle(e.target.value)}
                      placeholder="MH 01 AB 1234"
                      className="ds-input font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">Driver Name</label>
                    <input
                      value={driver}
                      onChange={(e) => setDriver(e.target.value)}
                      className="ds-input"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">Driver Phone</label>
                    <input
                      value={driverPhone}
                      onChange={(e) => setDriverPhone(e.target.value)}
                      placeholder="+91"
                      className="ds-input"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">Transporter Name</label>
                    <input
                      value={transporterName}
                      onChange={(e) => setTransporterName(e.target.value)}
                      placeholder="—"
                      className="ds-input"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">Distance (km)</label>
                    <input
                      type="number"
                      min={0}
                      step="0.1"
                      value={distanceKm}
                      onChange={(e) => setDistanceKm(e.target.value)}
                      className="ds-input tabular-nums"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">Departure Date/Time</label>
                    <input
                      type="datetime-local"
                      value={departure}
                      onChange={(e) => setDeparture(e.target.value)}
                      className="ds-input"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">E-Way Bill #</label>
                    <input
                      value={eway}
                      onChange={(e) => setEway(e.target.value)}
                      placeholder="EWB No."
                      className="ds-input font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-medium text-ds-ink-muted">E-Way Bill Expiry</label>
                    <input
                      type="date"
                      value={ewayExp}
                      onChange={(e) => setEwayExp(e.target.value)}
                      className="ds-input"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-medium text-ds-ink-muted">Delivery Address</label>
                  <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} className="ds-input resize-none" />
                </div>
              </CardSection>
            )}
          </div>
        )}
      </SlideOverPanel>
    </IndustrialModuleShell>
  )
}
