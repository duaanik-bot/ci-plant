'use client'

/**
 * User Master — rebuilt with ERP design system
 * ─────────────────────────────────────────────
 * Before: raw fetch + useEffect, browser confirm(), EnterpriseTableShell
 * After:  useQuery/useMutation, DataTable, PageHeader, KpiCard,
 *         SearchInput, Pagination, ConfirmDialog, toast
 *         machineAccess count badge is preserved.
 */

import { useState }                           from 'react'
import Link                                   from 'next/link'
import { useRouter }                          from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Users, UserCheck, UserX, Pencil, Trash2 } from 'lucide-react'

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
type User = {
  id: string
  name: string
  email: string
  role: { id: string; roleName: string }
  whatsappNumber: string | null
  lastLoginAt: string | null
  machineAccess: string[]
  active: boolean
}

const PAGE_LIMIT = 20

/* ── API helpers ─────────────────────────────────────────────────────────── */
async function fetchUsers(): Promise<User[]> {
  const res = await fetch('/api/masters/users')
  if (!res.ok) throw new Error('Failed to load users')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`/api/masters/users/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error((j as { error?: string }).error ?? 'Failed to delete user')
  }
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function MastersUsersPage() {
  const router = useRouter()
  const qc     = useQueryClient()

  const [q,            setQ]            = useState('')
  const [page,         setPage]         = useState(1)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)

  /* ── Fetch ───────────────────────────────────────────────────────────── */
  const { data: list = [], isLoading } = useQuery<User[]>({
    queryKey: ['masters', 'users'],
    queryFn:  fetchUsers,
  })

  /* ── Delete mutation ─────────────────────────────────────────────────── */
  const deleteMut = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      toast.success('User deleted')
      void qc.invalidateQueries({ queryKey: ['masters', 'users'] })
      setDeleteTarget(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /* ── Filter + paginate ───────────────────────────────────────────────── */
  const ql = q.toLowerCase()
  const filtered = list.filter(u =>
    u.name.toLowerCase().includes(ql) ||
    u.email.toLowerCase().includes(ql) ||
    (u.role?.roleName ?? '').toLowerCase().includes(ql) ||
    (u.whatsappNumber ?? '').includes(ql),
  )
  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  /* ── Column definitions ──────────────────────────────────────────────── */
  const columns = [
    {
      key:       'name',
      label:     'Name',
      className: 'font-medium',
      render:    (row: User) => (
        <Link
          href={`/masters/users/${row.id}`}
          className="hover:text-ds-brand hover:underline"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key:       'email',
      label:     'Email',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: User) => row.email,
    },
    {
      key:       'role',
      label:     'Role',
      render:    (row: User) => (
        <span className="rounded bg-ds-elevated px-2 py-0.5 text-xs text-ds-ink-muted">
          {row.role?.roleName ?? '—'}
        </span>
      ),
    },
    {
      key:       'whatsappNumber',
      label:     'WhatsApp',
      className: 'font-mono text-xs text-ds-ink-muted',
      render:    (row: User) => row.whatsappNumber ?? '—',
    },
    {
      key:    'machineAccess',
      label:  'Machine Access',
      render: (row: User) =>
        Array.isArray(row.machineAccess) && row.machineAccess.length > 0 ? (
          <span className="rounded bg-ds-brand/10 px-2 py-0.5 text-xs font-medium text-ds-brand">
            {row.machineAccess.length} machine{row.machineAccess.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="text-ds-ink-faint">—</span>
        ),
    },
    {
      key:       'lastLoginAt',
      label:     'Last Login',
      className: 'font-mono text-xs text-ds-ink-muted',
      render:    (row: User) =>
        row.lastLoginAt
          ? new Date(row.lastLoginAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
          : '—',
    },
    {
      key:    'active',
      label:  'Status',
      render: (row: User) => (
        <StatusBadge status={row.active ? 'active' : 'inactive'} />
      ),
    },
    {
      key:    'actions',
      label:  '',
      render: (row: User) => (
        <div className="flex items-center gap-1 justify-end">
          <Link
            href={`/masters/users/${row.id}`}
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
          title="Total Users"
          value={list.length}
          icon={Users}
          color="blue"
          loading={isLoading}
        />
        <KpiCard
          title="Active"
          value={list.filter(u => u.active).length}
          icon={UserCheck}
          color="green"
          loading={isLoading}
        />
        <KpiCard
          title="Inactive"
          value={list.filter(u => !u.active).length}
          icon={UserX}
          color="orange"
          loading={isLoading}
        />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="User Master"
        subtitle="Manage system users, roles and machine access"
        action={
          <Button icon={Plus} onClick={() => router.push('/masters/users/new')}>
            Add User
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search by name, email or role…"
          className="w-80"
        />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={
          q ? 'No users match your search.' : 'No users yet. Add one to get started.'
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
        title="Delete User"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Yes, Delete"
        loading={deleteMut.isPending}
      />

    </div>
  )
}
