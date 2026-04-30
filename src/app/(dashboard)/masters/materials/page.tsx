'use client'

import { useState, useEffect, useMemo } from 'react'
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

type Material = {
  id: string
  materialCode: string
  description: string
  unit: string
  qtyAvailable: number
  qtyReserved: number
  reorderPoint: number
  safetyStock: number
  boardType: string | null
  gsm: number | null
  supplier: { id: string; name: string } | null
  active: boolean
}

function stockHealth(available: number, reorder: number, safety: number): 'green' | 'yellow' | 'red' {
  if (available <= safety) return 'red'
  if (available <= reorder) return 'yellow'
  return 'green'
}

const DOT: Record<string, string> = {
  green: 'bg-green-500',
  yellow: 'bg-ds-warning',
  red: 'bg-red-500',
}

const cellWrap = `${enterpriseTdBase} whitespace-normal break-words align-top`

export default function MastersMaterialsPage() {
  const [list, setList] = useState<Material[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  function load() {
    fetch('/api/masters/materials')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleDelete(m: Material) {
    if (!confirm(`Delete material "${m.materialCode}"? This action cannot be undone.`)) return
    setDeletingId(m.id)
    try {
      const res = await fetch(`/api/masters/materials/${m.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to delete material')
      toast.success('Material deleted')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete material')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleBulkDelete() {
    const targets = filtered.filter((m) => selectedIds.has(m.id))
    if (!targets.length) return
    if (!confirm(`Delete ${targets.length} material record(s)?`)) return
    const token = prompt('Second confirmation: type DELETE to continue bulk delete.')
    if (token !== 'DELETE') return
    setBulkDeleting(true)
    let ok = 0
    let fail = 0
    for (const m of targets) {
      try {
        const res = await fetch(`/api/masters/materials/${m.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok) toast.success(`Deleted ${ok} material(s)`)
    if (fail) toast.error(`Failed to delete ${fail} material(s)`)
    setBulkDeleting(false)
    setSelectedIds(new Set())
    load()
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return list
    const q = search.toLowerCase().trim()
    return list.filter((m) => {
      const haystack = [
        m.materialCode,
        m.description,
        m.boardType ?? '',
        m.gsm != null ? String(m.gsm) : '',
        m.unit,
        String(m.qtyAvailable),
        String(m.qtyReserved),
        m.supplier?.name ?? '',
        m.active ? 'active' : 'inactive',
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [list, search])

  if (loading) {
    return <div className="text-sm text-ds-ink-faint dark:text-ds-ink-muted">Loading...</div>
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Board / Paper Master</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSelectedIds((prev) =>
                prev.size === filtered.length ? new Set() : new Set(filtered.map((m) => m.id)),
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
          <Link href="/masters/materials/new" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
            Add material
          </Link>
        </div>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, description, board type, GSM, supplier..."
          className="min-h-[40px] w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground"
        />
      </div>

      <EnterpriseTableShell>
        <table className="w-full min-w-[1100px] table-fixed border-collapse text-left text-sm text-[var(--text-primary)]">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && selectedIds.size === filtered.length}
                  onChange={() =>
                    setSelectedIds((prev) =>
                      prev.size === filtered.length ? new Set() : new Set(filtered.map((m) => m.id)),
                    )
                  }
                />
              </th>
              <th className={enterpriseThClass}>Stock</th>
              <th className={enterpriseThClass}>Code</th>
              <th className={enterpriseThClass}>Description</th>
              <th className={enterpriseThClass}>Board Type</th>
              <th className={enterpriseThClass}>GSM</th>
              <th className={enterpriseThClass}>Unit</th>
              <th className={enterpriseThClass}>Available</th>
              <th className={enterpriseThClass}>Reserved</th>
              <th className={enterpriseThClass}>Supplier</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.map((m) => {
              const h = stockHealth(m.qtyAvailable, m.reorderPoint, m.safetyStock)
              return (
                <tr key={m.id} className={enterpriseTrClass}>
                  <td className={`${cellWrap} w-10`}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(m.id)}
                      onChange={() =>
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(m.id)) next.delete(m.id)
                          else next.add(m.id)
                          return next
                        })
                      }
                    />
                  </td>
                  <td className={`${cellWrap} w-10`}>
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[h]}`} title={h} />
                  </td>
                  <td className={`${cellWrap} font-designing-queue`}>{m?.materialCode ?? '—'}</td>
                  <td className={cellWrap}>{m?.description ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{m?.boardType ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{m?.gsm ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{m?.unit ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{m?.qtyAvailable ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{m?.qtyReserved ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{m?.supplier?.name ?? '—'}</td>
                  <td className={cellWrap}>
                    <span className={m?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                      {m?.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className={cellWrap}>
                    <Link href={`/masters/materials/${m?.id ?? ''}`} className="mr-2 text-blue-600 hover:underline dark:text-blue-400">
                      Edit
                    </Link>
                    <button
                      type="button"
                      onClick={() => void handleDelete(m)}
                      disabled={deletingId === m.id}
                      className="text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-400"
                    >
                      {deletingId === m.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {filtered.length === 0 && (
        <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No materials match your search.</p>
      )}
    </div>
  )
}
