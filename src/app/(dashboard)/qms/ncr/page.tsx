'use client'

/**
 * NCR / CAPA List — rebuilt with ERP design system
 * ──────────────────────────────────────────────────
 * ✓ useQuery (replaces useEffect + fetch)
 * ✓ DataTable (replaces raw <table>)
 * ✓ PageHeader, KpiCard, Button, SearchInput, Pagination, StatusBadge
 */

import { useMemo, useState }                                      from 'react'
import Link                                                       from 'next/link'
import { useQueryClient, useQuery, useMutation }                  from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Clock, FileWarning, Plus }  from 'lucide-react'
import { format }                                                 from 'date-fns'

import { PageHeader }  from '@/components/shared/PageHeader'
import { DataTable }   from '@/components/shared/DataTable'
import { KpiCard }     from '@/components/shared/KpiCard'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button }      from '@/components/ui/Button'
import { SearchInput } from '@/components/ui/SearchInput'
import { Pagination }  from '@/components/ui/Pagination'
import { toast }       from '@/store/toastStore'

/* ── Types ──────────────────────────────────────────────────────────────── */
type Ncr = {
  id: string
  jobId: string
  trigger: string
  severity: string
  description: string
  quantityAffected: number | null
  status: string
  raisedAt: string
  dueDate: string | null
  job: { jobNumber: string; productName: string }
  raiser: { name: string }
  assignee: { name: string } | null
}

type Job = { id: string; jobNumber: string; productName: string }

const TRIGGERS = ['qc_fail', 'excess_wastage', 'customer_complaint', 'old_stock', 'other']

const STATUS_OPTIONS = [
  { value: '',            label: 'All statuses' },
  { value: 'open',        label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'closed',      label: 'Closed' },
  { value: 'overdue',     label: 'Overdue' },
]

const PAGE_LIMIT = 20

