'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/store/toastStore'
import { resolveSheetSize, resolveUps } from '@/lib/production-os-resolvers'
import { PageHeader } from '@/components/shared/PageHeader'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type CuttingStatus = 'pending' | 'assigned' | 'running' | 'completed'

type JobCardRow = {
  id: string
  setNumber: string | null
  jobCardNumber: number
  sheetsIssued: number
  status: string
  postPressRouting?: Record<string, unknown> | null
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
      sheetLengthMm: number | null
      sheetWidthMm: number | null
    } | null
    specOverrides?: Record<string, unknown> | null
  } | null
  requiredSheets: number
  stages?: {
    id: string
    stageName: string
    status: string
    operator: string | null
    counter: number | null
  }[]
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
      return 'text-[var(--success)] bg-[var(--success-bg)]'
    case 'running':
      return 'text-[var(--info)] bg-[var(--info-bg)]'
    case 'assigned':
      return 'text-ds-warning bg-ds-warning/10'
    default:
      return 'text-ds-ink-faint bg-ds-main/30'
  }
}

type CuttingData = {
  rows: JobCardRow[]
  users: Array<{ id: string; name: string }>
  machines: Array<{ id: string; machineCode: string; name: string }>
}

export default function CuttingQueuePage() {
  const { data: session } = useSession()
  const qc = useQueryClient()

  const [metaByJob,    setMetaByJob]    = useState<Record<string, LocalCuttingMeta>>({})
  const [activeJobId,  setActiveJobId]  = useState<string | null>(null)
  const [counterEdits, setCounterEdits] = useState<Record<string, string>>({})
  const [savingRow,    setSavingRow]    = useState<string | null>(null)

  const deriveInitialStatus = useCallback((row: JobCardRow): CuttingStatus => {
    const cutting = (row.stages ?? []).find((s) => s.stageName === 'Cutting')
    if (!cutting) return 'pending'
    if (cutting.status === 'completed') return 'completed'
    if (cutting.status === 'in_progress') return 'running'
    if (cutting.status === 'ready' && (cutting.operator || '').trim()) return 'assigned'
    return 'pending'
  }, [])

  const { data: cuttingData, isLoading: loading } = useQuery<CuttingData>({
    queryKey: ['cutting-queue'],
    queryFn:  async () => {
      const [jcRes, uRes, mRes] = await Promise.all([
        fetch('/api/job-cards'),
        fetch('/api/users'),
        fetch('/api/machines'),
      ])
      const jcData     = await jcRes.json()
      const userData   = await uRes.json()
      const machineData = await mRes.json()
      if (!jcRes.ok) throw new Error(jcData?.error || 'Failed to load job cards')
      const allRows = (Array.isArray(jcData) ? jcData : []) as JobCardRow[]
      const cuttingRows = allRows.filter((j) => {
        const hasCutting = (j.stages ?? []).some((s) => s.stageName === 'Cutting')
        return hasCutting && j.poLine != null
      })
      return {
        rows:     cuttingRows,
        users:    Array.isArray(userData)   ? userData   : [],
        machines: Array.isArray(machineData) ? machineData : [],
      }
    },
  })

  const rows     = cuttingData?.rows     ?? []
  const users    = cuttingData?.users    ?? []
  const machines = cuttingData?.machines ?? []

  /* Initialise metaByJob whenever rows arrive from query */
  useEffect(() => {
    if (!rows.length) return
    setMetaByJob((prev) => {
      const next = { ...prev }
      for (const row of rows) {
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
  }, [rows, deriveInitialStatus])

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['cutting-queue'] })
  }, [qc])

  const visibleRows = useMemo(() => {
    const role = String((session?.user as { role?: string } | undefined)?.role ?? '').toLowerCase()
    const base =
      role !== 'cutting_operator'
        ? rows
        : rows.filter((row) => {
      const meta = metaByJob[row.id]
      const assigned = String(meta?.operatorName ?? '').trim().toLowerCase()
          const currentUserName = String(session?.user?.name ?? '').trim().toLowerCase()
          return assigned !== '' && assigned === currentUserName
        })

    // Keep completed rows visible but always pushed to the end.
    return [...base].sort((a, b) => {
      const sa = (metaByJob[a.id]?.status ?? deriveInitialStatus(a)) === 'completed' ? 1 : 0
      const sb = (metaByJob[b.id]?.status ?? deriveInitialStatus(b)) === 'completed' ? 1 : 0
      if (sa !== sb) return sa - sb
      return a.jobCardNumber - b.jobCardNumber
    })
  }, [rows, metaByJob, session?.user, deriveInitialStatus])

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

  const cuttingStage = (row: JobCardRow) => (row.stages ?? []).find((s) => s.stageName === 'Cutting') ?? null

  const getCounterValue = (row: JobCardRow) => {
    const edited = counterEdits[row.id]
    if (edited != null) return edited
    const stage = cuttingStage(row)
    if (stage?.counter != null && Number.isFinite(stage.counter)) return String(stage.counter)
    return row.sheetsIssued > 0 ? String(row.sheetsIssued) : ''
  }

  async function saveRowCounter(row: JobCardRow) {
    const stage = cuttingStage(row)
    if (!stage) {
      toast.error('Cutting stage missing for this job card')
      return
    }
    const raw = (counterEdits[row.id] ?? '').trim()
    const val = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(val) || val < 0) {
      toast.error('Actual counter must be a valid non-negative number')
      return
    }
    setSavingRow(row.id)
    try {
      const prevPostPress =
        row.postPressRouting && typeof row.postPressRouting === 'object'
          ? (row.postPressRouting as Record<string, unknown>)
          : {}
      const prevExec =
        prevPostPress.executionOrchestration && typeof prevPostPress.executionOrchestration === 'object'
          ? (prevPostPress.executionOrchestration as Record<string, unknown>)
          : {}
      const stageProgress =
        prevExec.stageProgress && typeof prevExec.stageProgress === 'object'
          ? (prevExec.stageProgress as Record<string, unknown>)
          : {}
      const cuttingProgress =
        stageProgress.cutting && typeof stageProgress.cutting === 'object'
          ? (stageProgress.cutting as Record<string, unknown>)
          : {}

      const res = await fetch(`/api/job-cards/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheetsIssued: Math.floor(val),
          postPressRouting: {
            ...prevPostPress,
            executionOrchestration: {
              ...prevExec,
              stageProgress: {
                ...stageProgress,
                cutting: {
                  ...cuttingProgress,
                  completedQty: Math.floor(val),
                  pushedQty: Math.floor(val),
                  status: stage?.status ?? 'pending',
                },
              },
            },
          },
          stages: [
            {
              id: stage.id,
              counter: Math.floor(val),
              status: stage.status,
            },
          ],
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : 'Failed to save counter')
      toast.success('Actual counter updated')
      setCounterEdits((prev) => {
        const next = { ...prev }
        delete next[row.id]
        return next
      })
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save counter')
    } finally {
      setSavingRow(null)
    }
  }

  async function updateCuttingStatus(row: JobCardRow, status: CuttingStatus) {
    const stage = cuttingStage(row)
    if (!stage) {
      toast.error('Cutting stage missing for this job card')
      return
    }
    setSavingRow(row.id)
    try {
      const stageStatus =
        status === 'running' ? 'in_progress' : status === 'completed' ? 'completed' : status === 'assigned' ? 'ready' : 'pending'
      const operatorName =
        status === 'assigned' || status === 'running'
          ? String(session?.user?.name ?? metaByJob[row.id]?.operatorName ?? '').trim() || null
          : metaByJob[row.id]?.operatorName ?? null
      const enteredCounter = Number((counterEdits[row.id] ?? '').trim())
      const existingCounter = Number(stage.counter ?? 0)
      const targetCounter = Number.isFinite(enteredCounter) && enteredCounter > 0 ? Math.floor(enteredCounter) : existingCounter
      const safeCounter =
        status === 'completed' ? Math.max(targetCounter, row.requiredSheets || row.sheetsIssued || 0) : Math.max(0, targetCounter)

      const prevPostPress =
        row.postPressRouting && typeof row.postPressRouting === 'object'
          ? (row.postPressRouting as Record<string, unknown>)
          : {}
      const prevExec =
        prevPostPress.executionOrchestration && typeof prevPostPress.executionOrchestration === 'object'
          ? (prevPostPress.executionOrchestration as Record<string, unknown>)
          : {}
      const stageProgress =
        prevExec.stageProgress && typeof prevExec.stageProgress === 'object'
          ? (prevExec.stageProgress as Record<string, unknown>)
          : {}
      const cuttingProgress =
        stageProgress.cutting && typeof stageProgress.cutting === 'object'
          ? (stageProgress.cutting as Record<string, unknown>)
          : {}

      const res = await fetch(`/api/job-cards/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheetsIssued: safeCounter,
          postPressRouting: {
            ...prevPostPress,
            executionOrchestration: {
              ...prevExec,
              printingQueuedAt:
                status === 'completed' ? new Date().toISOString() : (prevExec.printingQueuedAt as string | undefined),
              stageProgress: {
                ...stageProgress,
                cutting: {
                  ...cuttingProgress,
                  completedQty: safeCounter,
                  pushedQty: safeCounter,
                  status: stageStatus,
                },
              },
            },
          },
          stages: [{ id: stage.id, status: stageStatus, operator: operatorName }],
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : 'Failed to update status')
      updateMeta(row.id, { status, operatorName })
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update status')
    } finally {
      setSavingRow(null)
    }
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
      <div className="w-full px-4 py-4 md:px-6 space-y-3">
        {/* ── Page header ─────────────────────────────────────────────── */}
        <PageHeader
          title="Cutting Queue"
          subtitle="Production execution · Planning-style board. Table is the action surface; right drawer is decision + execution detail."
        />

        <div className="flex flex-wrap gap-2">
          <span className={`rounded bg-ds-main/40 px-2 py-0.5 text-xs ${mono}`}>
            Pending: {counters.pending}
          </span>
          <span className={`rounded bg-ds-warning/10 px-2 py-0.5 text-xs ${mono}`}>
            Assigned: {counters.assigned}
          </span>
          <span className={`rounded bg-[var(--info-bg)] px-2 py-0.5 text-xs ${mono}`}>
            Running: {counters.running}
          </span>
          <span className={`rounded bg-[var(--success-bg)] px-2 py-0.5 text-xs ${mono}`}>
            Completed: {counters.completed}
          </span>
        </div>

        <div className="rounded-ds-lg bg-card overflow-hidden shadow-ds-depth-sm">
          <div className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>
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
              <table className={`w-full text-xs ${mono}`}>
                <thead className="text-ds-ink-faint text-xs font-semibold uppercase tracking-wider bg-ds-main/40">
                  <tr>
                    <th className="text-left py-2 px-3">Operator</th>
                    <th className="text-left py-2 px-3">Job Card No.</th>
                    <th className="text-left py-2 px-3">Product / Carton Details</th>
                    <th className="text-left py-2 px-3">Set No.</th>
                    <th className="text-left py-2 px-3">Parent Sheet Size</th>
                    <th className="text-left py-2 px-3">Required Sheets</th>
                    <th className="text-left py-2 px-3">Paper Divide</th>
                    <th className="text-left py-2 px-3">Cut Sheet Size</th>
                    <th className="text-left py-2 px-3">Total Sheets Issued</th>
                    <th className="text-left py-2 px-3">Actual Counter</th>
                    <th className="text-left py-2 px-3">Production Status</th>
                    <th className="text-left py-2 px-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const meta = metaByJob[r.id]
                    const status = meta?.status ?? deriveInitialStatus(r)
                    const mq = r.poLine?.materialQueue
                    const stage = cuttingStage(r)
                    const spec =
                      r.poLine?.specOverrides && typeof r.poLine.specOverrides === 'object'
                        ? (r.poLine.specOverrides as Record<string, unknown>)
                        : {}
                    const planningCore =
                      spec.planningCore && typeof spec.planningCore === 'object'
                        ? (spec.planningCore as Record<string, unknown>)
                        : {}
                    const ups = resolveUps(r.poLine ?? {})
                    const parentSheet =
                      (mq?.sheetLengthMm && mq?.sheetWidthMm)
                        ? `${mq.sheetLengthMm}x${mq.sheetWidthMm}`
                        : (typeof planningCore.parentSize === 'string' && planningCore.parentSize.trim())
                          ? planningCore.parentSize.trim()
                        : '—'
                    const cutSheet = resolveSheetSize(r.poLine ?? {}) || r.poLine?.cartonSize || '—'
                    const operatorDisplay = stage?.operator ?? meta?.operatorName ?? '—'
                    const totalSheetsIssued =
                      Number(stage?.counter ?? 0) > 0
                        ? Number(stage?.counter ?? 0)
                        : Number(r.sheetsIssued ?? 0) > 0
                          ? Number(r.sheetsIssued ?? 0)
                          : Number(mq?.totalSheets ?? 0) > 0
                            ? Number(mq?.totalSheets ?? 0)
                            : Number(r.requiredSheets ?? 0)
                    return (
                      <tr
                        key={r.id}
                        className={`hover:bg-ds-main/30 cursor-pointer ${status === 'completed' ? 'bg-[var(--success-bg)]' : ''}`}
                        onClick={() => setActiveJobId(r.id)}
                      >
                        <td className="py-1.5 px-3">{operatorDisplay}</td>
                        <td className="py-1.5 px-3">
                          <Link
                            href={`/production/job-cards/${r.id}`}
                            className="text-[var(--info)] hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            JC-{r.jobCardNumber}
                          </Link>
                        </td>
                        <td className="py-1.5 px-3 max-w-[18rem]">
                          <div className="truncate text-ds-ink" title={r.poLine?.cartonName ?? ''}>
                            {r.poLine?.cartonName ?? '—'}
                          </div>
                          <div className="text-ds-ink-faint truncate">
                            PO {r.poLine?.poNumber ?? '—'} · Qty {r.poLine?.quantity ?? 0}
                          </div>
                        </td>
                        <td className="py-1.5 px-3">{r.setNumber ?? '—'}</td>
                        <td className="py-1.5 px-3">{parentSheet}</td>
                        <td className="py-1.5 px-3">{r.requiredSheets}</td>
                        <td className="py-1.5 px-3">{ups ?? mq?.ups ?? (typeof planningCore.paperDivide === 'number' ? planningCore.paperDivide : '—')}</td>
                        <td className="py-1.5 px-3">{cutSheet}</td>
                        <td className="py-1.5 px-3">{Number(totalSheetsIssued).toLocaleString('en-IN')}</td>
                        <td className="py-1.5 px-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            inputMode="numeric"
                            className="w-24 rounded bg-ds-elevated px-2 py-1 text-xs"
                            value={getCounterValue(r)}
                            onChange={(e) =>
                              setCounterEdits((prev) => ({ ...prev, [r.id]: e.target.value.replace(/[^\d]/g, '') }))
                            }
                            onBlur={() => void saveRowCounter(r)}
                          />
                        </td>
                        <td className="py-1.5 px-3">
                          <span className={`rounded px-1.5 py-0.5 text-xs uppercase tracking-wide ${statusTone(status)}`}>
                            {status}
                          </span>
                        </td>
                        <td className="py-1.5 px-3">
                          <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="rounded bg-ds-elevated px-1.5 py-px text-xs text-ds-ink-muted hover:text-ds-brand transition-colors disabled:opacity-50"
                              onClick={() => void updateCuttingStatus(r, 'assigned')}
                              disabled={savingRow === r.id}
                            >
                              Assign
                            </button>
                            <button
                              type="button"
                              className="rounded bg-ds-elevated px-1.5 py-px text-xs text-ds-ink-muted hover:text-ds-brand transition-colors disabled:opacity-50"
                              onClick={() => void updateCuttingStatus(r, 'running')}
                              disabled={savingRow === r.id}
                            >
                              Start
                            </button>
                            <button
                              type="button"
                              className="rounded bg-ds-elevated px-1.5 py-px text-xs text-ds-ink-muted hover:text-ds-brand transition-colors disabled:opacity-50"
                              onClick={() => void updateCuttingStatus(r, 'assigned')}
                              disabled={savingRow === r.id}
                            >
                              Hold
                            </button>
                            <button
                              type="button"
                              className="rounded bg-ds-elevated px-1.5 py-px text-xs text-ds-ink-muted hover:text-ds-brand transition-colors disabled:opacity-50"
                              onClick={() => void updateCuttingStatus(r, 'completed')}
                              disabled={savingRow === r.id}
                            >
                              Complete
                            </button>
                            <button
                              type="button"
                              className="rounded bg-ds-warning/10 px-1.5 py-px text-xs text-ds-warning hover:bg-ds-warning/15 transition-colors disabled:opacity-50"
                              onClick={() => void saveRowCounter(r)}
                              disabled={savingRow === r.id}
                            >
                              {savingRow === r.id ? 'Saving…' : 'Save Counter'}
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
          <aside className="fixed right-0 top-0 h-screen w-full max-w-md bg-card shadow-2xl z-50 overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-2.5">
              <div>
                <p className={`text-xs font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>Cutting decision</p>
                <h2 className={`text-xs font-semibold text-ds-warning ${mono}`}>
                  JC #{activeRow.jobCardNumber}
                </h2>
              </div>
              <button
                type="button"
                className="rounded bg-ds-elevated px-2 py-1 text-xs"
                onClick={() => setActiveJobId(null)}
              >
                Close
              </button>
            </div>

            <div className="space-y-3 p-4 text-xs">
              <section className="rounded-ds-md bg-[var(--bg-elevated)] p-2.5 shadow-ds-depth-sm">
                <p className={`text-xs font-semibold uppercase tracking-wider text-ds-ink-faint mb-2 ${mono}`}>Job Snapshot</p>
                <div className="space-y-1">
                  <p><span className="text-ds-ink-faint">Carton:</span> {activeRow.poLine?.cartonName ?? '—'}</p>
                  <p><span className="text-ds-ink-faint">Qty:</span> {activeRow.poLine?.quantity ?? '—'}</p>
                  <p><span className="text-ds-ink-faint">Specs:</span> {activeRow.poLine?.cartonSize ?? '—'}</p>
                  <p><span className="text-ds-ink-faint">Batch:</span> {activeRow.status}</p>
                </div>
              </section>

              <section className="rounded-ds-md bg-[var(--bg-elevated)] p-2.5 shadow-ds-depth-sm">
                <p className={`text-xs font-semibold uppercase tracking-wider text-ds-ink-faint mb-2 ${mono}`}>Cutting Decisions</p>
                <div className="space-y-2">
                  <label className="block">
                    <span className="text-ds-ink-faint">Assign Operator</span>
                    <select
                      className="mt-1 w-full rounded bg-ds-elevated px-2 py-1"
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
                      className="mt-1 w-full rounded bg-ds-elevated px-2 py-1"
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
                      className="mt-1 w-full rounded bg-ds-elevated px-2 py-1"
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

              <section className="rounded-ds-md bg-[var(--bg-elevated)] p-2.5 shadow-ds-depth-sm">
                <p className={`text-xs font-semibold uppercase tracking-wider text-ds-ink-faint mb-2 ${mono}`}>Tooling Info</p>
                <p><span className="text-ds-ink-faint">Die Number:</span> {activeRow.poLine?.dyeNumber != null ? `#${activeRow.poLine.dyeNumber}` : '—'}</p>
                <p><span className="text-ds-ink-faint">Die Status:</span> {activeRow.poLine?.dyeNumber != null ? 'Available' : 'Required'}</p>
              </section>

              <section className="rounded-ds-md bg-[var(--bg-elevated)] p-2.5 shadow-ds-depth-sm">
                <p className={`text-xs font-semibold uppercase tracking-wider text-ds-ink-faint mb-2 ${mono}`}>Execution Controls</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded bg-[var(--info-bg)] px-3 py-1 text-[var(--info)]"
                    onClick={() => updateMeta(activeRow.id, { status: 'running' })}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="rounded bg-ds-warning/10 px-3 py-1 text-ds-warning"
                    onClick={() => updateMeta(activeRow.id, { status: 'assigned' })}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="rounded bg-[var(--success-bg)] px-3 py-1 text-[var(--success)]"
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
