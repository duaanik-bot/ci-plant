'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { MachineHealthMeter } from '@/components/industrial/MachineHealthMeter'
import { PmSpotlightDrawer } from '@/components/industrial/PmSpotlightDrawer'
import {
  EnterpriseTableShell,
  enterpriseTableClass,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdBase,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type Machine = {
  id: string
  machineCode: string
  name: string
  make: string | null
  specification: string | null
  capacityPerShift: number
  stdWastePct: number
  status: string
  lastPmDate: string | null
  nextPmDue: string | null
}

type PmRow = {
  machineId: string
  healthPct: number
  hasSchedule: boolean
  overdue: boolean
  usageRunHours: number
  usageImpressions: string
}

export default function MastersMachinesPage() {
  const [list, setList] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [pmById, setPmById] = useState<Record<string, PmRow>>({})
  const [pmMachineId, setPmMachineId] = useState<string | null>(null)

  function load() {
    Promise.all([fetch('/api/masters/machines'), fetch('/api/production/machine-health')])
      .then(async ([machRes, pmRes]) => {
        const data = await machRes.json()
        const pmJson = await pmRes.json()
        setList(Array.isArray(data) ? data : [])
        const map: Record<string, PmRow> = {}
        if (pmJson.machines && Array.isArray(pmJson.machines)) {
          for (const row of pmJson.machines as PmRow[]) {
            map[row.machineId] = row
          }
        }
        setPmById(map)
      })
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleDelete(m: Machine) {
    if (!confirm(`Delete machine "${m.machineCode}"? This action cannot be undone.`)) return
    setDeletingId(m.id)
    try {
      const res = await fetch(`/api/masters/machines/${m.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to delete machine')
      toast.success('Machine deleted')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete machine')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleBulkDelete() {
    const targets = list.filter((m) => selectedIds.has(m.id))
    if (!targets.length) return
    if (!confirm(`Delete ${targets.length} machine record(s)?`)) return
    const token = prompt('Second confirmation: type DELETE to continue bulk delete.')
    if (token !== 'DELETE') return
    setBulkDeleting(true)
    let ok = 0
    let fail = 0
    for (const m of targets) {
      try {
        const res = await fetch(`/api/masters/machines/${m.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok) toast.success(`Deleted ${ok} machine(s)`)
    if (fail) toast.error(`Failed to delete ${fail} machine(s)`)
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
        <h2 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Machine Master (CI-01 to CI-12)</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSelectedIds((prev) =>
                prev.size === list.length ? new Set() : new Set(list.map((m) => m.id)),
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
        </div>
      </div>
      <EnterpriseTableShell>
        <table className={`w-full min-w-[900px] border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink ${mono}`}>
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>
                <input
                  type="checkbox"
                  checked={list.length > 0 && selectedIds.size === list.length}
                  onChange={() =>
                    setSelectedIds((prev) =>
                      prev.size === list.length ? new Set() : new Set(list.map((m) => m.id)),
                    )
                  }
                />
              </th>
              <th className={enterpriseThClass}>Code</th>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>Health</th>
              <th className={enterpriseThClass}>PM usage</th>
              <th className={enterpriseThClass}>Make</th>
              <th className={enterpriseThClass}>Capacity/Shift</th>
              <th className={enterpriseThClass}>Std Waste %</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Last PM</th>
              <th className={enterpriseThClass}>Next PM Due</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((m) => {
              const pm = pmById[m.id]
              return (
                <tr
                  key={m.id}
                  className={`${enterpriseTrClass} ${pm?.overdue ? 'bg-rose-50 dark:bg-rose-950/20' : ''}`}
                >
                  <td className={enterpriseTdClass}>
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
                  <td className={`${enterpriseTdClass} text-ds-warning dark:text-ds-warning`}>{m?.machineCode ?? '—'}</td>
                  <td className={enterpriseTdClass}>{m?.name ?? '—'}</td>
                  <td className={enterpriseTdBase}>
                    {pm?.hasSchedule ? (
                      <MachineHealthMeter
                        healthPct={pm.healthPct}
                        hasSchedule
                        onClick={() => setPmMachineId(m.id)}
                      />
                    ) : (
                      <MachineHealthMeter healthPct={0} hasSchedule={false} />
                    )}
                  </td>
                  <td className={enterpriseTdMutedClass}>
                    {pm?.hasSchedule ? `${pm.usageRunHours}h · ${pm.usageImpressions}` : '—'}
                  </td>
                  <td className={enterpriseTdMutedClass}>{m?.make ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{(m?.capacityPerShift ?? 0).toLocaleString()}</td>
                  <td className={enterpriseTdMonoClass}>{m?.stdWastePct ?? '—'}%</td>
                  <td className={enterpriseTdClass}>
                    <span
                      className={
                        m?.status === 'active'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : m?.status === 'under_maintenance'
                            ? 'text-ds-warning dark:text-ds-warning'
                            : 'text-rose-600 dark:text-rose-400'
                      }
                    >
                      {(m?.status ?? '—').replace('_', ' ')}
                    </span>
                  </td>
                  <td className={enterpriseTdMonoClass}>{m?.lastPmDate ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>
                    <span className={m?.nextPmDue && new Date(m.nextPmDue) < new Date() ? 'text-rose-600 dark:text-rose-400' : ''}>
                      {m?.nextPmDue ?? '—'}
                    </span>
                  </td>
                  <td className={enterpriseTdClass}>
                    <Link href={`/masters/machines/${m?.id ?? ''}`} className="mr-2 text-blue-600 hover:underline dark:text-blue-400">
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
      {list.length === 0 && <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No machines. Run seed.</p>}
      <PmSpotlightDrawer machineId={pmMachineId} onClose={() => setPmMachineId(null)} />
    </div>
  )
}
