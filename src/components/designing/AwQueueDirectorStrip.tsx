'use client'

import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle } from 'lucide-react'
import clsx from 'clsx'

export type AwRibbonStep = { id: string; label: string; status: 'done' | 'current' | 'pending' }

type Props = {
  editSpecsEnabled: boolean
  onEditSpecsChange: (enabled: boolean) => void
  showRecallJob: boolean
  recallBusy: boolean
  onConfirmRecall: () => void | Promise<void>
  ribbonSteps: AwRibbonStep[]
}

export function AwQueueDirectorStrip({
  editSpecsEnabled,
  onEditSpecsChange,
  showRecallJob,
  recallBusy,
  onConfirmRecall,
  ribbonSteps,
}: Props) {
  const [recallOpen, setRecallOpen] = useState(false)

  return (
    <div className="border-b border-slate-800 bg-[#000000] px-3 py-2">
      <div className="max-w-7xl mx-auto w-full flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 rounded-md border border-slate-800 bg-black px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded border-amber-500/60 h-3.5 w-3.5 accent-amber-500"
              checked={editSpecsEnabled}
              onChange={(e) => onEditSpecsChange(e.target.checked)}
            />
            Edit specs
          </label>
          {showRecallJob ? (
            <Dialog.Root open={recallOpen} onOpenChange={setRecallOpen}>
              <Dialog.Trigger asChild>
                <button
                  type="button"
                  className="rounded-md bg-amber-600 hover:bg-amber-500 px-2.5 py-1.5 text-[11px] font-semibold text-black disabled:opacity-50"
                  disabled={recallBusy}
                >
                  {recallBusy ? 'Recalling…' : 'Recall job'}
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out fade-in-0" />
                <Dialog.Content
                  className={clsx(
                    'fixed left-1/2 top-1/2 z-[101] w-[min(100vw-1.5rem,24rem)] -translate-x-1/2 -translate-y-1/2',
                    'rounded-lg border border-slate-700 bg-[#0a0a0a] p-4 shadow-xl',
                    'data-[state=open]:animate-in data-[state=closed]:animate-out fade-in-0 zoom-in-95',
                  )}
                >
                  <Dialog.Title className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" aria-hidden />
                    Recall job from hubs?
                  </Dialog.Title>
                  <Dialog.Description className="mt-2 text-xs text-slate-400 leading-relaxed">
                    This reverses Plate Hub finalization, cancels the plate requirement, and resets hub
                    handshakes and dispatch stamps to draft. Use only when you must pull the job back for
                    edits.
                  </Dialog.Description>
                  <div className="mt-4 flex justify-end gap-2">
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                    </Dialog.Close>
                    <button
                      type="button"
                      disabled={recallBusy}
                      className="rounded-md bg-amber-600 hover:bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"
                      onClick={() => {
                        void (async () => {
                          await onConfirmRecall()
                          setRecallOpen(false)
                        })()
                      }}
                    >
                      Confirm recall
                    </button>
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          ) : null}
        </div>

        <nav
          className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[10px] sm:text-[11px] font-medium text-slate-500"
          aria-label="Hub pipeline"
        >
          {ribbonSteps.map((step, i) => (
            <span key={step.id} className="inline-flex items-center gap-1">
              {i > 0 ? <span className="text-slate-700 px-0.5" aria-hidden>→</span> : null}
              <span
                className={clsx(
                  'rounded px-1.5 py-0.5 border',
                  step.status === 'done' && 'border-emerald-500/50 text-emerald-400/95 bg-emerald-950/30',
                  step.status === 'current' && 'border-amber-500/60 text-amber-200 bg-amber-950/25',
                  step.status === 'pending' && 'border-slate-800 text-slate-600',
                )}
              >
                {step.label}
              </span>
            </span>
          ))}
        </nav>
      </div>
    </div>
  )
}

const PLATE_STAGES = [
  'idle',
  'triage',
  'ctp_queue',
  'vendor_queue',
  'burning_complete',
  'ready_inventory',
] as const

/** CTP / plate flow progress: highlights current stage through the plate hub pipeline. */
export function PlateHubReadinessSparkline({ plateFlowStatus }: { plateFlowStatus?: string | null }) {
  const key = (plateFlowStatus || 'idle').trim().toLowerCase()
  const idx = PLATE_STAGES.indexOf(key as (typeof PLATE_STAGES)[number])
  const active = idx >= 0 ? idx : 0
  return (
    <div className="flex items-center gap-0.5" title={`Plate flow: ${key}`}>
      {PLATE_STAGES.map((s, i) => (
        <span
          key={s}
          className={clsx(
            'h-1 w-4 rounded-sm',
            i < active && 'bg-emerald-600/70',
            i === active && 'bg-amber-500 ring-1 ring-amber-600/60',
            i > active && 'bg-slate-800',
          )}
        />
      ))}
    </div>
  )
}
