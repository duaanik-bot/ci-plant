'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { safeJsonParse } from '@/lib/safe-json'

export type ToolingHubAuditContext = {
  tool: 'die' | 'emboss'
  id: string
  zoneLabel: string
  displayCode: string
  title: string
  specSummary: string
  units: number
}

type JobEventEntry = {
  id?: string
  createdAt?: string
  timeLabel: string
  actionType?: string
  action: string
  detail: string
  summaryLine?: string
  performedBy: string | null
  /** Canonical hub action (dies). */
  hubAction?: string | null
  /** Good | Fair | Poor when captured. */
  condition?: string | null
  operatorName?: string | null
  details?: unknown
  metadata?: unknown
  auditActionType?: string
}

type UsageHistoryRow = {
  dateLabel: string
  operator: string
  machine: string
  returnCondition: string
}

function eventDetailsObject(details: unknown): Record<string, unknown> | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  return details as Record<string, unknown>
}

function machineLabelFromDetails(d: Record<string, unknown> | null): string {
  if (!d) return '—'
  const mc = d.machineCode
  const mn = d.machineName
  const code = typeof mc === 'string' ? mc.trim() : ''
  const name = typeof mn === 'string' ? mn.trim() : ''
  if (code && name) return `${code} — ${name}`
  if (code) return code
  if (name) return name
  return '—'
}

function buildUsageHistoryRows(entries: JobEventEntry[]): UsageHistoryRow[] {
  const sorted = [...entries].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return ta - tb
  })
  let lastMachine = '—'
  const out: UsageHistoryRow[] = []
  for (const e of sorted) {
    const d = eventDetailsObject(e.details)
    if (e.actionType === 'ISSUE_TO_MACHINE') {
      lastMachine = machineLabelFromDetails(d)
    } else if (e.actionType === 'RETURN_TO_RACK') {
      const condRaw = d?.returnCondition
      const returnCondition = typeof condRaw === 'string' && condRaw.trim() ? condRaw.trim() : '—'
      const op =
        e.performedBy?.trim() ||
        (typeof d?.returnOperatorName === 'string' ? d.returnOperatorName.trim() : '') ||
        '—'
      out.push({
        dateLabel: e.timeLabel,
        operator: op,
        machine: lastMachine,
        returnCondition,
      })
      lastMachine = '—'
    }
  }
  return out.reverse()
}

