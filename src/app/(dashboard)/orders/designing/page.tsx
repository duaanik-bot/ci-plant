'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { parseDesignerCommand } from '@/lib/designer-command'

type SpecOverrides = {
  assignedDesignerId?: string
  customerApprovalPharma?: boolean
  shadeCardQaTextApproval?: boolean
  prePressSentToPlateHubAt?: string
  [k: string]: unknown
} | null

type Row = {
  id: string
  cartonName: string
  artworkCode?: string | null
  quantity: number
  paperType: string | null
  coatingType: string | null
  embossingLeafing: string | null
  setNumber: string | null
  planningStatus: string
  jobCardNumber: number | null
  specOverrides: SpecOverrides
  po: {
    id: string
    poNumber: string
    status: string
    poDate: string
    customer: { id: string; name: string }
  }
  jobCard: {
    id: string
    jobCardNumber: number
    artworkApproved: boolean
    firstArticlePass: boolean
    finalQcPass: boolean
    qaReleased: boolean
    status: string
  } | null
  readiness: {
    hasSet: boolean
    hasJobCard: boolean
    artworkApproved: boolean
    artworkLocksCompleted?: number
    approvalsComplete?: boolean
    prePressFinalized?: boolean
    artworkStatusLabel?: string
    firstArticlePass: boolean
    readyForProduction: boolean
    planningForwarded?: boolean
    plateFlowStatus?: string | null
  }
  directorPriority?: boolean
  directorHold?: boolean
}

type Customer = { id: string; name: string }
type User = { id: string; name: string }

