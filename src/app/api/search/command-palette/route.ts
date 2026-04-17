import { NextRequest, NextResponse } from 'next/server'
import { PastingStyle } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import type {
  CommandPaletteGroup,
  CommandPaletteGroupId,
  CommandPaletteResult,
} from '@/lib/command-palette-types'

export const dynamic = 'force-dynamic'

const TAKE = 10

function poStatusBadge(status: string): { text: string; className: string } {
  const s = status.toLowerCase()
  if (s === 'confirmed') {
    return { text: 'Confirmed', className: 'bg-sky-600/70 text-white ring-1 ring-sky-300/30' }
  }
  if (s === 'draft') {
    return { text: 'Draft', className: 'bg-slate-600/70 text-slate-100 ring-1 ring-slate-400/25' }
  }
  if (s === 'closed') {
    return { text: 'Closed', className: 'bg-slate-700/80 text-slate-200 ring-1 ring-slate-500/30' }
  }
  return {
    text: status.replace(/_/g, ' '),
    className: 'bg-amber-700/60 text-amber-50 ring-1 ring-amber-400/25',
  }
}

function jobStatusBadge(status: string): { text: string; className: string } {
  const s = status.toLowerCase()
  if (s === 'in_production') {
    return { text: 'In production', className: 'bg-emerald-700/75 text-white ring-1 ring-emerald-300/35' }
  }
  if (s === 'dispatched') {
    return { text: 'Dispatched', className: 'bg-violet-700/75 text-white ring-1 ring-violet-300/35' }
  }
  if (s === 'closed') {
    return { text: 'Closed', className: 'bg-slate-700/80 text-slate-200 ring-1 ring-slate-500/30' }
  }
  if (s === 'pending_artwork' || s === 'artwork_approved') {
    return { text: 'Artwork', className: 'bg-amber-700/65 text-amber-50 ring-1 ring-amber-400/30' }
  }
  return {
    text: status.replace(/_/g, ' '),
    className: 'bg-slate-600/70 text-slate-100 ring-1 ring-slate-400/25',
  }
}

