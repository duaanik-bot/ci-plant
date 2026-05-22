'use client'

/**
 * Jobs List — rebuilt with ERP design system
 * ────────────────────────────────────────────
 * ✓ useQuery (replaces useEffect + fetch)
 * ✓ DataTable (replaces EnterpriseTableShell)
 * ✓ PageHeader, KpiCard, Button, SearchInput, Pagination, StatusBadge
 */

import { useMemo, useState }                                   from 'react'
import Link                                                    from 'next/link'
import { useRouter }                                           from 'next/navigation'
import { useQuery }                                            from '@tanstack/react-query'
import { format, differenceInDays }                            from 'date-fns'
import { Plus, Briefcase, Clock, CheckCircle2, AlertTriangle } from 'lucide-react'

import { PageHeader }  from '@/components/shared/PageHeader'
import { DataTable }   from '@/components/shared/DataTable'
import { KpiCard }     from '@/components/shared/KpiCard'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button }      from '@/components/ui/Button'
import { SearchInput } from '@/components/ui/SearchInput'
import { Pagination }  from '@/components/ui/Pagination'

/* ── Types ──────────────────────────────────────────────────────────────── */
type Job = {
  id: string
  jobNumber: string
  productName: string
  qtyOrdered: number
  dueDate: string
  status: string
  customer: { name: string }
  artwork?: { versionNumber: number; status: string; locksCompleted: number } | null
}

const STATUS_OPTIONS = [
  { value: '',                  label: 'All statuses' },
  { value: 'pending_artwork',   label: 'Pending Artwork' },
  { value: 'artwork_approved',  label: 'Artwork Approved' },
  { value: 'in_production',     label: 'In Production' },
  { value: 'folding',           label: 'Folding' },
  { value: 'final_qc',          label: 'Final QC' },
  { value: 'packing',           label: 'Packing' },
  { value: 'dispatched',        label: 'Dispatched' },
  { value: 'closed',            label: 'Closed' },
]

const PAGE_LIMIT = 20

