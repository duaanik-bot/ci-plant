'use client'

/**
 * Job Card Queue — rebuilt with ERP design system
 * ─────────────────────────────────────────────────
 * ✓ useQuery (replaces useEffect + fetch)
 * ✓ PageHeader
 * ✓ Keeps custom table, bulk actions, sorting, multi-select, JobCardHubAuditDrawer
 * NOTE: Button imported from @/components/design-system/Button (not /ui/Button)
 */

import { useCallback, useMemo, useState }              from 'react'
import Link                                             from 'next/link'
import { ArrowRight, CheckSquare, Square }              from 'lucide-react'
import { useQuery, useQueryClient }                     from '@tanstack/react-query'

import { toast }                  from '@/store/toastStore'
import { Button }                 from '@/components/design-system/Button'
import { PageHeader }             from '@/components/shared/PageHeader'
import { JobCardHubAuditDrawer }  from '@/components/production/JobCardHubAuditDrawer'

/* ── Types ──────────────────────────────────────────────────────────────── */
type YieldMetrics = { yieldPercent: number | null }

type JobCardRow = {
  id: string
  jobCardNumber: number
  status: string
  qaReleased: boolean
  createdAt: string
  assignedOperator: string | null
  requiredSheets: number
  sheetsIssued: number
  customer: { id: string; name: string }
  poLine: {
    id: string
    cartonName: string
    cartonSize: string | null
    quantity: number
    poNumber: string
    customerName?: string | null
  } | null
  yield?: YieldMetrics
}

type UiStatus   = 'draft' | 'ready' | 'material_pending' | 'released' | 'in_production' | 'completed'
type Readiness  = 'ready' | 'partial' | 'shortage' | 'not_mapped'

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const statusTone: Record<UiStatus, string> = {
  draft:            'bg-slate-100 text-slate-700',
  ready:            'bg-[var(--success-bg)] text-[var(--success)]',
  material_pending: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  released:         'bg-[var(--info-bg)] text-[var(--info)]',
  in_production:    'bg-[var(--info-bg)] text-[var(--info)]',
  completed:        'bg-[var(--success-bg)] text-[var(--success)]',
}

const readinessTone: Record<Readiness, string> = {
  ready:     'bg-[var(--success-bg)] text-[var(--success)]',
  partial:   'bg-[var(--warning-bg)] text-[var(--warning)]',
  shortage:  'bg-[var(--error-bg)] text-[var(--error)]',
  not_mapped: 'bg-slate-100 text-slate-700',
}

function mapStatus(row: JobCardRow): UiStatus {
  const s = String(row.status || '').toLowerCase()
  if (s === 'archived') return 'completed'
  if (s === 'closed') return 'completed'
  if (s === 'qa_released') return 'released'
  if (s === 'in_progress' || s === 'final_qc') return 'in_production'
  if (row.requiredSheets > 0 && row.sheetsIssued >= row.requiredSheets) return 'ready'
  if (row.sheetsIssued > 0) return 'material_pending'
  return 'draft'
}

function mapReadiness(row: JobCardRow): Readiness {
  if (!row.requiredSheets) return 'not_mapped'
  if (row.sheetsIssued >= row.requiredSheets) return 'ready'
  if (row.sheetsIssued > 0) return 'partial'
  return 'shortage'
}

function isDraftLike(row: JobCardRow) {
  const s = String(row.status || '').toLowerCase()
  return ['design_ready', 'pending', 'draft', 'archived'].includes(s)
}