function mapPasting(s: PastingStyle | null | undefined): CommandPaletteResult['pastingStyle'] {
  if (s === PastingStyle.BSO) return 'BSO'
  if (s === PastingStyle.LOCK_BOTTOM) return 'LOCK_BOTTOM'
  if (s === PastingStyle.SPECIAL) return 'SPECIAL'
  return null
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ groups: [] satisfies CommandPaletteGroup[] })
  }

  const mode = 'insensitive' as const
  const dyeNum = /^\d{1,6}$/.test(q) ? parseInt(q, 10) : null

  const dyeWhere =
    dyeNum != null
      ? {
          OR: [
            { dyeNumber: dyeNum },
            { sheetSize: { contains: q, mode } },
            { cartonSize: { contains: q, mode } },
          ],
        }
      : {
          OR: [
            { sheetSize: { contains: q, mode } },
            { cartonSize: { contains: q, mode } },
            { dyeType: { contains: q, mode } },
          ],
        }

  const kpiIntent =
    /\b(kpi|vital|vitals|director|command|oee|overview|business|procurement|sales|order book|gate pass|customer|supplier|vendor)\b/i.test(
      q,
    )

  const [purchaseOrders, cartons, dyes, jobs, suppliers] = await Promise.all([
    db.purchaseOrder.findMany({
      where: {
        OR: [{ poNumber: { contains: q, mode } }, { customer: { name: { contains: q, mode } } }],
      },
      take: TAKE,
      orderBy: { updatedAt: 'desc' },
      include: { customer: { select: { name: true } } },
    }),
    db.carton.findMany({
      where: {
        OR: [
          { cartonName: { contains: q, mode } },
          { artworkCode: { contains: q, mode } },
        ],
      },
      take: TAKE,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        cartonName: true,
        artworkCode: true,
        pastingStyle: true,
        customer: { select: { name: true } },
      },
    }),
    db.dye.findMany({
      where: dyeWhere,
      take: TAKE,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        dyeNumber: true,
        dyeType: true,
        sheetSize: true,
        cartonSize: true,
        pastingStyle: true,
        active: true,
      },
    }),
    db.job.findMany({
      where: {
        OR: [{ jobNumber: { contains: q, mode } }, { productName: { contains: q, mode } }],
      },
      take: TAKE,
      orderBy: { dueDate: 'asc' },
      include: { customer: { select: { name: true } } },
    }),
    db.supplier.findMany({
      where: {
        OR: [
          { name: { contains: q, mode } },
          { gstNumber: { contains: q, mode } },
          { contactName: { contains: q, mode } },
        ],
      },
      take: TAKE,
      orderBy: { name: 'asc' },
    }),
  ])

  const orderResults: CommandPaletteResult[] = purchaseOrders.map((po) => ({
    id: `po-${po.id}`,
    title: po.poNumber,
    subtitle: po.customer.name,
    href: `/orders/purchase-orders/${po.id}`,
    statusBadge: poStatusBadge(po.status),
  }))

  const masterResults: CommandPaletteResult[] = cartons.map((c) => ({
    id: `carton-${c.id}`,
    title: c.cartonName,
    subtitle: [c.customer.name, c.artworkCode ? `Art ${c.artworkCode}` : null].filter(Boolean).join(' · '),
    href: `/masters/cartons/${c.id}`,
    pastingStyle: mapPasting(c.pastingStyle),
  }))

  const dieResults: CommandPaletteResult[] = dyes.map((d) => ({
    id: `die-${d.id}`,
    title: `Die #${d.dyeNumber}`,
    subtitle: `${d.dyeType} · ${d.sheetSize} · ${d.cartonSize}`,
    href: `/masters/dies/${d.id}`,
    pastingStyle: mapPasting(d.pastingStyle),
    statusBadge: d.active
      ? undefined
      : { text: 'Inactive', className: 'bg-slate-700/80 text-slate-300 ring-1 ring-slate-500/30' },
  }))

  const jobResults: CommandPaletteResult[] = jobs.map((j) => ({
    id: `job-${j.id}`,
    title: j.jobNumber,
    subtitle: `${j.productName} · ${j.customer.name}`,
    href: `/jobs/${j.id}`,
    statusBadge: jobStatusBadge(j.status),
  }))

  const toolingResults: CommandPaletteResult[] = [...dieResults, ...jobResults]

  const supplierResults: CommandPaletteResult[] = suppliers.map((s) => ({
    id: `supplier-${s.id}`,
    title: s.name,
    subtitle: [s.gstNumber, s.contactPhone].filter(Boolean).join(' · ') || 'Supplier',
    href: `/masters/suppliers/${s.id}`,
  }))

  const businessResults: CommandPaletteResult[] = kpiIntent
    ? [
        {
          id: 'biz-director',
          title: 'Director Command Center',
          subtitle: 'KPIs · order book · procurement · OEE',
          href: '/director/command-center',
        },
        {
          id: 'biz-pos',
          title: 'Customer purchase orders',
          subtitle: 'Live order book & pipeline',
          href: '/orders/purchase-orders',
        },
        {
          id: 'biz-procurement',
          title: 'Procurement workbench',
          subtitle: 'Vendor material POs',
          href: '/orders/procurement',
        },
        {
          id: 'biz-oee',
          title: 'OEE live dashboard',
          subtitle: 'Press efficiency',
          href: '/oee',
        },
      ]
    : []

  const groups: CommandPaletteGroup[] = (
    [
      ...(businessResults.length > 0
        ? ([
            {
              id: 'business' as const satisfies CommandPaletteGroupId,
              label: 'BUSINESS / KPIs',
              results: businessResults,
            },
          ] satisfies CommandPaletteGroup[])
        : []),
      { id: 'orders' as const satisfies CommandPaletteGroupId, label: 'ORDERS', results: orderResults },
      { id: 'tooling' as const satisfies CommandPaletteGroupId, label: 'TOOLING', results: toolingResults },
      {
        id: 'masters' as const satisfies CommandPaletteGroupId,
        label: 'MASTERS',
        results: [...masterResults, ...supplierResults],
      },
    ] satisfies CommandPaletteGroup[]
  ).filter((g) => g.results.length > 0)

  return NextResponse.json({ groups })
}
