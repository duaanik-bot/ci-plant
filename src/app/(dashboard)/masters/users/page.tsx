'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  EnterpriseTableShell,
  enterpriseTableClass,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

type User = {
  id: string
  name: string
  email: string
  role: { id: string; roleName: string }
  whatsappNumber: string | null
  lastLoginAt: string | null
  active: boolean
}

export default function MastersUsersPage() {
  const [list, setList] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  function load() {
    fetch('/api/masters/users')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleDelete(u: User) {
    if (!confirm(`Delete user "${u.name}"? This action cannot be undone.`)) return
    setDeletingId(u.id)
    try {
      const res = await fetch(`/api/masters/users/${u.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to delete user')
      toast.success('User deleted')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete user')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleBulkDelete() {
    const targets = list.filter((u) => selectedIds.has(u.id))
    if (!targets.length) return
    if (!confirm(`Delete ${targets.length} user record(s)?`)) return
    const token = prompt('Second confirmation: type DELETE to continue bulk delete.')
    if (token !== 'DELETE') return
    setBulkDeleting(true)
    let ok = 0
    let fail = 0
    for (const u of targets) {
      try {
        const res = await fetch(`/api/masters/users/${u.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok) toast.success(`Deleted ${ok} user(s)`)
    if (fail) toast.error(`Failed to delete ${fail} user(s)`)
    setBulkDeleting(false)
    setSelectedIds(new Set())
    load()
  }

  if (loading) {
    return <div className="text-sm text-ds-ink-faint dark:text-ds-ink-muted">Loading…</div>
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">User Master</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSelectedIds((prev) =>
                prev.size === list.length ? new Set() : new Set(list.map((u) => u.id)),
              )
            }
            className="rounded-lg border border-ds-line/60 px-3 py-1.5 text-sm text-ds-ink"
          >
            {selectedIds.size === list.length && list.length > 0 ? 'Unselect all' : 'Select all'}
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="rounded-lg border border-ds-line/60 px-3 py-1.5 text-sm text-ds-ink"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={selectedIds.size === 0 || bulkDeleting}
            onClick={() => void handleBulkDelete()}
            className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-sm text-rose-600 disabled:opacity-50 dark:text-rose-400"
          >
            {bulkDeleting ? 'Deleting…' : `Bulk delete (${selectedIds.size})`}
          </button>
          <Link
            href="/masters/users/new"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-primary-foreground hover:bg-blue-700"
          >
            Add user
          </Link>
        </div>
      </div>
      <EnterpriseTableShell>
        <table className={enterpriseTableClass}>
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>
                <input
                  type="checkbox"
                  checked={list.length > 0 && selectedIds.size === list.length}
                  onChange={() =>
                    setSelectedIds((prev) =>
                      prev.size === list.length ? new Set() : new Set(list.map((u) => u.id)),
                    )
                  }
                />
              </th>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>Email</th>
              <th className={enterpriseThClass}>Role</th>
              <th className={enterpriseThClass}>WhatsApp</th>
              <th className={enterpriseThClass}>Last login</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((u) => (
              <tr key={u.id} className={enterpriseTrClass}>
                <td className={enterpriseTdClass}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(u.id)}
                    onChange={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(u.id)) next.delete(u.id)
                        else next.add(u.id)
                        return next
                      })
                    }
                  />
                </td>
                <td className={enterpriseTdClass}>{u?.name ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{u?.email ?? '—'}</td>
                <td className={enterpriseTdClass}>{u?.role?.roleName ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{u?.whatsappNumber ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>
                  {u?.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}
                </td>
                <td className={enterpriseTdClass}>
                  <span className={u?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {u?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/users/${u?.id ?? ''}`} className="mr-2 text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                  <button
                    type="button"
                    onClick={() => void handleDelete(u)}
                    disabled={deletingId === u.id}
                    className="text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-400"
                  >
                    {deletingId === u.id ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No users.</p>}
    </div>
  )
}
