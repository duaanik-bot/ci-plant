'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdBase,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

type CartonRow = {
  id: string
  cartonName: string
  customerId: string
  customer: { id: string; name: string }
  gsm: number | null
  boardGrade: string | null
  paperType: string | null
  finishedLength: number | null
  finishedWidth: number | null
  finishedHeight: number | null
  rate: number | null
  active: boolean
}

const cellWrap = `${enterpriseTdBase} whitespace-normal break-words`

export default function CartonMasterPage() {
  const [rows, setRows] = useState<CartonRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  async function load() {
    try {
      const cartonsRes = await fetch('/api/masters/cartons')
      const cartonsJson = await cartonsRes.json()
      setRows(Array.isArray(cartonsJson) ? cartonsJson : [])
    } catch {
      toast.error('Failed to load cartons')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleDelete(c: CartonRow) {
    if (!confirm(`Delete carton "${c.cartonName}"? This action cannot be undone.`)) return
    setDeletingId(c.id)
    try {
      const res = await fetch(`/api/masters/cartons/${c.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to delete carton')
      toast.success('Carton deleted')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete carton')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleBulkDelete() {
    const targets = filtered.filter((c) => selectedIds.has(c.id))
    if (!targets.length) return
    if (!confirm(`Delete ${targets.length} carton record(s)?`)) return
    const token = prompt('Second confirmation: type DELETE to continue bulk delete.')
    if (token !== 'DELETE') return
    setBulkDeleting(true)
    let ok = 0
    let fail = 0
    for (const c of targets) {
      try {
        const res = await fetch(`/api/masters/cartons/${c.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok) toast.success(`Deleted ${ok} carton(s)`)
    if (fail) toast.error(`Failed to delete ${fail} carton(s)`)
    setBulkDeleting(false)
    setSelectedIds(new Set())
    await load()
  }

  const filtered = useMemo(() => {
    return rows.filter((c) => {
      if (search) {
        const q = search.toLowerCase()
        const size = `${c.finishedLength ?? ''}x${c.finishedWidth ?? ''}x${c.finishedHeight ?? ''}`.toLowerCase()
        const haystack = [
          c.cartonName,
          c.customer?.name || '',
          c.boardGrade || '',
          c.paperType || '',
          String(c.gsm ?? ''),
          size,
          c.active ? 'active' : 'inactive',
          c.rate != null ? String(c.rate) : '',
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [rows, search])

  if (loading) {
    return <div className="text-sm text-ds-ink-faint dark:text-ds-ink-muted">Loading cartons…</div>
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Carton Master</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSelectedIds((prev) =>
                prev.size === filtered.length ? new Set() : new Set(filtered.map((c) => c.id)),
              )
            }
            className="rounded-lg border border-ds-line/60 px-3 py-1.5 text-sm text-ds-ink"
          >
            {selectedIds.size === filtered.length && filtered.length > 0 ? 'Unselect all' : 'Select all'}
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
          <Link href="/masters/cartons/new" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
            Add carton
          </Link>
        </div>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients, board grades, GSM, size, carton..."
          className="min-h-[40px] w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground"
        />
      </div>

      <EnterpriseTableShell>
        <table className="w-full min-w-[960px] table-fixed border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && selectedIds.size === filtered.length}
                  onChange={() =>
                    setSelectedIds((prev) =>
                      prev.size === filtered.length ? new Set() : new Set(filtered.map((c) => c.id)),
                    )
                  }
                />
              </th>
              <th className={enterpriseThClass}>Carton</th>
              <th className={enterpriseThClass}>Client</th>
              <th className={enterpriseThClass}>L×W×H</th>
              <th className={enterpriseThClass}>GSM</th>
              <th className={enterpriseThClass}>Board</th>
              <th className={enterpriseThClass}>Coating</th>
              <th className={enterpriseThClass}>Rate</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.map((c) => (
              <tr key={c.id} className={enterpriseTrClass}>
                <td className={cellWrap}>
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
                <td className={`${cellWrap} font-designing-queue`}>{c?.cartonName ?? '—'}</td>
                <td className={cellWrap}>{c?.customer?.name ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>
                  {c?.finishedLength ?? '—'}×{c?.finishedWidth ?? '—'}×{c?.finishedHeight ?? '—'}
                </td>
                <td className={enterpriseTdMonoClass}>{c?.gsm ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.boardGrade ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.paperType ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>{c?.rate != null ? `₹${c.rate.toFixed(2)}` : '—'}</td>
                <td className={cellWrap}>
                  <span className={c?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {c?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={cellWrap}>
                  <Link href={`/masters/cartons/${c?.id ?? ''}`} className="mr-2 text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                  <button
                    type="button"
                    onClick={() => void handleDelete(c)}
                    disabled={deletingId === c.id}
                    className="text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-400"
                  >
                    {deletingId === c.id ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {filtered.length === 0 && (
        <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No cartons match your search.</p>
      )}
    </div>
  )
}
