'use client'

import { useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle } from 'lucide-react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

export type AwRibbonStep = { id: string; label: string; status: 'done' | 'current' | 'pending' }

type Props = {
  editSpecsEnabled: boolean
  onEditSpecsChange: (enabled: boolean) => void
  showRecallJob: boolean
  recallBusy: boolean
  onConfirmRecall: () => void | Promise<void>
}

export function AwQueueDirectorStrip({
  editSpecsEnabled,
  onEditSpecsChange,
  showRecallJob,
  recallBusy,
  onConfirmRecall,
}: Props) {
  const [recallOpen, setRecallOpen] = useState(false)

  return (
    <div className="border-b border-ds-line/40 bg-background px-3 py-1.5">
      <div className="max-w-7xl mx-auto w-full flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 rounded-md border border-ds-line/40 bg-background px-2.5 py-1.5 text-[11px] font-semibold text-ds-ink cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded border-ds-warning/60 h-3.5 w-3.5 accent-ds-warning"
              checked={editSpecsEnabled}
              onChange={(e) => onEditSpecsChange(e.target.checked)}
            />
            Edit specs
          </label>
          {showRecallJob ? (
            <>
              <button
                type="button"
                className="rounded-md bg-ds-warning hover:bg-ds-warning px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"
                disabled={recallBusy}
                onClick={() => setRecallOpen(true)}
              >
                {recallBusy ? 'Recalling…' : 'Recall job'}
              </button>
              <SlideOverPanel
                title={
                  <span className="inline-flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-ds-warning shrink-0" aria-hidden />
                    Recall job from hubs?
                  </span>
                }
                isOpen={recallOpen}
                onClose={() => setRecallOpen(false)}
                zIndexClass="z-[100]"
                backdropClassName="bg-ds-main/50 backdrop-blur-[1.5px]"
                panelClassName="border-l border-ds-line/50 bg-ds-card text-ds-ink shadow-2xl"
                footer={
                  <div className="flex w-full justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-ds-sm border border-ds-line/60 px-3 py-1.5 text-xs text-ds-ink transition hover:bg-ds-elevated"
                      onClick={() => setRecallOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={recallBusy}
                      className="rounded-ds-sm bg-ds-warning px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-95 disabled:opacity-50"
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
                }
              >
                <p className="text-xs text-ds-ink-muted leading-relaxed">
                  This reverses Plate Hub finalization, cancels the plate requirement, and resets hub
                  handshakes and dispatch stamps to draft. Use only when you must pull the job back for
                  edits.
                </p>
              </SlideOverPanel>
            </>
          ) : null}
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
            i === active && 'bg-ds-warning ring-1 ring-ds-warning/60',
            i > active && 'bg-ds-elevated',
          )}
        />
      ))}
    </div>
  )
}
