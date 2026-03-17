'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

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

export default function DispatchPlanningPage() {
  const qc = useQueryClient()

  const [customerId, setCustomerId] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [planOpen, setPlanOpen] = useState(false)
  const [planJob, setPlanJob] = useState<DispatchReadyRow | null>(null)
  const [qtyDispatched, setQtyDispatched] = useState<number>(0)
  const [transportMode, setTransportMode] = useState<'Road' | 'Air' | 'Sea'>('Road')
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [driverName, setDriverName] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [departureAt, setDepartureAt] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')

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
  }, [list, customerId, status, from, to])

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
      const header = customer.name
      const addrLines = [customer.address, customer.contactName, customer.contactPhone]
        .filter(Boolean)
        .join('\n')
      setDeliveryAddress(`${header}\n${addrLines}`)
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
    }
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-amber-400">Dispatch Planning</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Ready for dispatch jobs (auto-refresh 30s){isFetching ? ' • refreshing…' : ''}
          </p>
        </div>
        <button
          onClick={() => {
            const csv = toCsv(
              filtered.map((r) => ({
                jobNumber: r.jobNumber,
                customerName: r.customerName,
                status: r.existingDispatch?.status ?? 'ready',
                dueDate: new Date(r.dueDate).toISOString().slice(0, 10),
              }))
            )
            downloadText(`dispatch-ready-${new Date().toISOString().slice(0, 10)}.csv`, csv)
          }}
          className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 hover:border-amber-500/60 text-sm"
        >
          Export CSV
        </button>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white min-w-[220px]"
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
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        >
          <option value="">All statuses</option>
          <option value="ready">Ready</option>
          <option value="pending_qa">Pending QA</option>
          <option value="qa_released">QA Released</option>
          <option value="dispatched">In Transit</option>
          <option value="pod_received">Delivered</option>
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        />
      </div>

      {isLoading ? (
        <div className="p-4 text-slate-400">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-4 py-2">Job #</th>
                <th className="px-4 py-2">Client</th>
                <th className="px-4 py-2">Required By</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Vehicle</th>
                <th className="px-4 py-2">Driver</th>
                <th className="px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filtered.map((r) => {
                const st = r.existingDispatch?.status ?? 'ready'
                return (
                  <tr key={r.jobId} className="hover:bg-slate-800/60">
                    <td className="px-4 py-2 font-mono text-amber-300">{r.jobNumber}</td>
                    <td className="px-4 py-2 text-slate-200">{r.customerName}</td>
                    <td className="px-4 py-2 text-slate-300">
                      {new Date(r.dueDate).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <span className="px-2 py-0.5 rounded text-xs border bg-slate-800 text-slate-200 border-slate-600">
                        {st}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-300">
                      {r.existingDispatch?.vehicleNumber ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-slate-300">
                      {r.existingDispatch?.driverName ?? '—'}
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => openPlan(r)}
                        className="text-amber-400 hover:underline"
                      >
                        Plan Dispatch
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">No jobs ready for dispatch.</p>
      )}

      {planOpen && planJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            className="absolute inset-0 bg-black/50"
            onClick={() => setPlanOpen(false)}
            aria-label="Close"
            type="button"
          />
          <div className="relative w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Plan Dispatch</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {planJob.jobNumber} · {planJob.customerName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPlanOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Transport Mode</label>
                <select
                  value={transportMode}
                  onChange={(e) => setTransportMode(e.target.value as 'Road' | 'Air' | 'Sea')}
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                >
                  <option value="Road">Road</option>
                  <option value="Air">Air</option>
                  <option value="Sea">Sea</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Qty Dispatched *</label>
                <input
                  type="number"
                  min={1}
                  value={qtyDispatched || ''}
                  onChange={(e) => setQtyDispatched(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Vehicle Number</label>
                <input
                  value={vehicleNumber}
                  onChange={(e) => setVehicleNumber(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Driver Name</label>
                <input
                  value={driverName}
                  onChange={(e) => setDriverName(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Driver Phone</label>
                <input
                  value={driverPhone}
                  onChange={(e) => setDriverPhone(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Departure Date/Time</label>
                <input
                  type="datetime-local"
                  value={departureAt}
                  onChange={(e) => setDepartureAt(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-slate-400 mb-1">Delivery Address</label>
                <textarea
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-slate-500">
                Documents: Invoice · Packing List · CoA · E-Way Bill (wired in later steps)
              </p>
              <button
                type="button"
                onClick={submitPlan}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
              >
                Confirm Dispatch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

