'use client'

import { memo, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  onCancel?: () => void
  onSaveDraft?: () => Promise<void>
  onLock: () => Promise<void>
  locked?: boolean
  disabled?: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export const PlanningEngineFooter = memo(function PlanningEngineFooter({
  onCancel,
  onSaveDraft,
  onLock,
  locked,
  disabled,
}: Props) {
  const [savingDraft, setSavingDraft] = useState(false)
  const [locking, setLocking] = useState(false)

  async function handleSaveDraft() {
    if (!onSaveDraft) return
    setSavingDraft(true)
    try { await onSaveDraft() } finally { setSavingDraft(false) }
  }

  async function handleLock() {
    setLocking(true)
    try { await onLock() } finally { setLocking(false) }
  }

  return (
    <div className="flex items-center justify-between border-t border-ds-line/20 bg-ds-main px-6 py-3">
      {/* Left — cancel */}
      <div>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled || locking}
            className="rounded-ds-sm px-4 py-2 text-sm font-medium text-ds-ink-faint hover:text-ds-ink transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {/* Right — save draft + lock */}
      <div className="flex items-center gap-2">
        {onSaveDraft ? (
          <button
            type="button"
            disabled={disabled || savingDraft || locking}
            onClick={() => { void handleSaveDraft() }}
            className="rounded-ds-sm border border-ds-line/40 px-4 py-2 text-sm font-semibold text-ds-ink hover:bg-ds-elevated/60 transition-colors disabled:opacity-40"
          >
            {savingDraft ? 'Saving…' : 'Save as Draft'}
          </button>
        ) : null}

        <button
          type="button"
          disabled={disabled || locking || locked}
          onClick={() => { void handleLock() }}
          className={[
            'rounded-ds-sm px-5 py-2 text-sm font-semibold transition-all',
            locked
              ? 'bg-emerald-500/20 text-emerald-300 cursor-default'
              : 'bg-ds-brand text-white hover:opacity-90 disabled:opacity-50',
          ].join(' ')}
        >
          {locked
            ? '✓ Locked'
            : locking
              ? 'Locking…'
              : 'Save & Lock'}
        </button>
      </div>
    </div>
  )
})
