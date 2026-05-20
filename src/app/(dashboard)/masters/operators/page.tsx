'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { toast } from 'sonner'
import { HardHat, Search } from 'lucide-react'
import { isHubStaffAdmin } from '@/lib/hub-admin-gate'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'

type OperatorRow = {
  id: string
  name: string
  isActive: boolean
  stageKeys: string[]
}

export default function MastersOperatorsPage() {
  const { data: session, status } = useSession()
  const [rows, setRows] = useState<OperatorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const isAdmin = isHubStaffAdmin(session?.user?.role)

  const load = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const r = await fetch('/api/operator-master?all=1')
      const t = await r.text()
      const j = safeJsonParse<{ operators?: OperatorRow[]; error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Failed to load operators')
        setRows([])
        return
      }
      setRows(Array.isArray(j.operators) ? j.operators : [])
    } catch {
      toast.error('Failed to load operators')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  useEffect(() => {
    void load()
  }, [load])

  async function addOperator() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/operator-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ name: trimmed }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Failed')
      toast.success('Operator added')
      setName('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(id: string, next: boolean) {
    setSaving(true)
    try {
      const r = await fetch(`/api/operator-master/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ isActive: next }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) throw new Error(j.error ?? 'Failed')
      toast.success(next ? 'Operator activated' : 'Operator deactivated')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (!showInactive && !r.isActive) return false
      if (!q) return true
      return (
        r.name.toLowerCase().includes(q) ||
        r.stageKeys.some((k) => k.toLowerCase().includes(q))
      )
    })
  }, [rows, search, showInactive])

  const activeCount = rows.filter((r) => r.isActive).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Operator Master</h2>
          <p className="mt-0.5 text-xs text-ds-ink-faint">
            {activeCount} active operator{activeCount === 1 ? '' : 's'} on the floor.
            Station assignments come from the production-stage migration and feed every operator dropdown across the app.
          </p>
        </div>
      </div>

      {status === 'loading' ? (
        <p className="text-sm text-ds-ink-faint">Loading…</p>
      ) : !isAdmin ? (
        <div className="rounded-ds-md border border-ds-line bg-ds-card p-4 text-sm text-ds-ink-faint">
          Only administrators can manage Operator Master records. Floor staff can still select operators
          inside Die Hub and Shade Card Hub flows.
          <p className="mt-2">
            <Link href="/hub/dies" className="text-[var(--info)] hover:underline">
              Open Die Hub →
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-ds-md border border-ds-line bg-ds-card p-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ds-ink-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or station…"
                className="h-8 w-full rounded-ds-sm border border-ds-line bg-ds-bg pl-8 pr-3 text-sm text-ds-ink placeholder:text-ds-ink-faint focus:border-ds-brand focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-ds-ink-muted">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Show inactive
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-2 rounded-ds-md border border-ds-line bg-ds-card p-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-ds-ink-muted">
              Add operator
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Ravi Kumar"
                className="h-8 w-64 rounded-ds-sm border border-ds-line bg-ds-bg px-3 text-sm text-ds-ink placeholder:text-ds-ink-faint focus:border-ds-brand focus:outline-none"
              />
            </label>
            <button
              type="button"
              disabled={saving || !name.trim()}
              onClick={() => void addOperator()}
              className="inline-flex h-8 items-center gap-1.5 rounded-ds-sm bg-ds-brand px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-ds-brand-hover disabled:opacity-50"
            >
              <HardHat className="size-3.5" /> Add operator
            </button>
          </div>

          <div className="overflow-hidden rounded-ds-md border border-ds-line bg-ds-card">
            <table className="w-full text-sm">
              <thead className="bg-ds-bg-muted text-left text-xs uppercase tracking-wide text-ds-ink-faint">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Stations</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ds-line">
                {loading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-ds-ink-faint">
                      Loading operators…
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-ds-ink-faint">
                      {rows.length === 0
                        ? 'No operators yet. Add the first one above.'
                        : 'No operators match your filters.'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((o) => (
                    <tr key={o.id} className="hover:bg-ds-bg-muted/40">
                      <td className="px-3 py-2 font-medium text-ds-ink">{o.name}</td>
                      <td className="px-3 py-2">
                        {o.stageKeys.length === 0 ? (
                          <span className="text-xs text-ds-ink-faint">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {o.stageKeys.map((k) => (
                              <span
                                key={k}
                                className="inline-flex items-center rounded-ds-sm border border-ds-line bg-ds-bg-muted px-1.5 py-0.5 text-[11px] font-medium text-ds-ink"
                              >
                                {k}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {o.isActive ? (
                          <span className="inline-flex items-center rounded-ds-sm bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-ds-sm bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                            Inactive
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void toggleActive(o.id, !o.isActive)}
                          className={`inline-flex h-7 items-center rounded-ds-sm border px-2 text-[11px] font-semibold transition ${
                            o.isActive
                              ? 'border-ds-line text-ds-ink-muted hover:bg-ds-bg-muted'
                              : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                          }`}
                        >
                          {o.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-ds-ink-faint">
            Station mapping is managed via the operator-station migration. To add/remove a station for an
            operator, update <code className="rounded bg-ds-bg-muted px-1 py-0.5">machinery_operators_migration.xlsx</code>{' '}
            and rerun <code className="rounded bg-ds-bg-muted px-1 py-0.5">scripts/migrate-machinery-operators.ts</code>.
          </p>
        </>
      )}
    </div>
  )
}
