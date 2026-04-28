'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { toast } from 'sonner'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type CuttingStatus = 'pending' | 'assigned' | 'running' | 'completed'

type JobCardRow = {
  id: string
  jobCardNumber: number
  status: string
  poLine: {
    id: string
    cartonName: string
    cartonSize: string | null
    quantity: number
    poNumber: string
    dyeNumber: number | null
    materialQueue: {
      boardType: string
      gsm: number
      ups: number
      totalSheets: number
    } | null
  } | null
  stages?: { id: string; stageName: string; status: string; operator: string | null }[]
}

type LocalCuttingMeta = {
  stage: 'cutting'
  status: CuttingStatus
  operatorId: string | null
  operatorName: string | null
  machineId: string | null
  priority: 'normal' | 'high' | 'critical'
}

function statusTone(status: CuttingStatus): string {
  switch (status) {
    case 'completed':
      return 'border-emerald-600/50 text-emerald-300 bg-emerald-500/10'
    case 'running':
      return 'border-sky-600/50 text-sky-300 bg-sky-500/10'
    case 'assigned':
      return 'border-ds-warning/60 text-ds-warning bg-ds-warning/10'
    default:
      return 'border-ds-line/40 text-ds-ink-faint bg-ds-main/30'
  }
}

export default function CuttingQueuePage() {
  const { data: session } = useSession()
  const [rows, setRows] = useState<JobCardRow[]>([])
  const [metaByJob, setMetaByJob] = useState<Record<string, LocalCuttingMeta>>({})
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([])
  const [machines, setMachines] = useState<Array<{ id: string; machineCode: string; name: string }>>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const deriveInitialStatus = useCallback((row: JobCardRow): CuttingStatus => {
    const cutting = (row.stages ?? []).find((s) => s.stageName === 'Cutting')
    if (!cutting) return 'pending'
    if (cutting.status === 'completed') return 'completed'
    if (cutting.status === 'in_progress') return 'running'
    if (cutting.status === 'ready' && (cutting.operator || '').trim()) return 'assigned'
    return 'pending'
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [jcRes, uRes, mRes] = await Promise.all([
        fetch('/api/job-cards'),
        fetch('/api/users'),
        fetch('/api/machines'),
      ])
      const jcData = await jcRes.json()
      const userData = await uRes.json()
      const machineData = await mRes.json()

      if (!jcRes.ok) throw new Error(jcData?.error || 'Failed to load job cards')

      const allRows = (Array.isArray(jcData) ? jcData : []) as JobCardRow[]
      const cuttingRows = allRows.filter((j) => {
        const hasCutting = (j.stages ?? []).some((s) => s.stageName === 'Cutting')
        return hasCutting && j.poLine != null
      })

      setRows(cuttingRows)
      setUsers(Array.isArray(userData) ? userData : [])
      setMachines(Array.isArray(machineData) ? machineData : [])
      setMetaByJob((prev) => {
        const next = { ...prev }
        for (const row of cuttingRows) {
          if (next[row.id]) continue
          const cutting = (row.stages ?? []).find((s) => s.stageName === 'Cutting')
          next[row.id] = {
            stage: 'cutting',
            status: deriveInitialStatus(row),
            operatorId: null,
            operatorName: cutting?.operator ?? null,
            machineId: null,
            priority: 'normal',
          }
        }
        return next
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [deriveInitialStatus])

  useEffect(() => {
    void load()
  }, [load])

  const visibleRows = useMemo(() => {
    const role = String((session?.user as { role?: string } | undefined)?.role ?? '').toLowerCase()
    if (role !== 'cutting_operator') return rows
    const currentUserName = String(session?.user?.name ?? '').trim().toLowerCase()
    return rows.filter((row) => {
      const meta = metaByJob[row.id]
      const assigned = String(meta?.operatorName ?? '').trim().toLowerCase()
      return assigned !== '' && assigned === currentUserName
    })
  }, [rows, metaByJob, session?.user])

  const activeRow = activeJobId ? visibleRows.find((r) => r.id === activeJobId) ?? null : null
  const activeMeta =
    activeRow != null
      ? metaByJob[activeRow.id] ?? {
          stage: 'cutting' as const,
          status: deriveInitialStatus(activeRow),
          operatorId: null,
          operatorName: null,
          machineId: null,
          priority: 'normal' as const,
        }
      : null

  const updateMeta = (jobId: string, patch: Partial<LocalCuttingMeta>) => {
    setMetaByJob((prev) => ({
      ...prev,
      [jobId]: {
        ...(prev[jobId] ?? {
          stage: 'cutting',
          status: 'pending',
          operatorId: null,
          operatorName: null,
          machineId: null,
          priority: 'normal',
        }),
        ...patch,
      },
    }))
  }

  const counters = useMemo(() => {
    const base = { pending: 0, assigned: 0, running: 0, completed: 0 }
    for (const r of visibleRows) {
      const status = metaByJob[r.id]?.status ?? deriveInitialStatus(r)
      base[status] += 1
    }
    return base
  }, [visibleRows, metaByJob, deriveInitialStatus])

  return (
    <div className="min-h-screen bg-background text-ds-ink pb-10">
      <div className="mx-auto max-w-7xl px-3 py-3 space-y-3">
        <div className="sticky top-0 z-20 border-b border-ds-line/30 bg-background/95 py-1.5 backdrop-blur">
          <p className={`text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>
            Production execution · Cutting
          </p>
          <h1 className={`text-lg font-semibold text-ds-warning ${mono}`}>Cutting queue</h1>
          <p className="text-xs text-ds-ink-muted mt-0.5">
            Planning-style execution board. Table is the action surface; right drawer is decision + execution detail.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className={`rounded border border-ds-line/40 bg-ds-main/40 px-2 py-0.5 text-[10px] ${mono}`}>
            Pending: {counters.pending}
          </span>
          <span className={`rounded border border-ds-warning/40 bg-ds-warning/10 px-2 py-0.5 text-[10px] ${mono}`}>
            Assigned: {counters.assigned}
          </span>
          <span className={`rounded border border-sky-600/40 bg-sky-500/10 px-2 py-0.5 text-[10px] ${mono}`}>
            Running: {counters.running}
          </span>
          <span className={`rounded border border-emerald-600/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] ${mono}`}>
            Completed: {counters.completed}
          </span>
        </div>

        <div className="rounded-xl border border-border/40 bg-card overflow-hidden">
          <div className={`px-3 py-2 border-b border-border/40 text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>
            Cutting jobs
          </div>
          {loading ? (
            <div className={`p-6 text-ds-ink-faint ${mono}`}>Loading…</div>
          ) : visibleRows.length === 0 ? (
            <div className={`p-6 text-ds-ink-faint text-sm`}>
              No cutting jobs visible for the current role filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className={`w-full text-[11px] ${mono}`}>
                <thead className="text-ds-ink-faint text-[10px] font-semibold uppercase tracking-wider bg-ds-main/40">
                  <tr className="border-b border-border/40">
                    <th className="text-left py-2 px-3">Carton Name</th>
                    <th className="text-left py-2 px-3">Carton</th>
                    <th className="text-left py-2 px-3">Qty</th>
                    <th className="text-left py-2 px-3">Board</th>
                    <th className="text-left py-2 px-3">Size</th>
                    <th className="text-left py-2 px-3">Die Required</th>
                    <th className="text-left py-2 px-3">Status</th>
                    <th className="text-left py-2 px-3">Operator</th>
                    <th className="text-left py-2 px-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const meta = metaByJob[r.id]
                    const status = meta?.status ?? deriveInitialStatus(r)
                    const mq = r.poLine?.materialQueue
                    const board = mq ? `${mq.boardType}${mq.gsm ? ` · ${mq.gsm} GSM` : ''}` : '—'
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-border/20 hover:bg-ds-main/30 cursor-pointer"
                        onClick={() => setActiveJobId(r.id)}
                      >
                        <td className="py-1.5 px-3 text-ds-ink max-w-[14rem] truncate" title={r.poLine?.cartonName ?? ''}>
                          {r.poLine?.cartonName ?? '—'}
                          <span className="ml-1 text-ds-ink-faint">· JC #{r.jobCardNumber}</span>
                        </td>
                        <td className="py-1.5 px-3">
                          <Link
                            href={`/production/job-cards/${r.id}`}
                            className="text-sky-400 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            PO {r.poLine?.poNumber ?? '—'}
                          </Link>
                        </td>
                        <td className="py-1.5 px-3">{r.poLine?.quantity ?? '—'}</td>
                        <td className="py-1.5 px-3">{board}</td>
                        <td className="py-1.5 px-3">{r.poLine?.cartonSize ?? '—'}</td>
                        <td className="py-1.5 px-3">{r.poLine?.dyeNumber != null ? `#${r.poLine.dyeNumber}` : 'Required'}</td>
                        <td className="py-1.5 px-3">
                          <span className={`rounded px-1.5 py-0.5 border text-[9px] uppercase tracking-wide ${statusTone(status)}`}>
                            {status}
                          </span>
                        </td>
                        <td className="py-1.5 px-3">{meta?.operatorName ?? '—'}</td>
                        <td className="py-1.5 px-3">
                          <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="rounded border border-ds-line/50 px-1.5 py-px text-[9px] text-ds-ink-muted hover:border-ds-brand/40 hover:text-ds-brand transition-colors"
                              onClick={() => setActiveJobId(r.id)}
                            >
                              Assign
                            </button>
                            <button
                              type="button"
                              className="rounded border border-ds-line/50 px-1.5 py-px text-[9px] text-ds-ink-muted hover:border-ds-brand/40 hover:text-ds-brand transition-colors"
                              onClick={() => updateMeta(r.id, { status: 'running' })}
                            >
                              Start
                            </button>
                            <button
                              type="button"
                              className="rounded border border-ds-line/50 px-1.5 py-px text-[9px] text-ds-ink-muted hover:border-ds-brand/40 hover:text-ds-brand transition-colors"
                              onClick={() => updateMeta(r.id, { status: 'assigned' })}
                            >
                              Hold
                            </button>
                            <button
                              type="button"
                              className="rounded border border-ds-line/50 px-1.5 py-px text-[9px] text-ds-ink-muted hover:border-ds-brand/40 hover:text-ds-brand transition-colors"
                              onClick={() => updateMeta(r.id, { status: 'completed' })}
                            >
                              Complete
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {activeRow && activeMeta ? (
          <>
          <div
            className="fixed inset-0 z-40 bg-black/35"
            onClick={() => setActiveJobId(null)}
            aria-hidden
          />
          <aside className="fixed right-0 top-0 h-screen w-full max-w-md border-l border-ds-line/40 bg-card shadow-2xl z-50 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-ds-line/40 px-4 py-2.5">
              <div>
                <p className={`text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>Cutting decision</p>
                <h2 className={`text-xs font-semibold text-ds-warning ${mono}`}>
                  JC #{activeRow.jobCardNumber}
                </h2>
              </div>
              <button
                type="button"
                className="rounded border border-ds-line/50 px-2 py-1 text-xs"
                onClick={() => setActiveJobId(null)}
              >
                Close
              </button>
            </div>

            <div className="space-y-3 p-4 text-xs">
              <section className="rounded-lg border border-ds-line/40 p-2.5">
                <p className={`text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-2 ${mono}`}>Job Snapshot</p>
                <div className="space-y-1">
                  <p><span className="text-ds-ink-faint">Carton:</span> {activeRow.poLine?.cartonName ?? '—'}</p>
                  <p><span className="text-ds-ink-faint">Qty:</span> {activeRow.poLine?.quantity ?? '—'}</p>
                  <p><span className="text-ds-ink-faint">Specs:</span> {activeRow.poLine?.cartonSize ?? '—'}</p>
                  <p><span className="text-ds-ink-faint">Batch:</span> {activeRow.status}</p>
                </div>
              </section>

              <section className="rounded-lg border border-ds-line/40 p-2.5">
                <p className={`text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-2 ${mono}`}>Cutting Decisions</p>
                <div className="space-y-2">
                  <label className="block">
                    <span className="text-ds-ink-faint">Assign Operator</span>
                    <select
                      className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-1"
                      value={activeMeta.operatorId ?? ''}
                      onChange={(e) => {
                        const operatorId = e.target.value || null
                        const op = users.find((u) => u.id === operatorId)
                        updateMeta(activeRow.id, {
                          operatorId,
                          operatorName: op?.name ?? null,
                          status: operatorId ? 'assigned' : 'pending',
                        })
                      }}
                    >
                      <option value="">Unassigned</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="text-ds-ink-faint">Assign Machine</span>
                    <select
                      className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-1"
                      value={activeMeta.machineId ?? ''}
                      onChange={(e) => updateMeta(activeRow.id, { machineId: e.target.value || null })}
                    >
                      <option value="">Unassigned</option>
                      {machines.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.machineCode} · {m.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="text-ds-ink-faint">Cutting Priority</span>
                    <select
                      className="mt-1 w-full rounded border border-ds-line/50 bg-background px-2 py-1"
                      value={activeMeta.priority}
                      onChange={(e) => updateMeta(activeRow.id, { priority: e.target.value as LocalCuttingMeta['priority'] })}
                    >
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="rounded-lg border border-ds-line/40 p-2.5">
                <p className={`text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-2 ${mono}`}>Tooling Info</p>
                <p><span className="text-ds-ink-faint">Die Number:</span> {activeRow.poLine?.dyeNumber != null ? `#${activeRow.poLine.dyeNumber}` : '—'}</p>
                <p><span className="text-ds-ink-faint">Die Status:</span> {activeRow.poLine?.dyeNumber != null ? 'Available' : 'Required'}</p>
              </section>

              <section className="rounded-lg border border-ds-line/40 p-2.5">
                <p className={`text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-2 ${mono}`}>Execution Controls</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-sky-600/40 px-3 py-1 text-sky-300"
                    onClick={() => updateMeta(activeRow.id, { status: 'running' })}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="rounded border border-ds-warning/40 px-3 py-1 text-ds-warning"
                    onClick={() => updateMeta(activeRow.id, { status: 'assigned' })}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="rounded border border-emerald-600/40 px-3 py-1 text-emerald-300"
                    onClick={() => updateMeta(activeRow.id, { status: 'completed' })}
                  >
                    Complete
                  </button>
                </div>
              </section>
            </div>
          </aside>
          </>
        ) : null}
      </div>
    </div>
  )
}
