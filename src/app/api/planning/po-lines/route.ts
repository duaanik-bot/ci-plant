import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  computeFivePointReadiness,
  computeMaterialGate,
  computeToolingInterlock,
  estimateDurationHours,
  suggestMachineId,
} from '@/lib/planning-interlock'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('planningStatus')
  const customerId = searchParams.get('customerId')

  const where: Record<string, unknown> = {}
  if (status) where.planningStatus = status
  if (customerId) where.po = { customerId }

  const [list, machines, invRows, paperRows] = await Promise.all([
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
      select: { materialCode: true, description: true, qtyAvailable: true, qtyReserved: true },
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

      const specTwoApprovals = !!(spec.customerApprovalPharma && spec.shadeCardQaTextApproval)
      const artworkLocksCompleted = specTwoApprovals
        ? 2
        : Number(
            spec.artworkLocksCompleted ??
              (jc
                ? (jc.artworkApproved ? 1 : 0) +
                  (jc.finalQcPass ? 1 : 0) +
                  (jc.qaReleased ? 1 : 0) +
                  (jc.qaReleased ? 1 : 0)
                : 0),
          )
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

      const boardFromPo = typeof li.paperType === 'string' && li.paperType.trim() ? li.paperType.trim() : ''
      const boardFromCarton =
        typeof li.carton?.paperType === 'string' && li.carton.paperType.trim() ? li.carton.paperType.trim() : ''
      const boardFromQueue =
        typeof li.materialQueue?.boardType === 'string' && li.materialQueue.boardType.trim()
          ? li.materialQueue.boardType.trim()
          : ''
      const boardWanted = boardFromQueue || boardFromPo || boardFromCarton
      const gsmWanted =
        typeof li.materialQueue?.gsm === 'number'
          ? li.materialQueue.gsm
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
      const requiredSheets = li.materialQueue?.totalSheets ?? null
      const availableTotalSheets = mainAvailableSheets + leftoverSheets
      let stockSignal: 'green' | 'yellow' | 'red' = 'red'
      if (requiredSheets != null && availableTotalSheets >= requiredSheets) stockSignal = 'green'
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

      return {
        ...li,
        jobCard: jc,
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
            boardWanted: boardWanted || null,
            gsmWanted: typeof gsmWanted === 'number' && Number.isFinite(gsmWanted) ? gsmWanted : null,
            suggestedBoardOptions,
            availableMainSheets: mainAvailableSheets,
            availableLeftoverSheets: leftoverSheets,
            availableTotalSheets,
            reservedSheets: Math.max(0, Number(requiredSheets ?? 0) - availableTotalSheets),
            requiredSheets,
            stockSignal,
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
