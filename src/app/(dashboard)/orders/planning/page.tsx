'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'

type PlanningSpec = {
  machineId?: string
  shift?: string
  plannedDate?: string
}

type Line = {
  id: string
  cartonName: string
  cartonSize: string | null
  quantity: number
  rate: number | null
  gsm: number | null
  coatingType: string | null
  embossingLeafing: string | null
  paperType: string | null
  dyeId: string | null
  remarks: string | null
  setNumber: string | null
  jobCardNumber: number | null
  planningStatus: string
  specOverrides: PlanningSpec | null
  po: {
    id: string
    poNumber: string
    status: string
    poDate: string
    customer: { id: string; name: string }
  }
}

type Customer = { id: string; name: string; contactName?: string | null }
type Machine = { id: string; machineCode: string; name: string; stdWastePct: number | null }

const PLANNING_STATUSES = [
  'pending',
  'planned',
  'design_ready',
  'job_card_created',
  'in_production',
  'closed',
] as const

const SHIFTS = ['A', 'B', 'C'] as const

export default function PlanningPage() {
  const [rows, setRows] = useState<Line[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)
  const [planningStatus, setPlanningStatus] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'planning-customer',
    search: async (query: string) => {
      const res = await fetch('/api/masters/customers')
      const data = (await res.json()) as Customer[]
      const q = query.toLowerCase()
      return data.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.contactName ?? '').toLowerCase().includes(q),
      )
    },
    getId: (c) => c.id,
    getLabel: (c) => c.name,
  })

  const applyCustomer = (c: Customer | null) => {
    if (c) {
      customerSearch.select(c)
      setCustomerId(c.id)
    } else {
      customerSearch.setQuery('')
      setCustomerId('')
    }
  }

  const fetchRows = async () => {
    const params = new URLSearchParams()
    if (planningStatus) params.set('planningStatus', planningStatus)
    if (customerId) params.set('customerId', customerId)
    const res = await fetch(`/api/planning/po-lines?${params}`)
    const json = await res.json()
    const list = Array.isArray(json) ? (json as Line[]) : []
    setRows(
      list.map((li) => ({
        ...li,
        // Ensure specOverrides is a simple object for planning use
        specOverrides:
          li.specOverrides && typeof li.specOverrides === 'object'
            ? (li.specOverrides as PlanningSpec)
            : null,
      })),
    )
  }

  useEffect(() => {
    async function load() {
      try {
        const machRes = await fetch('/api/machines')
        const machJson = await machRes.json()
        setMachines(Array.isArray(machJson) ? machJson : [])
        await fetchRows()
      } catch {
        toast.error('Failed to load planning queue')
      } finally {
        setLoading(false)
      }
    }
    setLoading(true)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planningStatus, customerId])

  const updateRow = (id: string, patch: Partial<Line>) => {
    setRows((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  const updateSpec = (id: string, patch: Partial<PlanningSpec>) => {
    setRows((prev) =>
      prev.map((l) =>
        l.id === id
          ? {
              ...l,
              specOverrides: { ...(l.specOverrides || {}), ...patch },
            }
          : l,
      ),
    )
  }

  const save = async (id: string) => {
    const li = rows.find((x) => x.id === id)
    if (!li) return
    setSavingId(id)
    try {
      const body: any = {
        setNumber: li.setNumber,
        planningStatus: li.planningStatus,
        specOverrides: li.specOverrides || undefined,
      }
      const res = await fetch(`/api/planning/po-lines/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Planning updated')
      await fetchRows()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingId(null)
    }
  }

  const totalQty = useMemo(
    () => rows.reduce((sum, r) => sum + (r.quantity || 0), 0),
    [rows],
  )

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-amber-400">Planning Queue</h1>
          <p className="text-xs text-slate-500">
            {rows.length} line(s) · Total qty{' '}
            <span className="text-amber-300 font-semibold">
              {totalQty.toLocaleString('en-IN')}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/orders/purchase-orders"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Customer POs
          </Link>
          <Link
            href="/orders/designing"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Designing
          </Link>
          <Link
            href="/production/job-cards"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Job Cards
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm items-end">
        <select
          value={planningStatus}
          onChange={(e) => setPlanningStatus(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        >
          <option value="">All planning statuses</option>
          {PLANNING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="relative min-w-[200px]">
          <label className="block text-xs text-slate-400 mb-0.5">Customer</label>
          <input
            type="text"
            value={customerSearch.query}
            onChange={(e) => {
              customerSearch.setQuery(e.target.value)
              setCustomerId('')
            }}
            placeholder="All customers or type to search…"
            className="w-full px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
          />
          {customerSearch.options.length > 0 && (
            <div className="absolute z-10 mt-0.5 w-full rounded border border-slate-700 bg-slate-900 max-h-40 overflow-y-auto">
              {customerSearch.options.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyCustomer(c)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 text-slate-100"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {customerSearch.lastUsed.length > 0 && !customerSearch.query && (
            <div className="mt-1 flex flex-wrap gap-1">
              {customerSearch.lastUsed.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyCustomer(c)}
                  className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-200 border border-slate-600 hover:border-amber-500"
                >
                  {c.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => applyCustomer(null)}
                className="px-2 py-0.5 rounded-full bg-slate-700 text-xs text-slate-400 hover:text-white"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-3 py-2">PO</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Carton</th>
              <th className="px-3 py-2">Qty</th>
              <th className="px-3 py-2">Set #</th>
              <th className="px-3 py-2">Machine</th>
              <th className="px-3 py-2">Shift</th>
              <th className="px-3 py-2">Planned date</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {rows.map((r) => {
              const spec = r.specOverrides || {}
              const machine = spec.machineId
                ? machines.find((m) => m.id === spec.machineId)
                : null
              return (
                <tr key={r.id} className="hover:bg-slate-800/60">
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-col">
                      <Link
                        href={`/orders/purchase-orders/${r.po.id}`}
                        className="font-mono text-amber-300 hover:underline text-xs"
                      >
                        {r.po.poNumber}
                      </Link>
                      <span className="text-[11px] text-slate-500">
                        {new Date(r.po.poDate).toLocaleDateString('en-IN')}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-slate-200">
                    {r.po.customer.name}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="text-slate-200">{r.cartonName}</div>
                    <div className="text-[11px] text-slate-500">
                      {r.cartonSize || '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-slate-200 tabular-nums">
                    {r.quantity.toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <input
                      type="text"
                      value={r.setNumber ?? ''}
                      onChange={(e) =>
                        updateRow(r.id, { setNumber: e.target.value || null })
                      }
                      className="w-20 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-white text-xs"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={spec.machineId ?? ''}
                      onChange={(e) =>
                        updateSpec(r.id, {
                          machineId: e.target.value || undefined,
                        })
                      }
                      className="min-w-[140px] px-2 py-1 rounded bg-slate-900 border border-slate-700 text-white text-xs"
                    >
                      <option value="">Unassigned</option>
                      {machines.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.machineCode} · {m.name}
                        </option>
                      ))}
                    </select>
                    {machine && (
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Std waste {machine.stdWastePct ?? 0}%
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={spec.shift ?? ''}
                      onChange={(e) =>
                        updateSpec(r.id, { shift: e.target.value || undefined })
                      }
                      className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-white text-xs"
                    >
                      <option value="">—</option>
                      {SHIFTS.map((s) => (
                        <option key={s} value={s}>
                          Shift {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <input
                      type="date"
                      value={spec.plannedDate ?? ''}
                      onChange={(e) =>
                        updateSpec(r.id, {
                          plannedDate: e.target.value || undefined,
                        })
                      }
                      className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-white text-xs"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={r.planningStatus}
                      onChange={(e) =>
                        updateRow(r.id, { planningStatus: e.target.value })
                      }
                      className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-white text-xs"
                    >
                      {PLANNING_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 align-top space-y-1">
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        onClick={() => save(r.id)}
                        disabled={savingId === r.id}
                        className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-[11px] font-medium"
                      >
                        {savingId === r.id ? 'Saving…' : 'Save'}
                      </button>
                      <Link
                        href={`/orders/designing/${r.id}`}
                        className="px-3 py-1 rounded-lg border border-slate-700 text-slate-200 text-[11px]"
                      >
                        Make Processing
                      </Link>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px] text-slate-400 mt-1">
                      <Link
                        href={`/orders/purchase-orders/${r.po.id}`}
                        className="hover:text-amber-300"
                      >
                        PO
                      </Link>
                      {r.jobCardNumber ? (
                        <Link
                          href="/production/job-cards"
                          className="hover:text-amber-300"
                        >
                          JC#{r.jobCardNumber}
                        </Link>
                      ) : (
                        <Link
                          href={`/production/job-cards/new?lineId=${r.id}&poId=${r.po.id}`}
                          className="hover:text-amber-300"
                        >
                          Create JC
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={10}
                  className="px-4 py-6 text-center text-slate-500 text-sm"
                >
                  No items in planning queue.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

