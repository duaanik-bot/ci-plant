'use client'

/**
 * QC Instrument Master — rebuilt with ERP design system
 * ──────────────────────────────────────────────────────
 * Before: raw fetch + useEffect, browser confirm(), EnterpriseTableShell
 * After:  useQuery/useMutation, DataTable, PageHeader, KpiCard,
 *         SearchInput, Pagination, ConfirmDialog, toast
 *         Calibration overdue highlighting is preserved.
 */

import { useState }                           from 'react'
import Link                                   from 'next/link'
import { useRouter }                          from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Gauge, CheckCircle, AlertTriangle, Pencil, Trash2 } from 'lucide-react'

import { PageHeader }    from '@/components/shared/PageHeader'
import { DataTable }     from '@/components/shared/DataTable'
import { StatusBadge }   from '@/components/shared/StatusBadge'
import { KpiCard }       from '@/components/shared/KpiCard'
import { Button }        from '@/components/ui/Button'
import { SearchInput }   from '@/components/ui/SearchInput'
import { Pagination }    from '@/components/ui/Pagination'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { toast }         from '@/store/toastStore'

/* ── Types ──────────────────────────────────────────────────────────────── */
type Instrument = {
  id: string
  instrumentName: string
  specification: string | null
  range: string | null
  lastCalibration: string | null
  calibrationDue: string | null
  certificateUrl: string | null
  active: boolean
}

const PAGE_LIMIT = 20

/* ── API helpers ─────────────────────────────────────────────────────────── */
async function fetchInstruments(): Promise<Instrument[]> {
  const res = await fetch('/api/masters/instruments')
  if (!res.ok) throw new Error('Failed to load instruments')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function deleteInstrument(id: string): Promise<void> {
  const res = await fetch(`/api/masters/instruments/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error((j as { error?: string }).error ?? 'Failed to delete instrument')
  }
}

function isOverdue(dateStr: string | null): boolean {
  if (!dateStr) return false
  return new Date(dateStr) < new Date()
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function MastersInstrumentsPage() {
  const router = useRouter()
  const qc     = useQueryClient()

  const [q,            setQ]            = useState('')
  const [page,         setPage]         = useState(1)
  const [deleteTarget, setDeleteTarget] = useState<Instrument | null>(null)

  /* ── Fetch ───────────────────────────────────────────────────────────── */
  const { data: list = [], isLoading } = useQuery<Instrument[]>({
    queryKey: ['masters', 'instruments'],
    queryFn:  fetchInstruments,
  })

  /* ── Delete mutation ─────────────────────────────────────────────────── */
  const deleteMut = useMutation({
    mutationFn: deleteInstrument,
    onSuccess: () => {
      toast.success('Instrument deleted')
      void qc.invalidateQueries({ queryKey: ['masters', 'instruments'] })
      setDeleteTarget(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /* ── Filter + paginate ───────────────────────────────────────────────── */
  const ql = q.toLowerCase()
  const filtered = list.filter(i =>
    i.instrumentName.toLowerCase().includes(ql) ||
    (i.specification ?? '').toLowerCase().includes(ql) ||
    (i.range ?? '').toLowerCase().includes(ql),
  )
  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  const overdueCount = list.filter(i => isOverdue(i.calibrationDue)).length

  /* ── Column definitions ──────────────────────────────────────────────── */
  const columns = [
    {
      key:       'instrumentName',
      label:     'Name',
      className: 'font-medium',
      render:    (row: Instrument) => (
        <Link
          href={`/masters/instruments/${row.id}`}
          className="hover:text-ds-brand hover:underline"
        >
          {row.instrumentName}
        </Link>
      ),
    },
    {
      key:       'specification',
      label:     'Specification',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: Instrument) => row.specification ?? '—',
    },
    {
      key:       'range',
      label:     'Range',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: Instrument) => row.range ?? '—',
    },
    {
      key:    'active',
      label:  'Status',
      render: (row: Instrument) => (
        <StatusBadge status={row.active ? 'active' : 'inactive'} />
      ),
    },
    {
      key:       'lastCalibration',
      label:     'Last Calibration',
      className: 'font-mono text-xs text-ds-ink-muted',
      render:    (row: Instrument) => row.lastCalibration ?? '—',
    },
    {
      key:    'calibrationDue',
      label:  'Due Date',
      render: (row: Instrument) => {
        const overdue = isOverdue(row.calibrationDue)
        return row.calibrationDue ? (
          <span className={overdue ? 'font-semibold text-ds-error' : 'font-mono text-xs text-ds-ink-muted'}>
            {overdue && '⚠ '}{row.calibrationDue}
          </span>
        ) : (
          <span className="text-ds-ink-faint">—</span>
        )
      },
    },
    {
      key:    'certificateUrl',
      label:  'Certificate',
      render: (row: Instrument) =>
        row.certificateUrl ? (
          <a
            href={row.certificateUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ds-brand hover:underline text-sm"
          >
            View
          </a>
        ) : (
          <span className="text-ds-ink-faint">—</span>
        ),
    },
    {
      key:    'actions',
      label:  '',
      render: (row: Instrument) => (
        <div className="flex items-center gap-1 justify-end">
          <Link
            href={`/masters/instruments/${row.id}`}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-brand hover:bg-ds-brand/8 transition-colors"
            title="Edit"
          >
            <Pencil size={14} />
          </Link>
          <button
            onClick={() => setDeleteTarget(row)}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-error hover:bg-ds-error/8 transition-colors"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ]

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          title="Total Instruments"
          value={list.length}
          icon={Gauge}
          color="blue"
          loading={isLoading}
        />
        <KpiCard
          title="Active"
          value={list.filter(i => i.active).length}
          icon={CheckCircle}
          color="green"
          loading={isLoading}
        />
        <KpiCard
          title="Calibration Overdue"
          value={overdueCount}
          icon={AlertTriangle}
          color={overdueCount > 0 ? 'red' : 'orange'}
          loading={isLoading}
        />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="QC Instrument Master"
        subtitle="Manage calibration schedules and certificates for QC instruments"
        action={
          <Button icon={Plus} onClick={() => router.push('/masters/instruments/new')}>
            Add Instrument
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search by name, specification or range…"
          className="w-80"
        />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={
          q ? 'No instruments match your search.' : 'No instruments yet. Add one to get started.'
        }
      />

      {/* ── Pagination ────────────────────────────────────────────────── */}
      <Pagination
        page={page}
        total={filtered.length}
        limit={PAGE_LIMIT}
        onChange={setPage}
      />

      {/* ── Delete confirmation ───────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        title="Delete Instrument"
        message={`Are you sure you want to delete "${deleteTarget?.instrumentName}"? This cannot be undone.`}
        confirmLabel="Yes, Delete"
        loading={deleteMut.isPending}
      />

    </div>
  )
}
