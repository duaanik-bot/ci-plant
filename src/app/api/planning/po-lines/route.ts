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

  const [list, machines, invRows] = await Promise.all([
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
