'use client'

import { useState, type ComponentType } from 'react'
import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { HubPriorityDomain } from '@/lib/hub-priority-domain'

const iconBtnClass =
  'h-6 w-6 inline-flex items-center justify-center rounded border border-transparent text-slate-400 ' +
  'hover:bg-[#1E293B] hover:text-amber-400 active:scale-[0.98] ' +
  'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-400'

export function HubPriorityRankBadge({ rank }: { rank: number }) {
  if (rank < 1) return null
  return (
    <span
      className="shrink-0 rounded border border-amber-600/30 bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-bold text-amber-300/90 font-designing-queue tabular-nums"
      title="Column priority"
    >
      #{rank}
    </span>
  )
}

type PriorityAction = 'top' | 'up' | 'down' | 'bottom'

/**
 * 4-button priority cluster (24×24, ghost, slate / amber on hover on slate-800).
 */
export function HubPriorityController({
  domain,
  entityId,
  isFirst,
  isLast,
  disabled,
  onSuccess,
  className = '',
  align = 'end',
}: {
  domain: HubPriorityDomain
  entityId: string
  isFirst: boolean
  isLast: boolean
  disabled?: boolean
  onSuccess: () => void
  className?: string
  align?: 'end' | 'start'
}) {
  const [busy, setBusy] = useState(false)
  const [busyAction, setBusyAction] = useState<PriorityAction | null>(null)
  const off = disabled || busy

  async function go(action: PriorityAction) {
    if (action === 'up' && isFirst) return
    if (action === 'down' && isLast) return
    setBusy(true)
    setBusyAction(action)
    try {
      const r = await fetch('/api/hub/priority-sequence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, entityId, action }),
      })
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) {
        toast.error(j.error ?? 'Priority update failed')
        return
      }
      onSuccess()
    } catch {
      toast.error('Priority update failed')
    } finally {
      setBusy(false)
      setBusyAction(null)
    }
  }

  return (
    <div
      className={`inline-flex items-center gap-0.5 ${align === 'end' ? 'justify-end' : 'justify-start'} ${className}`}
    >
      <ActionIconButton
        label="Top priority"
        off={off || isFirst}
        icon={ChevronsUp}
        isSpinning={busy && busyAction === 'top'}
        onClick={() => void go('top')}
      />
      <ActionIconButton
        label="Up one"
        off={off || isFirst}
        icon={ChevronUp}
        isSpinning={busy && busyAction === 'up'}
        onClick={() => void go('up')}
      />
      <ActionIconButton
        label="Down one"
        off={off || isLast}
        icon={ChevronDown}
        isSpinning={busy && busyAction === 'down'}
        onClick={() => void go('down')}
      />
      <ActionIconButton
        label="End of queue"
        off={off || isLast}
        icon={ChevronsDown}
        isSpinning={busy && busyAction === 'bottom'}
        onClick={() => void go('bottom')}
      />
    </div>
  )
}

function ActionIconButton({
  label,
  off,
  onClick,
  icon: Icon,
  isSpinning,
}: {
  label: string
  off: boolean
  onClick: () => void
  icon: ComponentType<Record<string, unknown>>
  isSpinning: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={off}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={iconBtnClass}
    >
      {isSpinning ? <Loader2 className="h-4 w-4 animate-spin text-amber-400" strokeWidth={2} /> : <Icon className="h-4 w-4" strokeWidth={2} />}
    </button>
  )
}
