import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  computeFivePointReadiness,
  computeMaterialGate,
  computeToolingInterlock,
  estimateDurationHours,
  isArtworkLocked,
  suggestMachineId,
} from '@/lib/planning-interlock'
import { readCartonSpecPack, computePackSheetMath } from '@/lib/carton-spec-pack'
import { boardTypeLabelsMatch, normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

const PLANNING_LIST_MAX_LIMIT = 600
const PLANNING_SLOW_MS = 500
const PLANNING_BOARD_STATUSES = ['pending', 'design_ready', 'job_card_created'] as const
const PLANNING_RESERVATION_REF_TYPES = [
  'planning_reserve',
  'planning_adjust_increase',
  'planning_release',
  'planning_adjust_decrease',
  'planning_shortage_allocation',
] as const

function normFg(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Sum finished-goods stock (inventory.qtyFg) whose material matches this line's product. */
function fgStockForLine(
  line: { cartonName: string | null; artworkCode: string | null; carton?: { artworkCode?: string | null } | null },
  fgRows: { materialCode: string; description: string; qtyFg: unknown }[],
): number {
  const cartonN = normFg(line.cartonName)
  const awN = normFg(line.artworkCode ?? line.carton?.artworkCode ?? '')
  if (!cartonN && !awN) return 0
  let sum = 0
  for (const inv of fgRows) {
    const codeN = normFg(inv.materialCode)
    const descN = normFg(inv.description)
    const match =
      (cartonN.length > 4 && (descN.includes(cartonN) || cartonN.includes(descN))) ||
      (awN.length > 2 && (codeN.includes(awN) || descN.includes(awN)))
    if (match) {
      const q = Number((inv.qtyFg as { toString(): string })?.toString?.() ?? inv.qtyFg ?? 0)
      if (Number.isFinite(q) && q > 0) sum += q
    }
  }
  return Math.round(sum)
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('planningStatus')
  const customerId = searchParams.get('customerId')
  const rawLimit = searchParams.get('limit')
  const limitParam = rawLimit == null ? null : Number(rawLimit)
  const take =
    limitParam == null || !Number.isFinite(limitParam)
      ? null
      : Math.min(PLANNING_LIST_MAX_LIMIT, Math.max(1, Math.floor(limitParam)))

  const where: Record<string, unknown> = {}
  if (status) where.planningStatus = status
  else where.planningStatus = { in: [...PLANNING_BOARD_STATUSES] }
  if (customerId) where.po = { customerId }

  const list = await db.poLineItem.findMany({
      where,
      orderBy: [
        { directorPriority: 'desc' },
        { po: { isPriority: 'desc' } },
        { directorHold: 'asc' },
        { createdAt: 'desc' },
      ],
      ...(take != null ? { take } : {}),
      select: {
        id: true,
        poId: true,
        cartonId: true,
        cartonName: true,
        cartonSize: true,
        quantity: true,
        artworkCode: true,
        rate: true,
        gsm: true,
        coatingType: true,
        otherCoating: true,
        embossingLeafing: true,
        paperType: true,
        dyeId: true,
        dieMasterId: true,
        dimLengthMm: true,
        dimWidthMm: true,
        remarks: true,
        setNumber: true,
        jobCardNumber: true,
        planningStatus: true,
        materialProcurementStatus: true,
        specOverrides: true,
        specPack: true,
        tolerancePct: true,
        directorPriority: true,
        directorHold: true,
        shadeCardId: true,
        createdAt: true,
        po: {
          select: {
            id: true,
            poNumber: true,
            status: true,
            poDate: true,
            isPriority: true,
            customer: { select: { id: true, name: true } },
          },
        },
        shadeCard: {
          select: {
            id: true,
            custodyStatus: true,
            mfgDate: true,
            approvalDate: true,
            createdAt: true,
            isActive: true,
          },
        },
        materialQueue: {
          select: {
            totalSheets: true,
            boardType: true,
            gsm: true,
            orderQty: true,
            ups: true,
            sheetLengthMm: true,
            sheetWidthMm: true,
          },
        },
        carton: {
          select: {
            id: true,
            numberOfColours: true,
            embossingLeafing: true,
            coatingType: true,
            laminateType: true,
            paperType: true,
            gsm: true,
            blankLength: true,
            blankWidth: true,
            sheetSizeL: true,
            sheetSizeW: true,
            ups: true,
            artworkCode: true,
            specialInstructions: true,
          },
        },
        dieMaster: {
          select: {
            id: true,
            dyeNumber: true,
            ups: true,
            sheetSize: true,
          },
        },
      },
    })
  const machines = await db.machine.findMany({
      select: {
        id: true,
        machineCode: true,
        name: true,
        stdWastePct: true,
        capacityPerShift: true,
        specification: true,
      },
      orderBy: { machineCode: 'asc' },
    })
  const invRows = await db.inventory.findMany({
      where: { active: true },
      select: {
        id: true,
        materialCode: true,
        description: true,
        boardType: true,
        boardClassification: true,
        gsm: true,
        sheetLength: true,
        sheetWidth: true,
        qtyAvailable: true,
        qtyReserved: true,
      },
    })
  const fgRows = await db.inventory.findMany({
      where: { active: true, qtyFg: { gt: 0 } },
      select: { materialCode: true, description: true, qtyFg: true },
    })

  const jobCardNumbers = Array.from(
    new Set(
      list
        .map((li) => li.jobCardNumber)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
    ),
  )
  const jobCards = jobCardNumbers.length
    ? await db.productionJobCard.findMany({
        where: { jobCardNumber: { in: jobCardNumbers } },
        select: {
          id: true,
          jobCardNumber: true,
          artworkApproved: true,
          firstArticlePass: true,
          finalQcPass: true,
          qaReleased: true,
          plateSetId: true,
          status: true,
          issuedStockDisplay: true,
          grainFitStatus: true,
          inventoryLocationPointer: true,
          sheetsIssued: true,
          totalSheets: true,
          stages: {
            select: { stageName: true, counter: true },
            orderBy: { stageName: 'asc' },
          },
          allocatedPaperWarehouse: { select: { lotNumber: true } },
        },
      })
    : []
  const jobCardByNumber = new Map(jobCards.map((jc) => [jc.jobCardNumber, jc]))

  const selectedMaterialPairs = list
    .map((li) => {
      const spec = li.specOverrides && typeof li.specOverrides === 'object'
        ? (li.specOverrides as Record<string, unknown>)
        : {}
      const materialId = typeof spec.planningMaterialId === 'string' ? spec.planningMaterialId.trim() : ''
      return materialId ? { lineId: li.id, materialId } : null
    })
    .filter((pair): pair is { lineId: string; materialId: string } => !!pair)
  const selectedLineIds = Array.from(new Set(selectedMaterialPairs.map((pair) => pair.lineId)))
  const selectedMaterialIds = Array.from(new Set(selectedMaterialPairs.map((pair) => pair.materialId)))
  const reservedByLineMaterial = new Map<string, number>()
  if (selectedLineIds.length > 0 && selectedMaterialIds.length > 0) {
    const reservationRows = await db.stockMovement.findMany({
      where: {
        refId: { in: selectedLineIds },
        materialId: { in: selectedMaterialIds },
        refType: { in: [...PLANNING_RESERVATION_REF_TYPES] },
      },
      select: { refId: true, materialId: true, refType: true, qty: true },
    })
    for (const row of reservationRows) {
      if (!row.refId) continue
      const key = `${row.refId}:${row.materialId}`
      const qty = Number(row.qty) || 0
      const sign =
        row.refType === 'planning_release' || row.refType === 'planning_adjust_decrease' ? -1 : 1
      reservedByLineMaterial.set(key, Math.max(0, (reservedByLineMaterial.get(key) || 0) + sign * qty))
    }
  }

  const machineList = machines.map((m) => ({ id: m.id, machineCode: m.machineCode }))

  const enriched = list.map((li) => {
      const jc = li.jobCardNumber ? jobCardByNumber.get(li.jobCardNumber) ?? null : null

      const spec = li.specOverrides && typeof li.specOverrides === 'object'
        ? (li.specOverrides as Record<string, unknown>)
        : {}

      // Keep specPack selected explicitly; it drives sheet requirement math.
      const resolved = readCartonSpecPack({
        specPack: (li as { specPack?: unknown }).specPack ?? null,
        specOverrides: li.specOverrides ?? null,
      })
      const packBoard = resolved.pack.board
      const wastagePct = li.tolerancePct != null ? Number(li.tolerancePct.toString()) : 2
      const packMath = computePackSheetMath(
        resolved.pack.sheet, li.quantity, wastagePct,
      )

      const artworkLocksCompleted = isArtworkLocked(spec) ? 2 : 0
      const platesStatus = String(spec.platesStatus ?? (jc?.plateSetId ? 'available' : 'new_required'))
      const dieStatus = String(spec.dieStatus ?? (li.dyeId ? 'good' : 'not_available'))
      const embossStatus = String(
        spec.embossStatus ?? 'vendor_ordered',
      )
      const machineAllocated = !!(spec.machineId && String(spec.machineId).trim())

      const numberOfColours =
        typeof spec.numberOfColours === 'number'
          ? spec.numberOfColours
          : li.carton?.numberOfColours ?? null

      const suggestedMachineId = suggestMachineId(machineList, numberOfColours)
      const specMachineId = typeof spec.machineId === 'string' ? spec.machineId.trim() : ''

      const toolingInterlock = computeToolingInterlock({
        platesStatus,
        dieStatus,
        embossingLeafing: li.embossingLeafing ?? li.carton?.embossingLeafing,
        embossStatus,
        shadeCardId: li.shadeCardId,
        shadeCard: li.shadeCard,
      })

      const materialGate = computeMaterialGate({
        materialQueue: li.materialQueue,
        materialProcurementStatus: li.materialProcurementStatus,
        inventoryRows: invRows,
      })

      const boardFromPack = packBoard.boardGrade?.trim() || packBoard.paperType?.trim() || ''
      const boardFromPo = typeof li.paperType === 'string' && li.paperType.trim() ? li.paperType.trim() : ''
      const boardFromQueue =
        typeof li.materialQueue?.boardType === 'string' && li.materialQueue.boardType.trim()
          ? li.materialQueue.boardType.trim()
          : ''
      const boardWanted = normalizeBoardTypeForStorage(boardFromQueue || boardFromPack || boardFromPo) || ''
      const gsmWanted =
        typeof li.materialQueue?.gsm === 'number'
          ? li.materialQueue.gsm
          : packBoard.gsm != null
            ? packBoard.gsm
            : typeof li.gsm === 'number'
              ? li.gsm
              : li.carton?.gsm ?? null

      const matchedInventoryRows = invRows.filter((row) => {
        if (typeof gsmWanted === 'number' && Number.isFinite(gsmWanted) && row.gsm !== gsmWanted) return false
        if (!boardWanted) return true
        return (
          boardTypeLabelsMatch(boardWanted, row.boardType) ||
          boardTypeLabelsMatch(boardWanted, row.boardClassification) ||
          row.materialCode.toLowerCase().includes(boardWanted.toLowerCase().replace(/[^a-z0-9]+/g, ''))
        )
      })
      const leftoverSheets = 0
      const mainAvailableSheets = matchedInventoryRows
        .reduce((sum, row) => {
          const available = Math.max(0, Number(row.qtyAvailable) || 0)
          const reserved = Math.max(0, Number(row.qtyReserved) || 0)
          return sum + Math.max(0, available - reserved)
        }, 0)
      const requiredSheets =
        packMath.sheetsRequired ?? li.materialQueue?.totalSheets ?? null
      const selectedPlanningMaterialId =
        typeof spec.planningMaterialId === 'string' && spec.planningMaterialId.trim()
          ? spec.planningMaterialId.trim()
          : ''
      const selectedPlanningMaterial = selectedPlanningMaterialId
        ? invRows.find((row) => row.id === selectedPlanningMaterialId) ?? null
        : null
      const selectedAvailableSheets = Math.max(0, Number(selectedPlanningMaterial?.qtyAvailable) || 0)
      const selectedReservedSheets = Math.max(0, Number(selectedPlanningMaterial?.qtyReserved) || 0)
      const selectedFreeSheets = Math.max(0, selectedAvailableSheets - selectedReservedSheets)
      const selectedMaterialSize =
        selectedPlanningMaterial &&
        Number(selectedPlanningMaterial.sheetLength) > 0 &&
        Number(selectedPlanningMaterial.sheetWidth) > 0
          ? `${Number(selectedPlanningMaterial.sheetLength)} x ${Number(selectedPlanningMaterial.sheetWidth)}`
          : null
      const selectedMaterialLabel =
        normalizeBoardTypeForStorage(selectedPlanningMaterial?.boardClassification)?.trim() ||
        normalizeBoardTypeForStorage(selectedPlanningMaterial?.boardType)?.trim() ||
        selectedPlanningMaterial?.materialCode?.trim() ||
        null
      const reservedForPlanningLine =
        selectedPlanningMaterial && selectedPlanningMaterialId
          ? Math.max(0, Number(reservedByLineMaterial.get(`${li.id}:${selectedPlanningMaterialId}`) || 0))
          : 0
      const availableTotalSheets = selectedPlanningMaterial
        ? Math.max(selectedFreeSheets, reservedForPlanningLine)
        : mainAvailableSheets + leftoverSheets
      const shortageSheets = Math.max(0, Number(requiredSheets ?? 0) - availableTotalSheets)
      const materialSpecComplete = packMath.specComplete || Boolean(selectedPlanningMaterial && requiredSheets != null)
      let stockSignal: 'green' | 'yellow' | 'red' = 'red'
      if (selectedPlanningMaterial) {
        if (requiredSheets != null && availableTotalSheets >= Number(requiredSheets)) stockSignal = 'green'
        else if (availableTotalSheets > 0) stockSignal = 'yellow'
      } else if (materialGate.status === 'available') stockSignal = 'green'
      else if (materialGate.status === 'ordered') stockSignal = 'yellow'
      else if (requiredSheets != null && availableTotalSheets >= requiredSheets) stockSignal = 'green'
      else if (availableTotalSheets > 0) stockSignal = 'yellow'

      const suggestedBoardOptions = Array.from(
        new Set(
          matchedInventoryRows
            .map((row) => (normalizeBoardTypeForStorage(row.boardClassification)?.trim() || normalizeBoardTypeForStorage(row.boardType)?.trim() || row.materialCode.trim()))
            .filter((v) => !!v),
        ),
      ).slice(0, 3)

      const effectiveMaterialGate =
        selectedPlanningMaterial && requiredSheets != null && availableTotalSheets >= Number(requiredSheets)
          ? {
              ...materialGate,
              status: 'available' as const,
              requiredSheets: Number(requiredSheets),
              netAvailable: Math.max(Number(materialGate.netAvailable ?? 0), availableTotalSheets),
              netFreeSheets: availableTotalSheets,
            }
          : materialGate

      const readinessFive = computeFivePointReadiness({
        artworkLocksCompleted,
        platesStatus,
        materialGate: effectiveMaterialGate,
        dieStatus,
        embossingLeafing: li.embossingLeafing ?? li.carton?.embossingLeafing,
        embossStatus,
        shadeCardId: li.shadeCardId,
        shadeCard: li.shadeCard,
      })

      const mqSheets = li.materialQueue?.totalSheets ?? null
      const selectedMachine = machines.find((m) => m.id === specMachineId) ?? null
      const wastePct = selectedMachine?.stdWastePct ?? machines[0]?.stdWastePct
      const estimatedDurationHours = estimateDurationHours(
        mqSheets,
        wastePct != null ? Number(wastePct) : null,
      )

      const fgStockQty = fgStockForLine(li, fgRows)

      return {
        ...li,
        jobCard: jc,
        fgStockQty,
        readiness: {
          artworkLocksCompleted,
          platesStatus,
          dieStatus,
          machineAllocated,
        },
        planningLedger: {
          toolingInterlock,
          materialGate: effectiveMaterialGate,
          boardStockInsight: {
            boardWanted: selectedMaterialLabel || boardWanted || null,
            gsmWanted:
              typeof selectedPlanningMaterial?.gsm === 'number' && Number.isFinite(selectedPlanningMaterial.gsm)
                ? selectedPlanningMaterial.gsm
                : typeof gsmWanted === 'number' && Number.isFinite(gsmWanted)
                  ? gsmWanted
                  : null,
            suggestedBoardOptions: selectedMaterialLabel
              ? Array.from(new Set([selectedMaterialLabel, ...suggestedBoardOptions])).slice(0, 3)
              : suggestedBoardOptions,
            availableMainSheets: selectedPlanningMaterial ? availableTotalSheets : mainAvailableSheets,
            availableLeftoverSheets: leftoverSheets,
            availableTotalSheets,
            reservedSheets: selectedPlanningMaterial
              ? Math.max(selectedReservedSheets, reservedForPlanningLine)
              : Math.max(0, Number(effectiveMaterialGate.netAvailable ?? 0)),
            shortageSheets,
            requiredSheets,
            stockSignal,
            specComplete: materialSpecComplete,
            specIncompleteReason: materialSpecComplete ? null : packMath.reason,
            recommendedBoardGrade: normalizeBoardTypeForStorage(selectedPlanningMaterial?.boardClassification) ?? normalizeBoardTypeForStorage(packBoard.boardGrade),
            recommendedGsm:
              typeof selectedPlanningMaterial?.gsm === 'number' && Number.isFinite(selectedPlanningMaterial.gsm)
                ? selectedPlanningMaterial.gsm
                : packBoard.gsm,
            recommendedPaperType: normalizeBoardTypeForStorage(selectedPlanningMaterial?.boardType) ?? normalizeBoardTypeForStorage(packBoard.paperType),
            selectedMaterialId: selectedPlanningMaterialId || null,
            selectedMaterialCode: selectedPlanningMaterial?.materialCode ?? null,
            selectedMaterialSize,
            packSheetsRequired: packMath.sheetsRequired,
            procurementSuggestion:
              shortageSheets > 0 && (packBoard.boardGrade || packBoard.paperType)
                ? {
                    boardGrade: normalizeBoardTypeForStorage(packBoard.boardGrade),
                    gsm: packBoard.gsm,
                    paperType: normalizeBoardTypeForStorage(packBoard.paperType),
                    suggestedSheets: shortageSheets,
                  }
                : null,
          },
          suggestedMachineId,
          estimatedDurationHours,
          numberOfColours,
          readinessFive,
        },
      }
    })

  const elapsedMs = Date.now() - startedAt
  if (elapsedMs > PLANNING_SLOW_MS) {
    console.warn('[slow-api] /api/planning/po-lines', {
      elapsedMs,
      rows: enriched.length,
      limit: take ?? 'unbounded',
      status: status ?? null,
      customerId: customerId ?? null,
      jobCards: jobCards.length,
      selectedMaterialReservations: reservedByLineMaterial.size,
    })
  }

  return NextResponse.json(enriched)
}
