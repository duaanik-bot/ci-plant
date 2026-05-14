'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Search, X, Truck, Package, CheckCircle2, Clock } from 'lucide-react'
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

type ExistingDispatch = {
  id: string
  status: string
  qtyDispatched: number
  vehicleNumber: string | null
  driverName: string | null
  ewayBillNumber: string | null
  ewayBillExpiry: string | null
  dispatchedAt: string | null
  podReceivedAt: string | null
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
  existingDispatch: ExistingDispatch | null
}

type Customer = { id: string; name: string; address?: string | null; contactName?: string | null; contactPhone?: string | null }

const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready', pending_qa: 'Pending QA', qa_released: 'QA Released',
  dispatched: 'In Transit', pod_received: 'Delivered',
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

  const [row, setRow] = useState<DispatchRow | null>(null)
  const [qtyDispatched, setQtyDispatched] = useState(0)
  const [mode, setMode] = useState<'Road' | 'Air' | 'Sea' | 'Rail'>('Road')
  const [vehicle, setVehicle] = useState('')
  const [driver, setDriver] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [eway, setEway] = useState('')
  const [ewayExp, setEwayExp] = useState('')
  const [departure, setDeparture] = useState('')
  const [address, setAddress] = useState('')
  const [docs, setDocs] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [podSaving, setPodSaving] = useState(false)

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

  const kpiReady = list.filter((r) => !r.existingDispatch || r.existingDispatch.status === 'ready').length
  const kpiTransit = list.filter((r) => r.existingDispatch?.status === 'dispatched').length
  const kpiDone = list.filter((r) => r.existingDispatch?.status === 'pod_received').length
  const kpiOverdue = list.filter((r) => isOverdue(r.dueDate) && r.existingDispatch?.status !== 'pod_received').length

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
    setMode('Road')
    setDocs({})
    const cust = customers.find((c) => c.id === r.customerId)
    setAddress(cust ? `${cust.name}${cust.address ? '\n' + cust.address : ''}` : '')
  }

  async function confirmDispatch() {
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
          ewayBillNumber: eway || undefined,
          ewayBillExpiry: ewayExp || undefined,
          createDraftBill: true,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(json?.error ?? 'Failed'); return }
      if (json?.draftBillId) {
        toast.success(
          `Dispatched ${qtyDispatched.toLocaleString('en-IN')} cartons — draft bill ${json.draftBillNumber}`,
          {
            action: {
              label: 'Open bill',
              onClick: () => window.open(`/billing/${json.draftBillId}`, '_blank'),
            },
          },
        )
      } else {
        toast.success(`Dispatched ${qtyDispatched.toLocaleString('en-IN')} cartons — ${row.customerName}`)
      }
      setRow(null)
      await qc.invalidateQueries({ queryKey: ['dispatch-ready'] })
    } catch { toast.error('Network error') }
    finally { setSaving(false) }
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
      qtyOrdered: r.qtyOrdered, qtyProduced: r.qtyProducedGood, qtyDispatched: r.existingDispatch?.qtyDispatched ?? 0,
      vehicle: r.existingDispatch?.vehicleNumber ?? '', driver: r.existingDispatch?.driverName ?? '',
      ewayBill: r.existingDispatch?.ewayBillNumber ?? '', dueDate: r.dueDate.slice(0, 10), status: r.existingDispatch?.status ?? 'ready',
    })))
    download(`dispatch-${new Date().toISOString().slice(0, 10)}.csv`, csv)
  }

  const drawerFooter = (
    <div className="flex items-center gap-2">
      {!isDispatched ? (
        <Button variant="primary" className="flex-1 gap-2" onClick={confirmDispatch} disabled={saving}>
          {saving ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Truck className="h-4 w-4" />}
          {saving ? 'Saving…' : 'Confirm Dispatch'}
        </Button>
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

      {/* Table */}
      {isLoading ? <div className="py-12 text-center text-sm text-ds-ink-muted">Loading…</div> : (
        <div className={industrialTableClassName()}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--bg-elevated)]">
              <tr className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-muted">
                <th className="px-3 py-2.5">Job #</th>
                <th className="px-3 py-2.5">Product / Carton</th>
                <th className="px-3 py-2.5">Client</th>
                <th className="px-3 py-2.5 text-right">Ordered</th>
                <th className="px-3 py-2.5 text-right">Produced</th>
                <th className="px-3 py-2.5 text-right">Dispatched</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">Vehicle #</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">Driver</th>
                <th className="hidden px-3 py-2.5 xl:table-cell">E-Way Bill</th>
                <th className="px-3 py-2.5">Due Date</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.map((r) => {
                const st = r.existingDispatch?.status ?? 'ready'
                const overdue = isOverdue(r.dueDate) && st !== 'pod_received'
                const pushed = st === 'dispatched' || st === 'pod_received'
                return (
                  <tr
                    key={r.jobCardId}
                    className={`transition-colors hover:bg-[var(--bg-muted)] ${pushed ? 'bg-emerald-500/10' : ''}`}
                  >
                    <td className="px-3 py-2.5"><span className="font-mono text-xs font-medium text-[var(--brand-primary)]">{r.jobNumber}</span></td>
                    <td className="max-w-[180px] px-3 py-2.5"><span className="block truncate text-xs font-medium text-ds-ink">{r.productName}</span></td>
                    <td className="px-3 py-2.5 text-xs text-ds-ink">{r.customerName}</td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink-muted">{r.qtyOrdered.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      <span className={r.qtyProducedGood >= r.qtyOrdered ? 'font-medium text-[var(--success)]' : 'font-medium text-[var(--warning)]'}>
                        {r.qtyProducedGood.toLocaleString('en-IN')}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      {r.existingDispatch ? <span className="font-semibold text-ds-ink">{r.existingDispatch.qtyDispatched.toLocaleString('en-IN')}</span> : <span className="text-ds-ink-faint">—</span>}
                    </td>
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-ds-ink-muted lg:table-cell">{r.existingDispatch?.vehicleNumber ?? '—'}</td>
                    <td className="hidden px-3 py-2.5 text-xs text-ds-ink-muted lg:table-cell">{r.existingDispatch?.driverName ?? '—'}</td>
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-ds-ink-muted xl:table-cell">{r.existingDispatch?.ewayBillNumber ?? '—'}</td>
                    <td className="px-3 py-2.5 text-xs">
                      <span className={overdue ? 'font-medium text-[var(--error)]' : 'text-ds-ink-muted'}>{fmtDate(r.dueDate)}</span>
                      {overdue && <Badge tone="danger" className="ml-1 px-1 py-0 text-[9px]">LATE</Badge>}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={STATUS_LABELS[st] ?? st} />
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
                <tr><td colSpan={12} className="px-3 py-12 text-center text-sm text-ds-ink-faint">{q ? `No jobs matching "${q}"` : 'No jobs ready for dispatch.'}</td></tr>
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
            {/* Job summary */}
            <div className="space-y-3 rounded-ds-md border border-[var(--brand-primary)]/25 bg-[var(--brand-bg-soft)] px-4 py-3.5">
              <SectionLabel accent>Job Details</SectionLabel>
              <InfoGrid rows={[
                ['Qty Ordered', <span key="qo" className="tabular-nums">{row.qtyOrdered.toLocaleString('en-IN')}</span>],
                ['Qty Produced', <span key="qp" className={`font-semibold tabular-nums ${row.qtyProducedGood >= row.qtyOrdered ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>{row.qtyProducedGood.toLocaleString('en-IN')}</span>],
                ['Due Date', <span key="dd" className={isOverdue(row.dueDate) && dispSt !== 'pod_received' ? 'font-medium text-[var(--error)]' : ''}>{fmtDate(row.dueDate)}</span>],
                ['Status', <StatusBadge key="st" status={STATUS_LABELS[dispSt] ?? dispSt} />],
              ]} />
            </div>

            {/* Existing dispatch record */}
            {row.existingDispatch && (
              <CardSection title="Dispatch Record">
                <InfoGrid rows={[
                  ['Qty Dispatched', <span key="qd" className="font-semibold tabular-nums text-ds-ink">{row.existingDispatch.qtyDispatched.toLocaleString('en-IN')}</span>],
                  ['Vehicle #', <span key="vn" className="font-mono">{row.existingDispatch.vehicleNumber ?? '—'}</span>],
                  ['Driver', row.existingDispatch.driverName ?? '—'],
                  ['E-Way Bill', <span key="eb" className="font-mono">{row.existingDispatch.ewayBillNumber ?? '—'}</span>],
                  ['Dispatched At', fmtDateTime(row.existingDispatch.dispatchedAt)],
                  ...(row.existingDispatch.podReceivedAt ? [['POD Received', <span key="pod" className="font-medium text-[var(--success)]">{fmtDateTime(row.existingDispatch.podReceivedAt)}</span>] as [string, React.ReactNode]] : []),
                ]} />
              </CardSection>
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
                      onChange={(e) => setQtyDispatched(Number(e.target.value))}
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
