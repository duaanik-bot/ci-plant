'use client'

import { useCallback, useState } from 'react'
import type { PlanningEngineLine, PlanningEngineReadiness, PlanningEngineReservationContext, SectionPatchFn } from './types'
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
import { PlanningDecisionReversal } from './PlanningDecisionReversal'
import { getPlanningRequirement } from './planningRequirement'

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
  onSelectBoard?: (materialId: string, cutsPerSheet?: number, parentSize?: string, cutType?: number) => Promise<void>
  /** Clear the selected board material when no reservation remains against it. */
  onDeselectBoard?: () => Promise<void>
  /** Persist board-allocation sheet size / UPS back onto the carton master (inches). */
  onSaveCartonMaster?: (patch: { sheetSizeL?: number | null; sheetSizeW?: number | null; ups?: number | null }) => Promise<void>
  /**
   * Reserve the matched material against this line's requirement.
   * Wires to POST /api/planning/po-lines/:id/reserve-material with actionType='reserve'.
   * When undefined the Reserve button is hidden.
   */
  onReserve?: (context?: PlanningEngineReservationContext) => Promise<void>
  /**
   * Release/unreserve the stock reservation for this line.
   * Wires to POST /api/planning/po-lines/:id/reservation-control with action='release'.
   * When undefined the Unreserve button is hidden.
   * Optional qty = partial release; omitted = full release.
   */
  onUnreserve?: (qty?: number) => Promise<void>
  /** Remove the planning lock / downstream release marker and return to Draft. */
  onReverseLock?: () => Promise<void>
  /** Return the line from Planning back to Artwork/designing queue. */
  onSendBackToArtwork?: () => Promise<void>
  /**
   * Raise a draft Purchase Request for the shortage on this line.
   * When undefined the Raise PR button is hidden in the shortage banner.
   */
  onRaisePR?: (context?: PlanningEngineReservationContext) => Promise<void>
  /** Search warehouse stock by query string — returns matching materials. */
  onStockSearch?: (q: string) => Promise<StockSearchResult[]>
  /** Open the Warehouse modal / drawer — threaded to Warehouse Availability section. */
  onOpenWarehouse?: () => void
}

/**
 * Layout — material flows top-to-bottom per target planning workspace:
 *
 *   Header → Board allocation → Cut plan & balance → Smart match
 *   → Batch decision → Review & lock.
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
  onDeselectBoard,
  onSaveCartonMaster,
  onReserve,
  onUnreserve,
  onReverseLock,
  onSendBackToArtwork,
  onRaisePR,
  onOpenWarehouse,
  onStockSearch,
}: PlanningEngineBodyProps) {
  const [draftUnitsPerSheet, setDraftUnitsPerSheet] = useState<string | null>(null)
  const [draftCutType, setDraftCutType] = useState<string | null>(null)
  const spec = (line.specOverrides ?? {}) as Record<string, unknown>
  const locked = line.batchDecision?.status === 'Locked' || !!line.batchDecision?.lockedAt
  const guardedPatch = useCallback<SectionPatchFn>(
    async (patch) => {
      if (locked) return false
      return onPatch(patch)
    },
    [locked, onPatch],
  )
  const editablePatch = locked ? guardedPatch : onPatch
  const editableSelectBoard = locked ? undefined : onSelectBoard
  const editableDeselectBoard = locked ? undefined : onDeselectBoard
  const editableSaveCartonMaster = locked ? undefined : onSaveCartonMaster
  const editableReserve = locked ? undefined : onReserve
  const editableUnreserve = locked ? undefined : onUnreserve
  const editableRaisePR = locked ? undefined : onRaisePR
  const editableSendBackToArtwork = locked ? undefined : onSendBackToArtwork
  const hasSelectedParentSheet =
    typeof spec.planningMaterialId === 'string' && spec.planningMaterialId.trim().length > 0
  const headerRequirement = getPlanningRequirement(line, {
    unitsPerSheet: draftUnitsPerSheet != null ? Number(draftUnitsPerSheet) : null,
    wastageSheets: spec.wastageSheets != null ? Number(spec.wastageSheets) : null,
  })

  return (
    <div className="space-y-4">
      <SectionProductRequirement
        line={line}
        readiness={readiness}
        requiredSheetsOverride={headerRequirement.totalRequired}
      />

      <div className="grid grid-cols-1 xl:grid-cols-[220px_minmax(720px,1fr)_320px] gap-4 items-start">
        <aside className="hidden xl:block sticky top-4 self-start rounded-ds-card bg-[var(--bg-card)] shadow-ds-depth">
          <PlanningStepNav line={line} readiness={readiness} />
        </aside>

        <main className="min-w-0 space-y-4">
          <div id="section-board" className="space-y-3 scroll-mt-4">
            <PlanningDecisionReversal
              line={line}
              readiness={readiness}
              onPatch={editablePatch}
              onDeselectBoard={editableDeselectBoard}
              onUnreserve={editableUnreserve}
              onReverseLock={onReverseLock}
              onSendBackToArtwork={editableSendBackToArtwork}
            />
            <SectionSelectedParentSheet readiness={readiness} selected={hasSelectedParentSheet} />
            <SectionBoardAllocation
              line={line}
              readiness={readiness}
              readinessLoading={readinessLoading}
              onPatch={editablePatch}
              onSelectBoard={editableSelectBoard}
              onSaveCartonMaster={editableSaveCartonMaster}
              onReserve={editableReserve}
              onUnreserve={editableUnreserve}
              onRaisePR={editableRaisePR}
              onStockSearch={onStockSearch}
              onDraftUnitsPerSheetChange={setDraftUnitsPerSheet}
              onDraftCutTypeChange={setDraftCutType}
            />
          </div>

          <div id="section-cutplan" className="space-y-4 scroll-mt-4">
            <SectionCutPlanBalance
              line={line}
              readiness={readiness}
              onPatch={editablePatch}
              onReserve={editableReserve}
              onRaisePR={editableRaisePR}
              onLock={onLock}
              draftUnitsPerSheet={draftUnitsPerSheet}
              draftCutType={draftCutType}
            />
            <SectionBalanceStockHandling
              line={line}
              readiness={readiness}
              onPatch={editablePatch}
              onOpenWarehouse={onOpenWarehouse}
            />
          </div>

          <div id="section-smartmatch" className="scroll-mt-4 xl:hidden">
            <SectionSmartMatch
              line={line}
              readiness={readiness}
              onPatch={editablePatch}
              onSelectBoard={editableSelectBoard}
              onOpenWarehouse={onOpenWarehouse}
            />
          </div>

          <div id="section-warehouse" className="scroll-mt-4 xl:hidden">
            <SectionWarehouseAvailability readiness={readiness} onOpenWarehouse={onOpenWarehouse} />
          </div>

          <div id="section-batch" className="scroll-mt-4 xl:hidden">
            <SectionBatchDecision
              line={line}
              onPatch={editablePatch}
              onLock={onLock}
              onUnlock={onReverseLock}
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
              onPatch={editablePatch}
              onSelectBoard={editableSelectBoard}
              onOpenWarehouse={onOpenWarehouse}
              sidebar
            />
          </div>
          <button type="button" onClick={onOpenWarehouse} className="w-full text-left">
            <SectionWarehouseSnapshot readiness={readiness} />
          </button>
          <div className="hidden xl:block">
            <SectionBatchDecision
              line={line}
              onPatch={editablePatch}
              onLock={onLock}
              onUnlock={onReverseLock}
              onGenerateJobCard={onGenerateJobCard}
              compact
            />
          </div>
        </aside>
      </div>
    </div>
  )
}
