import { PrismaClient } from '@prisma/client'
import { reserveMaterial, allocateGRNToShortage, getMaterialReadiness } from '@/lib/material-readiness-service'

const prisma = new PrismaClient()

async function main() {
  const material = await prisma.inventory.create({
    data: {
      materialCode: `TEST-MAT-${Date.now()}`,
      description: 'Test board material',
      boardType: 'SBS',
      boardClassification: 'Art Folding',
      sheetLength: 123 + Math.floor(Math.random() * 10),
      sheetWidth: 231 + Math.floor(Math.random() * 10),
      gsm: 300,
      unit: 'sheets',
      qtyAvailable: 100,
      physicalStockSheets: 100,
      active: true,
    },
  })

  const user = await prisma.user.findFirst({ select: { id: true } })
  if (!user) throw new Error('No user found for test')

  const customer = await prisma.customer.create({
    data: {
      name: `TEST-CUSTOMER-${Date.now()}`,
    },
  })

  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: `TEST-PO-${Date.now()}`,
      customerId: customer.id,
      poDate: new Date(),
      createdBy: user.id,
      status: 'draft',
    },
  })

  const required = Number(material.qtyAvailable) + 25

  const jc = await prisma.productionJobCard.create({
    data: {
      customerId: po.customerId,
      requiredSheets: required,
      totalSheets: required,
      wastageSheets: 0,
      status: 'design_ready',
    },
  })

  const line = await prisma.poLineItem.create({
    data: {
      poId: po.id,
      cartonName: 'TEST-MATERIAL-READINESS',
      quantity: required,
      planningStatus: 'job_card_created',
      jobCardNumber: jc.jobCardNumber,
      paperType: material.boardType,
      gsm: material.gsm,
    },
  })

  const mq = await prisma.materialQueue.create({
    data: {
      purchaseOrderId: po.id,
      poLineItemId: line.id,
      boardType: material.boardType ?? 'Unknown',
      gsm: material.gsm ?? 0,
      grainDirection: 'Long grain',
      sheetLengthMm: material.sheetLength!,
      sheetWidthMm: material.sheetWidth!,
      ups: 1,
      wastagePct: 0,
      orderQty: required,
      totalSheets: required,
      totalWeightKg: 0,
    },
  })

  const reserve = await reserveMaterial(material.id, jc.id, required, line.id)
  if (reserve.status !== 'partial_shortage') throw new Error('Expected partial_shortage')
  if (!reserve.shortage?.id) throw new Error('Shortage not created')
  if (!reserve.purchaseRequest?.id) throw new Error('PR not created')

  const grnMovement = await prisma.stockMovement.create({
    data: {
      materialId: material.id,
      movementType: 'grn_quarantine',
      qty: reserve.shortageSheets,
      refType: 'test_grn',
      refId: `TEST-${Date.now()}`,
    },
  })

  await prisma.inventory.update({
    where: { id: material.id },
    data: { qtyQuarantine: { increment: reserve.shortageSheets } },
  })

  const alloc = await allocateGRNToShortage(grnMovement.id, reserve.shortage.id)
  if (alloc.remainingQty !== 0) throw new Error('Shortage not closed after allocation')

  const readiness = await getMaterialReadiness(jc.id)
  const ok = readiness.shortageSheets === 0 && readiness.reservedSheets >= required

  console.log(JSON.stringify({ ok, reserveStatus: reserve.status, prStatus: readiness.prStatus, readiness }, null, 2))

  await prisma.grnShortageAllocation.deleteMany({ where: { shortageId: reserve.shortage.id } })
  await prisma.materialShortage.deleteMany({ where: { jobCardId: jc.id } })
  await prisma.materialReservation.deleteMany({ where: { jobCardId: jc.id } })
  await prisma.purchaseRequisition.deleteMany({ where: { sourceJobCardId: jc.id } })
  await prisma.stockMovement.deleteMany({ where: { materialId: material.id } })

  await prisma.materialQueue.delete({ where: { id: mq.id } })
  await prisma.poLineItem.delete({ where: { id: line.id } })
  await prisma.productionJobCard.delete({ where: { id: jc.id } })
  await prisma.purchaseOrder.delete({ where: { id: po.id } })
  await prisma.customer.delete({ where: { id: customer.id } })
  await prisma.inventory.delete({ where: { id: material.id } })

}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})
