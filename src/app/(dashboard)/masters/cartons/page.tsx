'use client'

/**
 * Carton Master — rebuilt with ERP design system
 * ─────────────────────────────────────────────────
 * Before: raw fetch + useEffect, browser confirm(), EnterpriseTableShell
 * After:  useQuery/useMutation, DataTable, PageHeader, KpiCard,
 *         SearchInput, Pagination, ConfirmDialog, toast
 *         AI-imported badge (source === 'po_import_ai') is preserved.
 */

import { useState }                           from 'react'
import Link                                   from 'next/link'
import { useRouter }                          from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Box, CheckCircle, XCircle, Pencil, Trash2, Sparkles } from 'lucide-react'

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
type CartonRow = {
  id: string
  cartonName: string
  customerId: string
  customer: { id: string; name: string }
  gsm: number | null
  boardGrade: string | null
  paperType: string | null
  coatingType: string | null
  finishedLength: number | null
  finishedWidth: number | null
  finishedHeight: number | null
  rate: number | null
  active: boolean
  source: string | null
}

const PAGE_LIMIT = 20

/* ── API helpers ─────────────────────────────────────────────────────────── */
async function fetchCartons(): Promise<CartonRow[]> {
  const res = await fetch('/api/masters/cartons')
  if (!res.ok) throw new Error('Failed to load cartons')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function deleteCarton(id: string): Promise<void> {
  const res = await fetch(`/api/masters/cartons/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error((j as { error?: string }).error ?? 'Failed to delete carton')
  }
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function CartonMasterPage() {
  const router = useRouter()
  const qc     = useQueryClient()

  const [q,            setQ]            = useState('')
  const [page,         setPage]         = useState(1)
  const [deleteTarget, setDeleteTarget] = useState<CartonRow | null>(null)

  /* ── Fetch ───────────────────────────────────────────────────────────── */
  const { data: list = [], isLoading } = useQuery<CartonRow[]>({
    queryKey: ['masters', 'cartons'],
    queryFn:  fetchCartons,
  })

  /* ── Delete mutation ─────────────────────────────────────────────────── */
  const deleteMut = useMutation({
    mutationFn: deleteCarton,
    onSuccess: () => {
      toast.success('Carton deleted')
      void qc.invalidateQueries({ queryKey: ['masters', 'cartons'] })
      setDeleteTarget(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /* ── Filter + paginate ───────────────────────────────────────────────── */
  const ql = q.toLowerCase()
  const filtered = list.filter(c => {
    if (!ql) return true
    const size = `${c.finishedLength ?? ''}x${c.finishedWidth ?? ''}x${c.finishedHeight ?? ''}`
    return [
      c.cartonName,
      c.customer?.name ?? '',
      c.boardGrade ?? '',
      c.paperType ?? '',
      String(c.gsm ?? ''),
      size,
      c.active ? 'active' : 'inactive',
      c.rate != null ? String(c.rate) : '',
      c.source === 'po_import_ai' ? 'ai imported' : '',
    ].join(' ').toLowerCase().includes(ql)
  })
  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  const aiImportedCount = list.filter(c => c.source === 'po_import_ai').length

  /* ── Column definitions ──────────────────────────────────────────────── */
  const columns = [
    {
      key:    'cartonName',
      label:  'Carton',
      render: (row: CartonRow) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/masters/cartons/${row.id}`}
            className="font-medium hover:text-ds-brand hover:underline"
          >
            {row.cartonName}
          </Link>
          {row.source === 'po_import_ai' && (
            <span
              title="Auto-created from a PO PDF import — please verify before relying on for matching."
              className="inline-flex items-center gap-0.5 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300"
            >
              <Sparkles size={9} />
              AI
            </span>
          )}
        </div>
      ),
    },
    {
      key:       'customer',
      label:     'Client',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: CartonRow) => row.customer?.name ?? '—',
    },
    {
      key:       'dimensions',
      label:     'L×W×H',
      className: 'font-mono text-xs',
      render:    (row: CartonRow) =>
        `${row.finishedLength ?? '—'}×${row.finishedWidth ?? '—'}×${row.finishedHeight ?? '—'}`,
    },
    {
      key:       'gsm',
      label:     'GSM',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: CartonRow) => row.gsm ?? '—',
    },
    {
      key:       'boardGrade',
      label:     'Board',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: CartonRow) => row.boardGrade ?? '—',
    },
    {
      key:       'coatingType',
      label:     'Coating',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: CartonRow) => row.coatingType ?? '—',
    },
    {
      key:       'rate',
      label:     'Rate',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: CartonRow) =>
        row.rate != null ? `₹${row.rate.toFixed(2)}` : '—',
    },
    {
      key:    'active',
      label:  'Status',
      render: (row: CartonRow) => (
        <StatusBadge status={row.active ? 'active' : 'inactive'} />
      ),
    },
    {
      key:    'actions',
      label:  '',
      render: (row: CartonRow) => (
        <div className="flex items-center gap-1 justify-end">
          <Link
            href={`/masters/cartons/${row.id}`}
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
          title="Total Cartons"
          value={list.length}
          icon={Box}
          color="blue"
          loading={isLoading}
        />
        <KpiCard
          title="Active"
          value={list.filter(c => c.active).length}
          icon={CheckCircle}
          color="green"
          loading={isLoading}
        />
        <KpiCard
          title="AI Imported"
          value={aiImportedCount}
          icon={Sparkles}
          color={aiImportedCount > 0 ? 'orange' : 'slate'}
          loading={isLoading}
        />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Carton Master"
        subtitle="Manage carton specifications, board grades and pricing"
        action={
          <Button icon={Plus} onClick={() => router.push('/masters/cartons/new')}>
            Add Carton
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search by name, client, board grade, GSM, size…"
          className="w-96"
        />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={
          q ? 'No cartons match your search.' : 'No cartons yet. Add one to get started.'
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
        title="Delete Carton"
        message={`Are you sure you want to delete "${deleteTarget?.cartonName}"? This cannot be undone.`}
        confirmLabel="Yes, Delete"
        loading={deleteMut.isPending}
      />
    </div>
  )
}
