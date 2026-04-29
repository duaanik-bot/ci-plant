'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { toast } from 'sonner'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'
import { isHubStaffAdmin } from '@/lib/hub-admin-gate'

type OperatorRow = {
  id: string
  name: string
  isActive: boolean
}

export default function DieHubSettingsPage() {
  const { data: session, status } = useSession()
  const [operators, setOperators] = useState<OperatorRow[]>([])
  const [loading, setLoading] = useState(true)
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
        toast.error(j.error ?? 'Failed to load staff')
        setOperators([])
        return
      }
      setOperators(Array.isArray(j.operators) ? j.operators : [])
    } catch {
      toast.error('Failed to load staff')
      setOperators([])
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  useEffect(() => {
    void load()
  }, [load])

  async function addOperator() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/operator-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          name: name.trim(),
        }),
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

  return (
    <div className="min-h-screen bg-background text-ds-ink p-4 md:p-6">
      <div className="max-w-[720px] mx-auto space-y-6">
        <HubCategoryNav active="dies" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Die Hub settings</h1>
            <p className="text-sm text-neutral-500 mt-1">Staff management and floor operator directory.</p>
          </div>
          <Link
            href="/hub/dies"
            className="text-sm font-semibold text-ds-warning hover:text-ds-warning border border-ds-warning/30 rounded-lg px-3 py-2"
          >
            ← Back to board
          </Link>
        </div>

        {status === 'loading' ? (
          <p className="text-neutral-500">Loading…</p>
        ) : !isAdmin ? (
          <p className="text-neutral-500 text-sm rounded-lg border border-ds-line/50 bg-ds-main p-4">
            Only administrators can manage Operator Master records. Floor staff can still select operators
            on the Die Hub board.
          </p>
        ) : loading ? (
          <p className="text-neutral-500">Loading staff…</p>
        ) : (
          <section className="rounded-xl border border-ds-line/50 bg-ds-main p-4 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ds-warning">Staff management</h2>
            <p className="text-xs text-neutral-500">
              Active operators appear in issuance and return modals. Inactive names stay in the audit history.
            </p>

            <div className="rounded-lg border border-ds-line/40 bg-background/40 p-3 space-y-2">
              <h3 className="text-xs font-bold uppercase text-neutral-500">Add new operator</h3>
              <label className="block text-sm text-neutral-400">
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-ds-line/50 text-foreground"
                  placeholder="e.g. Jane Smith"
                />
              </label>
              <button
                type="button"
                disabled={saving || !name.trim()}
                onClick={() => void addOperator()}
                className="w-full py-2 rounded-md bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm font-bold disabled:opacity-50"
              >
                Add operator
              </button>
            </div>

            <ul className="divide-y divide-ds-elevated border border-ds-line/40 rounded-lg overflow-hidden">
              {operators.length === 0 ? (
                <li className="px-3 py-6 text-center text-neutral-500 text-sm">No operators yet.</li>
              ) : (
                operators.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-background/30">
                    <div>
                      <p className="text-sm font-medium text-ds-ink">{o.name}</p>
                      <p className="text-xs text-neutral-500">
                        {o.isActive ? (
                          <span className="text-emerald-500 font-semibold">Active</span>
                        ) : (
                          <span className="text-neutral-600 font-semibold">Inactive</span>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void toggleActive(o.id, !o.isActive)}
                      className={`text-xs font-bold px-2 py-1 rounded border ${
                        o.isActive
                          ? 'border-ds-line/50 text-neutral-400 hover:bg-ds-card'
                          : 'border-emerald-700 text-emerald-300 hover:bg-emerald-950/40'
                      }`}
                    >
                      {o.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
