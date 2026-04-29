'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { ScheduleHandshake } from '@/lib/production-schedule-spec'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type UserOpt = { id: string; name: string }

export function OperatorHandshakeDrawer({
  open,
  onClose,
  title,
  defaultOeePct,
  initial,
  onSave,
  saving,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** From product / press baseline — prefilled */
  defaultOeePct: number
  initial: ScheduleHandshake
  onSave: (h: ScheduleHandshake) => void
  saving?: boolean
}) {
  const [users, setUsers] = useState<UserOpt[]>([])
  const [operatorUserId, setOperatorUserId] = useState<string>(initial.operatorUserId ?? '')
  const [targetOeePct, setTargetOeePct] = useState<number>(
    initial.targetOeePct ?? defaultOeePct,
  )
  const [pmStart, setPmStart] = useState('')
  const [pmEnd, setPmEnd] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/users')
        if (!r.ok) return
        const j = (await r.json()) as UserOpt[]
        if (!cancelled && Array.isArray(j)) setUsers(j)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setOperatorUserId(initial.operatorUserId ?? '')
    setTargetOeePct(initial.targetOeePct ?? defaultOeePct)
    const w = initial.pmWindows?.[0]
    setPmStart(w?.start ? w.start.slice(0, 16) : '')
    setPmEnd(w?.end ? w.end.slice(0, 16) : '')
  }, [open, initial, defaultOeePct])

  if (!open) return null

  const pmWindows =
    pmStart && pmEnd
      ? [{ start: new Date(pmStart).toISOString(), end: new Date(pmEnd).toISOString() }]
      : []

  return (
    <div className="fixed inset-0 z-[80] flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-background/70"
        aria-label="Close drawer"
        onClick={onClose}
      />
      <aside
        className="relative h-full w-full max-w-md border-l border-ds-line/40 bg-[#050505] shadow-2xl flex flex-col"
        role="dialog"
        aria-labelledby="handshake-title"
      >
        <div className="flex items-center justify-between border-b border-ds-line/40 px-4 py-3">
          <div>
            <h2 id="handshake-title" className="text-sm font-semibold text-ds-warning">
              Operator handshake
            </h2>
            <p className={`text-xs text-ds-ink-faint mt-0.5 ${mono}`}>{title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ds-ink-faint hover:text-ds-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <label className="block space-y-1">
            <span className={`text-xs uppercase tracking-wide text-ds-ink-faint ${mono}`}>
              Operator (Staff Hub)
            </span>
            <select
              value={operatorUserId}
              onChange={(e) => setOperatorUserId(e.target.value)}
              className={`w-full h-9 rounded border border-ds-line/50 bg-background px-2 text-xs text-ds-ink ${mono}`}
            >
              <option value="">— Select —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className={`text-xs uppercase tracking-wide text-ds-ink-faint ${mono}`}>
              Target OEE speed %
            </span>
            <input
              type="number"
              min={40}
              max={100}
              step={0.5}
              value={targetOeePct}
              onChange={(e) => setTargetOeePct(Number(e.target.value))}
              className={`w-full h-9 rounded border border-ds-line/50 bg-background px-2 text-xs text-ds-ink ${mono}`}
            />
            <p className="text-xs text-ds-ink-faint">
              Auto-filled from product / press baseline; adjust per run.
            </p>
          </label>

          <div className="space-y-2">
            <span className={`text-xs uppercase tracking-wide text-ds-ink-faint ${mono}`}>
              Planned maintenance (window)
            </span>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-0.5">
                <span className="text-xs text-ds-ink-faint">Start</span>
                <input
                  type="datetime-local"
                  value={pmStart}
                  onChange={(e) => setPmStart(e.target.value)}
                  className={`w-full h-9 rounded border border-ds-line/50 bg-background px-1 text-xs text-ds-ink ${mono} [color-scheme:dark]`}
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-xs text-ds-ink-faint">End</span>
                <input
                  type="datetime-local"
                  value={pmEnd}
                  onChange={(e) => setPmEnd(e.target.value)}
                  className={`w-full h-9 rounded border border-ds-line/50 bg-background px-1 text-xs text-ds-ink ${mono} [color-scheme:dark]`}
                />
              </label>
            </div>
          </div>
        </div>

        <div className="border-t border-ds-line/40 px-4 py-3 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border/15 px-3 py-1.5 text-xs text-ds-ink-muted hover:border-border/25"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              onSave({
                operatorUserId: operatorUserId || null,
                targetOeePct,
                pmWindows,
              })
            }
            className="rounded border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Confirm handshake'}
          </button>
        </div>
      </aside>
    </div>
  )
}
