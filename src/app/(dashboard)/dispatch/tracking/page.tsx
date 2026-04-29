'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

type TrackingRow = {
  id: string
  status: string
  qtyDispatched: number
  vehicleNumber: string | null
  driverName: string | null
  ewayBillNumber: string | null
  dispatchedAt: string | null
  podReceivedAt: string | null
  jobId: string
  jobNumber: string
  customerId: string
  customerName: string
}

type Customer = { id: string; name: string }

function toCsv(rows: Record<string, string | number | null | undefined>[]) {
  const headers = Array.from(
    rows.reduce((s, r) => {
      Object.keys(r).forEach((k) => s.add(k))
      return s
    }, new Set<string>())
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

export default function DispatchTrackingPage() {
  const qc = useQueryClient()

  const [customerId, setCustomerId] = useState('')
  const [status, setStatus] = useState('')

  const [podOpen, setPodOpen] = useState(false)
  const [podRow, setPodRow] = useState<TrackingRow | null>(null)
  const [createDraftBill, setCreateDraftBill] = useState(true)
  const [receivedBy, setReceivedBy] = useState('')
  const [receivedAt, setReceivedAt] = useState('')
  const [remarks, setRemarks] = useState('')

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ['dispatch-tracking-customers'],
    queryFn: () => fetch('/api/masters/customers').then((r) => r.json()),
  })

  const {
    data: list = [],
    isLoading,
    isFetching,
  } = useQuery<TrackingRow[]>({
    queryKey: ['dispatch-tracking'],
    queryFn: () => fetch('/api/dispatch/tracking').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const filtered = useMemo(() => {
    return list
      .filter((r) => (customerId ? r.customerId === customerId : true))
      .filter((r) => (status ? r.status === status : true))
      .sort((a, b) => {
        const at = a.dispatchedAt ? new Date(a.dispatchedAt).getTime() : 0
        const bt = b.dispatchedAt ? new Date(b.dispatchedAt).getTime() : 0
        return bt - at
      })
  }, [list, customerId, status])

  const openPod = (row: TrackingRow) => {
    setPodRow(row)
    setReceivedBy('')
    setReceivedAt('')
    setRemarks('')
    setPodOpen(true)
  }

  const submitPod = async () => {
    if (!podRow) return
    try {
      const res = await fetch(`/api/dispatch/${podRow.id}/pod`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receivedAt: receivedAt ? new Date(receivedAt).toISOString() : undefined,
          createDraftBill: createDraftBill ?? true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to confirm POD')
        return
      }
      if (data.draftBillId) {
        toast.success(`POD received. Draft bill ${data.draftBillNumber} created.`, {
          action: {
            label: 'View bill',
            onClick: () => window.open(`/billing/${data.draftBillId}`, '_blank'),
          },
        })
      } else {
        toast.success('Marked delivered (POD received)')
      }
      setPodOpen(false)
      setPodRow(null)
      await qc.invalidateQueries({ queryKey: ['dispatch-tracking'] })
    } catch {
      toast.error('Failed to confirm POD')
    }
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-ds-warning">Delivery Tracking</h1>
          <p className="text-xs text-ds-ink-faint mt-0.5">
            Dispatch timeline (auto-refresh 30s){isFetching ? ' • refreshing…' : ''}
          </p>
        </div>
        <button
          onClick={() => {
            const csv = toCsv(
              filtered.map((r) => ({
                jobNumber: r.jobNumber,
                customerName: r.customerName,
                status: r.status,
                vehicleNumber: r.vehicleNumber,
                driverName: r.driverName,
                dispatchedAt: r.dispatchedAt,
                podReceivedAt: r.podReceivedAt,
              }))
            )
            downloadText(`dispatch-tracking-${new Date().toISOString().slice(0, 10)}.csv`, csv)
          }}
          className="px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/50 hover:border-ds-warning/60 text-sm"
        >
          Export CSV
        </button>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground min-w-[220px]"
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
          <option value="pending_qa">Pending QA</option>
          <option value="qa_released">QA Released</option>
          <option value="dispatched">In Transit</option>
          <option value="pod_received">Delivered</option>
        </select>
      </div>

      {isLoading ? (
        <div className="p-4 text-ds-ink-muted">Loading…</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <div key={r.id} className="rounded-xl border border-ds-line/50 bg-ds-card p-4">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-sm font-semibold text-ds-ink">
                    <span className="font-mono text-ds-warning">{r.jobNumber}</span> · {r.customerName}
                  </p>
                  <p className="text-xs text-ds-ink-faint mt-0.5">
                    Vehicle: {r.vehicleNumber ?? '—'} · Driver: {r.driverName ?? '—'} · E-way: {r.ewayBillNumber ?? '—'}
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded text-xs border bg-ds-elevated text-ds-ink border-ds-line/60">
                  {r.status}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                <div className="rounded-lg border border-ds-line/50 bg-ds-elevated/40 p-2">
                  <p className="text-ds-ink-muted">● Dispatched</p>
                  <p className="text-ds-ink mt-0.5">
                    {r.dispatchedAt ? new Date(r.dispatchedAt).toLocaleString() : '—'}
                  </p>
                </div>
                <div className="rounded-lg border border-ds-line/50 bg-ds-elevated/40 p-2">
                  <p className="text-ds-ink-muted">● In Transit</p>
                  <p className="text-ds-ink mt-0.5">{r.status === 'dispatched' ? 'Active' : '—'}</p>
                </div>
                <div className="rounded-lg border border-ds-line/50 bg-ds-elevated/40 p-2">
                  <p className="text-ds-ink-muted">● Delivered / POD</p>
                  <p className="text-ds-ink mt-0.5">
                    {r.podReceivedAt ? new Date(r.podReceivedAt).toLocaleString() : '—'}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex justify-end">
                <button
                  disabled={r.status === 'pod_received'}
                  onClick={() => openPod(r)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium border ${
                    r.status === 'pod_received'
                      ? 'bg-ds-elevated text-ds-ink-faint border-ds-line/50 cursor-not-allowed'
                      : 'bg-ds-warning hover:bg-ds-warning text-primary-foreground border-ds-warning/40'
                  }`}
                >
                  Mark Delivered
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="text-ds-ink-faint text-center py-8 text-sm">No dispatched jobs found.</p>
          )}
        </div>
      )}

      {podOpen && podRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            className="absolute inset-0 bg-background/50"
            onClick={() => setPodOpen(false)}
            aria-label="Close"
            type="button"
          />
          <div className="relative w-full max-w-xl rounded-xl border border-ds-line/50 bg-ds-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Confirm POD</h2>
                <p className="text-xs text-ds-ink-muted mt-0.5">
                  {podRow.jobNumber} · {podRow.customerName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPodOpen(false)}
                className="text-ds-ink-muted hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <label className="mt-4 flex items-center gap-2 text-sm text-ds-ink-muted cursor-pointer">
              <input
                type="checkbox"
                checked={createDraftBill}
                onChange={(e) => setCreateDraftBill(e.target.checked)}
                className="rounded border-ds-line/60 bg-ds-elevated text-ds-warning"
              />
              Create draft bill from this dispatch
            </label>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div>
                <label className="block text-xs text-ds-ink-muted mb-1">Received By</label>
                <input
                  value={receivedBy}
                  onChange={(e) => setReceivedBy(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div>
                <label className="block text-xs text-ds-ink-muted mb-1">Delivery Date/Time</label>
                <input
                  type="datetime-local"
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-ds-ink-muted mb-1">Remarks</label>
                <textarea
                  rows={3}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={submitPod}
                className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm font-medium"
              >
                Confirm POD
              </button>
            </div>
            <p className="text-xs text-ds-ink-faint mt-2">
              If &quot;Create draft bill&quot; is checked, a draft bill (customer + one line from job) will be created when you confirm POD.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

