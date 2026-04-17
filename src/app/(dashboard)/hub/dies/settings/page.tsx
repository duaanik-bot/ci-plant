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
    <div className="min-h-screen bg-black text-zinc-100 p-4 md:p-6">
      <div className="max-w-[720px] mx-auto space-y-6">
        <HubCategoryNav active="dies" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Die Hub settings</h1>
            <p className="text-sm text-zinc-400 mt-1">Staff management and floor operator directory.</p>
          </div>
          <Link
            href="/hub/dies"
            className="text-sm font-semibold text-amber-400 hover:text-amber-300 border border-amber-700/60 rounded-lg px-3 py-2"
          >
            ← Back to board
          </Link>
        </div>

        {status === 'loading' ? (
          <p className="text-zinc-500">Loading…</p>
        ) : !isAdmin ? (
          <p className="text-zinc-400 text-sm rounded-lg border border-zinc-700 bg-zinc-950 p-4">
            Only administrators can manage Operator Master records. Floor staff can still select operators
            on the Die Hub board.
          </p>
        ) : loading ? (
          <p className="text-zinc-500">Loading staff…</p>
        ) : (
          <section className="rounded-xl border border-zinc-700 bg-zinc-950 p-4 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">Staff management</h2>
            <p className="text-xs text-zinc-500">
              Active operators appear in issuance and return modals. Inactive names stay in the audit history.
            </p>

            <div className="rounded-lg border border-zinc-800 bg-black/40 p-3 space-y-2">
              <h3 className="text-xs font-bold uppercase text-zinc-500">Add new operator</h3>
              <label className="block text-sm text-zinc-300">
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                  placeholder="e.g. Jane Smith"
                />
              </label>
              <button
                type="button"
                disabled={saving || !name.trim()}
                onClick={() => void addOperator()}
                className="w-full py-2 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50"
              >
                Add operator
              </button>
            </div>

            <ul className="divide-y divide-zinc-800 border border-zinc-800 rounded-lg overflow-hidden">
              {operators.length === 0 ? (
                <li className="px-3 py-6 text-center text-zinc-500 text-sm">No operators yet.</li>
              ) : (
                operators.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-black/30">
                    <div>
                      <p className="text-sm font-medium text-zinc-100">{o.name}</p>
                      <p className="text-[11px] text-zinc-500">
                        {o.isActive ? (
                          <span className="text-emerald-500 font-semibold">Active</span>
                        ) : (
                          <span className="text-zinc-600 font-semibold">Inactive</span>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void toggleActive(o.id, !o.isActive)}
                      className={`text-xs font-bold px-2 py-1 rounded border ${
                        o.isActive
                          ? 'border-zinc-600 text-zinc-300 hover:bg-zinc-900'
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