/* ── API ─────────────────────────────────────────────────────────────────── */
async function fetchNcrs(jobId: string, status: string): Promise<Ncr[]> {
  const params = new URLSearchParams()
  if (jobId) params.set('jobId', jobId)
  if (status) params.set('status', status)
  const res = await fetch(`/api/ncrs?${params}`)
  if (!res.ok) throw new Error('Failed to load NCRs')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function fetchJobs(): Promise<Job[]> {
  const res = await fetch('/api/jobs')
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function NcrListPage() {
  const qc = useQueryClient()

  const [jobFilter,    setJobFilter]    = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [q,            setQ]            = useState('')
  const [page,         setPage]         = useState(1)
  const [showForm,     setShowForm]     = useState(false)
  const [form, setForm] = useState({
    jobId: '',
    trigger: 'qc_fail',
    severity: 'major' as 'critical' | 'major' | 'minor',
    description: '',
    quantityAffected: '',
  })

  const { data: list = [], isLoading } = useQuery<Ncr[]>({
    queryKey: ['ncrs', jobFilter, statusFilter],
    queryFn:  () => fetchNcrs(jobFilter, statusFilter),
  })

  const { data: jobs = [] } = useQuery<Job[]>({
    queryKey: ['jobs-list'],
    queryFn:  fetchJobs,
    staleTime: 60_000,
  })

  const createMutation = useMutation({
    mutationFn: async (body: object) => {
      const res = await fetch('/api/ncrs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create')
      return json
    },
    onSuccess: () => {
      toast.success('NCR created')
      setShowForm(false)
      setForm({ jobId: '', trigger: 'qc_fail', severity: 'major', description: '', quantityAffected: '' })
      void qc.invalidateQueries({ queryKey: ['ncrs'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  })

  /* ── Client-side search ─────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    if (!ql) return list
    return list.filter(n =>
      n.job.jobNumber.toLowerCase().includes(ql) ||
      n.description.toLowerCase().includes(ql) ||
      n.trigger.toLowerCase().includes(ql) ||
      (n.assignee?.name ?? '').toLowerCase().includes(ql),
    )
  }, [list, q])

  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  /* ── KPIs ───────────────────────────────────────────────────────────── */
  const kpiTotal    = list.length
  const kpiOpen     = list.filter(n => n.status === 'open').length
  const kpiOverdue  = list.filter(n => n.status === 'overdue').length
  const kpiClosed   = list.filter(n => n.status === 'closed').length

  /* ── Columns ────────────────────────────────────────────────────────── */
  const columns = [
    {
      key:       'job',
      label:     'Job',
      className: 'font-mono text-sm text-ds-warning font-semibold',
      render:    (row: Ncr) => row.job.jobNumber,
    },
    {
      key:    'trigger',
      label:  'Trigger',
      render: (row: Ncr) => <span className="text-ds-ink text-sm">{row.trigger.replace(/_/g, ' ')}</span>,
    },
    {
      key:    'severity',
      label:  'Severity',
      render: (row: Ncr) => {
        const cls = row.severity === 'critical' ? 'text-ds-error font-semibold'
          : row.severity === 'major' ? 'text-ds-warning font-medium'
          : 'text-ds-ink-muted'
        return <span className={`text-sm ${cls}`}>{row.severity}</span>
      },
    },
    {
      key:       'description',
      label:     'Description',
      className: 'max-w-xs truncate text-ds-ink-muted text-sm',
      render:    (row: Ncr) => <span title={row.description}>{row.description}</span>,
    },
    {
      key:    'status',
      label:  'Status',
      render: (row: Ncr) => <StatusBadge status={row.status.replace(/_/g, ' ')} />,
    },
    {
      key:    'assignee',
      label:  'Assignee',
      render: (row: Ncr) => <span className="text-ds-ink-muted text-sm">{row.assignee?.name ?? '—'}</span>,
    },
    {
      key:    'dueDate',
      label:  'Due',
      render: (row: Ncr) => {
        if (!row.dueDate) return <span className="text-ds-ink-faint text-xs">—</span>
        const d = new Date(row.dueDate)
        const overdue = d < new Date() && row.status !== 'closed'
        return (
          <span className={`font-mono text-xs ${overdue ? 'text-ds-error font-semibold' : 'text-ds-ink-muted'}`}>
            {format(d, 'dd MMM yyyy')}
          </span>
        )
      },
    },
    {
      key:    'action',
      label:  '',
      render: (row: Ncr) => (
        <Link href={`/qms/ncr/${row.id}`} className="text-ds-brand hover:underline text-xs">
          Open →
        </Link>
      ),
    },
  ]

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.jobId || !form.description) {
      toast.error('Job and description required')
      return
    }
    createMutation.mutate({
      jobId: form.jobId,
      trigger: form.trigger,
      severity: form.severity,
      description: form.description,
      quantityAffected: form.quantityAffected ? Number(form.quantityAffected) : null,
    })
  }

  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard title="Total NCRs"  value={kpiTotal}   icon={FileWarning}    color="blue"   loading={isLoading} />
        <KpiCard title="Open"        value={kpiOpen}    icon={Clock}          color="orange" loading={isLoading} />
        <KpiCard title="Overdue"     value={kpiOverdue} icon={AlertTriangle}  color={kpiOverdue > 0 ? 'red' : 'slate'} loading={isLoading} />
        <KpiCard title="Closed"      value={kpiClosed}  icon={CheckCircle2}   color="green"  loading={isLoading} />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="NCR / CAPA"
        subtitle="Non-conformance reports and corrective action tracking"
        action={
          <Button icon={Plus} onClick={() => setShowForm(v => !v)}>
            {showForm ? 'Cancel' : 'Raise NCR'}
          </Button>
        }
      />

      {/* ── Create form ───────────────────────────────────────────────── */}
      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-ds-lg bg-ds-card border border-ds-line p-4 space-y-3"
        >
          <h2 className="text-sm font-semibold text-ds-ink">Raise NCR</h2>
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            <div>
              <label className="block text-ds-ink-muted mb-1">Job *</label>
              <select
                value={form.jobId}
                onChange={e => setForm(f => ({ ...f, jobId: e.target.value }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              >
                <option value="">Select job…</option>
                {jobs.map(j => (
                  <option key={j.id} value={j.id}>{j.jobNumber} — {j.productName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Trigger</label>
              <select
                value={form.trigger}
                onChange={e => setForm(f => ({ ...f, trigger: e.target.value }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              >
                {TRIGGERS.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Severity</label>
              <select
                value={form.severity}
                onChange={e => setForm(f => ({ ...f, severity: e.target.value as 'critical' | 'major' | 'minor' }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              >
                <option value="critical">Critical</option>
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Qty affected</label>
              <input
                type="number"
                min={0}
                value={form.quantityAffected}
                onChange={e => setForm(f => ({ ...f, quantityAffected: e.target.value }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-ds-ink-muted mb-1">Description *</label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
                className="w-full rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              />
            </div>
          </div>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Saving…' : 'Create NCR'}
          </Button>
        </form>
      )}

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search job #, description, trigger…"
          className="w-80"
        />
        <select
          value={jobFilter}
          onChange={e => { setJobFilter(e.target.value); setPage(1) }}
          className="min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
        >
          <option value="">All jobs</option>
          {jobs.map(j => <option key={j.id} value={j.id}>{j.jobNumber}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
          className="min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={q ? 'No NCRs match your search.' : 'No NCRs found.'}
      />

      {/* ── Pagination ────────────────────────────────────────────────── */}
      <Pagination
        page={page}
        total={filtered.length}
        limit={PAGE_LIMIT}
        onChange={setPage}
      />

    </div>
  )
}