export function ToolingJobAuditModal({
  context,
  onClose,
}: {
  context: ToolingHubAuditContext | null
  onClose: () => void
}) {
  const [entries, setEntries] = useState<JobEventEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'timeline' | 'usage'>('timeline')

  const load = useCallback(async () => {
    if (!context) return
    setLoading(true)
    setError(null)
    try {
      const q = `tool=${encodeURIComponent(context.tool)}&id=${encodeURIComponent(context.id)}`
      const r = await fetch(`/api/tooling-hub/job-events?${q}`)
      const t = await r.text()
      const j = safeJsonParse<{ entries?: JobEventEntry[]; error?: string }>(t, {})
      if (!r.ok) {
        setError(j.error ?? 'Failed to load history')
        setEntries([])
        return
      }
      setEntries(Array.isArray(j.entries) ? j.entries : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [context])

  useEffect(() => {
    if (!context) {
      setEntries([])
      return
    }
    setTab('timeline')
    void load()
  }, [context, load])

  const usageRows = useMemo(() => buildUsageHistoryRows(entries), [entries])

  useEffect(() => {
    if (!context) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [context, onClose])

  if (!context) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/85 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        className="w-full max-w-lg max-h-[90vh] rounded-xl border border-zinc-600 bg-zinc-950 shadow-2xl flex flex-col"
        role="dialog"
        aria-labelledby="tooling-audit-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-zinc-800 shrink-0">
          <div className="flex justify-between gap-2 items-start">
            <div className="min-w-0">
              <h2 id="tooling-audit-title" className="text-lg font-semibold text-foreground truncate">
                Tool details &amp; history
              </h2>
              <p className="text-sm font-medium text-blue-300/90 mt-1 truncate">{context.title}</p>
              <p className="text-xs text-zinc-400 mt-0.5 font-mono">
                {context.displayCode} · {context.zoneLabel}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 px-2 py-1 rounded border border-zinc-600 text-zinc-300 text-xs hover:bg-zinc-800"
            >
              Close
            </button>
          </div>
          <div
            className="mt-3 flex rounded-lg border border-zinc-700 overflow-hidden p-0.5 bg-background/50"
            role="tablist"
            aria-label="Audit sections"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'timeline'}
              onClick={() => setTab('timeline')}
              className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-colors ${
                tab === 'timeline' ? 'bg-amber-600 text-primary-foreground' : 'text-zinc-400 hover:text-foreground'
              }`}
            >
              Timeline
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'usage'}
              onClick={() => setTab('usage')}
              className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-colors ${
                tab === 'usage' ? 'bg-amber-600 text-primary-foreground' : 'text-zinc-400 hover:text-foreground'
              }`}
            >
              Usage history
            </button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
              Current specs
            </h3>
            <div className="rounded-lg border border-zinc-800 bg-background/50 p-3 space-y-2">
              <p className="text-[10px] text-zinc-500 uppercase">Units</p>
              <p className="text-sm text-zinc-200 font-medium tabular-nums">{context.units}</p>
              <p className="text-[10px] text-zinc-500 uppercase">Specification</p>
              <p className="text-sm text-zinc-200 leading-snug">{context.specSummary}</p>
            </div>
          </section>

          {tab === 'timeline' ? (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
                Hub event timeline
              </h3>
              {loading ? (
                <p className="text-sm text-zinc-500">Loading history…</p>
              ) : error ? (
                <p className="text-sm text-rose-400">{error}</p>
              ) : entries.length === 0 ? (
                <p className="text-sm text-zinc-500">No hub events recorded yet for this tool.</p>
              ) : (
                <ul className="relative border-l border-zinc-700 pl-4 space-y-4 ml-1.5">
                {entries.map((e, i) => (
                  <li key={e.id ?? `${e.timeLabel}-${i}`} className="relative">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-amber-500 ring-4 ring-zinc-950" />
                    {context.tool === 'die' ? (
                      <div className="rounded-lg border border-zinc-800 bg-background/40 p-2.5 space-y-1.5">
                        <p className="text-[11px] text-zinc-500 font-mono tabular-nums">{e.timeLabel}</p>
                        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1 text-xs">
                          <dt className="text-zinc-500 font-semibold uppercase tracking-wide">Operator</dt>
                          <dd className="text-zinc-200">
                            {(e.operatorName ?? e.performedBy)?.trim() || '—'}
                          </dd>
                          <dt className="text-zinc-500 font-semibold uppercase tracking-wide">Action</dt>
                          <dd className="text-zinc-100 font-mono text-[11px]">
                            {e.hubAction?.trim() || e.actionType?.trim() || '—'}
                          </dd>
                          <dt className="text-zinc-500 font-semibold uppercase tracking-wide">Condition</dt>
                          <dd className="text-zinc-200">{e.condition?.trim() || '—'}</dd>
                          <dt className="text-zinc-500 font-semibold uppercase tracking-wide">Timestamp</dt>
                          <dd className="text-zinc-400 font-mono text-[10px] break-all">
                            {e.createdAt ?? '—'}
                          </dd>
                        </dl>
                        {e.summaryLine ? (
                          <p className="text-[11px] text-zinc-500 leading-snug pt-1 border-t border-zinc-800/80">
                            {e.summaryLine}
                          </p>
                        ) : null}
                      </div>
                    ) : e.summaryLine ? (
                      <p className="text-sm text-zinc-100 leading-snug font-medium">{e.summaryLine}</p>
                    ) : (
                      <>
                        <p className="text-[11px] text-zinc-500 font-mono">{e.timeLabel}</p>
                        <p className="text-sm font-bold text-zinc-100 mt-0.5">{e.action}</p>
                        <p className="text-xs text-zinc-400 mt-1 leading-snug">{e.detail}</p>
                        {e.performedBy ? (
                          <p className="text-[10px] text-zinc-600 mt-1">By {e.performedBy}</p>
                        ) : null}
                      </>
                    )}
                  </li>
                ))}
                </ul>
              )}
            </section>
          ) : (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
                Usage history
              </h3>
              <p className="text-[11px] text-zinc-500 mb-2 leading-snug">
                Returns to rack with the press that was last issued (from hub events).
              </p>
              {loading ? (
                <p className="text-sm text-zinc-500">Loading…</p>
              ) : error ? (
                <p className="text-sm text-rose-400">{error}</p>
              ) : usageRows.length === 0 ? (
                <p className="text-sm text-zinc-500">No return cycles recorded yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="w-full text-left text-xs border-collapse min-w-[420px]">
                    <thead>
                      <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500">
                        <th className="px-2 py-2 font-semibold whitespace-nowrap">Date</th>
                        <th className="px-2 py-2 font-semibold">Operator</th>
                        <th className="px-2 py-2 font-semibold">Machine</th>
                        <th className="px-2 py-2 font-semibold whitespace-nowrap">Return condition</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usageRows.map((row, i) => (
                        <tr key={`${row.dateLabel}-${i}`} className="border-b border-zinc-800/80">
                          <td className="px-2 py-2 text-zinc-400 font-mono whitespace-nowrap">
                            {row.dateLabel}
                          </td>
                          <td className="px-2 py-2 text-zinc-200">{row.operator}</td>
                          <td className="px-2 py-2 text-zinc-300">{row.machine}</td>
                          <td className="px-2 py-2">
                            {row.returnCondition === 'Poor' ? (
                              <span className="text-red-400 font-semibold">{row.returnCondition}</span>
                            ) : (
                              <span className="text-zinc-300">{row.returnCondition}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
