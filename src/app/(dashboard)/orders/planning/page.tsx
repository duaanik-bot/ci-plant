'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { isEmbossingRequired } from '@/lib/emboss-conditions'
import { mergeOrchestrationIntoSpec, PLANNING_FLOW } from '@/lib/orchestration-spec'

type PlanningSpec = {
  machineId?: string
  shift?: string
  plannedDate?: string
  artworkLocksCompleted?: number
  platesStatus?: 'available' | 'partial' | 'new_required'
  dieStatus?: 'good' | 'attention' | 'not_available'
  embossStatus?: 'ready' | 'vendor_ordered' | 'na'
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
  jobCard?: {
    id: string
    jobCardNumber: number
    status: string
  } | null
  readiness?: {
    artworkLocksCompleted: number
    platesStatus: string
    dieStatus: string
    machineAllocated: boolean
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

function artworkBadge(locks: number) {
  if (locks >= 2) return { label: '✅ 2/2', cls: 'bg-green-900/40 text-green-300 border border-green-700' }
  return { label: `⏳ ${locks}/2`, cls: 'bg-amber-900/40 text-amber-300 border border-amber-700' }
}

function platesBadge(status: string) {
  if (status === 'available') return { label: '✅ Available', cls: 'text-green-300' }
  if (status === 'partial') return { label: '⚠ Partial', cls: 'text-amber-300' }
  return { label: '❌ New required', cls: 'text-red-300' }
}

function dieBadge(status: string) {
  if (status === 'good') return { label: '✅ Good', cls: 'text-green-300' }
  if (status === 'attention') return { label: '⚠ Attention', cls: 'text-amber-300' }
  return { label: '❌ Not available', cls: 'text-red-300' }
}

export default function PlanningPage() {
  const [rows, setRows] = useState<Line[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)
  const [planningStatus, setPlanningStatus] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [queueTab, setQueueTab] = useState<'all' | 'ready' | 'awaiting_tools' | 'awaiting_artwork'>('all')

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'planning-customer',
    search: async (query: string) => {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(query)}`)
      return (await res.json()) as Customer[]
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
      const rawSpec = {
        ...(li.specOverrides && typeof li.specOverrides === 'object' ? li.specOverrides : {}),
      } as Record<string, unknown>
      let specOverrides: Record<string, unknown> = rawSpec
      if (String(rawSpec.machineId || '').trim()) {
        specOverrides = mergeOrchestrationIntoSpec(rawSpec, {
          planningFlowStatus: PLANNING_FLOW.in_progress,
        })
      }
      const body: Record<string, unknown> = {
        setNumber: li.setNumber,
        planningStatus: li.planningStatus,
        specOverrides,
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

  const canMakeProcessing = (r: Line) => {
    const spec = r.specOverrides || {}
    const artworkLocks = Number(spec.artworkLocksCompleted ?? r.readiness?.artworkLocksCompleted ?? 0)
    if (artworkLocks < 2) return { ok: false, reason: `Pre-press approvals pending (${artworkLocks}/2)` }

    const plateStatus = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')
    if (plateStatus === 'new_required') return { ok: false, reason: 'Plates not verified' }

    const currentDieStatus = String(spec.dieStatus ?? r.readiness?.dieStatus ?? (r.dyeId ? 'good' : 'not_available'))
    if (currentDieStatus === 'not_available') return { ok: false, reason: 'Die needs inspection' }

    const embossRequired = isEmbossingRequired(r.embossingLeafing)
    const embossStatus = embossRequired ? String(spec.embossStatus ?? 'vendor_ordered') : 'na'
    if (embossRequired && embossStatus !== 'ready') return { ok: false, reason: 'Emboss block pending' }

    if (!spec.machineId) return { ok: false, reason: 'Machine not allocated' }

    return { ok: true, reason: '' }
  }

  const totalQty = useMemo(
    () => rows.reduce((sum, r) => sum + (r.quantity || 0), 0),
    [rows],
  )

  const tabFilteredRows = useMemo(() => {
    return rows.filter((r) => {
      const spec = r.specOverrides || {}
      const artworkLocks = Number(spec.artworkLocksCompleted ?? r.readiness?.artworkLocksCompleted ?? 0)
      const plateStatus = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')
      const currentDieStatus = String(spec.dieStatus ?? r.readiness?.dieStatus ?? (r.dyeId ? 'good' : 'not_available'))
      const embossRequired = isEmbossingRequired(r.embossingLeafing)
      const embossStatus = embossRequired ? String(spec.embossStatus ?? 'vendor_ordered') : 'na'
      const isReady = artworkLocks >= 2 && plateStatus === 'available' && currentDieStatus === 'good' && (embossStatus === 'ready' || embossStatus === 'na')
      const awaitingTools = artworkLocks >= 2 && !isReady
      const awaitingArtwork = artworkLocks < 2
      if (queueTab === 'ready') return isReady
      if (queueTab === 'awaiting_tools') return awaitingTools
      if (queueTab === 'awaiting_artwork') return awaitingArtwork
      return true
    })
  }, [rows, queueTab])

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
            Artwork Queue
          </Link>
          <Link
            href="/production/job-cards"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Job Cards
          </Link>
          <Link
            href="/production/stages"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Production Planning →
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setQueueTab('all')} className={`px-3 py-1.5 rounded border text-xs ${queueTab === 'all' ? 'bg-amber-600 border-amber-500 text-white' : 'border-slate-700 text-slate-300'}`}>All</button>
        <button onClick={() => setQueueTab('ready')} className={`px-3 py-1.5 rounded border text-xs ${queueTab === 'ready' ? 'bg-amber-600 border-amber-500 text-white' : 'border-slate-700 text-slate-300'}`}>Ready to Process</button>
        <button onClick={() => setQueueTab('awaiting_tools')} className={`px-3 py-1.5 rounded border text-xs ${queueTab === 'awaiting_tools' ? 'bg-amber-600 border-amber-500 text-white' : 'border-slate-700 text-slate-300'}`}>Awaiting Tools</button>
        <button onClick={() => setQueueTab('awaiting_artwork')} className={`px-3 py-1.5 rounded border text-xs ${queueTab === 'awaiting_artwork' ? 'bg-amber-600 border-amber-500 text-white' : 'border-slate-700 text-slate-300'}`}>Awaiting Artwork</button>
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
        <div className="min-w-[260px]">
          <MasterSearchSelect
            label="Customer"
            query={customerSearch.query}
            onQueryChange={(value) => {
              customerSearch.setQuery(value)
              setCustomerId('')
            }}
            loading={customerSearch.loading}
            options={customerSearch.options}
            lastUsed={customerSearch.lastUsed}
            onSelect={applyCustomer}
            getOptionLabel={(c) => c.name}
            getOptionMeta={(c) => c.contactName ?? ''}
            placeholder="Type 1-2 letters to filter customers..."
            recentLabel="Recent customers"
            loadingMessage="Searching customers..."
            emptyMessage="No customer found."
          />
          {customerId ? (
            <button
              type="button"
              onClick={() => applyCustomer(null)}
              className="mt-1 text-xs text-slate-400 hover:text-white"
            >
              Clear customer filter
            </button>
          ) : null}
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
              <th className="px-3 py-2">AW Status</th>
              <th className="px-3 py-2">Plates</th>
              <th className="px-3 py-2">Die</th>
              <th className="px-3 py-2">Emboss</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {tabFilteredRows.map((r) => {
              const spec = r.specOverrides || {}
              const gate = canMakeProcessing(r)
              const artworkLocks = Number(spec.artworkLocksCompleted ?? r.readiness?.artworkLocksCompleted ?? 0)
              const plateStatus = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')
              const currentDieStatus = String(spec.dieStatus ?? r.readiness?.dieStatus ?? (r.dyeId ? 'good' : 'not_available'))
              const embossRequired = isEmbossingRequired(r.embossingLeafing)
              const embossStatus = embossRequired ? String(spec.embossStatus ?? 'vendor_ordered') : 'na'
              const art = artworkBadge(artworkLocks)
              const plate = platesBadge(plateStatus)
              const die = dieBadge(currentDieStatus)
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
                  <td className="px-3 py-2 align-top">
                    <span className={`px-2 py-1 rounded text-[11px] ${art.cls}`}>
                      {artworkLocks >= 2 ? '✅ 2/2' : `⏳ ${artworkLocks}/2`}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={plateStatus}
                      onChange={(e) =>
                        updateSpec(r.id, {
                          platesStatus: e.target.value as PlanningSpec['platesStatus'],
                        })
                      }
                      className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-white text-xs"
                    >
                      <option value="available">✅ Available</option>
                      <option value="partial">⚠ Partial</option>
                      <option value="new_required">❌ New required</option>
                    </select>
                    <p className={`text-[11px] mt-0.5 ${plate.cls}`}>{plate.label}</p>
                    {(() => {
                      const orch = (
                        spec as {
                          orchestration?: { plateFlowStatus?: string }
                        }
                      ).orchestration
                      const pf = orch?.plateFlowStatus
                      if (pf === 'ready_inventory')
                        return (
                          <p className="text-[11px] mt-1 font-medium text-emerald-400">
                            Tooling: Ready
                          </p>
                        )
                      if (pf === 'ctp_queue')
                        return (
                          <p className="text-[11px] mt-1 text-amber-300">Tooling: CTP queue</p>
                        )
                      if (pf === 'triage')
                        return (
                          <p className="text-[11px] mt-1 text-slate-400">Tooling: Plate triage</p>
                        )
                      if (pf === 'vendor_queue')
                        return (
                          <p className="text-[11px] mt-1 text-violet-300">Tooling: Outside vendor</p>
                        )
                      return null
                    })()}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={currentDieStatus}
                      onChange={(e) =>
                        updateSpec(r.id, {
                          dieStatus: e.target.value as PlanningSpec['dieStatus'],
                        })
                      }
                      className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-white text-xs"
                    >
                      <option value="good">✅ Good</option>
                      <option value="attention">⚠ Attention</option>
                      <option value="not_available">❌ Not available</option>
                    </select>
                    <p className={`text-[11px] mt-0.5 ${die.cls}`}>{die.label}</p>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={embossStatus}
                      disabled={!embossRequired}
                      onChange={(e) =>
                        updateSpec(r.id, {
                          embossStatus: e.target.value as PlanningSpec['embossStatus'],
                        })
                      }
                      className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-white text-xs disabled:opacity-70"
                    >
                      <option value="na">⊘ N/A</option>
                      <option value="ready">✅ Ready</option>
                      <option value="vendor_ordered">🔴 Vendor Ordered</option>
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
                      <button
                        type="button"
                        title={gate.ok ? 'Ready to make processing' : gate.reason}
                        onClick={() => {
                          if (!gate.ok) {
                            toast.error(gate.reason)
                            return
                          }
                          window.location.href = `/production/job-cards/new?lineId=${r.id}&poId=${r.po.id}`
                        }}
                        className="px-3 py-1 rounded-lg border border-slate-700 text-slate-200 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={!gate.ok || queueTab !== 'ready'}
                      >
                        Make Processing
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px] text-slate-400 mt-1">
                      <Link
                        href={`/orders/purchase-orders/${r.po.id}`}
                        className="hover:text-amber-300"
                      >
                        PO
                      </Link>
                      {r.jobCard?.id ? (
                        <Link
                          href={`/production/job-cards/${r.jobCard.id}`}
                          className="hover:text-amber-300"
                        >
                          Open Job Card →
                        </Link>
                      ) : (
                        <span className="text-slate-500">No job card yet</span>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {tabFilteredRows.length === 0 && (
              <tr>
                <td
                  colSpan={14}
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
