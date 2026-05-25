'use client'

import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'
import { SectionProductRequirement } from './SectionProductRequirement'
import { SectionBoardAllocation, type StockSearchResult } from './SectionBoardAllocation'
import { SectionWarehouseAvailability } from './SectionWarehouseAvailability'
import { SectionSmartMatch } from './SectionSmartMatch'
import { SectionUpsAndSpec } from './SectionUpsAndSpec'
import { SectionBatchDecision } from './SectionBatchDecision'

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
 * Layout — material flows top-to-bottom per spec (req-9):
 *
 *   ┌──────────── Product Requirement ─────────────────┐  (full width)
 *   ├──────────── Board Allocation ────────────────────┤  (full width)
 *   ├──────────── Smart Match ─────────────────────────┤  (full width)
 *   ├──────────── Warehouse Availability ──────────────┤  (full width)
 *   ├─── Sheet Metrics ─┬─── Batch Decision ───────────┤  (2-col)
 *   └──────────────────────────────────────────────────┘
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
      <SectionSmartMatch
        line={line}
        readiness={readiness}
        onPatch={onPatch}
        onSelectBoard={onSelectBoard}
      />
      <SectionWarehouseAvailability readiness={readiness} onOpenWarehouse={onOpenWarehouse} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionUpsAndSpec line={line} onPatch={onPatch} />
        <SectionBatchDecision
          line={line}
          onPatch={onPatch}
          onLock={onLock}
          onGenerateJobCard={onGenerateJobCard}
        />
      </div>
    </div>
  )
}
