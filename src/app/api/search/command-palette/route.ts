import { NextRequest, NextResponse } from 'next/server'
import { PastingStyle, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { searchTokens } from '@/lib/command-palette-fuzzy'
import type {
  CommandPaletteGroup,
  CommandPaletteGroupId,
  CommandPaletteResult,
} from '@/lib/command-palette-types'

export const dynamic = 'force-dynamic'

const TAKE_EACH = 12

function poStatusBadge(status: string): { text: string; className: string } {
  const s = status.toLowerCase()
  if (s === 'confirmed') {
    return { text: 'Confirmed', className: 'bg-sky-600/70 text-white ring-1 ring-sky-300/30' }
  }
  if (s === 'draft') {
    return { text: 'Pending', className: 'bg-amber-700/55 text-amber-50 ring-1 ring-amber-400/30' }
  }
  if (s === 'closed') {
    return { text: 'Closed', className: 'bg-slate-700/80 text-slate-200 ring-1 ring-slate-500/30' }
  }
  return {
    text: status.replace(/_/g, ' '),
    className: 'bg-amber-700/60 text-amber-50 ring-1 ring-amber-400/25',
  }
}

function dieConditionBadge(condition: string | null | undefined): {
  text: string
  className: string
} {
  const c = (condition || 'Good').trim()
  const low = c.toLowerCase()
  if (low.includes('poor') || low.includes('bad') || low === 'p') {
    return { text: 'Poor', className: 'bg-rose-700/70 text-rose-50 ring-1 ring-rose-400/35' }
  }
  return { text: 'Good', className: 'bg-emerald-700/65 text-emerald-50 ring-1 ring-emerald-400/30' }
}

function mapPasting(s: PastingStyle | null | undefined): CommandPaletteResult['pastingStyle'] {
  if (s === PastingStyle.BSO) return 'BSO'
  if (s === PastingStyle.LOCK_BOTTOM) return 'LOCK_BOTTOM'
  if (s === PastingStyle.SPECIAL) return 'SPECIAL'
  return null
}

function formatCartonSize(c: {
  finishedLength: Prisma.Decimal | null
  finishedWidth: Prisma.Decimal | null
  finishedHeight: Prisma.Decimal | null
}): string | null {
  const l = c.finishedLength != null ? Number(c.finishedLength) : null
  const w = c.finishedWidth != null ? Number(c.finishedWidth) : null
  const h = c.finishedHeight != null ? Number(c.finishedHeight) : null
  if (l != null && w != null && h != null && l > 0 && w > 0 && h > 0) {
    return `${l}×${w}×${h}`
  }
  return null
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ groups: [] satisfies CommandPaletteGroup[] })
  }

  const tokens = searchTokens(q)
  if (tokens.length === 0) {
    return NextResponse.json({ groups: [] satisfies CommandPaletteGroup[] })
  }

  const mode = 'insensitive' as const

  const poOr: Prisma.PurchaseOrderWhereInput[] = []
  for (const t of tokens) {
    poOr.push(
      { poNumber: { contains: t, mode } },
      { customer: { name: { contains: t, mode } } },
    )
  }

  const cartonOr: Prisma.CartonWhereInput[] = []
  for (const t of tokens) {
    cartonOr.push(
      { cartonName: { contains: t, mode } },
      { artworkCode: { contains: t, mode } },
    )
  }

  const artworkOr: Prisma.ArtworkWhereInput[] = []
  for (const t of tokens) {
    artworkOr.push(
      { filename: { contains: t, mode } },
      { job: { productName: { contains: t, mode } } },
      { job: { jobNumber: { contains: t, mode } } },
    )
  }

  const dyeNumToken = tokens.find((t) => /^\d{1,6}$/.test(t))
  const dyeNum = dyeNumToken != null ? parseInt(dyeNumToken, 10) : null

  const dyeOr: Prisma.DyeWhereInput[] = []
  if (dyeNum != null) {
    dyeOr.push({ dyeNumber: dyeNum })
  }
  for (const t of tokens) {
    dyeOr.push(
      { sheetSize: { contains: t, mode } },
      { cartonSize: { contains: t, mode } },
      { dyeType: { contains: t, mode } },
      { location: { contains: t, mode } },
    )
  }

  const kpiIntent =
    /\b(kpi|vital|vitals|director|command|oee|overview|business|procurement|sales|order book|gate pass|customer|supplier|vendor)\b/i.test(
      q,
    )

  const [purchaseOrders, cartons, artworks, dyes] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { OR: poOr },
      take: TAKE_EACH,
      orderBy: { updatedAt: 'desc' },
      include: { customer: { select: { name: true } } },
    }),
    db.carton.findMany({
      where: { OR: cartonOr },
      take: TAKE_EACH,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        cartonName: true,
        artworkCode: true,
        pastingStyle: true,
        finishedLength: true,
        finishedWidth: true,
        finishedHeight: true,
        customer: { select: { name: true } },
      },
    }),
    db.artwork.findMany({
      where: { OR: artworkOr },
      take: TAKE_EACH,
      orderBy: { updatedAt: 'desc' },
      include: {
        job: { select: { id: true, jobNumber: true, productName: true } },
      },
    }),
    db.dye.findMany({
      where: { OR: dyeOr },
      take: TAKE_EACH,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        dyeNumber: true,
        dyeType: true,
        sheetSize: true,
        cartonSize: true,
        location: true,
        condition: true,
        conditionRating: true,
        active: true,
        pastingStyle: true,
        dimLengthMm: true,
        dimWidthMm: true,
        dimHeightMm: true,
      },
    }),
  ])

  const orderResults: CommandPaletteResult[] = purchaseOrders.map((po) => ({
    id: `po-${po.id}`,
    title: po.poNumber,
    titleMono: true,
    subtitle: po.customer.name,
    href: `/orders/purchase-orders/${po.id}`,
    statusBadge: poStatusBadge(po.status),
  }))

  const masterResults: CommandPaletteResult[] = [
    ...cartons.map((c) => {
      const size = formatCartonSize(c)
      return {
        id: `carton-${c.id}`,
        title: c.cartonName,
        subtitle: [size, c.customer.name, c.artworkCode ? `AW ${c.artworkCode}` : null]
          .filter(Boolean)
          .join(' · '),
        subtitleMono: Boolean(size),
        href: `/masters/cartons/${c.id}`,
        pastingStyle: mapPasting(c.pastingStyle),
        showMasterIcon: true,
      } satisfies CommandPaletteResult
    }),
    ...artworks.map((a) => {
      const j = a.job
      const subtitle = j
        ? [j.productName, j.jobNumber !== a.filename ? `Job ${j.jobNumber}` : null, `AW ${a.filename}`]
            .filter(Boolean)
            .join(' · ')
        : `AW ${a.filename}`
      return {
        id: `artwork-${a.id}`,
        title: a.filename,
        titleMono: true,
        subtitle,
        subtitleMono: true,
        href: `/jobs/${j?.id ?? a.jobId}`,
        statusBadge: {
          text: 'Artwork',
          className: 'bg-violet-700/60 text-violet-50 ring-1 ring-violet-400/25',
        },
        showMasterIcon: true,
      } satisfies CommandPaletteResult
    }),
  ]

  const dieResults: CommandPaletteResult[] = dyes.map((d) => {
    const cond =
      (d.conditionRating || d.condition || 'Good').toLowerCase().includes('poor') ||
      (d.condition || '').toLowerCase().includes('poor')
        ? 'Poor'
        : 'Good'
    const dimBits = [d.dimLengthMm, d.dimWidthMm, d.dimHeightMm]
      .filter((x) => x != null)
      .map((x) => String(x))
    const dimStr = dimBits.length === 3 ? `${dimBits[0]}×${dimBits[1]}×${dimBits[2]} mm` : null
    return {
      id: `die-${d.id}`,
      title: `DYE-${d.dyeNumber}`,
      titleMono: true,
      subtitle: [cond, d.location || '—', dimStr || d.cartonSize].filter(Boolean).join(' · '),
      subtitleMono: true,
      href: `/hub/dies?focusDie=${encodeURIComponent(d.id)}`,
      pastingStyle: mapPasting(d.pastingStyle),
      statusBadge: !d.active
        ? { text: 'Inactive', className: 'bg-slate-700/80 text-slate-300 ring-1 ring-slate-500/30' }
        : dieConditionBadge(d.condition || d.conditionRating),
    }
  })

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
          title: 'Material Readiness Hub',
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
      {
        id: 'orders' as const satisfies CommandPaletteGroupId,
        label: 'ORDERS',
        results: orderResults,
      },
      {
        id: 'masters' as const satisfies CommandPaletteGroupId,
        label: 'MASTERS',
        results: masterResults,
      },
      {
        id: 'tooling' as const satisfies CommandPaletteGroupId,
        label: 'TOOLING',
        results: dieResults,
      },
    ] satisfies CommandPaletteGroup[]
  ).filter((g) => g.results.length > 0)

  return NextResponse.json({ groups })
}
