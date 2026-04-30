import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { getPostPressRouting } from '@/lib/emboss-conditions'
import { CUSTODY_PREPARING_FOR_PRODUCTION } from '@/lib/inventory-hub-custody'
import {
  computeFivePointReadiness,
  computeMaterialGate,
  estimateDurationHours,
  firstFivePointBlockerName,
} from '@/lib/planning-interlock'
import { applyAllocatedStockToJobCard, get_allocated_stock_dims } from '@/lib/allocated-stock-dims'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  requiredSheets: z.number().int().positive().optional(),
  wastageSheets: z.number().int().min(0).optional(),
  batchNumber: z.string().optional(),
  assignedOperator: z.string().optional(),
})

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: poLineItemId } = await context.params
  const json = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const { requiredSheets: bodySheets, wastageSheets, batchNumber, assignedOperator } = parsed.data

  const invRows = await db.inventory.findMany({
    where: { active: true },
    select: { materialCode: true, description: true, qtyAvailable: true, qtyReserved: true },
  })

  const li = await db.poLineItem.findUnique({
    where: { id: poLineItemId },
    include: {
      po: { include: { customer: true } },
      shadeCard: {
        select: {
          custodyStatus: true,
          mfgDate: true,
          approvalDate: true,
          createdAt: true,
          isActive: true,
        },
      },
      materialQueue: {
        select: { totalSheets: true, boardType: true, gsm: true },
      },
      carton: {
        select: {
          embossingLeafing: true,
          coatingType: true,
          laminateType: true,
          embossBlockId: true,
        },
      },
    },
  })

  if (!li) return NextResponse.json({ error: 'PO line item not found' }, { status: 404 })
  if (li.jobCardNumber) {
    return NextResponse.json(
      { error: `Job card already exists for this line (JC# ${li.jobCardNumber})` },
      { status: 400 },
    )
  }
  if (li.directorHold) {
    return NextResponse.json({ error: 'Line is on director hold' }, { status: 400 })
  }

  const spec = (li.specOverrides && typeof li.specOverrides === 'object'
    ? li.specOverrides
    : {}) as Record<string, unknown>

  const specTwoApprovals = !!(spec.customerApprovalPharma && spec.shadeCardQaTextApproval)
  let artworkLocksCompleted = specTwoApprovals
    ? 2
    : Number(spec.artworkLocksCompleted ?? 0)
  if (artworkLocksCompleted < 2) {
    return NextResponse.json(
      { error: 'Pre-press approvals incomplete — both artwork gates must pass before job card generation' },
      { status: 400 },
    )
  }

  const platesStatus = String(spec.platesStatus ?? 'new_required')
  const dieStatus = String(spec.dieStatus ?? (li.dyeId ? 'good' : 'not_available'))
  const embossStatus = String(spec.embossStatus ?? 'vendor_ordered')

  const materialGate = computeMaterialGate({
    materialQueue: li.materialQueue,
    materialProcurementStatus: li.materialProcurementStatus,
    inventoryRows: invRows,
  })

  const { segments: fiveSegs, allGreen } = computeFivePointReadiness({
    artworkLocksCompleted,
    platesStatus,
    materialGate,
    dieStatus,
    embossingLeafing: li.embossingLeafing ?? li.carton?.embossingLeafing,
    embossStatus,
    shadeCardId: li.shadeCardId,
    shadeCard: li.shadeCard,
  })

  if (!allGreen) {
    const miss = firstFivePointBlockerName(fiveSegs, platesStatus)
    return NextResponse.json(
      {
        error: `5-point readiness not satisfied${miss ? ` — blocked on ${miss}` : ''}`,
      },
      { status: 400 },
    )
  }

  const machineId = typeof spec.machineId === 'string' ? spec.machineId.trim() : ''
  if (!machineId) {
    return NextResponse.json({ error: 'Machine must be allocated on the line before generation' }, { status: 400 })
  }

  const mqSheets = li.materialQueue?.totalSheets
  const baseRequiredSheets = bodySheets ?? mqSheets ?? Math.max(1, Math.ceil(li.quantity / 4))
  const reservedQty =
    spec.fgReservation && typeof spec.fgReservation === 'object'
      ? Number((spec.fgReservation as Record<string, unknown>).qtyReserved ?? 0)
      : 0
  const useReservedFirst = spec.useReservedFirst !== false
  const requiredSheets = useReservedFirst
    ? Math.max(1, baseRequiredSheets - Math.max(0, reservedQty))
    : baseRequiredSheets
  const waste = wastageSheets ?? 0
  const totalSheets = requiredSheets + waste

  const routingSource = {
    embossingLeafing: li.embossingLeafing ?? li.carton?.embossingLeafing,
    coatingType: li.coatingType ?? li.carton?.coatingType,
    laminateType: li.carton?.laminateType,
  }
  const postPressRouting = getPostPressRouting(routingSource)

  const embossBlockId = li.carton?.embossBlockId ?? null

  const created = await db.$transaction(async (tx) => {
    const jcRow = await tx.productionJobCard.create({
      data: {
        customerId: li.po.customerId,
        setNumber: li.setNumber || null,
        machineId: machineId || null,
        assignedOperator: assignedOperator || null,
        requiredSheets,
        wastageSheets: waste,
        totalSheets,
        sheetsIssued: 0,
        artworkApproved: false,
        firstArticlePass: false,
        finalQcPass: false,
        qaReleased: false,
        coaGenerated: false,
        batchNumber: batchNumber || null,
        status: 'design_ready',
        postPressRouting: postPressRouting as object,
        embossBlockId,
        plateSetId: null,
      },
    })

    const stageNames = [
      'Cutting',
      'Printing',
      'Chemical Coating',
      'Lamination',
      'Embossing',
      'Leafing',
      'Spot UV',
      'Dye Cutting',
      'Pasting',
    ]
    await Promise.all(
      stageNames.map((stageName) =>
        tx.productionStageRecord.create({
          data: {
            jobCardId: jcRow.id,
            stageName,
            status: stageName === 'Cutting' ? 'ready' : 'pending',
          },
        }),
      ),
    )

    await tx.poLineItem.update({
      where: { id: li.id },
      data: {
        jobCardNumber: jcRow.jobCardNumber,
        planningStatus: 'job_card_created',
        toolingLocked: true,
      },
    })

    if (li.dyeId) {
      await tx.dye.update({
        where: { id: li.dyeId },
        data: {
          custodyStatus: CUSTODY_PREPARING_FOR_PRODUCTION,
          issuedMachineId: machineId,
          issuedAt: new Date(),
        },
      })
    }
    if (embossBlockId) {
      await tx.embossBlock.update({
        where: { id: embossBlockId },
        data: {
          custodyStatus: CUSTODY_PREPARING_FOR_PRODUCTION,
          issuedMachineId: machineId,
          issuedAt: new Date(),
        },
      })
    }
    if (li.shadeCardId) {
      await tx.shadeCard.update({
        where: { id: li.shadeCardId },
        data: {
          custodyStatus: CUSTODY_PREPARING_FOR_PRODUCTION,
          issuedJobCardId: jcRow.id,
          issuedMachineId: machineId,
          issuedAt: new Date(),
        },
      })
    }

    return jcRow
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'production_job_cards',
    recordId: created.id,
    newValue: {
      jobCardNumber: created.jobCardNumber,
      poLineItemId,
      source: 'planning_generate',
    },
  })

  const awTargetSheet =
    typeof spec.actualSheetSize === 'string' ? spec.actualSheetSize.trim() || null : null
  const allocated = await get_allocated_stock_dims(db, { poLineItemId: li.id })
  if (allocated) {
    await applyAllocatedStockToJobCard(db, created.id, allocated, awTargetSheet)
  }

  const machine = await db.machine.findUnique({
    where: { id: machineId },
    select: { stdWastePct: true },
  })
  const estH = estimateDurationHours(
    mqSheets ?? requiredSheets,
    machine?.stdWastePct != null ? Number(machine.stdWastePct) : null,
  )

  return NextResponse.json(
    {
      ...created,
      planning: {
        readinessFive: { segments: fiveSegs, allGreen },
        materialGate,
        estimatedDurationHours: estH,
        reservedApplied: useReservedFirst ? Math.max(0, reservedQty) : 0,
        baseRequiredSheets,
      },
    },
    { status: 201 },
  )
}