export default function DesigningQueuePage() {
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [customerId, setCustomerId] = useState('')
  const [finalizingId, setFinalizingId] = useState<string | null>(null)
  const [forwardingId, setForwardingId] = useState<string | null>(null)
  const [recallingPlanningId, setRecallingPlanningId] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const [custRes, usersRes, linesRes] = await Promise.all([
          fetch('/api/masters/customers'),
          fetch('/api/users'),
          fetch(`/api/designing/po-lines?${customerId ? `customerId=${customerId}` : ''}`),
        ])
        const custJson = await custRes.json()
        const usersJson = await usersRes.json()
        const json = await linesRes.json()
        setCustomers(Array.isArray(custJson) ? custJson : [])
        setUsers(Array.isArray(usersJson) ? usersJson : [])
        setRows(Array.isArray(json) ? json : [])
      } catch {
        toast.error('Failed to load designing queue')
      } finally {
        setLoading(false)
      }
    }
    setLoading(true)
    load()
  }, [customerId])

  const userById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users])

  const readyCount = useMemo(
    () => rows.filter((r) => r.readiness?.readyForProduction).length,
    [rows],
  )

  const forwardPlanning = async (r: Row) => {
    setForwardingId(r.id)
    try {
      const res = await fetch(`/api/designing/po-lines/${r.id}/forward-planning`, { method: 'POST' })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Forward failed')
      toast.success('Forwarded to planning')
      const linesRes = await fetch(`/api/designing/po-lines?${customerId ? `customerId=${customerId}` : ''}`)
      const list = await linesRes.json()
      setRows(Array.isArray(list) ? list : [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Forward failed')
    } finally {
      setForwardingId(null)
    }
  }

  const recallPlanning = async (r: Row) => {
    setRecallingPlanningId(r.id)
    try {
      const res = await fetch(`/api/designing/po-lines/${r.id}/recall-planning`, { method: 'POST' })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Recall failed')
      toast.success('Recalled from planning')
      const linesRes = await fetch(`/api/designing/po-lines?${customerId ? `customerId=${customerId}` : ''}`)
      const list = await linesRes.json()
      setRows(Array.isArray(list) ? list : [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recall failed')
    } finally {
      setRecallingPlanningId(null)
    }
  }

  const finalizeFromList = async (r: Row) => {
    const setN = (r.setNumber || '').trim()
    const aw = (r.artworkCode || '').trim()
    if (!setN || !/^\d+$/.test(setN)) {
      toast.error('Set # must be filled (numeric) on the edit screen')
      return
    }
    if (!aw) {
      toast.error('Artwork code is required — open Edit to enter it')
      return
    }
    const spec = r.specOverrides || {}
    if (!spec.customerApprovalPharma || !spec.shadeCardQaTextApproval) {
      toast.error('Both approvals must be checked')
      return
    }
    const designerId = (spec.assignedDesignerId as string | undefined) || null
    const designerCommand = parseDesignerCommand(spec.designerCommand)
    setFinalizingId(r.id)
    try {
      const res = await fetch('/api/plate-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poLineId: r.id,
          setNumber: setN,
          awCode: aw,
          customerApproval: true,
          qaTextCheckApproval: true,
          assignedDesignerId: designerId,
          designerCommand,
          status: 'PUSH_TO_PRODUCTION_QUEUE',
        }),
      })
      const json = (await res.json()) as { error?: string; requirementCode?: string }
      if (res.status === 409) {
        toast.info(json.error || 'Already finalized')
        router.refresh()
        return
      }
      if (!res.ok) throw new Error(json.error || 'Finalize failed')
      toast.success('Data successfully routed to Tooling Hubs')
      const linesRes = await fetch(`/api/designing/po-lines?${customerId ? `customerId=${customerId}` : ''}`)
      const list = await linesRes.json()
      setRows(Array.isArray(list) ? list : [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Finalize failed')
    } finally {
      setFinalizingId(null)
    }
  }

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="px-2 py-1 rounded border border-green-700 text-green-300">Customer PO ✓</span>
          <span className="text-slate-500">→</span>
          <span className="px-2 py-1 rounded border border-blue-700 bg-blue-900/30 text-blue-200">Artwork queue</span>
          <span className="text-slate-500">→</span>
          <span className="px-2 py-1 rounded border border-slate-700 text-slate-300">Plate Hub</span>
          <span className="text-slate-500">→</span>
          <span className="px-2 py-1 rounded border border-slate-700 text-slate-300">Planning</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-amber-400">Artwork queue</h1>
          <p className="text-xs text-slate-500">
            Ready for production: <span className="text-amber-300 font-semibold">{readyCount}</span> /{' '}
            {rows.length}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/orders/purchase-orders"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Customer orders / POs
          </Link>
          <Link
            href="/hub/plates"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Plate Hub →
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white min-w-[180px]"
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left table-fixed">
          <thead className="bg-slate-800 text-slate-200">
            <tr>
              <th className="px-3 py-2 w-[9rem]">PO</th>
              <th className="px-3 py-2 w-[7rem]">Customer</th>
              <th className="px-3 py-2 min-w-[12rem]">Carton</th>
              <th className="px-3 py-2 w-[5rem]">Qty</th>
              <th className="px-3 py-2 w-[4rem]">Set</th>
              <th className="px-3 py-2 w-[6rem]">Designer</th>
              <th className="px-3 py-2 w-[8rem]">Artwork</th>
              <th className="px-3 py-2 min-w-[10rem]">Pre-press status</th>
              <th className="px-3 py-2 min-w-[14rem]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {rows.map((r) => {
              const designerId = r.specOverrides?.assignedDesignerId
              const designerName = designerId ? (userById[designerId]?.name ?? '—') : '—'
              const label = r.readiness.artworkStatusLabel ?? 'Awaiting approval'
              const approvalsDone = !!r.readiness.approvalsComplete
              const finalized = !!r.readiness.prePressFinalized
              const planningForwarded = !!r.readiness.planningForwarded
              const spec = (r.specOverrides || {}) as Record<string, unknown>
              const machineAllocated = !!String(spec.machineId || '').trim()
              const canFinalizeRow =
                approvalsDone && !finalized && !!(r.setNumber || '').trim() && !!(r.artworkCode || '').trim()
              const canRecallPlanning = planningForwarded && !machineAllocated && !['in_production', 'closed'].includes(r.planningStatus)
              return (
                <tr
                  key={r.id}
                  className={`hover:bg-slate-800/60 ${r.directorHold ? 'opacity-50 bg-slate-900/80' : ''}`}
                >
                  <td className="px-3 py-3 align-top font-mono text-amber-300 break-all">
                    <div className="flex flex-col gap-1">
                      <span>{r.po.poNumber}</span>
                      {r.directorPriority ? (
                        <span className="inline-flex w-fit rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-amber-500/25 text-amber-300 ring-1 ring-amber-500/40">
                          Director priority
                        </span>
                      ) : null}
                      {r.directorHold ? (
                        <span className="inline-flex w-fit rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-slate-600/50 text-slate-300 ring-1 ring-slate-500/50">
                          Hold
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top text-slate-100">{r.po.customer.name}</td>
                  <td className="px-3 py-3 align-top text-slate-100 text-balance break-words">
                    {r.cartonName}
                  </td>
                  <td className="px-3 py-3 align-top text-slate-200 tabular-nums">{r.quantity}</td>
                  <td className="px-3 py-3 align-top text-slate-200">{r.setNumber ?? '—'}</td>
                  <td className="px-3 py-3 align-top text-xs text-slate-200">{designerName}</td>
                  <td className="px-3 py-3 align-top text-slate-100 text-xs leading-snug">{label}</td>
                  <td className="px-3 py-3 align-top text-slate-100 text-xs text-balance leading-snug break-words">
                    {finalized && planningForwarded
                      ? 'Plate Hub + Planning (parallel) — both tracks active'
                      : finalized
                        ? 'Sent to Plate Hub — planning can run in parallel'
                        : planningForwarded
                          ? 'Forwarded to planning — send to Plate Hub when ready'
                          : approvalsDone
                            ? 'Approvals complete — use Plate Hub and/or Planning'
                            : 'Awaiting customer & QA text approvals'}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap gap-1">
                        <Link
                          href={`/orders/designing/${r.id}`}
                          className="inline-flex px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
                        >
                          Edit
                        </Link>
                        {canFinalizeRow && (
                          <button
                            type="button"
                            disabled={finalizingId === r.id}
                            onClick={() => void finalizeFromList(r)}
                            className="inline-flex px-2 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-medium"
                          >
                            {finalizingId === r.id ? '…' : 'Send to Plate Hub'}
                          </button>
                        )}
                        {approvalsDone && !planningForwarded && (
                          <button
                            type="button"
                            disabled={forwardingId === r.id}
                            onClick={() => void forwardPlanning(r)}
                            className="inline-flex px-2 py-1 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-medium"
                          >
                            {forwardingId === r.id ? '…' : 'Forward to Planning'}
                          </button>
                        )}
                        {finalized && (
                          <Link
                            href="/hub/plates"
                            className="inline-flex px-2 py-1 rounded-md border border-emerald-500/80 text-emerald-200 hover:bg-emerald-950 text-xs font-medium"
                          >
                            Open Plate Hub
                          </Link>
                        )}
                        {planningForwarded && (
                          <Link
                            href="/orders/planning"
                            className="inline-flex px-2 py-1 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-medium"
                          >
                            Open Planning
                          </Link>
                        )}
                        {canRecallPlanning && (
                          <button
                            type="button"
                            disabled={recallingPlanningId === r.id}
                            onClick={() => void recallPlanning(r)}
                            className="inline-flex px-2 py-1 rounded-md bg-rose-900/80 hover:bg-rose-800 border border-rose-700/60 disabled:opacity-50 text-rose-100 text-xs font-medium"
                          >
                            {recallingPlanningId === r.id ? '…' : 'Recall from Planning'}
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs">
                        <a
                          href={`/api/designing/po-lines/${r.id}/job-spec-pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-amber-300 hover:underline"
                        >
                          Spec PDF
                        </a>
                        <Link
                          href={`/orders/purchase-orders/${r.po.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-slate-300 hover:underline"
                        >
                          PO
                        </Link>
                      </div>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">No items in designing queue.</p>
      )}
    </div>
  )
}
