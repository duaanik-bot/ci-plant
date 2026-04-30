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

export default function MastersCustomersPage() {
  const [list, setList] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  function load() {
    fetch('/api/masters/customers')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load customers'))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
  }, [])

  async function deactivate(c: Customer) {
    if (!confirm(`Deactivate ${c.name}?`)) return
    const res = await fetch(`/api/masters/customers/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    })
    if (res.ok) {
      toast.success('Customer deactivated')
      load()
    } else toast.error('Failed')
  }

  async function handleDelete(c: Customer) {
    if (!confirm(`Delete customer "${c.name}"? This action cannot be undone.`)) return
    setDeletingId(c.id)
    try {
      const res = await fetch(`/api/masters/customers/${c.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to delete customer')
      toast.success('Customer deleted')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete customer')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleBulkDelete() {
    const targets = list.filter((c) => selectedIds.has(c.id))
    if (!targets.length) return
    if (!confirm(`Delete ${targets.length} customer record(s)?`)) return
    const token = prompt('Second confirmation: type DELETE to continue bulk delete.')
    if (token !== 'DELETE') return
    setBulkDeleting(true)
    let ok = 0
    let fail = 0
    for (const c of targets) {
      try {
        const res = await fetch(`/api/masters/customers/${c.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok) toast.success(`Deleted ${ok} customer(s)`)
    if (fail) toast.error(`Failed to delete ${fail} customer(s)`)
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
        <h2 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Customer Master</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSelectedIds((prev) =>
                prev.size === list.length ? new Set() : new Set(list.map((c) => c.id)),
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
            href="/masters/customers/new"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-primary-foreground hover:bg-blue-700"
          >
            Add customer
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
                      prev.size === list.length ? new Set() : new Set(list.map((c) => c.id)),
                    )
                  }
                />
              </th>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>GST</th>
              <th className={enterpriseThClass}>Contact</th>
              <th className={enterpriseThClass}>Phone</th>
              <th className={enterpriseThClass}>Credit Limit</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((c) => (
              <tr key={c.id} className={enterpriseTrClass}>
                <td className={enterpriseTdClass}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(c.id)) next.delete(c.id)
                        else next.add(c.id)
                        return next
                      })
                    }
                  />
                </td>
                <td className={enterpriseTdClass}>{c?.name ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.gstNumber ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.contactName ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.contactPhone ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>{c?.creditLimit ?? '—'}</td>
                <td className={enterpriseTdClass}>
                  <span className={c?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {c?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/customers/${c?.id ?? ''}`} className="mr-2 text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                  {c?.active && (
                    <button type="button" onClick={() => deactivate(c)} className="text-ds-ink-faint hover:underline dark:text-ds-ink-muted">
                      Deactivate
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDelete(c)}
                    disabled={deletingId === c.id}
                    className="ml-2 text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-400"
                  >
                    {deletingId === c.id ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && (
        <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No customers. Add one to get started.</p>
      )}
    </div>
  )
}
