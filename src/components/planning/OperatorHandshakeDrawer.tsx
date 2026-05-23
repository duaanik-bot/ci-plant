'use client'

import { useEffect, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
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

  const pmWindows =
    pmStart && pmEnd
      ? [{ start: new Date(pmStart).toISOString(), end: new Date(pmEnd).toISOString() }]
      : []

  return (
    <GlobalPopoutModal
      isOpen={open}
      onClose={onClose}
      title="Operator handshake"
      metadata={<span className={`text-xs text-ds-ink-faint ${mono}`}>{title}</span>}
      mode="preview"
      size="sm"
      zIndexClass="z-[80]"
      primaryAction={{
        label: 'Confirm handshake',
        loadingLabel: 'Saving…',
        onClick: () => onSave({ operatorUserId: operatorUserId || null, targetOeePct, pmWindows }),
        disabled: saving,
        loading: saving,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="space-y-4">
        <label className="block space-y-1">
          <span className={`text-xs uppercase tracking-wide text-ds-ink-faint ${mono}`}>
            Operator (Staff Hub)
          </span>
          <select
            value={operatorUserId}
            onChange={(e) => setOperatorUserId(e.target.value)}
            className={`w-full h-9 rounded bg-ds-main px-2 text-xs text-ds-ink ${mono}`}
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
            className={`w-full h-9 rounded bg-ds-main px-2 text-xs text-ds-ink ${mono}`}
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
                className={`w-full h-9 rounded bg-ds-main px-1 text-xs text-ds-ink ${mono}`}
              />
            </label>
            <label className="space-y-0.5">
              <span className="text-xs text-ds-ink-faint">End</span>
              <input
                type="datetime-local"
                value={pmEnd}
                onChange={(e) => setPmEnd(e.target.value)}
                className={`w-full h-9 rounded bg-ds-main px-1 text-xs text-ds-ink ${mono}`}
              />
            </label>
          </div>
        </div>
      </div>
    </GlobalPopoutModal>
  )
}
