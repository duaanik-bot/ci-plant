'use client'

import { useCallback, useEffect, useState } from 'react'
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

type TimelineEntry = {
  id?: string
  timeLabel: string
  action: string
  detail: string
  performedBy: string | null
}

export function ToolingJobAuditModal({
  context,
  onClose,
}: {
  context: ToolingHubAuditContext | null
  onClose: () => void
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!context) return
    setLoading(true)
    setError(null)
    try {
      const q = `tool=${encodeURIComponent(context.tool)}&id=${encodeURIComponent(context.id)}`
      const r = await fetch(`/api/tooling-hub/job-events?${q}`)
      const t = await r.text()
      const j = safeJsonParse<{ entries?: TimelineEntry[]; error?: string }>(t, {})
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
    void load()
  }, [context, load])

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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
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
              <h2 id="tooling-audit-title" className="text-lg font-semibold text-white truncate">
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
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
              Current specs
            </h3>
            <div className="rounded-lg border border-zinc-800 bg-black/50 p-3 space-y-2">
              <p className="text-[10px] text-zinc-500 uppercase">Units</p>
              <p className="text-sm text-zinc-200 font-medium tabular-nums">{context.units}</p>
              <p className="text-[10px] text-zinc-500 uppercase">Specification</p>
              <p className="text-sm text-zinc-200 leading-snug">{context.specSummary}</p>
            </div>
          </section>

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
                    <p className="text-[11px] text-zinc-500 font-mono">{e.timeLabel}</p>
                    <p className="text-sm font-bold text-zinc-100 mt-0.5">{e.action}</p>
                    <p className="text-xs text-zinc-400 mt-1 leading-snug">{e.detail}</p>
                    {e.performedBy ? (
                      <p className="text-[10px] text-zinc-600 mt-1">By {e.performedBy}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