/* ── API ─────────────────────────────────────────────────────────────────── */
async function fetchJobs(statusFilter: string, customerFilter: string): Promise<Job[]> {
  const params = new URLSearchParams()
  if (statusFilter)   params.set('status',     statusFilter)
  if (customerFilter) params.set('customerId', customerFilter)
  const res = await fetch(`/api/jobs?${params}`)
  if (!res.ok) throw new Error('Failed to load jobs')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function JobsPage() {
  const router = useRouter()

  const [statusFilter,   setStatusFilter]   = useState('')
  const [customerFilter, setCustomerFilter] = useState('')
  const [q,              setQ]              = useState('')
  const [page,           setPage]           = useState(1)

  const { data: list = [], isLoading } = useQuery<Job[]>({
    queryKey: ['jobs', statusFilter, customerFilter],
    queryFn:  () => fetchJobs(statusFilter, customerFilter),
  })

  /* ── Client-side search ─────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    if (!ql) return list
    return list.filter(j =>
      (j.jobNumber   ?? '').toLowerCase().includes(ql) ||
      (j.productName ?? '').toLowerCase().includes(ql) ||
      (j.customer?.name ?? '').toLowerCase().includes(ql),
    )
  }, [list, q])

  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  /* ── KPIs ───────────────────────────────────────────────────────────── */
  const today       = new Date()
  const kpiTotal    = list.length
  const kpiActive   = list.filter(j => !['dispatched', 'closed'].includes(j.status)).length
  const kpiOverdue  = list.filter(j => {
    const d = new Date(j.dueDate)
    return !isNaN(d.getTime()) && d < today && !['dispatched', 'closed'].includes(j.status)
  }).length
  const kpiClosed   = list.filter(j => j.status === 'closed' || j.status === 'dispatched').length

  /* ── Columns ────────────────────────────────────────────────────────── */
  const columns = [
    {
      key:       'jobNumber',
      label:     'Job #',
      className: 'font-mono text-sm text-ds-warning font-semibold',
      render:    (row: Job) => (
        <Link href={`/jobs/${row.id}`} className="hover:text-ds-brand hover:underline">
          {row.jobNumber}
        </Link>
      ),
    },
    {
      key:    'customer',
      label:  'Customer',
      render: (row: Job) => row.customer?.name ?? '—',
    },
    {
      key:       'productName',
      label:     'Product',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: Job) => row.productName ?? '—',
    },
    {
      key:       'qtyOrdered',
      label:     'Qty',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: Job) => (row.qtyOrdered ?? 0).toLocaleString('en-IN'),
    },
    {
      key:    'status',
      label:  'Status',
      render: (row: Job) => (
        <StatusBadge status={row.status.replace(/_/g, ' ')} />
      ),
    },
    {
      key:    'dueDate',
      label:  'Due Date',
      render: (row: Job) => {
        const d = new Date(row.dueDate)
        if (isNaN(d.getTime())) return <span className="text-ds-ink-faint">—</span>
        const overdue = d < today && !['dispatched', 'closed'].includes(row.status)
        return (
          <span className={`font-mono text-xs ${overdue ? 'text-ds-error font-semibold' : 'text-ds-ink-muted'}`}>
            {format(d, 'dd MMM yyyy')}
          </span>
        )
      },
    },
    {
      key:    'daysLeft',
      label:  'Days Left',
      align:  'right' as const,
      render: (row: Job) => {
        const d = new Date(row.dueDate)
        if (isNaN(d.getTime())) return <span className="text-ds-ink-faint">—</span>
        const days = differenceInDays(d, today)
        return (
          <span className={`font-mono text-sm ${days < 2 ? 'font-semibold text-ds-error' : days < 5 ? 'text-ds-warning' : 'text-ds-ink-muted'}`}>
            {days}
          </span>
        )
      },
    },
    {
      key:    'actions',
      label:  '',
      render: (row: Job) => (
        <div className="flex items-center gap-1.5">
          <Link
            href={`/jobs/${row.id}`}
            className="rounded border border-ds-line/70 px-2 py-1 text-xs text-ds-ink-muted hover:bg-ds-elevated transition-colors"
          >
            View
          </Link>
          <a
            href={`/api/jobs/${row.id}/card-pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-ds-line/70 px-2 py-1 text-xs text-ds-ink-muted hover:bg-ds-elevated transition-colors"
          >
            PDF
          </a>
        </div>
      ),
    },
  ]

  /* ── Row class — highlight overdue ──────────────────────────────────── */
  function getRowClassName(row: Job): string {
    const d = new Date(row.dueDate)
    if (!isNaN(d.getTime()) && d < today && !['dispatched', 'closed'].includes(row.status)) {
      return 'bg-rose-50 dark:bg-[var(--error-bg)]/20'
    }
    return ''
  }

  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard title="Total Jobs"   value={kpiTotal}   icon={Briefcase}      color="blue"   loading={isLoading} />
        <KpiCard title="Active"       value={kpiActive}  icon={Clock}          color="orange" loading={isLoading} />
        <KpiCard title="Overdue"      value={kpiOverdue} icon={AlertTriangle}  color={kpiOverdue > 0 ? 'red' : 'slate'} loading={isLoading} />
        <KpiCard title="Closed"       value={kpiClosed}  icon={CheckCircle2}   color="green"  loading={isLoading} />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Jobs"
        subtitle="Track all production jobs from artwork to dispatch"
        action={
          <Button icon={Plus} onClick={() => router.push('/jobs/new')}>
            New Job
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search job #, product, customer…"
          className="w-80"
        />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
          className="min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Customer ID…"
          value={customerFilter}
          onChange={e => { setCustomerFilter(e.target.value); setPage(1) }}
          className="min-h-[40px] w-44 rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
        />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        rowClassName={getRowClassName}
        emptyMessage={
          q ? 'No jobs match your search.' : 'No jobs found. Create one to get started.'
        }
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
