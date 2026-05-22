'use client'

/**
 * QC Records — rebuilt with ERP design system
 * ─────────────────────────────────────────────
 * ✓ useQuery (replaces useEffect + fetch)
 * ✓ DataTable (replaces raw <table>)
 * ✓ PageHeader, KpiCard, Button, SearchInput, Pagination, StatusBadge
 */

import { useMemo, useState }                                from 'react'
import { useQueryClient, useQuery, useMutation }            from '@tanstack/react-query'
import { CheckCircle2, ClipboardCheck, Plus, XCircle }      from 'lucide-react'
import { format }                                           from 'date-fns'

import { PageHeader }  from '@/components/shared/PageHeader'
import { DataTable }   from '@/components/shared/DataTable'
import { KpiCard }     from '@/components/shared/KpiCard'
import { Button }      from '@/components/ui/Button'
import { SearchInput } from '@/components/ui/SearchInput'
import { Pagination }  from '@/components/ui/Pagination'
import { toast }       from '@/store/toastStore'
import { QC_INSTRUMENTS } from '@/lib/constants'

/* ── Types ──────────────────────────────────────────────────────────────── */
type QcRecord = {
  id: string
  jobId: string
  checkType: string
  instrumentName: string
  measuredValue: string | null
  specMin: string | null
  specMax: string | null
  result: string
  isFirstArticle: boolean
  checkedAt: string
  job: { jobNumber: string; productName: string }
  checker: { name: string }
}

type Job = { id: string; jobNumber: string; productName: string }

const PAGE_LIMIT = 20

