import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { grnNumber, n, prNumber, ymd } from '@/lib/procurement-foundation'
import { getPendingSupplierPayables } from '@/lib/procurement-integration'

export const dynamic = 'force-dynamic'

const DASHBOARD_CACHE_MS = 10_000
let dashboardCache: { createdAt: number; payload: unknown } | null = null
let dashboardInflight: Promise<unknown> | null = null

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const now = Date.now()
  if (dashboardCache && now - dashboardCache.createdAt < DASHBOARD_CACHE_MS) {
    return NextResponse.json(dashboardCache.payload)
  }

  dashboardInflight ??= buildDashboardPayload()
    .then((payload) => {
      dashboardCache = { createdAt: Date.now(), payload }
      return payload
    })
    .finally(() => {
      dashboardInflight = null
    })

  return NextResponse.json(await dashboardInflight)
}

async function buildDashboardPayload() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const twoDaysAgo = new Date(today)
  twoDaysAgo.setDate(today.getDate() - 2)

  const openPoWhere: Prisma.VendorMaterialPurchaseOrderWhereInput = {
    status: { in: ['draft', 'confirmed', 'sent', 'partial_received'] },
    isShortClosed: false,
  }
  const criticalShortageWhere: Prisma.PurchaseRequisitionWhereInput = {
    status: { in: ['draft', 'pending', 'approved'] },
    OR: [{ triggerReason: { contains: 'critical', mode: 'insensitive' as const } }, { material: { shortageSheets: { gt: 0 } } }],
  }
  const [
    openPrs,
    pendingApprovalPrs,
    approvedPrs,
    openPoCount,
    openPoRows,
    overduePosCount,
    receiptsToday,
    postedToday,
    criticalShortages,
    monthPostedReceipts,
    postedReceipts,
    pendingApprovalRows,
    criticalShortageRows,
    pendingGrnRows,
    qcRejectedRows,
    followUpPos,
    payables,
  ] = await Promise.all([
    db.purchaseRequisition.count({ where: { status: { in: ['draft', 'pending'] } } }),
    db.purchaseRequisition.count({ where: { status: 'pending' } }),
    db.purchaseRequisition.count({ where: { status: 'approved' } }),
    db.vendorMaterialPurchaseOrder.count({ where: openPoWhere }),
    db.vendorMaterialPurchaseOrder.findMany({
      where: openPoWhere,
      take: 150,
      orderBy: { requiredDeliveryDate: 'asc' },
      include: { supplier: true, lines: true },
    }),
    db.vendorMaterialPurchaseOrder.count({
      where: {
        ...openPoWhere,
        requiredDeliveryDate: { lt: today },
      },
    }),
    db.vendorMaterialReceipt.count({ where: { receiptDate: { gte: today, lt: tomorrow } } }),
    db.vendorMaterialReceipt.count({ where: { qcStatus: 'POSTED_TO_STOCK', qcPerformedAt: { gte: today, lt: tomorrow } } }),
    db.purchaseRequisition.count({ where: criticalShortageWhere }),
    db.vendorMaterialReceipt.findMany({
      where: { qcStatus: 'POSTED_TO_STOCK', qcPerformedAt: { gte: monthStart } },
      include: { vendorPo: { include: { lines: true } } },
    }),
    db.vendorMaterialReceipt.findMany({
      where: { qcStatus: 'POSTED_TO_STOCK', qcPerformedAt: { not: null } },
      take: 200,
      orderBy: { qcPerformedAt: 'desc' },
      include: { vendorPo: true },
    }),
    db.purchaseRequisition.findMany({
      where: { status: 'pending' },
      take: 8,
      orderBy: { raisedAt: 'asc' },
      include: { material: true },
    }),
    db.purchaseRequisition.findMany({
      where: criticalShortageWhere,
      take: 8,
      orderBy: { raisedAt: 'asc' },
      include: { material: true },
    }),
    db.vendorMaterialReceipt.findMany({
      where: { OR: [{ qcStatus: null }, { qcStatus: { in: ['DRAFT', 'RECEIVED', 'QC_PENDING', 'QC_ACCEPTED', 'QC_REJECTED', 'PARTIALLY_ACCEPTED'] } }] },
      take: 8,
      orderBy: { receiptDate: 'asc' },
      include: { vendorPo: { include: { supplier: true } } },
    }),
    db.vendorMaterialReceipt.findMany({
      where: { qtyRejected: { gt: 0 }, qcStatus: { not: 'POSTED_TO_STOCK' } },
      take: 8,
      orderBy: { receiptDate: 'desc' },
      include: { vendorPo: { include: { supplier: true } } },
    }),
    db.vendorMaterialPurchaseOrder.findMany({
      where: {
        status: { in: ['confirmed', 'sent', 'partial_received'] },
        OR: [{ requiredDeliveryDate: { lte: tomorrow } }, { logisticsUpdatedAt: { lt: twoDaysAgo } }],
      },
      take: 8,
      orderBy: { requiredDeliveryDate: 'asc' },
      include: { supplier: true },
    }),
    getPendingSupplierPayables(),
  ])

  const pendingGrns = await db.vendorMaterialReceipt.count({
    where: { OR: [{ qcStatus: null }, { qcStatus: { in: ['DRAFT', 'RECEIVED', 'QC_PENDING'] } }] },
  })
  const openPoValue = openPoRows.reduce(
    (sum, po) => sum + po.lines.reduce((s, line) => s + n(line.totalWeightKg) * n(line.ratePerKg), 0),
    0,
  )
  const monthlyPurchaseValue = monthPostedReceipts.reduce((sum, receipt) => {
    const ordered = receipt.vendorPo.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
    const accepted = n(receipt.qtyAcceptedStandard) + n(receipt.qtyAcceptedPenalty)
    return sum + receipt.vendorPo.lines.reduce((s, line) => s + n(line.ratePerKg) * accepted * (ordered > 0 ? n(line.totalWeightKg) / ordered : 0), 0)
  }, 0)
  const avgPoToGrnDays = postedReceipts.length
    ? postedReceipts.reduce((s, r) => s + Math.max(0, (r.receiptDate.getTime() - r.vendorPo.orderDate.getTime()) / 86400000), 0) / postedReceipts.length
    : 0
  const onTimeDeliveries = postedReceipts.filter((r) => !r.vendorPo.requiredDeliveryDate || r.receiptDate <= r.vendorPo.requiredDeliveryDate).length
  const totalReceived = postedReceipts.reduce((s, r) => s + n(r.receivedQty), 0)
  const totalRejected = postedReceipts.reduce((s, r) => s + n(r.qtyRejected), 0)

  return {
    openPrs,
    pendingApprovalPrs,
    approvedPrs,
    openPos: openPoCount,
    pendingGrns,
    overduePos: overduePosCount,
    todaysReceipts: receiptsToday,
    postedGrnsToday: postedToday,
    openPoValue,
    monthlyPurchaseValue,
    averagePrToPoTime: 0,
    averagePoToGrnTime: Number(avgPoToGrnDays.toFixed(1)),
    supplierOnTimeDeliveryPct: postedReceipts.length ? Number(((onTimeDeliveries / postedReceipts.length) * 100).toFixed(1)) : 0,
    qcRejectionPct: totalReceived > 0 ? Number(((totalRejected / totalReceived) * 100).toFixed(1)) : 0,
    criticalShortagesLinkedToPr: criticalShortages,
    controlTower: {
      cards: {
        criticalShortages,
        pendingApprovals: pendingApprovalPrs,
        openPos: openPoCount,
        overdueDeliveries: overduePosCount,
        grnPendingPosting: pendingGrns,
        qcRejectedReceipts: qcRejectedRows.length,
        suppliersRequiringFollowUp: followUpPos.length,
        pendingSupplierInvoices: payables.length,
        pendingPayableValue: payables.reduce((sum, p) => sum + p.accruedPayableInr, 0),
      },
      criticalShortages: criticalShortageRows.map((pr) => ({
        id: pr.id,
        label: prNumber(pr.id, pr.raisedAt),
        material: pr.material.materialCode,
        qty: n(pr.qtyRequired),
        status: pr.status,
        href: `/procurement/pr/${pr.id}`,
        action: pr.status === 'approved' ? 'Convert PR' : pr.status === 'pending' ? 'Approve PR' : 'Review PR',
      })),
      pendingApprovals: pendingApprovalRows.map((pr) => ({
        id: pr.id,
        label: prNumber(pr.id, pr.raisedAt),
        material: pr.material.materialCode,
        qty: n(pr.qtyRequired),
        status: pr.status,
        href: `/procurement/pr/${pr.id}`,
        action: 'Approve PR',
      })),
      overdueDeliveries: openPoRows
        .filter((po) => po.requiredDeliveryDate && po.requiredDeliveryDate < today)
        .slice(0, 8)
        .map((po) => ({
          id: po.id,
          label: po.poNumber,
          supplier: po.supplier.name,
          expectedDelivery: ymd(po.requiredDeliveryDate),
          status: po.status,
          href: `/procurement/po/${po.id}`,
          action: 'Receive Material',
        })),
      grnPendingPosting: pendingGrnRows.map((r) => ({
        id: r.id,
        label: grnNumber(r.id, r.receiptDate),
        poNumber: r.vendorPo.poNumber,
        supplier: r.vendorPo.supplier.name,
        receiptDate: ymd(r.receiptDate),
        status: r.qcStatus ?? 'QC_PENDING',
        href: `/procurement/grn/${r.id}`,
        action: 'Post GRN',
      })),
      qcRejectedReceipts: qcRejectedRows.map((r) => ({
        id: r.id,
        label: grnNumber(r.id, r.receiptDate),
        poNumber: r.vendorPo.poNumber,
        supplier: r.vendorPo.supplier.name,
        rejectedQty: n(r.qtyRejected),
        href: `/procurement/grn/${r.id}`,
        action: 'Review QC',
      })),
      supplierFollowUps: followUpPos.map((po) => ({
        id: po.id,
        label: po.poNumber,
        supplier: po.supplier.name,
        expectedDelivery: ymd(po.requiredDeliveryDate),
        status: po.status,
        href: `/procurement/po/${po.id}`,
        action: po.status === 'draft' ? 'Send PO' : 'Follow Up',
      })),
      pendingPayables: payables.slice(0, 8).map((p) => ({
        id: p.poId,
        label: p.payableReference,
        supplier: p.supplierName,
        poNumber: p.poNumber,
        amount: p.accruedPayableInr,
        status: p.invoiceStatus,
        href: `/procurement/po/${p.poId}`,
        action: 'Match Invoice',
      })),
    },
  }
}
