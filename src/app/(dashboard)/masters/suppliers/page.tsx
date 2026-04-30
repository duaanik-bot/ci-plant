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
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

type Supplier = {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  materialTypes: string[]
  leadTimeDays: number
  active: boolean
}

export default function MastersSuppliersPage() {
  const [list, setList] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  function load() {
    fetch('/api/masters/suppliers')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleDelete(s: Supplier) {
    if (!confirm(`Delete supplier "${s.name}"? This action cannot be undone.`)) return
    setDeletingId(s.id)
    try {
      const res = await fetch(`/api/masters/suppliers/${s.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to delete supplier')
      toast.success('Supplier deleted')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete supplier')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleBulkDelete() {
    const targets = list.filter((s) => selectedIds.has(s.id))
    if (!targets.length) return
    if (!confirm(`Delete ${targets.length} supplier record(s)?`)) return
    const token = prompt('Second confirmation: type DELETE to continue bulk delete.')
    if (token !== 'DELETE') return
    setBulkDeleting(true)
    let ok = 0
    let fail = 0
    for (const s of targets) {
      try {
        const res = await fetch(`/api/masters/suppliers/${s.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok) toast.success(`Deleted ${ok} supplier(s)`)
    if (fail) toast.error(`Failed to delete ${fail} supplier(s)`)
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
        <h2 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Supplier Master</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSelectedIds((prev) =>
                prev.size === list.length ? new Set() : new Set(list.map((s) => s.id)),
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
            href="/masters/suppliers/new"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-primary-foreground hover:bg-blue-700"
          >
            Add supplier
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
                      prev.size === list.length ? new Set() : new Set(list.map((s) => s.id)),
                    )
                  }
                />
              </th>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>GST</th>
              <th className={enterpriseThClass}>Contact</th>
              <th className={enterpriseThClass}>Material types</th>
              <th className={enterpriseThClass}>Lead time</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((s) => (
              <tr key={s.id} className={enterpriseTrClass}>
                <td className={enterpriseTdClass}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    onChange={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(s.id)) next.delete(s.id)
                        else next.add(s.id)
                        return next
                      })
                    }
                  />
                </td>
                <td className={enterpriseTdClass}>{s?.name ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{s?.gstNumber ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{s?.contactName ?? '—'}</td>
                <td className={`${enterpriseTdClass} max-w-[14rem]`}>
                  {s?.materialTypes?.length
                    ? s.materialTypes.map((t) => (
                        <span key={t} className="mr-1 inline-block rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-800 dark:bg-ds-elevated dark:text-ds-ink">
                          {t}
                        </span>
                      ))
                    : '—'}
                </td>
                <td className={enterpriseTdClass}>{s?.leadTimeDays ?? '—'} days</td>
                <td className={enterpriseTdClass}>
                  <span className={s?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {s?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/suppliers/${s?.id ?? ''}`} className="mr-2 text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                  <button
                    type="button"
                    onClick={() => void handleDelete(s)}
                    disabled={deletingId === s.id}
                    className="text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-400"
                  >
                    {deletingId === s.id ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No suppliers.</p>}
    </div>
  )
}
