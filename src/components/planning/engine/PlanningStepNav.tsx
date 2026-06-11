'use client'

import { memo } from 'react'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type StepStatus = 'complete' | 'active' | 'pending'

type Step = {
  id: string
  number: number
  label: string
  sectionId: string
  status: StepStatus
}

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveSteps(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): Step[] {
  const spec = (line.specOverrides ?? {}) as Record<string, unknown>
  const meta = readPlanningMeta(spec)
  const selectedMaterialId = typeof spec.planningMaterialId === 'string' ? spec.planningMaterialId.trim() : ''
  const locked = line.batchDecision?.status === 'Locked' || !!line.batchDecision?.lockedAt

  const boardDone = locked || selectedMaterialId.length > 0 || !!readiness?.materialId
  const rawChildren = meta.cutPlanChildSizes
  const cutDone =
    locked ||
    Array.isArray(rawChildren) &&
    rawChildren.some((c: unknown) => {
      const o = c as Record<string, unknown>
      return Number(o.qty ?? 0) > 0 && Number(o.lMm ?? 0) > 0
    })

  const batchDone = locked || !!(line.batchDecision?.status)

  const stepData: { id: string; label: string; sectionId: string; done: boolean }[] = [
    { id: 'board', label: 'Board Allocation', sectionId: 'section-board', done: boardDone },
    { id: 'cutplan', label: 'Cut Plan & Balance', sectionId: 'section-cutplan', done: cutDone },
    { id: 'smartmatch', label: 'Smart Match', sectionId: 'section-smartmatch', done: locked || boardDone },
    { id: 'batch', label: 'Batch Decision', sectionId: 'section-batch', done: batchDone },
    { id: 'lock', label: 'Review & Lock', sectionId: 'section-lock', done: locked },
  ]

  // Match the planning workspace reference: once a board is selected the
  // planner remains in Cut Plan & Balance until the plan is locked.
  let activeIndex: number | null = boardDone && !locked ? 1 : null
  if (activeIndex === null) {
    for (let i = 0; i < stepData.length; i++) {
      if (!stepData[i]!.done) { activeIndex = i; break }
    }
  }
  if (activeIndex === null) activeIndex = stepData.length - 1

  return stepData.map((s, i) => ({
    id: s.id,
    number: i + 1,
    label: s.label,
    sectionId: s.sectionId,
    status: s.done ? 'complete' : i === activeIndex ? 'active' : 'pending',
  }))
}

function scrollToSection(sectionId: string) {
  const el = document.getElementById(sectionId)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ─── Component ────────────────────────────────────────────────────────────────

export const PlanningStepNav = memo(function PlanningStepNav({ line, readiness }: Props) {
  const steps = deriveSteps(line, readiness)

  return (
    <nav className="flex flex-col pt-4 pb-3 px-4 h-full min-h-[520px]" aria-label="Planning steps">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-ds-ink-faint mb-3 px-1">
        Steps
      </div>

      <div className="relative flex-1">
        {/* Vertical connecting line */}
        <div
          className="pointer-events-none absolute left-[19px] top-5 bottom-8 w-px bg-ds-line/30"
          aria-hidden="true"
        />

        <div className="space-y-0.5">
          {steps.map((step) => (
            <button
              key={step.id}
              type="button"
              onClick={() => scrollToSection(step.sectionId)}
              className={[
                'group relative w-full flex items-center gap-3 rounded-ds-md px-2 py-2.5 text-left transition-colors',
                step.status === 'active'
                  ? 'bg-ds-elevated/80'
                  : 'hover:bg-ds-elevated/50',
              ].join(' ')}
            >
              {/* Badge */}
              <div
                className={[
                  'relative z-10 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full border text-xs font-bold transition-all',
                  step.status === 'complete'
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                    : step.status === 'active'
                      ? 'border-[var(--brand-primary,#3b82f6)]/50 bg-ds-brand/15 text-ds-brand shadow-sm'
                      : 'border-ds-line/40 bg-ds-elevated text-ds-ink-faint',
                ].join(' ')}
              >
                {step.status === 'complete' ? (
                  // Checkmark
                  <svg viewBox="0 0 10 10" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M1.5 5l2.5 2.5 4.5-5" />
                  </svg>
                ) : (
                  step.number
                )}
              </div>

              {/* Label */}
              <span
                className={[
                  'text-xs font-medium leading-tight transition-colors',
                  step.status === 'complete'
                    ? 'text-ds-ink-muted line-through decoration-ds-ink-faint/40'
                    : step.status === 'active'
                      ? 'text-ds-ink font-semibold'
                      : 'text-ds-ink-faint group-hover:text-ds-ink-muted',
                ].join(' ')}
              >
                {step.label}
              </span>

              {/* Active pulse */}
              {step.status === 'active' ? (
                <span className="ml-auto mr-1 h-1.5 w-1.5 rounded-full bg-ds-brand animate-pulse shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {/* Planning history */}
      <div className="mt-4 pt-3 border-t border-ds-line/20">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-ds-sm px-2 py-1.5 text-[11px] text-ds-ink-faint hover:text-ds-ink hover:bg-ds-elevated/50 transition-colors"
        >
          <svg viewBox="0 0 14 14" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 4v3l2 1.5" />
          </svg>
          View Planning History
        </button>
      </div>
    </nav>
  )
})
