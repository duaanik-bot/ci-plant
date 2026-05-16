'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

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

export default function MastersInstrumentsPage() {
  const [list, setList] = useState<Instrument[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  function load() {
    fetch('/api/masters/instruments')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleDelete(i: Instrument) {
    if (!confirm(`Delete instrument "${i.instrumentName}"? This action cannot be undone.`)) return
    setDeletingId(i.id)
    try {
      const res = await fetch(`/api/masters/instruments/${i.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to delete instrument')
      toast.success('Instrument deleted')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete instrument')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleBulkDelete() {
    const targets = list.filter((i) => selectedIds.has(i.id))
    if (!targets.length) return
    if (!confirm(`Delete ${targets.length} instrument record(s)?`)) return
    const token = prompt('Second confirmation: type DELETE to continue bulk delete.')
    if (token !== 'DELETE') return
    setBulkDeleting(true)
    let ok = 0
    let fail = 0
    for (const i of targets) {
      try {
        const res = await fetch(`/api/masters/instruments/${i.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok) toast.success(`Deleted ${ok} instrument(s)`)
    if (fail) toast.error(`Failed to delete ${fail} instrument(s)`)
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
        <h2 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">QC Instrument Master</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSelectedIds((prev) =>
                prev.size === list.length ? new Set() : new Set(list.map((i) => i.id)),
              )
            }
            className="rounded-ds-md border border-ds-line/60 px-3 py-1.5 text-sm text-ds-ink"
          >
            {selectedIds.size === list.length && list.length > 0 ? 'Unselect all' : 'Select all'}
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="rounded-ds-md border border-ds-line/60 px-3 py-1.5 text-sm text-ds-ink"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={selectedIds.size === 0 || bulkDeleting}
            onClick={() => void handleBulkDelete()}
            className="rounded-ds-md border border-[var(--error)]/40 px-3 py-1.5 text-sm text-[var(--error)] disabled:opacity-50 dark:text-[var(--error)]"
          >
            {bulkDeleting ? 'Deleting…' : `Bulk delete (${selectedIds.size})`}
          </button>
          <Link
            href="/masters/instruments/new"
            className="rounded-ds-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          >
            Add instrument
          </Link>
        </div>
      </div>
      <EnterpriseTableShell>
        <table className="w-full border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>
                <input
                  type="checkbox"
                  checked={list.length > 0 && selectedIds.size === list.length}
                  onChange={() =>
                    setSelectedIds((prev) =>
                      prev.size === list.length ? new Set() : new Set(list.map((i) => i.id)),
                    )
                  }
                />
              </th>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>Specification</th>
              <th className={enterpriseThClass}>Range</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Last calibration</th>
              <th className={enterpriseThClass}>Due date</th>
              <th className={enterpriseThClass}>Certificate</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((i) => (
              <tr key={i.id} className={enterpriseTrClass}>
                <td className={enterpriseTdClass}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(i.id)}
                    onChange={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(i.id)) next.delete(i.id)
                        else next.add(i.id)
                        return next
                      })
                    }
                  />
                </td>
                <td className={enterpriseTdClass}>{i?.instrumentName ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{i?.specification ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{i?.range ?? '—'}</td>
                <td className={enterpriseTdClass}>
                  <span
                    className={
                      i?.active
                        ? 'rounded bg-[var(--success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--success)]'
                        : 'rounded bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-ds-elevated dark:text-ds-ink-muted'
                    }
                  >
                    {i?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={enterpriseTdMonoClass}>{i?.lastCalibration ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>
                  <span
                    className={
                      i?.calibrationDue && new Date(i.calibrationDue) < new Date()
                        ? 'font-medium text-[var(--error)] dark:text-[var(--error)]'
                        : ''
                    }
                  >
                    {i?.calibrationDue ?? '—'}
                  </span>
                </td>
                <td className={enterpriseTdClass}>
                  {i?.certificateUrl ? (
                    <a
                      href={i.certificateUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--info)] hover:underline dark:text-[var(--info)]"
                    >
                      View
                    </a>
                  ) : (
                    <span className="text-ds-ink-faint">—</span>
                  )}
                </td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/instruments/${i?.id ?? ''}`} className="mr-2 text-[var(--info)] hover:underline dark:text-[var(--info)]">
                    Edit
                  </Link>
                  <button
                    type="button"
                    onClick={() => void handleDelete(i)}
                    disabled={deletingId === i.id}
                    className="text-[var(--error)] hover:underline disabled:opacity-50 dark:text-[var(--error)]"
                  >
                    {deletingId === i.id ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No instruments. Run seed.</p>}
    </div>
  )
}
