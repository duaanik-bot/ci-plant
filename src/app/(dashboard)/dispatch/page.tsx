'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Search, X } from 'lucide-react'
import {
  IndustrialModuleShell,
  industrialTableClassName,
} from '@/components/industrial/IndustrialModuleShell'

type DispatchReadyRow = {
  jobId: string
  jobNumber: string
  customerId: string
  customerName: string
  status: string
  dueDate: string
  existingDispatch: {
    id: string
    status: string
    qtyDispatched: number
    vehicleNumber: string | null
    driverName: string | null
    dispatchedAt: string | null
    podReceivedAt: string | null
  } | null
}

type Customer = {
  id: string
  name: string
  gstNumber?: string | null
  contactName?: string | null
  contactPhone?: string | null
  email?: string | null
  address?: string | null
}

const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  pending_qa: 'Pending QA',
  qa_released: 'QA Released',
  dispatched: 'In Transit',
  pod_received: 'Delivered',
}

const STATUS_PILL: Record<string, string> = {
  ready:
    'bg-amber-500/10 text-amber-400 border-amber-500/30',
  pending_qa:
    'bg-slate-500/10 text-slate-400 border-slate-500/30',
  qa_released:
    'bg-sky-500/10 text-sky-400 border-sky-500/30',
  dispatched:
    'bg-blue-500/10 text-blue-400 border-blue-500/30',
  pod_received:
    'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
}

