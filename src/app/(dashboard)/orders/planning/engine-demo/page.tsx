'use client'

/**
 * DEMO PAGE — Planning Engine with fully-populated mock data.
 * Route: /orders/planning/engine-demo
 * Delete this file before production deployment.
 */

import { useState } from 'react'
import { PlanningEngineBody } from '@/components/planning/engine/PlanningEngineBody'
import type { PlanningEngineLine, PlanningEngineReadiness } from '@/components/planning/engine/types'

// ─── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_READINESS: PlanningEngineReadiness = {
  materialId: 'mat-fbb-720x1020-300',
  materialCode: 'ITC-FBB-300-720',
  boardType: 'FBB',
  boardClassification: 'Coated',
  size: '720×1020',
  gsm: 300,
  requiredSheets: 4650,
  availableSheets: 9200,
  reservedSheets: 1400,
  freeSheets: 7800,
  incomingSheets: 500,
  shortageSheets: 0,
  prId: null,
  prStatus: 'not_created',
  grnEta: null,
  status: 'green',
  gsmTolerance: 10,
  noMaterialsAtAll: false,
  materialMatchState: 'matched',
  debugMessage: null,
  mappingSafety: {
    requestedBoardType: 'FBB',
    requestedBoardClassification: 'Coated',
    candidatePoolCount: 18,
    strictPoolCount: 5,
    strategyUsed: 'strict',
  },
  suggestionDebug: {
    requiredSize: '720×1020',
    requiredGsm: 300,
    tolerance: 10,
    materialsFetched: 62,
    afterGsmFilter: 28,
    afterSizeFit: 8,
    finalSuggestions: 5,
  },
  suggestedBoardOptions: [
    {
      materialId: 'mat-fbb-720x1020-300',
      materialCode: 'ITC-FBB-300-720',
      boardType: 'FBB',
      boardClassification: 'Coated',
      gsm: 300,
      gsmDelta: 0,
      size: '720×1020',
      orientation: 'LxW',
      availableSheets: 9200,
      reservedSheets: 1400,
      freeSheets: 7800,
      cutsPerSheet: 6,
      requiredParentSheets: 775,
      shortageParentSheets: 0,
      wastagePct: 8.2,
      yieldPct: 91.8,
      sizeDeviationPct: 0,
      fitScore: 91,
      matchType: 'Direct Size',
      status: 'Ready',
      tags: ['Best Yield', 'Exact Match'],
      matchRank: 1,
      boardMatchMode: 'exact',
    },
    {
      materialId: 'mat-fbb-710x1010-300',
      materialCode: 'SPN-FBB-300-710',
      boardType: 'FBB',
      boardClassification: 'Coated',
      gsm: 300,
      gsmDelta: 0,
      size: '710×1010',
      orientation: 'LxW',
      availableSheets: 5600,
      reservedSheets: 800,
      freeSheets: 4800,
      cutsPerSheet: 6,
      requiredParentSheets: 775,
      shortageParentSheets: 0,
      wastagePct: 11.4,
      yieldPct: 88.6,
      sizeDeviationPct: 1.4,
      fitScore: 76,
      matchType: 'Cut Fit',
      status: 'Ready',
      tags: ['Most Available'],
      matchRank: 2,
      boardMatchMode: 'cross_field',
    },
    {
      materialId: 'mat-fbb-720x1020-290',
      materialCode: 'ITC-FBB-290-720',
      boardType: 'FBB',
      boardClassification: 'Coated',
      gsm: 290,
      gsmDelta: -10,
      size: '720×1020',
      orientation: 'LxW',
      availableSheets: 3100,
      reservedSheets: 200,
      freeSheets: 2900,
      cutsPerSheet: 6,
      requiredParentSheets: 775,
      shortageParentSheets: 0,
      wastagePct: 8.2,
      yieldPct: 91.8,
      sizeDeviationPct: 0,
      fitScore: 63,
      matchType: 'GSM Tolerance',
      status: 'Partial',
      tags: ['Closest GSM'],
      matchRank: 3,
      boardMatchMode: 'exact',
    },
  ],
  closestAvailableOptions: [],
}

const MOCK_LINE: PlanningEngineLine = {
  id: 'demo-line-001',
  cartonId: 'carton-001',
  cartonName: 'FERINTO TABLETS (VASU) MONOCARTON (2×15)',
  cartonSize: '85×130×22',
  quantity: 4650,
  artworkCode: 'AW-2627-FERINTO-R1',
  coatingType: 'Drip-off',
  otherCoating: null,
  embossingLeafing: null,
  paperType: 'FBB',
  gsm: 300,
  remarks: null,
  planningStatus: 'planning',
  po: {
    id: 'po-sg2-2627',
    poNumber: 'SG2/2627/POS/PMP/00119',
    poDate: '2026-05-15',
    customer: { id: 'cust-sg', name: 'Swiss Garniers Biotech Pvt Ltd' },
  },
  materialQueue: {
    boardType: 'FBB',
    sheetLengthMm: 1020,
    sheetWidthMm: 720,
  },
  specOverrides: {
    selectedBoardMaterialId: 'mat-fbb-720x1020-300',
    selectedBoardMaterialCode: 'ITC-FBB-300-720',
    selectedBoardSize: '720×1020',
    meta: {
      cuttingDirection: 'length',
      sheetUnit: 'mm',
      cutPlanChildSizes: [
        { lMm: 222, wMm: 120, qty: 3 },
        { lMm: 222, wMm: 120, qty: 3 },
      ],
      cutsPerSheet: 6,
      cutType: 6,
      selectedCutsPerSheet: 6,
      makeReadySheets: 50,
      wastageSheets: 150,
      ups: 6,
      balanceAction: 'return_warehouse',
      parentSize: '720×1020',
      sheetLengthMm: 1020,
      sheetWidthMm: 720,
    },
  },
  planningLedger: null,
  batchDecision: null,
} as unknown as PlanningEngineLine

// ─── Demo Page ────────────────────────────────────────────────────────────────

export default function PlanningEngineDemoPage() {
  const [line, setLine] = useState<PlanningEngineLine>(MOCK_LINE)
  const [locked, setLocked] = useState(false)

  async function handlePatch(patch: Partial<PlanningEngineLine>) {
    setLine((prev) => ({
      ...prev,
      ...patch,
      specOverrides: patch.specOverrides
        ? { ...(prev.specOverrides ?? {}), ...patch.specOverrides }
        : prev.specOverrides,
    }))
    await Promise.resolve()
    return true
  }

  async function handleLock() {
    setLocked(true)
    setLine((prev) => ({
      ...prev,
      batchDecision: {
        ...prev.batchDecision,
        status: 'Released',
        lockedAt: new Date().toISOString(),
      } as PlanningEngineLine['batchDecision'],
    }))
  }

  return (
    <div className="flex flex-col" style={{ minHeight: '100vh' }}>
      {/* Demo banner */}
      <div className="flex items-center gap-3 bg-amber-500/10 border-b border-amber-500/20 px-6 py-2 shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
          Demo Mode
        </span>
        <span className="text-xs text-amber-200/70">
          Planning engine with fully-mocked data · {line.cartonName}
        </span>
        {locked && (
          <span className="ml-auto text-[11px] font-semibold text-emerald-300">
            ✓ Locked
          </span>
        )}
      </div>

      {/* Engine — natural scroll */}
      <PlanningEngineBody
        line={line}
        readiness={MOCK_READINESS}
        readinessLoading={false}
        onPatch={handlePatch}
        onLock={handleLock}
      />
    </div>
  )
}
