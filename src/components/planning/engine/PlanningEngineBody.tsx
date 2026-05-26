'use client'

import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'
import { SectionProductRequirement } from './SectionProductRequirement'
import { SectionBoardAllocation, type StockSearchResult } from './SectionBoardAllocation'
import { SectionWarehouseAvailability } from './SectionWarehouseAvailability'
import { SectionSmartMatch } from './SectionSmartMatch'
import { SectionBatchDecision } from './SectionBatchDecision'
import { SectionSelectedParentSheet } from './SectionSelectedParentSheet'
import { SectionCutPlanBalance } from './SectionCutPlanBalance'
import { SectionBalanceStockHandling } from './SectionBalanceStockHandling'
import { SectionWarehouseSnapshot } from './SectionWarehouseSnapshot'
import { SectionPlanningSummary } from './SectionPlanningSummary'
import { SectionTraceabilityPreview } from './SectionTracebilityPreview'
import { PlanningStepNav } from './PlanningStepNav'

export type PlanningEngineBodyProps = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  readinessLoading: boolean
  onPatch: SectionPatchFn
  onLock: () => Promise<void>
  /**
   * Generate a Job Card from the locked planning decision.
   * Threaded to Batch Decision; the button is shown only when the line is
   * locked AND this handler is provided. When undefined the button is hidden.
   */
  onGenerateJobCard?: () => Promise<void>
  /** Link the line to a board material — drives Board allocation + Smart Match selection. */
  onSelectBoard?: (materialId: string) => Promise<void>
  /** Persist board-allocation sheet size / UPS back onto the carton master (inches). */
  onSaveCartonMaster?: (patch: { sheetSizeL?: number | null; sheetSizeW?: number | null; ups?: number | null }) => Promise<void>
  /**
   * Reserve the matched material against this line's requirement.
   * Wires to POST /api/planning/po-lines/:id/reserve-material with actionType='reserve'.
   * When undefined the Reserve button is hidden.
   */
  onReserve?: () => Promise<void>
  /**
   * Release/unreserve the stock reservation for this line.
   * Wires to POST /api/planning/po-lines/:id/reservation-control with action='release'.
   * When undefined the Unreserve button is hidden.
   * Optional qty = partial release; omitted = full release.
   */
  onUnreserve?: (qty?: number) => Promise<void>
  /**
   * Raise a draft Purchase Request for the shortage on this line.
   * When undefined the Raise PR button is hidden in the shortage banner.
   */
  onRaisePR?: () => Promise<void>
  /** Search warehouse stock by query string — returns matching materials. */
  onStockSearch?: (q: string) => Promise<StockSearchResult[]>
  /** Open the Warehouse modal / drawer — threaded to Warehouse Availability section. */
  onOpenWarehouse?: () => void
}

/**
 * Layout — material flows top-to-bottom per target planning workspace:
 *
 *   Header → Board allocation → Cut plan & balance → Smart match
 *   → Warehouse → Batch decision → Review & lock.
 *
 * All sections are wrapped in React.memo internally — re-renders are
 * isolated to the section whose props actually changed.
 */
export function PlanningEngineBody({
  line,
  readiness,
  readinessLoading,
  onPatch,
  onLock,
  onGenerateJobCard,
  onSelectBoard,
  onSaveCartonMaster,
  onReserve,
  onUnreserve,
  onRaisePR,
  onOpenWarehouse,
  onStockSearch,
}: PlanningEngineBodyProps) {
  return (
    <div className="space-y-4">
      <SectionProductRequirement line={line} readiness={readiness} />

      <div className="grid grid-cols-1 xl:grid-cols-[220px_minmax(720px,1fr)_320px] gap-4 items-start">
        <aside className="hidden xl:block sticky top-4 self-start rounded-ds-card bg-[var(--bg-card)] shadow-ds-depth">
          <PlanningStepNav line={line} readiness={readiness} />
        </aside>

        <main className="min-w-0 space-y-4">
          <div id="section-board" className="space-y-3 scroll-mt-4">
            <SectionSelectedParentSheet readiness={readiness} />
            {!readiness?.materialId ? (
              <SectionBoardAllocation
                line={line}
                readiness={readiness}
                readinessLoading={readinessLoading}
                onPatch={onPatch}
                onSelectBoard={onSelectBoard}
                onSaveCartonMaster={onSaveCartonMaster}
                onReserve={onReserve}
                onUnreserve={onUnreserve}
                onRaisePR={onRaisePR}
                onStockSearch={onStockSearch}
              />
            ) : null}
          </div>

          <div id="section-cutplan" className="space-y-4 scroll-mt-4">
            <SectionCutPlanBalance line={line} readiness={readiness} onPatch={onPatch} />
            <SectionBalanceStockHandling line={line} readiness={readiness} onPatch={onPatch} />
          </div>

          <div id="section-smartmatch" className="scroll-mt-4 xl:hidden">
            <SectionSmartMatch
              line={line}
              readiness={readiness}
              onPatch={onPatch}
              onSelectBoard={onSelectBoard}
            />
          </div>

          <div id="section-warehouse" className="scroll-mt-4 xl:hidden">
            <SectionWarehouseAvailability readiness={readiness} onOpenWarehouse={onOpenWarehouse} />
          </div>

          <div id="section-batch" className="scroll-mt-4 xl:hidden">
            <SectionBatchDecision
              line={line}
              onPatch={onPatch}
              onLock={onLock}
              onGenerateJobCard={onGenerateJobCard}
            />
          </div>

          <div id="section-lock" className="space-y-4 scroll-mt-4 xl:hidden">
            <SectionPlanningSummary line={line} readiness={readiness} />
            <SectionTraceabilityPreview line={line} readiness={readiness} />
          </div>
        </main>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start min-w-0">
          <div className="hidden xl:block">
            <SectionSmartMatch
              line={line}
              readiness={readiness}
              onPatch={onPatch}
              onSelectBoard={onSelectBoard}
              sidebar
            />
          </div>
          <button type="button" onClick={onOpenWarehouse} className="w-full text-left">
            <SectionWarehouseSnapshot readiness={readiness} />
          </button>
          <div className="hidden xl:block">
            <SectionBatchDecision
              line={line}
              onPatch={onPatch}
              onLock={onLock}
              onGenerateJobCard={onGenerateJobCard}
              compact
            />
          </div>
        </aside>
      </div>
    </div>
  )
}
