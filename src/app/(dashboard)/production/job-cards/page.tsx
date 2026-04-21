'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowDownAZ, ArrowUpAZ, Printer, Star } from 'lucide-react'
import { toast } from 'sonner'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import {
  INDUSTRIAL_PRIORITY_ROW_CLASS,
  INDUSTRIAL_PRIORITY_STAR_ICON_CLASS,
} from '@/lib/industrial-priority-ui'
import { JobCardHubAuditDrawer } from '@/components/production/JobCardHubAuditDrawer'
import clsx from 'clsx'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type YieldMetrics = {
  yieldPercent: number | null
  plannedWastePercent: number
  unexplainedWastePercent: number
  wastageVariancePercent: number | null
  finishedGoodsCount: number
  totalSheetsIssuedFloor: number
}

type JobCardRow = {
  id: string
  jobCardNumber: number
  setNumber: string | null
  assignedOperator: string | null
  customer: { id: string; name: string }
  requiredSheets: number
  wastageSheets: number
  totalSheets: number
  sheetsIssued: number
  status: string
  machine: { id: string; machineCode: string; capacityPerShift: number } | null
  shiftOperator: { id: string; name: string } | null
  openDowntime?: boolean
  poLine: {
    id: string
    cartonName: string
    cartonSize: string | null
    quantity: number
    industrialPriority?: boolean
    poNumber: string
    artworkCode: string | null
  } | null
  yield?: YieldMetrics
}

type MachineOpt = { id: string; machineCode: string; name: string }

type HubBadgeKind = 'running' | 'setup' | 'halt' | 'completed' | 'qa_hold'

function hubBadge(row: JobCardRow): { label: string; kind: HubBadgeKind } {
  const s = row.status
  if (s === 'closed' || s === 'qa_released') return { label: 'Completed', kind: 'completed' }
  if (s === 'design_ready') return { label: 'Setup', kind: 'setup' }
  if (s === 'final_qc') return { label: 'QA Hold', kind: 'qa_hold' }
  if (s === 'in_progress') {
    if (row.openDowntime) return { label: 'Halt', kind: 'halt' }
    return { label: 'Running', kind: 'running' }
  }
  return { label: s.replace(/_/g, ' '), kind: 'setup' }
}

function HubStatusBadge({ kind, label }: { kind: HubBadgeKind; label: string }) {
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border'
  switch (kind) {
    case 'running':
      return (
        <span
          className={clsx(
            base,
            'bg-emerald-500/15 text-emerald-400 border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.15)] animate-pulse',
          )}
        >
          {label}
        </span>
      )
    case 'setup':
      return (
        <span className={clsx(base, 'bg-amber-500/15 text-amber-400 border-amber-500/35')}>{label}</span>
      )
    case 'halt':
      return (
        <span className={clsx(base, 'bg-rose-700/20 text-rose-400 border-rose-600/50')}>
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          {label}
        </span>
      )
    case 'qa_hold':
      return (
        <span className={clsx(base, 'bg-fuchsia-950/40 text-fuchsia-300 border-fuchsia-700/40')}>{label}</span>
      )
    case 'completed':
    default:
      return (
        <span className={clsx(base, 'bg-slate-800/80 text-slate-400 border-slate-600/60')}>{label}</span>
      )
  }
}

type SortKey = 'machine' | 'operator' | 'status' | 'po' | 'yield' | null
type SortDir = 'asc' | 'desc'

const SEGMENTS = [
  { id: '', label: 'All active' },
  { id: 'in_production', label: 'In production' },
  { id: 'awaiting_setup', label: 'Awaiting setup' },
  { id: 'qa_hold', label: 'QA hold' },
  { id: 'completed', label: 'Completed' },
] as const

