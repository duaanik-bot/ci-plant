import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  const contains = q ? { contains: q, mode: 'insensitive' as const } : undefined

  const [materials, suppliers, approvedPrs, openPos] = await Promise.all([
    db.inventory.findMany({
      where: {
        active: true,
        ...(contains
          ? { OR: [{ materialCode: contains }, { description: contains }, { boardType: contains }, { category: contains }] }
          : {}),
      },
      orderBy: { materialCode: 'asc' },
      take: 50,
      select: {
        id: true,
        materialCode: true,
        description: true,
        unit: true,
        category: true,
        qtyAvailable: true,
        qtyReserved: true,
        qtyQuarantine: true,
        boardType: true,
        gsm: true,
      },
    }),
    db.supplier.findMany({
      where: {
        active: true,
        ...(contains ? { OR: [{ name: contains }, { contactName: contains }, { gstNumber: contains }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: 50,
      select: {
        id: true,
        name: true,
        contactName: true,
        contactPhone: true,
        email: true,
        gstNumber: true,
        address: true,
        paymentTerms: true,
      },
    }),
    db.purchaseRequisition.findMany({
      where: {
        status: 'approved',
        ...(contains
          ? { OR: [{ material: { materialCode: contains } }, { material: { description: contains } }, { triggerReason: contains }] }
          : {}),
      },
      orderBy: { raisedAt: 'desc' },
      take: 50,
      include: { material: { select: { materialCode: true, description: true, unit: true, boardType: true, gsm: true } } },
    }),
    db.vendorMaterialPurchaseOrder.findMany({
      where: {
        status: { in: ['draft', 'confirmed', 'sent', 'partial_received'] },
        isShortClosed: false,
        ...(contains ? { OR: [{ poNumber: contains }, { supplier: { name: contains } }] } : {}),
      },
      orderBy: { orderDate: 'desc' },
      take: 50,
      include: { supplier: { select: { name: true } }, lines: true },
    }),
  ])

  return NextResponse.json({
    materials: materials.map((m) => ({
      ...m,
      qtyAvailable: Number(m.qtyAvailable),
      qtyReserved: Number(m.qtyReserved),
      qtyQuarantine: Number(m.qtyQuarantine),
    })),
    suppliers,
    approvedPrs: approvedPrs.map((pr) => ({
      id: pr.id,
      materialId: pr.materialId,
      qtyRequired: Number(pr.qtyRequired),
      materialCode: pr.material.materialCode,
      description: pr.material.description,
      unit: pr.material.unit,
      boardType: pr.material.boardType,
      gsm: pr.material.gsm,
    })),
    openPos: openPos.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      supplierName: po.supplier.name,
      status: po.status,
      lines: po.lines.map((line) => ({
        id: line.id,
        boardGrade: line.boardGrade,
        gsm: line.gsm,
        totalSheets: line.totalSheets,
        totalWeightKg: Number(line.totalWeightKg),
        ratePerKg: line.ratePerKg == null ? null : Number(line.ratePerKg),
      })),
    })),
  })
}