/* ── API ─────────────────────────────────────────────────────────────────── */
async function fetchJobCards(): Promise<JobCardRow[]> {
  const res = await fetch('/api/job-cards?yieldMetrics=1', { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to load job cards')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function JobCardsPage() {
  const qc = useQueryClient()

  const [search,           setSearch]           = useState('')
  const [statusFilter,     setStatusFilter]     = useState<'all' | UiStatus>('all')
  const [readinessFilter,  setReadinessFilter]  = useState<'all' | Readiness>('all')
  const [clientFilter,     setClientFilter]     = useState<'all' | string>('all')
  const [sortBy,           setSortBy]           = useState<'jobCardNumber' | 'product' | 'client' | 'qty' | 'date'>('jobCardNumber')
  const [sortDir,          setSortDir]          = useState<'asc' | 'desc'>('desc')
  const [selected,         setSelected]         = useState<Set<string>>(new Set())
  const [auditRow,         setAuditRow]         = useState<JobCardRow | null>(null)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [busy,             setBusy]             = useState(false)

  const { data: rows = [], isLoading } = useQuery<JobCardRow[]>({
    queryKey: ['job-cards'],
    queryFn:  fetchJobCards,
  })

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['job-cards'] })
  }, [qc])

  /* ── Derived lists ────────────────────────────────────────────────── */
  const clients = useMemo(
    () =>
      Array.from(
        new Set(rows.map((r) => r.poLine?.customerName || r.customer?.name).filter(Boolean)),
      ).sort() as string[],
    [rows],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = rows.filter((r) => {
      if (String(r.status || '').toLowerCase() === 'archived') return false
      const st = mapStatus(r)
      const rd = mapReadiness(r)
      if (statusFilter !== 'all' && st !== statusFilter) return false
      if (readinessFilter !== 'all' && rd !== readinessFilter) return false
      const clientName = r.poLine?.customerName || r.customer?.name || ''
      if (clientFilter !== 'all' && clientName !== clientFilter) return false
      if (!q) return true
      const hay = [
        String(r.jobCardNumber),
        r.poLine?.cartonName || '',
        r.poLine?.customerName || r.customer?.name || '',
        r.poLine?.poNumber || '',
      ].join(' ').toLowerCase()
      return hay.includes(q)
    })

    out.sort((a, b) => {
      let av: string | number = ''
      let bv: string | number = ''
      if (sortBy === 'jobCardNumber') { av = a.jobCardNumber; bv = b.jobCardNumber }
      else if (sortBy === 'product')  { av = a.poLine?.cartonName || ''; bv = b.poLine?.cartonName || '' }
      else if (sortBy === 'client')   { av = a.poLine?.customerName || a.customer?.name || ''; bv = b.poLine?.customerName || b.customer?.name || '' }
      else if (sortBy === 'qty')      { av = a.poLine?.quantity || 0; bv = b.poLine?.quantity || 0 }
      else                            { av = new Date(a.createdAt).getTime(); bv = new Date(b.createdAt).getTime() }
      const base = av > bv ? 1 : av < bv ? -1 : 0
      return sortDir === 'asc' ? base : -base
    })
    return out
  }, [rows, search, statusFilter, readinessFilter, clientFilter, sortBy, sortDir])

  const allChecked  = filtered.length > 0 && filtered.every((r) => selected.has(r.id))
  const selectedRows = rows.filter((r) => selected.has(r.id))

  const toggleAll = () => {
    if (allChecked) setSelected(new Set())
    else setSelected(new Set(filtered.map((r) => r.id)))
  }

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* ── Bulk / single actions ────────────────────────────────────────── */
  const bulkRelease = async () => {
    const releasable = selectedRows.filter((r) => mapStatus(r) !== 'released' && mapStatus(r) !== 'completed')
    if (releasable.length === 0) return toast.error('No eligible rows for release')
    setBusy(true)
    try {
      await Promise.all(
        releasable.map((r) =>
          fetch(`/api/job-cards/${r.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'qa_released', qaReleased: true }),
          }),
        ),
      )
      toast.success(`Released ${releasable.length} job card(s)`)
      setSelected(new Set())
      refresh()
    } catch {
      toast.error('Bulk release failed')
    } finally {
      setBusy(false)
    }
  }

  const bulkArchive = async () => {
    const blocked = selectedRows.filter((r) => !isDraftLike(r))
    if (blocked.length > 0) return toast.error('Only Draft/Pending job cards can be archived')
    const reason = window.prompt('Delete reason (required):', '')?.trim() ?? ''
    if (reason.length < 3) return toast.error('Delete reason is required (min 3 characters)')
    const token = window.prompt('Second confirmation: type DELETE to continue bulk delete.', '')?.trim() ?? ''
    if (token !== 'DELETE') return
    setBusy(true)
    try {
      await Promise.all(
        selectedRows.map((r) =>
          fetch(`/api/job-cards/${r.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              status: 'archived',
              postPressRouting: { deleteMeta: { reason, by: 'job_card_queue_bulk', at: new Date().toISOString() } },
            }),
          }),
        ),
      )
      toast.success(`Deleted ${selectedRows.length} job card(s)`)
      setSelected(new Set())
      refresh()
    } catch {
      toast.error('Bulk delete failed')
    } finally {
      setBusy(false)
    }
  }

  const deleteOne = async (r: JobCardRow) => {
    if (!isDraftLike(r)) { toast.error('Only Draft/Pending job cards can be deleted'); return }
    const ok = window.confirm(`Delete JC-${r.jobCardNumber}?`)
    if (!ok) return
    const reason = window.prompt('Delete reason (required):', '')?.trim() ?? ''
    if (reason.length < 3) return toast.error('Delete reason is required (min 3 characters)')
    const token = window.prompt('Type DELETE to confirm', '')?.trim() ?? ''
    if (token !== 'DELETE') return
    const res = await fetch(`/api/job-cards/${r.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'archived',
        postPressRouting: { deleteMeta: { reason, by: 'job_card_queue_row', at: new Date().toISOString() } },
      }),
    })
    if (!res.ok) return toast.error('Delete failed')
    toast.success(`Deleted JC-${r.jobCardNumber}`)
    refresh()
  }

  const bulkAssignOperator = async () => {
    const name = window.prompt('Assign operator name')
    if (!name) return
    setBusy(true)
    try {
      await Promise.all(
        selectedRows.map((r) =>
          fetch(`/api/job-cards/${r.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignedOperator: name }),
          }),
        ),
      )
      toast.success(`Assigned operator to ${selectedRows.length} job card(s)`)
      refresh()
    } catch {
      toast.error('Bulk assign failed')
    } finally {
      setBusy(false)
    }
  }

  const clearQueue = async () => {
    setBusy(true)
    try {
      const res  = await fetch('/api/job-cards/clear-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Clear queue failed')
      toast.success(`Cleared ${data.cleared || 0} draft/pending job card(s)`)
      setClearConfirmOpen(false)
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Clear queue failed')
    } finally {
      setBusy(false)
    }
  }

  /* ── Sort header ──────────────────────────────────────────────────── */
  const sortHeader = (key: typeof sortBy, label: string) => (
    <button
      type="button"
      className="font-semibold uppercase tracking-wide text-ds-ink-muted text-xs"
      onClick={() => {
        if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        else { setSortBy(key); setSortDir('asc') }
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="p-6 space-y-4">

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Job Card Queue"
        subtitle="Customer PO → Planning → AW → Job Card"
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setClearConfirmOpen(true)}>
              Clear Job Card Queue
            </Button>
            <Link
              href="/production/job-cards/new"
              className="px-3 py-2 rounded-ds-sm bg-ds-warning text-primary-foreground text-sm"
            >
              Add Job Card
            </Link>
          </div>
        }
      />

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <div className="rounded-ds-lg border border-ds-line/50 bg-ds-card p-3 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by product/client/PO/job card"
            className="md:col-span-2 px-3 py-2 rounded-ds-sm border border-ds-line/50 bg-background text-sm"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | UiStatus)}
            className="px-3 py-2 rounded-ds-sm border border-ds-line/50 bg-background text-sm"
          >
            <option value="all">All status</option>
            <option value="draft">Draft</option>
            <option value="ready">Ready</option>
            <option value="material_pending">Material Pending</option>
            <option value="released">Released</option>
            <option value="in_production">In Production</option>
            <option value="completed">Completed</option>
          </select>
          <select
            value={readinessFilter}
            onChange={(e) => setReadinessFilter(e.target.value as 'all' | Readiness)}
            className="px-3 py-2 rounded-ds-sm border border-ds-line/50 bg-background text-sm"
          >
            <option value="all">All board readiness</option>
            <option value="ready">Ready</option>
            <option value="partial">Partial</option>
            <option value="shortage">Shortage</option>
            <option value="not_mapped">Not Mapped</option>
          </select>
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="px-3 py-2 rounded-ds-sm border border-ds-line/50 bg-background text-sm"
          >
            <option value="all">All clients</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* ── Bulk action bar ─────────────────────────────────────────── */}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-ds-sm border border-ds-line/50 bg-background px-3 py-2">
            <span className="text-sm">{selected.size} selected</span>
            <Button variant="secondary" onClick={bulkRelease}          disabled={busy}>Bulk Push / Release</Button>
            <Button variant="secondary" onClick={bulkArchive}          disabled={busy}>Bulk Delete</Button>
            <Button variant="secondary" onClick={bulkAssignOperator}   disabled={busy}>Bulk Assign Operator</Button>
            <Button variant="secondary" onClick={() => window.print()}>Bulk Print</Button>
            <Button variant="secondary" onClick={() => setSelected(new Set())}>Clear Selection</Button>
          </div>
        )}

        {/* ── Table ─────────────────────────────────────────────────── */}
        <div className="overflow-auto rounded-ds-md border border-ds-line/50">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="bg-background">
              <tr className="text-left">
                <th className="px-3 py-2 w-10">
                  <button type="button" onClick={toggleAll}>
                    {allChecked ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                  </button>
                </th>
                <th className="px-3 py-2">{sortHeader('jobCardNumber', 'Job Card No')}</th>
                <th className="px-3 py-2">{sortHeader('product', 'Product')}</th>
                <th className="px-3 py-2">{sortHeader('client', 'Client')}</th>
                <th className="px-3 py-2">PO No</th>
                <th className="px-3 py-2">{sortHeader('qty', 'Qty')}</th>
                <th className="px-3 py-2">Board Readiness</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">{sortHeader('date', 'Date')}</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-ds-ink-faint">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-ds-ink-faint">No job cards found.</td></tr>
              ) : filtered.map((r) => {
                const st = mapStatus(r)
                const rd = mapReadiness(r)
                return (
                  <tr key={r.id} className="border-t border-ds-line/40 hover:bg-background">
                    <td className="px-3 py-3">
                      <button type="button" onClick={() => toggleOne(r.id)}>
                        {selected.has(r.id) ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="px-3 py-3 cursor-pointer" onClick={() => setAuditRow(r)}>JC-{r.jobCardNumber}</td>
                    <td className="px-3 py-3 cursor-pointer" onClick={() => setAuditRow(r)}>{r.poLine?.cartonName || '-'}</td>
                    <td className="px-3 py-3">{r.poLine?.customerName || r.customer?.name || '-'}</td>
                    <td className="px-3 py-3">{r.poLine?.poNumber || '-'}</td>
                    <td className="px-3 py-3">{r.poLine?.quantity ?? 0}</td>
                    <td className="px-3 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs ${readinessTone[rd]}`}>
                        {rd.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs ${statusTone[st]}`}>
                        {st.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-3 py-3">{new Date(r.createdAt).toLocaleDateString()}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/production/job-cards/${r.id}`} className="text-xs text-ds-ink-muted hover:text-ds-warning">Open</Link>
                        <a href={`/api/job-cards/${r.id}/card-pdf`} target="_blank" rel="noreferrer" className="text-xs text-ds-ink-muted hover:text-ds-warning">Print</a>
                        {st !== 'released' && st !== 'completed' && (
                          <button
                            className="text-xs text-ds-ink-muted hover:text-ds-warning"
                            onClick={async () => {
                              const res = await fetch(`/api/job-cards/${r.id}`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'qa_released', qaReleased: true }),
                              })
                              if (!res.ok) return toast.error('Release failed')
                              toast.success('Released')
                              refresh()
                            }}
                          >
                            Release
                          </button>
                        )}
                        {isDraftLike(r) && (
                          <button className="text-xs text-[var(--error)]" onClick={() => deleteOne(r)}>
                            Delete
                          </button>
                        )}
                        <Link href={`/production/job-cards/${r.id}`} className="text-ds-ink-muted hover:text-ds-warning">
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Clear queue confirm modal ──────────────────────────────────── */}
      {clearConfirmOpen && (
        <div className="fixed inset-0 z-[120] bg-black/30 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-ds-lg bg-background border border-ds-line/50 p-4 space-y-3">
            <h3 className="text-base font-semibold">Clear Job Card Queue</h3>
            <p className="text-sm text-ds-ink-muted">
              This will remove draft/pending job cards only. Released/In Production job cards will not be deleted.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setClearConfirmOpen(false)}>Cancel</Button>
              <Button variant="primary"   onClick={clearQueue} disabled={busy}>Confirm Clear</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Audit drawer ──────────────────────────────────────────────── */}
      {auditRow && (
        <JobCardHubAuditDrawer
          jobCardId={auditRow.id}
          jobCardNumber={auditRow.jobCardNumber}
          onClose={() => setAuditRow(null)}
        />
      )}

    </div>
  )
}