export default function JobCardsPage() {
  const [list, setList] = useState<JobCardRow[]>([])
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [lastSync, setLastSync] = useState<string | null>(null)

  const [segment, setSegment] = useState<string>('')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [priorityOnly, setPriorityOnly] = useState(false)
  const [machineId, setMachineId] = useState('')
  const [operatorId, setOperatorId] = useState('')

  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const [auditRow, setAuditRow] = useState<JobCardRow | null>(null)

  const loadJobCards = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set('yieldMetrics', '1')
      if (segment) params.set('segment', segment)
      if (q.trim()) params.set('q', q.trim())
      if (priorityOnly) params.set('priorityOnly', '1')
      if (machineId) params.set('machineId', machineId)
      if (operatorId) params.set('operatorId', operatorId)

      const jcRes = await fetch(`/api/job-cards?${params}`)
      const jcJson = await jcRes.json()
      setList(Array.isArray(jcJson) ? jcJson : [])
      setLastSync(new Date().toLocaleString())
    } catch {
      toast.error('Failed to load job cards')
    } finally {
      setLoading(false)
    }
  }, [segment, q, priorityOnly, machineId, operatorId])

  useEffect(() => {
    fetch('/api/machines')
      .then((r) => r.json())
      .then((j) => setMachines(Array.isArray(j) ? j : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => setQ(qInput), 320)
    return () => window.clearTimeout(t)
  }, [qInput])

  useEffect(() => {
    setLoading(true)
    void loadJobCards()
  }, [loadJobCards])

  const loadRef = useRef(loadJobCards)
  loadRef.current = loadJobCards
  useEffect(() => {
    const onPri = () => {
      void loadRef.current()
    }
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [])

  const operatorOptions = useMemo(() => {
    const m = new Map<string, string>()
    list.forEach((j) => {
      if (j.shiftOperator) m.set(j.shiftOperator.id, j.shiftOperator.name)
    })
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [list])

  const sortedList = useMemo(() => {
    const copy = [...list]
    const dir = sortDir === 'asc' ? 1 : -1
    const cmp = (x: string, y: string) => x.localeCompare(y) * dir

    copy.sort((a, b) => {
      const pa = a.poLine?.industrialPriority === true ? 1 : 0
      const pb = b.poLine?.industrialPriority === true ? 1 : 0
      if (pa !== pb) return pb - pa

      if (sortKey === 'machine') {
        const ma = a.machine?.machineCode ?? '\uffff'
        const mb = b.machine?.machineCode ?? '\uffff'
        const c = cmp(ma, mb)
        if (c !== 0) return c
      } else if (sortKey === 'operator') {
        const oa = a.shiftOperator?.name ?? a.assignedOperator ?? '\uffff'
        const ob = b.shiftOperator?.name ?? b.assignedOperator ?? '\uffff'
        const c = cmp(oa, ob)
        if (c !== 0) return c
      } else if (sortKey === 'status') {
        const sa = hubBadge(a).label
        const sb = hubBadge(b).label
        const c = cmp(sa, sb)
        if (c !== 0) return c
      } else if (sortKey === 'po') {
        const pa2 = a.poLine?.poNumber ?? '\uffff'
        const pb2 = b.poLine?.poNumber ?? '\uffff'
        const c = cmp(pa2, pb2)
        if (c !== 0) return c
      } else if (sortKey === 'yield') {
        const ya = a.yield?.yieldPercent ?? -1
        const yb = b.yield?.yieldPercent ?? -1
        if (ya !== yb) return (ya - yb) * dir
      }

      return b.jobCardNumber - a.jobCardNumber
    })
    return copy
  }, [list, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
  }

  function SortHeader({
    label,
    k,
    className,
  }: {
    label: string
    k: SortKey
    className?: string
  }) {
    const active = sortKey === k
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={clsx(
          'inline-flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-200',
          className,
        )}
      >
        {label}
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUpAZ className="h-3.5 w-3.5" />
          ) : (
            <ArrowDownAZ className="h-3.5 w-3.5" />
          )
        ) : null}
      </button>
    )
  }

  if (loading && list.length === 0) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center bg-[#000000] text-slate-500 text-sm">
        Loading job card hub…
      </div>
    )
  }

  return (
    <div className="min-h-0 flex flex-col bg-[#000000] text-slate-100">
      <div className="border-b border-slate-800 px-4 py-3 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-bold text-amber-400 tracking-tight">Job Card Hub</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">High-density ledger · live audit</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          <Link
            href="/orders/planning"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-900"
          >
            Planning
          </Link>
          <a
            href="/api/job-cards/reconciliation-export"
            className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-xs hover:bg-slate-900"
          >
            Manual export (material batches)
          </a>
          <Link
            href="/production/job-cards/new"
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium"
          >
            New job card
          </Link>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3 border-b border-slate-800/80">
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="search"
            placeholder="Search PO, customer, AW code…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="min-w-[220px] flex-1 max-w-md px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
          />
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={priorityOnly}
              onChange={(e) => setPriorityOnly(e.target.checked)}
              className="rounded border-slate-600 bg-slate-950"
            />
            Director: priority only
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          {SEGMENTS.map((s) => (
            <button
              key={s.id || 'all'}
              type="button"
              onClick={() => setSegment(s.id)}
              className={clsx(
                'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                segment === s.id
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:border-slate-600',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 shrink-0">Machine</span>
            <select
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              className="px-2 py-1.5 rounded-md bg-slate-950 border border-slate-700 text-slate-200 max-w-[160px]"
            >
              <option value="">All</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.machineCode}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 shrink-0">Operator</span>
            <select
              value={operatorId}
              onChange={(e) => setOperatorId(e.target.value)}
              className="px-2 py-1.5 rounded-md bg-slate-950 border border-slate-700 text-slate-200 max-w-[180px]"
            >
              <option value="">All</option>
              {operatorOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-x-auto px-2 pb-4">
        <table className="w-full text-sm min-w-[960px] border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-left">
              <th className="py-2 pl-2 pr-1 w-8" aria-label="Priority" />
              <th className="py-2 px-2">
                <SortHeader k="po" label="PO #" />
              </th>
              <th className="py-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Client
              </th>
              <th className="py-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Product
              </th>
              <th className="py-2 px-2">
                <SortHeader k="machine" label="Machine" />
              </th>
              <th className="py-2 px-2">
                <SortHeader k="operator" label="Operator" />
              </th>
              <th className="py-2 px-2">
                <SortHeader k="status" label="Status" />
              </th>
              <th className="py-2 px-2 text-right">
                <SortHeader k="yield" label="Live yield %" className="justify-end w-full" />
              </th>
              <th className="py-2 px-2 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Card
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedList.map((jc) => {
              const badge = hubBadge(jc)
              const op = jc.shiftOperator?.name ?? jc.assignedOperator ?? '—'
              return (
                <tr
                  key={jc.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setAuditRow(jc)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setAuditRow(jc)
                    }
                  }}
                  className={clsx(
                    'border-b border-slate-900/90 cursor-pointer hover:bg-slate-950/80 transition-colors',
                    jc.poLine?.industrialPriority === true ? INDUSTRIAL_PRIORITY_ROW_CLASS : '',
                  )}
                >
                  <td className="py-2 pl-2 pr-0 align-middle">
                    {jc.poLine?.industrialPriority === true ? (
                      <Star
                        className={`h-4 w-4 shrink-0 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
                        aria-label="Industrial priority"
                      />
                    ) : (
                      <span className="inline-block w-4" />
                    )}
                  </td>
                  <td className={`py-2 px-2 align-middle ${mono} text-amber-200/95`}>
                    <div className="flex flex-col gap-0.5">
                      <span>{jc.poLine?.poNumber ?? '—'}</span>
                      {jc.poLine?.artworkCode ? (
                        <span className="text-[10px] text-slate-500">{jc.poLine.artworkCode}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="py-2 px-2 text-slate-300 align-middle max-w-[140px] truncate" title={jc.customer?.name}>
                    {jc.customer?.name}
                  </td>
                  <td className="py-2 px-2 text-slate-300 align-middle max-w-[200px]">
                    <div className="truncate" title={jc.poLine?.cartonName ?? ''}>
                      {jc.poLine?.cartonName ?? '—'}
                    </div>
                  </td>
                  <td className={`py-2 px-2 align-middle ${mono} text-slate-200`}>
                    {jc.machine?.machineCode ?? '—'}
                  </td>
                  <td className={`py-2 px-2 align-middle ${mono} text-slate-300 max-w-[120px] truncate`} title={op}>
                    {op}
                  </td>
                  <td className="py-2 px-2 align-middle">
                    <HubStatusBadge kind={badge.kind} label={badge.label} />
                  </td>
                  <td className={`py-2 px-2 align-middle text-right ${mono}`}>
                    {jc.yield?.yieldPercent != null ? (
                      <span
                        className={clsx(
                          jc.yield.yieldPercent < 92 ? 'text-rose-400' : 'text-emerald-400',
                        )}
                      >
                        {jc.yield.yieldPercent}%
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="py-2 px-2 align-middle text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <a
                        href={`/api/job-cards/${jc.id}/card-pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-md text-slate-400 hover:text-amber-400 hover:bg-slate-900"
                        title="Print official card"
                        aria-label="Print official card"
                      >
                        <Printer className="h-4 w-4" />
                      </a>
                      <Link
                        href={`/production/job-cards/${jc.id}`}
                        className="text-[11px] text-amber-500/90 hover:underline px-1 py-1.5"
                      >
                        Open
                      </Link>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {sortedList.length === 0 && (
          <p className="text-center text-slate-600 text-sm py-12">No job cards match these filters.</p>
        )}
      </div>

      <footer className="mt-auto border-t border-slate-800 px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span>
          Live Data Stream Verified - Last Sync:{' '}
          <span className={clsx(mono, 'text-slate-400')}>{lastSync ?? '—'}</span>.
        </span>
        <span className="text-slate-600">Anik Dua · Industrial priority star</span>
      </footer>

      <JobCardHubAuditDrawer
        jobCardId={auditRow?.id ?? null}
        jobCardNumber={auditRow?.jobCardNumber ?? null}
        onClose={() => setAuditRow(null)}
      />
    </div>
  )
}
