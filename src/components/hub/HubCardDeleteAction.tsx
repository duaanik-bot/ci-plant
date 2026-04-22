'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'

const CONFIRM_MONO =
  'font-[family-name:var(--font-designing-queue),ui-monospace,monospace] tracking-tight'

type HubDeleteAsset = 'plate_requirement' | 'plate_store' | 'die' | 'emboss' | 'shade_card'

export async function postHubSoftDelete(asset: HubDeleteAsset, id: string): Promise<{
  ok: true
} | { ok: false; planningBlock?: string; message: string }> {
  const r = await fetch('/api/hub/soft-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset, id }),
  })
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (r.ok && j.ok === true) return { ok: true }
  const msg =
    typeof j.message === 'string'
      ? j.message
      : r.status === 409 && typeof j.poNumber === 'string'
        ? `Cannot delete: Asset is reserved for ${j.poNumber}.`
        : typeof j.error === 'string'
          ? j.error
          : 'Delete failed'
  return { ok: false, planningBlock: typeof j.poNumber === 'string' ? j.poNumber : undefined, message: msg }
}

/**
 * Trash + anchored confirmation (no Radix Popover dep). JetBrains mono prompt.
 * Click the trash again or Cancel to dismiss; Delete runs `onDeleted` after successful API soft-delete.
 */
export function HubCardDeleteAction({
  asset,
  recordId,
  disabled,
  triggerClassName,
  onDeleted,
  stopPropagationOnTrigger,
}: {
  asset: HubDeleteAsset
  recordId: string
  disabled?: boolean
  triggerClassName: string
  onDeleted: () => void
  /** When the control sits on a clickable card (e.g. shade kanban), stop the card click. */
  stopPropagationOnTrigger?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const el = rootRef.current
      if (!el || el.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const runDelete = useCallback(async () => {
    setBusy(true)
    try {
      const res = await postHubSoftDelete(asset, recordId)
      if (res.ok) {
        setOpen(false)
        onDeleted()
      } else {
        const { toast } = await import('sonner')
        toast.error(res.ok === false ? res.message : 'Delete failed')
      }
    } finally {
      setBusy(false)
    }
  }, [asset, recordId, onDeleted])

  return (
    <div ref={rootRef} className={`pointer-events-auto ${triggerClassName}`}>
      <button
        type="button"
        disabled={disabled || busy}
        title="Delete from hub (soft)"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => {
          if (stopPropagationOnTrigger) e.stopPropagation()
          if (!disabled) setOpen((o) => !o)
        }}
        className="flex h-6 w-6 items-center justify-center rounded-md border border-ds-line/50 bg-ds-card/90 text-ds-ink-faint transition-shadow hover:border-rose-500/50 hover:text-rose-500 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          className="absolute right-0 top-[calc(100%+6px)] z-[100] w-[min(16rem,calc(100vw-1.5rem))] rounded-md border border-ds-line/50 bg-ds-main p-2.5 shadow-xl"
        >
          <p className={`text-[11px] font-bold text-ds-ink ${CONFIRM_MONO}`}>Delete this record?</p>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
              }}
              className="rounded border border-ds-line/50 bg-ds-elevated/80 px-2.5 py-1 text-[10px] font-semibold text-ds-ink hover:bg-ds-elevated"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                void runDelete()
              }}
              className="rounded bg-rose-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-rose-500"
            >
              {busy ? '…' : 'Delete'}
            </button>
          </div>
          <p className={`mt-2 border-t border-ds-line/40 pt-1.5 text-[8px] leading-tight text-neutral-500 ${CONFIRM_MONO}`}>
            Hub Integrity Managed - Individual Card Triggers Active.
          </p>
        </div>
      ) : null}
    </div>
  )
}
