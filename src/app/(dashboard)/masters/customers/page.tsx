'use client'

/**
 * Customer Master — rebuilt with ERP design system
 * ─────────────────────────────────────────────────
 * Before: raw fetch + useEffect, browser confirm(), EnterpriseTableShell
 * After:  useQuery/useMutation, DataTable, PageHeader, KpiCard,
 *         SearchInput, Pagination, ConfirmDialog, toast
 */

import { useState }                           from 'react'
import Link                                   from 'next/link'
import { useRouter }                          from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Users, UserCheck, UserX, Pencil, Trash2, PowerOff } from 'lucide-react'

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
type Customer = {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  email: string | null
  address: string | null
  creditLimit: number
  requiresArtworkApproval: boolean
  active: boolean
}

const PAGE_LIMIT = 20

/* ── API helpers ─────────────────────────────────────────────────────────── */
async function fetchCustomers(): Promise<Customer[]> {
  const res = await fetch('/api/masters/customers')
  if (!res.ok) throw new Error('Failed to load customers')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function deleteCustomer(id: string): Promise<void> {
  const res = await fetch(`/api/masters/customers/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error((j as { error?: string }).error ?? 'Failed to delete customer')
  }
}

async function deactivateCustomer(id: string): Promise<void> {
  const res = await fetch(`/api/masters/customers/${id}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ active: false }),
  })
  if (!res.ok) throw new Error('Failed to deactivate customer')
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function MastersCustomersPage() {
  const router = useRouter()
  const qc     = useQueryClient()

  const [q,                setQ]                = useState('')
  const [page,             setPage]             = useState(1)
  const [deleteTarget,     setDeleteTarget]     = useState<Customer | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<Customer | null>(null)

  /* ── Fetch ───────────────────────────────────────────────────────────── */
  const { data: list = [], isLoading } = useQuery<Customer[]>({
    queryKey: ['masters', 'customers'],
    queryFn:  fetchCustomers,
  })

  /* ── Delete mutation ─────────────────────────────────────────────────── */
  const deleteMut = useMutation({
    mutationFn: deleteCustomer,
    onSuccess: () => {
      toast.success('Customer deleted')
      void qc.invalidateQueries({ queryKey: ['masters', 'customers'] })
      setDeleteTarget(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /* ── Deactivate mutation ─────────────────────────────────────────────── */
  const deactivateMut = useMutation({
    mutationFn: deactivateCustomer,
    onSuccess: () => {
      toast.success('Customer deactivated')
      void qc.invalidateQueries({ queryKey: ['masters', 'customers'] })
      setDeactivateTarget(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /* ── Filter + paginate ───────────────────────────────────────────────── */
  const ql = q.toLowerCase()
  const filtered = list.filter(c =>
    c.name.toLowerCase().includes(ql) ||
    (c.gstNumber   ?? '').toLowerCase().includes(ql) ||
    (c.contactName ?? '').toLowerCase().includes(ql) ||
    (c.email       ?? '').toLowerCase().includes(ql),
  )
  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  /* ── Column definitions ──────────────────────────────────────────────── */
  const columns = [
    {
      key:       'name',
      label:     'Name',
      className: 'font-medium',
      render:    (row: Customer) => (
        <Link
          href={`/masters/customers/${row.id}`}
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
      render:    (row: Customer) => row.gstNumber ?? '—',
    },
    {
      key:    'contactName',
      label:  'Contact',
      render: (row: Customer) => (
        <div>
          <div className="text-ds-ink">{row.contactName ?? '—'}</div>
          {row.contactPhone && (
            <div className="text-xs text-ds-ink-faint">{row.contactPhone}</div>
          )}
        </div>
      ),
    },
    {
      key:       'email',
      label:     'Email',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: Customer) => row.email ?? '—',
    },
    {
      key:       'creditLimit',
      label:     'Credit Limit',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: Customer) =>
        row.creditLimit != null
          ? `₹${row.creditLimit.toLocaleString('en-IN')}`
          : '—',
    },
    {
      key:    'active',
      label:  'Status',
      render: (row: Customer) => (
        <StatusBadge status={row.active ? 'active' : 'inactive'} />
      ),
    },
    {
      key:    'actions',
      label:  '',
      render: (row: Customer) => (
        <div className="flex items-center gap-1 justify-end">
          <Link
            href={`/masters/customers/${row.id}`}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-brand hover:bg-ds-brand/8 transition-colors"
            title="Edit"
          >
            <Pencil size={14} />
          </Link>
          {row.active && (
            <button
              onClick={() => setDeactivateTarget(row)}
              className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-orange-500 hover:bg-orange-50 transition-colors"
              title="Deactivate"
            >
              <PowerOff size={14} />
            </button>
          )}
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
          title="Total Customers"
          value={list.length}
          icon={Users}
          color="blue"
          loading={isLoading}
        />
        <KpiCard
          title="Active"
          value={list.filter(c => c.active).length}
          icon={UserCheck}
          color="green"
          loading={isLoading}
        />
        <KpiCard
          title="Inactive"
          value={list.filter(c => !c.active).length}
          icon={UserX}
          color="orange"
          loading={isLoading}
        />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Customer Master"
        subtitle="Manage your customer accounts and credit limits"
        action={
          <Button icon={Plus} onClick={() => router.push('/masters/customers/new')}>
            Add Customer
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search by name, GST, contact or email…"
          className="w-80"
        />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={
          q ? 'No customers match your search.' : 'No customers yet. Add one to get started.'
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
        title="Delete Customer"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Yes, Delete"
        loading={deleteMut.isPending}
      />

      {/* ── Deactivate confirmation ───────────────────────────────────── */}
      <ConfirmDialog
        open={!!deactivateTarget}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={() => deactivateTarget && deactivateMut.mutate(deactivateTarget.id)}
        title="Deactivate Customer"
        message={`Deactivate "${deactivateTarget?.name}"? They will no longer appear in active lookups.`}
        confirmLabel="Yes, Deactivate"
        loading={deactivateMut.isPending}
      />

    </div>
  )
}
