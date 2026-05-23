'use client'

import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'
import { PlanningStepNav } from './PlanningStepNav'
import { SectionBoardAllocation } from './SectionBoardAllocation'
import { SectionSelectedParentSheet } from './SectionSelectedParentSheet'
import { SectionCutPlanBalance } from './SectionCutPlanBalance'
import { SectionBalanceStockHandling } from './SectionBalanceStockHandling'
import { SectionBatchDecision } from './SectionBatchDecision'
import { SectionPlanningSummary } from './SectionPlanningSummary'
import { SectionSmartMatch } from './SectionSmartMatch'
import { SectionWarehouseSnapshot } from './SectionWarehouseSnapshot'
import { PlanningEngineFooter } from './PlanningEngineFooter'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlanningEngineBodyProps = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  readinessLoading: boolean
  onPatch: SectionPatchFn
  onLock: () => Promise<void>
  /** Link the line to a board material — drives Board Allocation + Smart Match. */
  onSelectBoard?: (materialId: string) => Promise<void>
  /**
   * Reserve the matched material against this line's requirement.
   * When undefined the Reserve button is hidden.
   */
  onReserve?: () => Promise<void>
  /**
   * Release the reservation held against this line.
   * When undefined the Unreserve button is hidden.
   */
  onUnreserve?: () => Promise<void>
  /**
   * Raise a draft Purchase Request for the shortage on this line.
   * When undefined the Raise PR button is hidden.
   */
  onRaisePR?: () => Promise<void>
}

// ─── Layout ───────────────────────────────────────────────────────────────────
//
//  ┌─ Step nav (w-44) ─┬──────── Main content (flex-1) ───────┬── Right sidebar (w-80) ─┐
//  │  1. Board Alloc   │  Board Allocation                    │  Smart Match (sidebar)  │
//  │  2. Cut Plan      │  Selected Parent Sheet strip         │  Warehouse Snapshot     │
//  │  3. Smart Match   │  Cut Plan & Layout                   │                         │
//  │  4. Warehouse     │  Balance Stock Handling              │                         │
//  │  5. Batch         │  Batch Decision                      │                         │
//  │  6. Review & Lock │  Planning Summary                    │                         │
//  │  ─────────────    │                                      │                         │
//  │  Planning History │                                      │                         │
//  └───────────────────┴──────────────────────────────────────┴─────────────────────────┘
//  └──────────────────────────────── Footer ─────────────────────────────────────────────┘
//
//  Responsive: step nav hidden < lg, right sidebar hidden < xl.
//  Main content always scrolls within its parent.

export function PlanningEngineBody({
  line,
  readiness,
  readinessLoading,
  onPatch,
  onLock,
  onSelectBoard,
  onReserve,
  onUnreserve,
  onRaisePR,
}: PlanningEngineBodyProps) {
  const locked = !!line.batchDecision?.lockedAt

  return (
    <div className="flex flex-col min-h-0">
      {/* ── 3-panel workspace ── */}
      <div className="flex min-h-0 flex-1">

        {/* Left: Step navigation */}
        <aside
          className="hidden lg:flex w-44 shrink-0 flex-col border-r border-ds-line/20 sticky top-0 self-start max-h-screen overflow-y-auto"
          aria-label="Planning steps"
        >
          <PlanningStepNav line={line} readiness={readiness} />
        </aside>

        {/* Center: Scrollable main content */}
        <main className="flex-1 min-w-0 overflow-x-hidden">
          <div className="p-4 lg:p-5 space-y-4 max-w-4xl">

            {/* Step 1 — Board Allocation */}
            <div id="section-board">
              <SectionBoardAllocation
                line={line}
                readiness={readiness}
                readinessLoading={readinessLoading}
                onPatch={onPatch}
                onSelectBoard={onSelectBoard}
                onReserve={onReserve}
                onUnreserve={onUnreserve}
                onRaisePR={onRaisePR}
              />
            </div>

            {/* Selected Parent Sheet strip — visible when board is linked */}
            <SectionSelectedParentSheet readiness={readiness} />

            {/* Step 2 — Cut Plan & Layout */}
            <div id="section-cutplan">
              <SectionCutPlanBalance
                line={line}
                readiness={readiness}
                onPatch={onPatch}
              />
            </div>

            {/* Balance Stock Handling — visible when balance is non-trivial */}
            <SectionBalanceStockHandling
              line={line}
              readiness={readiness}
              onPatch={onPatch}
            />

            {/* Step 5 — Batch Decision */}
            <div id="section-batch">
              <SectionBatchDecision
                line={line}
                onPatch={onPatch}
                onLock={onLock}
              />
            </div>

            {/* Planning Summary — pre-lock review */}
            <div id="section-lock">
              <SectionPlanningSummary line={line} readiness={readiness} />
            </div>

            {/* Smart Match — full width fallback for < xl screens */}
            <div className="xl:hidden" id="section-smartmatch">
              <SectionSmartMatch
                line={line}
                readiness={readiness}
                onPatch={onPatch}
                onSelectBoard={onSelectBoard}
              />
            </div>

          </div>
        </main>

        {/* Right: Smart Match sidebar + Warehouse (xl+ only) */}
        <aside
          className="hidden xl:flex w-80 shrink-0 flex-col border-l border-ds-line/20 sticky top-0 self-start max-h-screen overflow-y-auto"
          aria-label="Smart match and warehouse"
          id="section-smartmatch"
        >
          <div className="p-4 space-y-4">
            {/* Smart Match sidebar */}
            <div id="section-warehouse">
              <SectionSmartMatch
                line={line}
                readiness={readiness}
                onPatch={onPatch}
                onSelectBoard={onSelectBoard}
                sidebar
              />
            </div>

            {/* Warehouse Snapshot */}
            <SectionWarehouseSnapshot readiness={readiness} />
          </div>
        </aside>

      </div>

      {/* ── Footer ── */}
      <PlanningEngineFooter
        onLock={onLock}
        locked={locked}
        disabled={readinessLoading}
      />
    </div>
  )
}