/* ── API ─────────────────────────────────────────────────────────────────── */
async function fetchQcRecords(jobId: string): Promise<QcRecord[]> {
  const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''
  const res = await fetch(`/api/qc-records${qs}`)
  if (!res.ok) throw new Error('Failed to load QC records')
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
export default function QcRecordsPage() {
  const qc = useQueryClient()

  const [jobFilter, setJobFilter] = useState('')
  const [q,         setQ]         = useState('')
  const [page,      setPage]      = useState(1)
  const [showForm,  setShowForm]  = useState(false)
  const [form, setForm] = useState({
    jobId: '',
    checkType: 'colour_delta_e',
    instrumentName: QC_INSTRUMENTS[0] ?? '',
    measuredValue: '',
    specMin: '',
    specMax: '',
    result: 'PASS' as 'PASS' | 'FAIL',
    isFirstArticle: false,
    notes: '',
  })

  const { data: list = [], isLoading } = useQuery<QcRecord[]>({
    queryKey: ['qc-records', jobFilter],
    queryFn:  () => fetchQcRecords(jobFilter),
  })

  const { data: jobs = [] } = useQuery<Job[]>({
    queryKey: ['jobs-list'],
    queryFn:  fetchJobs,
    staleTime: 60_000,
  })

  const createMutation = useMutation({
    mutationFn: async (body: object) => {
      const res = await fetch('/api/qc-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create')
      return json
    },
    onSuccess: () => {
      toast.success('QC record added')
      setShowForm(false)
      setForm({
        jobId: '',
        checkType: 'colour_delta_e',
        instrumentName: QC_INSTRUMENTS[0] ?? '',
        measuredValue: '',
        specMin: '',
        specMax: '',
        result: 'PASS',
        isFirstArticle: false,
        notes: '',
      })
      void qc.invalidateQueries({ queryKey: ['qc-records'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  })

  /* ── Client-side search ─────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    if (!ql) return list
    return list.filter(r =>
      r.job.jobNumber.toLowerCase().includes(ql) ||
      r.checkType.toLowerCase().includes(ql) ||
      r.instrumentName.toLowerCase().includes(ql) ||
      r.checker.name.toLowerCase().includes(ql),
    )
  }, [list, q])

  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  /* ── KPIs ───────────────────────────────────────────────────────────── */
  const kpiTotal  = list.length
  const kpiPass   = list.filter(r => r.result === 'PASS').length
  const kpiFail   = list.filter(r => r.result === 'FAIL').length
  const kpiFa     = list.filter(r => r.isFirstArticle).length

  /* ── Columns ────────────────────────────────────────────────────────── */
  const columns = [
    {
      key:       'job',
      label:     'Job',
      className: 'font-mono text-sm text-ds-warning font-semibold',
      render:    (row: QcRecord) => row.job.jobNumber,
    },
    {
      key:       'checkType',
      label:     'Check Type',
      className: 'text-ds-ink text-sm',
      render:    (row: QcRecord) => row.checkType.replace(/_/g, ' '),
    },
    {
      key:       'instrumentName',
      label:     'Instrument',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: QcRecord) => row.instrumentName,
    },
    {
      key:       'measuredValue',
      label:     'Value',
      className: 'font-mono text-sm text-ds-ink-muted',
      render:    (row: QcRecord) => row.measuredValue ?? '—',
    },
    {
      key:    'result',
      label:  'Result',
      render: (row: QcRecord) => (
        <span className={`font-semibold text-sm ${row.result === 'PASS' ? 'text-ds-success' : 'text-ds-error'}`}>
          {row.result}
        </span>
      ),
    },
    {
      key:    'isFirstArticle',
      label:  'FA',
      render: (row: QcRecord) => (
        <span className="text-ds-ink-muted text-sm">{row.isFirstArticle ? 'Yes' : '—'}</span>
      ),
    },
    {
      key:    'checker',
      label:  'Checked by',
      render: (row: QcRecord) => <span className="text-ds-ink-muted text-sm">{row.checker.name}</span>,
    },
    {
      key:    'checkedAt',
      label:  'Date',
      render: (row: QcRecord) => (
        <span className="font-mono text-xs text-ds-ink-muted">
          {format(new Date(row.checkedAt), 'dd MMM yyyy HH:mm')}
        </span>
      ),
    },
  ]

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.jobId) { toast.error('Select a job'); return }
    createMutation.mutate({
      ...form,
      measuredValue: form.measuredValue || null,
      specMin:       form.specMin       || null,
      specMax:       form.specMax       || null,
      notes:         form.notes         || null,
    })
  }

  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard title="Total Checks" value={kpiTotal} icon={ClipboardCheck} color="blue"   loading={isLoading} />
        <KpiCard title="Pass"         value={kpiPass}  icon={CheckCircle2}   color="green"  loading={isLoading} />
        <KpiCard title="Fail"         value={kpiFail}  icon={XCircle}        color={kpiFail > 0 ? 'red' : 'slate'} loading={isLoading} />
        <KpiCard title="First Article" value={kpiFa}  icon={ClipboardCheck} color="orange" loading={isLoading} />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="QC Records"
        subtitle="Quality control checks and first article inspections"
        action={
          <Button icon={Plus} onClick={() => setShowForm(v => !v)}>
            {showForm ? 'Cancel' : 'Add QC Record'}
          </Button>
        }
      />

      {/* ── Create form ───────────────────────────────────────────────── */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-ds-lg bg-ds-card border border-ds-line p-4 space-y-3"
        >
          <h2 className="text-sm font-semibold text-ds-ink">New QC Record</h2>
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
              <label className="block text-ds-ink-muted mb-1">Check type</label>
              <input
                type="text"
                value={form.checkType}
                onChange={e => setForm(f => ({ ...f, checkType: e.target.value }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Instrument</label>
              <select
                value={form.instrumentName}
                onChange={e => setForm(f => ({ ...f, instrumentName: e.target.value }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              >
                {QC_INSTRUMENTS.map(inst => <option key={inst} value={inst}>{inst}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Result *</label>
              <select
                value={form.result}
                onChange={e => setForm(f => ({ ...f, result: e.target.value as 'PASS' | 'FAIL' }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              >
                <option value="PASS">PASS</option>
                <option value="FAIL">FAIL</option>
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Measured value</label>
              <input
                type="text"
                value={form.measuredValue}
                onChange={e => setForm(f => ({ ...f, measuredValue: e.target.value }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Spec min / max</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Min"
                  value={form.specMin}
                  onChange={e => setForm(f => ({ ...f, specMin: e.target.value }))}
                  className="flex-1 min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
                />
                <input
                  type="text"
                  placeholder="Max"
                  value={form.specMax}
                  onChange={e => setForm(f => ({ ...f, specMax: e.target.value }))}
                  className="flex-1 min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
                />
              </div>
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="fa-check"
                type="checkbox"
                checked={form.isFirstArticle}
                onChange={e => setForm(f => ({ ...f, isFirstArticle: e.target.checked }))}
                className="rounded border-ds-line"
              />
              <label htmlFor="fa-check" className="text-ds-ink-muted text-sm">First article</label>
            </div>
            <div className="md:col-span-2">
              <label className="block text-ds-ink-muted mb-1">Notes</label>
              <input
                type="text"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
              />
            </div>
          </div>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Saving…' : 'Save Record'}
          </Button>
        </form>
      )}

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search job #, check type, instrument…"
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
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={q ? 'No QC records match your search.' : 'No QC records found.'}
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