function toCsv(rows: Record<string, string | number | null | undefined>[]) {
  const headers = Array.from(
    rows.reduce((s, r) => {
      Object.keys(r).forEach((k) => s.add(k))
      return s
    }, new Set<string>()),
  )
  const esc = (v: unknown) => {
    const str = v == null ? '' : String(v)
    const needs = /[",\n]/.test(str)
    const out = str.replace(/"/g, '""')
    return needs ? `"${out}"` : out
  }
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n')
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function DispatchPlanningPage() {
  const qc = useQueryClient()

  const [customerId, setCustomerId] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [localSearch, setLocalSearch] = useState('')

  const [planOpen, setPlanOpen] = useState(false)
  const [planJob, setPlanJob] = useState<DispatchReadyRow | null>(null)
  const [qtyDispatched, setQtyDispatched] = useState<number>(0)
  const [transportMode, setTransportMode] = useState<'Road' | 'Air' | 'Sea'>('Road')
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [driverName, setDriverName] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [departureAt, setDepartureAt] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ['dispatch-customers'],
    queryFn: () => fetch('/api/customers').then((r) => r.json()),
  })

  const {
    data: list = [],
    isLoading,
    isFetching,
  } = useQuery<DispatchReadyRow[]>({
    queryKey: ['dispatch-ready'],
    queryFn: () => fetch('/api/dispatch').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const filtered = useMemo(() => {
    const fFrom = from ? new Date(from) : null
    const fTo = to ? new Date(to) : null
    if (fTo) fTo.setHours(23, 59, 59, 999)
    return list
      .filter((r) => (customerId ? r.customerId === customerId : true))
      .filter((r) => {
        const st = r.existingDispatch?.status ?? 'ready'
        return status ? st === status : true
      })
      .filter((r) => {
        const d = new Date(r.dueDate)
        if (fFrom && d < fFrom) return false
        if (fTo && d > fTo) return false
        return true
      })
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
      .filter((r) => {
        const q = localSearch.trim().toLowerCase()
        if (!q) return true
        return r.jobNumber.toLowerCase().includes(q) || r.customerName.toLowerCase().includes(q)
      })
  }, [list, customerId, status, from, to, localSearch])

  const kpiReady = list.filter((r) => (r.existingDispatch?.status ?? 'ready') === 'ready').length
  const kpiInTransit = list.filter((r) => r.existingDispatch?.status === 'dispatched').length
  const kpiDelivered = list.filter((r) => r.existingDispatch?.status === 'pod_received').length

  const openPlan = (job: DispatchReadyRow) => {
    setPlanJob(job)
    setQtyDispatched(0)
    setTransportMode('Road')
    setVehicleNumber('')
    setDriverName('')
    setDriverPhone('')
    setDepartureAt('')
    const customer = customers.find((c) => c.id === job.customerId)
    if (customer?.address) {
      const addrLines = [customer.address, customer.contactName, customer.contactPhone]
        .filter(Boolean)
        .join('\n')
      setDeliveryAddress(`${customer.name}\n${addrLines}`)
    } else {
      setDeliveryAddress('')
    }
    setPlanOpen(true)
  }

  const submitPlan = async () => {
    if (!planJob) return
    if (!qtyDispatched || qtyDispatched <= 0) {
      toast.error('Enter qty to dispatch')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: planJob.jobId,
          qtyDispatched,
          vehicleNumber: vehicleNumber || undefined,
          driverName: driverName || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to plan dispatch')
        return
      }
      toast.success('Dispatch created')
      setPlanOpen(false)
      setPlanJob(null)
      await qc.invalidateQueries({ queryKey: ['dispatch-ready'] })
    } catch {
      toast.error('Failed to plan dispatch')
    } finally {
      setSubmitting(false)
    }
  }

  const kpiTiles = (
    <>
      <KpiTile label="Ready" value={kpiReady} color="amber" />
      <KpiTile label="In Transit" value={kpiInTransit} color="blue" />
      <KpiTile label="Delivered" value={kpiDelivered} color="emerald" />
    </>
  )

  return (
    <IndustrialModuleShell
      title="Dispatch Planning"
      subtitle={`Ready-for-dispatch jobs · auto-refresh 30s${isFetching ? ' · refreshing…' : ''}`}
      kpiRow={kpiTiles}
      headerAction={
        <button
          onClick={() => {
            const csv = toCsv(
              filtered.map((r) => ({
                jobNumber: r.jobNumber,
                customerName: r.customerName,
                status: r.existingDispatch?.status ?? 'ready',
                dueDate: new Date(r.dueDate).toISOString().slice(0, 10),
              })),
            )
            downloadText(`dispatch-ready-${new Date().toISOString().slice(0, 10)}.csv`, csv)
          }}
          className="px-3 py-1.5 rounded-lg bg-ds-elevated border border-ds-line/50 hover:border-ds-warning/60 text-sm text-ds-ink-muted"
        >
          Export CSV
        </button>
      }
    >
      {/* Search */}
      <div className="flex items-stretch gap-2">
        <div className={`group flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-ds-card/50 px-3 py-1.5 text-sm transition-all ${localSearch.trim().length >= 1 ? 'border-ds-warning/50 ring-1 ring-ds-warning/30' : 'border-ds-warning/30 ring-1 ring-ds-warning/20'}`}>
          <Search className="h-4 w-4 text-ds-warning shrink-0" aria-hidden />
          <input
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Job # or customer…"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-0.5 text-ds-ink placeholder:text-ds-ink-faint focus:outline-none text-sm"
          />
        </div>
        {localSearch.trim().length > 0 ? (
          <button
            type="button"
            onClick={() => setLocalSearch('')}
            className="shrink-0 self-center rounded-md border border-ds-line/50 bg-ds-card/60 px-2.5 py-2 text-ds-ink-faint hover:border-ds-warning/40 hover:text-ds-warning transition-colors"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground min-w-[200px]"
        >
          <option value="">All clients</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
        />
        <span className="self-center text-ds-ink-faint text-xs">to</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
        />
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-ds-ink-muted text-sm">Loading…</div>
      ) : (
        <div className={industrialTableClassName()}>
          <table className="w-full text-sm text-left">
            <thead className="bg-ds-elevated text-ds-ink-muted border-b border-ds-line/40">
              <tr>
                <th className="px-3 py-2 font-medium">Job #</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Required By</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell">Vehicle</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell">Driver</th>
                <th className="px-3 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ds-line/30">
              {filtered.map((r) => {
                const st = r.existingDispatch?.status ?? 'ready'
                return (
                  <tr key={r.jobId} className="hover:bg-ds-elevated/40 transition-colors">
                    <td className="px-3 py-2 font-mono text-ds-warning text-xs">{r.jobNumber}</td>
                    <td className="px-3 py-2 text-ds-ink">{r.customerName}</td>
                    <td className="px-3 py-2 text-ds-ink-muted text-xs">
                      {new Date(r.dueDate).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium ${STATUS_PILL[st] ?? 'bg-ds-elevated text-ds-ink border-ds-line/60'}`}
                      >
                        {STATUS_LABELS[st] ?? st}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ds-ink-muted text-xs hidden md:table-cell">
                      {r.existingDispatch?.vehicleNumber ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-ds-ink-muted text-xs hidden md:table-cell">
                      {r.existingDispatch?.driverName ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => openPlan(r)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-ds-warning/40 text-ds-warning text-xs hover:bg-ds-warning/10 transition-colors"
                      >
                        Plan <span aria-hidden>→</span>
                      </button>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-ds-ink-faint text-sm">
                    No jobs ready for dispatch.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Plan modal */}
      {planOpen && planJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            className="absolute inset-0 bg-background/60 backdrop-blur-sm"
            onClick={() => setPlanOpen(false)}
            aria-label="Close"
            type="button"
          />
          <div className="relative w-full max-w-xl rounded-xl border border-ds-line/50 bg-card shadow-xl p-5">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Plan Dispatch</h2>
                <p className="text-xs text-ds-ink-muted mt-0.5">
                  {planJob.jobNumber} · {planJob.customerName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPlanOpen(false)}
                className="text-ds-ink-muted hover:text-foreground text-lg leading-none"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div>
                <label className="block text-xs text-ds-ink-muted mb-1">Transport Mode</label>
                <select
                  value={transportMode}
                  onChange={(e) => setTransportMode(e.target.value as 'Road' | 'Air' | 'Sea')}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                >
                  <option value="Road">Road</option>
                  <option value="Air">Air</option>
                  <option value="Sea">Sea</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-ds-ink-muted mb-1">Qty Dispatched *</label>
                <input
                  type="number"
                  min={1}
                  value={qtyDispatched || ''}
                  onChange={(e) => setQtyDispatched(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div>
                <label className="block text-xs text-ds-ink-muted mb-1">Vehicle Number</label>
                <input
                  value={vehicleNumber}
                  onChange={(e) => setVehicleNumber(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div>
                <label className="block text-xs text-ds-ink-muted mb-1">Driver Name</label>
                <input
                  value={driverName}
                  onChange={(e) => setDriverName(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div>
                <label className="block text-xs text-ds-ink-muted mb-1">Driver Phone</label>
                <input
                  value={driverPhone}
                  onChange={(e) => setDriverPhone(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div>
                <label className="block text-xs text-ds-ink-muted mb-1">Departure Date/Time</label>
                <input
                  type="datetime-local"
                  value={departureAt}
                  onChange={(e) => setDepartureAt(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-ds-ink-muted mb-1">Delivery Address</label>
                <textarea
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground resize-none"
                />
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-ds-line/30 flex items-center justify-between gap-3">
              <p className="text-xs text-ds-ink-faint">
                Documents: Invoice · Packing List · CoA · E-Way Bill
              </p>
              <button
                type="button"
                onClick={submitPlan}
                disabled={submitting}
                className="px-4 py-2 rounded-lg bg-ds-warning text-primary-foreground text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {submitting && (
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                )}
                {submitting ? 'Saving…' : 'Confirm Dispatch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </IndustrialModuleShell>
  )
}

function KpiTile({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: 'amber' | 'blue' | 'emerald'
}) {
  const ring =
    color === 'amber'
      ? 'border-amber-500/20 text-amber-400'
      : color === 'blue'
        ? 'border-blue-500/20 text-blue-400'
        : 'border-emerald-500/20 text-emerald-400'
  return (
    <div
      className={`rounded-lg border bg-ds-elevated/60 px-4 py-3 flex flex-col gap-0.5 ${ring}`}
    >
      <span className="text-2xl font-bold">{value}</span>
      <span className="text-xs text-ds-ink-muted">{label}</span>
    </div>
  )
}
