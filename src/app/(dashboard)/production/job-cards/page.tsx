'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Star } from 'lucide-react'
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

type BoardReadiness = 'ready' | 'waiting' | 'not_ready'
type UiStatus = 'pending' | 'ready' | 'pushed'

function getBoardReadiness(row: JobCardRow): BoardReadiness {
  if (row.requiredSheets > 0 && row.sheetsIssued >= row.requiredSheets) return 'ready'
  if (row.sheetsIssued > 0) return 'waiting'
  return 'not_ready'
}

function boardReadinessMeta(r: BoardReadiness): { label: string; tooltip: string; dot: string } {
  if (r === 'ready') return { label: 'Ready', tooltip: 'Board available', dot: 'bg-emerald-500' }
  if (r === 'waiting') return { label: 'Waiting', tooltip: 'Board in procurement', dot: 'bg-amber-400' }
  return { label: 'Not Ready', tooltip: 'Board missing', dot: 'bg-rose-500' }
}

function getUiStatus(row: JobCardRow): UiStatus {
  if (row.status === 'closed' || row.status === 'qa_released') return 'pushed'
  if (row.status === 'in_progress' || row.status === 'final_qc') return 'ready'
  return 'pending'
}

export default function JobCardsPage() {
  const [list, setList] = useState<JobCardRow[]>([])
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | UiStatus>('all')
  const [readinessFilter, setReadinessFilter] = useState<'all' | BoardReadiness>('all')

  const [auditRow, setAuditRow] = useState<JobCardRow | null>(null)

  const loadJobCards = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set('yieldMetrics', '1')
      if (q.trim()) params.set('q', q.trim())

      const jcRes = await fetch(`/api/job-cards?${params}`)
      const jcJson = await jcRes.json()
      setList(Array.isArray(jcJson) ? jcJson : [])
      setLastSync(new Date().toLocaleString())
    } catch {
      toast.error('Failed to load job cards')
    } finally {
      setLoading(false)
    }
  }, [q])

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

  const sortedList = useMemo(() => {
    const copy = [...list]
    copy.sort((a, b) => {
      const pa = a.poLine?.industrialPriority === true ? 1 : 0
      const pb = b.poLine?.industrialPriority === true ? 1 : 0
      if (pa !== pb) return pb - pa
      const rank: Record<UiStatus, number> = { pending: 0, ready: 1, pushed: 2 }
      const d = rank[getUiStatus(a)] - rank[getUiStatus(b)]
      if (d !== 0) return d
      return a.jobCardNumber - b.jobCardNumber
    })
    return copy
  }, [list])

  const visibleList = useMemo(() => {
    return sortedList.filter((jc) => {
      const st = getUiStatus(jc)
      const br = getBoardReadiness(jc)
      if (statusFilter !== 'all' && st !== statusFilter) return false
      if (readinessFilter !== 'all' && br !== readinessFilter) return false
      return true
    })
  }, [readinessFilter, sortedList, statusFilter])

  if (loading && list.length === 0) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center bg-background text-ds-ink-faint text-sm">
        Loading job card hub…
      </div>
    )
  }

  return (
    <div className="min-h-0 flex flex-col bg-background text-ds-ink">
      <div className="border-b border-ds-line/40 px-4 py-3 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-bold text-ds-warning tracking-tight">Job Card Hub</h1>
          <p className="text-[11px] text-ds-ink-faint mt-0.5">High-density ledger · live audit</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          <Link
            href="/orders/planning"
            className="px-3 py-1.5 rounded-lg border border-ds-line/50 text-ds-ink-muted text-xs hover:bg-ds-card"
          >
            Planning
          </Link>
          <a
            href="/api/job-cards/reconciliation-export"
            className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-xs hover:bg-ds-card"
          >
            Manual export (material batches)
          </a>
          <Link
            href="/production/job-cards/new"
            className="px-3 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-xs font-medium"
          >
            New job card
          </Link>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3 border-b border-ds-line/50">
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="search"
            placeholder="Search customer…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="min-w-[220px] flex-1 max-w-md px-3 py-2 rounded-lg bg-ds-main border border-ds-line/50 text-sm text-ds-ink placeholder:text-ds-ink-faint focus:outline-none focus:ring-1 focus:ring-ds-warning/35"
          />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | UiStatus)}
              className="px-2 py-2 rounded-md bg-ds-main border border-ds-line/50 text-ds-ink text-sm"
            >
              <option value="all">All status</option>
              <option value="pending">Pending</option>
              <option value="ready">Ready</option>
              <option value="pushed">Pushed to Planning</option>
            </select>
            <select
              value={readinessFilter}
              onChange={(e) => setReadinessFilter(e.target.value as 'all' | BoardReadiness)}
              className="px-2 py-2 rounded-md bg-ds-main border border-ds-line/50 text-ds-ink text-sm"
            >
              <option value="all">All board readiness</option>
              <option value="ready">Ready</option>
              <option value="waiting">Waiting</option>
              <option value="not_ready">Not Ready</option>
            </select>
          </div>
      </div>

      {visibleList.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-ds-ink">No Job Cards Yet</h2>
            <p className="mt-1 text-sm text-ds-ink-faint">Jobs pushed from AW Queue will appear here</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-x-auto px-2 pb-4">
          <table className="w-full text-sm min-w-[960px] border-collapse">
          <thead>
            <tr className="border-b border-ds-line/40 text-left">
              <th className="py-2 pl-2 pr-1 w-8" aria-label="Priority" />
              <th className="py-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-ds-ink-muted">
                Product
              </th>
              <th className="py-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-ds-ink-muted">
                Qty
              </th>
              <th className="py-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-ds-ink-muted">
                Board readiness
              </th>
              <th className="py-2 px-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ds-ink-muted">
                  Status
                </span>
              </th>
              <th className="py-2 px-2 text-right text-[11px] font-semibold uppercase tracking-wide text-ds-ink-muted">Open</th>
            </tr>
          </thead>
          <tbody>
            {visibleList.map((jc) => {
              const st = getUiStatus(jc)
              const br = getBoardReadiness(jc)
              const brMeta = boardReadinessMeta(br)
              return (
                <tr
                  key={jc.id}
                  className={clsx(
                    'h-14 border-b border-ds-card/90 transition-all duration-150 hover:bg-ds-main/70 hover:shadow-sm',
                    jc.poLine?.industrialPriority === true ? INDUSTRIAL_PRIORITY_ROW_CLASS : '',
                    st === 'pushed' ? 'bg-emerald-500/10' : '',
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
                  <td className="py-2 px-2 align-middle">
                    <div className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        onClick={() => setAuditRow(jc)}
                        className="w-fit font-semibold text-ds-ink hover:text-ds-warning"
                      >
                        {jc.poLine?.cartonName ?? '—'}
                      </button>
                      <span className="text-[11px] text-ds-ink-faint truncate" title={jc.customer?.name}>{jc.customer?.name ?? '—'}</span>
                      <span className={`text-[10px] text-ds-ink-faint ${mono}`}>
                        {jc.poLine?.poNumber ?? '—'} • {jc.poLine?.artworkCode ?? '—'}
                      </span>
                    </div>
                  </td>
                  <td className={`py-2 px-2 align-middle ${mono} text-ds-ink text-right`}>
                    {jc.poLine?.quantity?.toLocaleString('en-IN') ?? '—'}
                  </td>
                  <td className="py-2 px-2 align-middle">
                    <span
                      className="inline-flex items-center gap-1.5 rounded border border-ds-line/50 bg-ds-main px-2 py-0.5 text-[11px]"
                      title={brMeta.tooltip}
                    >
                      <span className={clsx('h-2 w-2 rounded-full', brMeta.dot)} />
                      {brMeta.label}
                    </span>
                  </td>
                  <td className="py-2 px-2 align-middle">
                    <span
                      className={clsx(
                        'inline-flex items-center rounded border px-2 py-0.5 text-[11px]',
                        st === 'pending' && 'border-ds-line/60 bg-ds-main text-ds-ink-muted',
                        st === 'ready' && 'border-amber-400/40 bg-amber-400/10 text-amber-300',
                        st === 'pushed' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
                      )}
                    >
                      {st === 'pending' ? 'Pending' : st === 'ready' ? 'Ready' : 'Pushed to Planning'}
                    </span>
                  </td>
                  <td className="py-2 px-2 align-middle text-right">
                    <Link
                      href={`/production/job-cards/${jc.id}`}
                      className="inline-flex items-center justify-center rounded border border-ds-line/60 bg-ds-main p-1 text-ds-ink-muted hover:text-ds-warning"
                      aria-label={`Open full edit for job card ${jc.jobCardNumber}`}
                    >
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
          </table>
        </div>
      )}

      <footer className="mt-auto border-t border-ds-line/40 px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ds-ink-faint">
        <span>
          Live Data Stream Verified - Last Sync:{' '}
          <span className={clsx(mono, 'text-ds-ink-muted')}>{lastSync ?? '—'}</span>.
        </span>
        <span className="text-ds-ink-faint">Anik Dua · Industrial priority star</span>
      </footer>

      <JobCardHubAuditDrawer
        jobCardId={auditRow?.id ?? null}
        jobCardNumber={auditRow?.jobCardNumber ?? null}
        onClose={() => setAuditRow(null)}
      />
    </div>
  )
}
