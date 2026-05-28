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

export const dynamic = 'force-dynamic'

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
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('planningStatus')
  const customerId = searchParams.get('customerId')

  const where: Record<string, unknown> = {}
  if (status) where.planningStatus = status
  if (customerId) where.po = { customerId }

  const [list, machines, invRows, paperRows, fgRows] = await Promise.all([
    db.poLineItem.findMany({
      where,
      orderBy: [
        { directorPriority: 'desc' },
        { po: { isPriority: 'desc' } },
        { directorHold: 'asc' },
        { createdAt: 'desc' },
      ],
      include: {
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
    }),
    db.machine.findMany({
      select: {
        id: true,
        machineCode: true,
        name: true,
        stdWastePct: true,
        capacityPerShift: true,
        specification: true,
      },
      orderBy: { machineCode: 'asc' },
    }),
    db.inventory.findMany({
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
    }),
    db.paperWarehouse.findMany({
      where: { qtySheets: { gt: 0 } },
      select: {
        paperType: true,
        boardGrade: true,
        gsm: true,
        qtySheets: true,
        location: true,
      },
    }),
    db.inventory.findMany({
      where: { active: true, qtyFg: { gt: 0 } },
      select: { materialCode: true, description: true, qtyFg: true },
    }),
  ])

  const machineList = machines.map((m) => ({ id: m.id, machineCode: m.machineCode }))

  const enriched = await Promise.all(
    list.map(async (li) => {
      const jc = li.jobCardNumber
        ? await db.productionJobCard.findFirst({
            where: { jobCardNumber: li.jobCardNumber },
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
        : null

      const spec = li.specOverrides && typeof li.specOverrides === 'object'
        ? (li.specOverrides as Record<string, unknown>)
        : {}

      // NOTE: `specPack` is a scalar on PoLineItem returned because this query
      // uses Prisma `include` (which returns all root scalars). If a root-level
      // `select` is ever added to the poLineItem query, `specPack: true` MUST be
      // added there or every line silently degrades to legacy.
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
      const boardWanted = boardFromQueue || boardFromPack || boardFromPo
      const gsmWanted =
        typeof li.materialQueue?.gsm === 'number'
          ? li.materialQueue.gsm
          : packBoard.gsm != null
            ? packBoard.gsm
            : typeof li.gsm === 'number'
              ? li.gsm
              : li.carton?.gsm ?? null

      const boardTokens = boardWanted
        .toLowerCase()
        .split(/[\s/,-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
      const boardMatch = (txt: string) => {
        if (!boardTokens.length) return true
        const hay = txt.toLowerCase()
        return boardTokens.some((t) => hay.includes(t))
      }

      const matchedPaperRows = paperRows.filter((pw) => {
        if (typeof gsmWanted === 'number' && Number.isFinite(gsmWanted) && pw.gsm !== gsmWanted) return false
        return boardMatch(`${pw.boardGrade ?? ''} ${pw.paperType}`)
      })
      const leftoverSheets = matchedPaperRows
        .filter((pw) => String(pw.location ?? '').trim().toUpperCase() === 'FLOOR')
        .reduce((sum, pw) => sum + Math.max(0, Number(pw.qtySheets) || 0), 0)
      const mainAvailableSheets = matchedPaperRows
        .filter((pw) => String(pw.location ?? '').trim().toUpperCase() !== 'FLOOR')
        .reduce((sum, pw) => sum + Math.max(0, Number(pw.qtySheets) || 0), 0)
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
        selectedPlanningMaterial?.boardClassification?.trim() ||
        selectedPlanningMaterial?.boardType?.trim() ||
        selectedPlanningMaterial?.materialCode?.trim() ||
        null
      const availableTotalSheets = selectedPlanningMaterial ? selectedFreeSheets : mainAvailableSheets + leftoverSheets
      const shortageSheets = Math.max(0, Number(requiredSheets ?? 0) - availableTotalSheets)
      let stockSignal: 'green' | 'yellow' | 'red' = 'red'
      if (selectedPlanningMaterial) {
        if (requiredSheets != null && selectedFreeSheets >= Number(requiredSheets)) stockSignal = 'green'
        else if (selectedFreeSheets > 0) stockSignal = 'yellow'
      } else if (materialGate.status === 'available') stockSignal = 'green'
      else if (materialGate.status === 'ordered') stockSignal = 'yellow'
      else if (requiredSheets != null && availableTotalSheets >= requiredSheets) stockSignal = 'green'
      else if (availableTotalSheets > 0) stockSignal = 'yellow'

      const suggestedBoardOptions = Array.from(
        new Set(
          matchedPaperRows
            .map((pw) => (pw.boardGrade?.trim() || pw.paperType.trim()))
            .filter((v) => !!v),
        ),
      ).slice(0, 3)

      const readinessFive = computeFivePointReadiness({
        artworkLocksCompleted,
        platesStatus,
        materialGate,
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
          materialGate,
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
            availableMainSheets: selectedPlanningMaterial ? selectedFreeSheets : mainAvailableSheets,
            availableLeftoverSheets: leftoverSheets,
            availableTotalSheets,
            reservedSheets: selectedPlanningMaterial
              ? selectedReservedSheets
              : Math.max(0, Number(materialGate.netAvailable ?? 0)),
            shortageSheets,
            requiredSheets,
            stockSignal,
            specComplete: packMath.specComplete,
            specIncompleteReason: packMath.reason,
            recommendedBoardGrade: selectedPlanningMaterial?.boardClassification ?? packBoard.boardGrade,
            recommendedGsm:
              typeof selectedPlanningMaterial?.gsm === 'number' && Number.isFinite(selectedPlanningMaterial.gsm)
                ? selectedPlanningMaterial.gsm
                : packBoard.gsm,
            recommendedPaperType: selectedPlanningMaterial?.boardType ?? packBoard.paperType,
            selectedMaterialId: selectedPlanningMaterialId || null,
            selectedMaterialCode: selectedPlanningMaterial?.materialCode ?? null,
            selectedMaterialSize,
            packSheetsRequired: packMath.sheetsRequired,
            procurementSuggestion:
              shortageSheets > 0 && (packBoard.boardGrade || packBoard.paperType)
                ? {
                    boardGrade: packBoard.boardGrade,
                    gsm: packBoard.gsm,
                    paperType: packBoard.paperType,
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
    }),
  )

  return NextResponse.json(enriched)
}
