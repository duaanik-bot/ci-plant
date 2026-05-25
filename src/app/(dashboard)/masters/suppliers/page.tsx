'use client'

/**
 * Supplier Master — rebuilt with ERP design system
 * ─────────────────────────────────────────────────
 * Before: raw fetch + useEffect, browser confirm(), EnterpriseTableShell
 * After:  useQuery/useMutation, DataTable, PageHeader, KpiCard,
 *         SearchInput, Pagination, ConfirmDialog, toast
 */

import { useState }                           from 'react'
import Link                                   from 'next/link'
import { useRouter }                          from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Truck, CheckCircle, XCircle, Pencil, Trash2 } from 'lucide-react'

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
type Supplier = {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  materialTypes: string[]
  leadTimeDays: number
  paymentTerms: string | null
  paymentTermsDays: number | null
  active: boolean
}

const PAGE_LIMIT = 20

/* ── API helpers ─────────────────────────────────────────────────────────── */
async function fetchSuppliers(): Promise<Supplier[]> {
  const res = await fetch('/api/masters/suppliers')
  if (!res.ok) throw new Error('Failed to load suppliers')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function deleteSupplier(id: string): Promise<void> {
  const res = await fetch(`/api/masters/suppliers/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error((j as { error?: string }).error ?? 'Failed to delete supplier')
  }
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function MastersSuppliersPage() {
  const router = useRouter()
  const qc     = useQueryClient()

  const [q,             setQ]             = useState('')
  const [page,          setPage]          = useState(1)
  const [deleteTarget,  setDeleteTarget]  = useState<Supplier | null>(null)

  /* ── Fetch ───────────────────────────────────────────────────────────── */
  const { data: list = [], isLoading } = useQuery<Supplier[]>({
    queryKey: ['masters', 'suppliers'],
    queryFn:  fetchSuppliers,
  })

  /* ── Delete mutation ─────────────────────────────────────────────────── */
  const deleteMut = useMutation({
    mutationFn: deleteSupplier,
    onSuccess: () => {
      toast.success('Supplier deleted')
      void qc.invalidateQueries({ queryKey: ['masters', 'suppliers'] })
      setDeleteTarget(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /* ── Filter + paginate ───────────────────────────────────────────────── */
  const ql = q.toLowerCase()
  const filtered = list.filter(s =>
    s.name.toLowerCase().includes(ql) ||
    (s.gstNumber   ?? '').toLowerCase().includes(ql) ||
    (s.contactName ?? '').toLowerCase().includes(ql) ||
    (s.materialTypes ?? []).join(' ').toLowerCase().includes(ql),
  )
  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  /* ── Column definitions ──────────────────────────────────────────────── */
  const columns = [
    {
      key:       'name',
      label:     'Name',
      className: 'font-medium',
      render:    (row: Supplier) => (
        <Link
          href={`/masters/suppliers/${row.id}`}
          className="hover:text-ds-brand hover:underline"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key:       'gstNumber',
      label:     'GST No.',
      className: 'font-mono text-xs text-ds-ink-muted',
      render:    (row: Supplier) => row.gstNumber ?? '—',
    },
    {
      key:    'contactName',
      label:  'Contact',
      render: (row: Supplier) => (
        <div>
          <div className="text-ds-ink">{row.contactName ?? '—'}</div>
          {row.contactPhone && (
            <div className="text-xs text-ds-ink-faint">{row.contactPhone}</div>
          )}
        </div>
      ),
    },
    {
      key:    'materialTypes',
      label:  'Material Types',
      render: (row: Supplier) =>
        row.materialTypes?.length ? (
          <div className="flex flex-wrap gap-1">
            {row.materialTypes.map((t) => (
              <span
                key={t}
                className="rounded bg-ds-elevated px-1.5 py-0.5 text-xs text-ds-ink-muted"
              >
                {t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-ds-ink-faint">—</span>
        ),
    },
    {
      key:       'leadTimeDays',
      label:     'Lead Time',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: Supplier) => `${row.leadTimeDays} days`,
    },
    {
      key:    'paymentTerms',
      label:  'Payment Terms',
      render: (row: Supplier) =>
        row.paymentTerms == null && row.paymentTermsDays == null
          ? '—'
          : `${row.paymentTerms ?? '—'}${row.paymentTermsDays != null ? ` (${row.paymentTermsDays} days)` : ''}`,
    },
    {
      key:    'active',
      label:  'Status',
      render: (row: Supplier) => (
        <StatusBadge status={row.active ? 'active' : 'inactive'} />
      ),
    },
    {
      key:    'actions',
      label:  '',
      render: (row: Supplier) => (
        <div className="flex items-center gap-1 justify-end">
          <Link
            href={`/masters/suppliers/${row.id}`}
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
          title="Total Suppliers"
          value={list.length}
          icon={Truck}
          color="blue"
          loading={isLoading}
        />
        <KpiCard
          title="Active"
          value={list.filter(s => s.active).length}
          icon={CheckCircle}
          color="green"
          loading={isLoading}
        />
        <KpiCard
          title="Inactive"
          value={list.filter(s => !s.active).length}
          icon={XCircle}
          color="orange"
          loading={isLoading}
        />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Supplier Master"
        subtitle="Manage your supplier accounts and material sourcing"
        action={
          <Button icon={Plus} onClick={() => router.push('/masters/suppliers/new')}>
            Add Supplier
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search by name, GST, contact or material type…"
          className="w-80"
        />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={
          q ? 'No suppliers match your search.' : 'No suppliers yet. Add one to get started.'
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
        title="Delete Supplier"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Yes, Delete"
        loading={deleteMut.isPending}
      />

    </div>
  )
}
