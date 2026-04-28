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
    return { text: 'Confirmed', className: 'bg-sky-600/70 text-primary-foreground ring-1 ring-sky-300/30' }
  }
  if (s === 'draft') {
    return { text: 'Pending', className: 'bg-ds-warning/18 text-ds-ink ring-1 ring-ds-warning/40' }
  }
  if (s === 'closed') {
    return { text: 'Closed', className: 'bg-ds-elevated/80 text-ds-ink ring-1 ring-ds-line/30' }
  }
  return {
    text: status.replace(/_/g, ' '),
    className: 'bg-ds-warning/20 text-ds-ink ring-1 ring-ds-warning/40',
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

  const embossOr: Prisma.EmbossBlockWhereInput[] = []
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  for (const t of tokens) {
    if (uuidRe.test(t)) {
      embossOr.push({ id: t }, { cartonId: t })
    }
    embossOr.push(
      { blockCode: { contains: t, mode } },
      { blockType: { contains: t, mode } },
      { blockMaterial: { contains: t, mode } },
      { cartonName: { contains: t, mode } },
      {
        cartons: { some: { id: { contains: t, mode } } },
      },
      {
        cartons: { some: { cartonName: { contains: t, mode } } },
      },
      {
        cartons: { some: { customer: { name: { contains: t, mode } } } },
      },
    )
  }

  const shadeOr: Prisma.ShadeCardWhereInput[] = []
  for (const t of tokens) {
    shadeOr.push(
      { shadeCode: { contains: t, mode } },
      { productMaster: { contains: t, mode } },
      { inkComponent: { contains: t, mode } },
      { masterArtworkRef: { contains: t, mode } },
      { customer: { name: { contains: t, mode } } },
    )
  }

  const [purchaseOrders, cartons, artworks, dyes, embossBlocks, shadeCards] = await Promise.all([
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
    db.embossBlock.findMany({
      where: { active: true, OR: embossOr },
      take: TAKE_EACH,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        blockCode: true,
        blockMaterial: true,
        impressionCount: true,
        cartonName: true,
        cartonId: true,
        cartons: { take: 12, select: { id: true, cartonName: true } },
      },
    }),
    db.shadeCard.findMany({
      where: { OR: shadeOr },
      take: TAKE_EACH,
      orderBy: { updatedAt: 'desc' },
      include: {
        customer: { select: { name: true } },
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

  const embossResults: CommandPaletteResult[] = embossBlocks.map((b) => {
    const linkedId = b.cartonId ?? b.cartons[0]?.id ?? null
    const fromCarton = linkedId ? b.cartons.find((c) => c.id === linkedId) : undefined
    const productName =
      fromCarton?.cartonName?.trim() ||
      b.cartons[0]?.cartonName?.trim() ||
      b.cartonName?.trim() ||
      b.blockCode
    return {
      id: `emboss-${b.id}`,
      title: productName,
      titleMono: false,
      subtitle: [b.blockCode, b.blockMaterial, `${b.impressionCount.toLocaleString()} strikes`]
        .filter(Boolean)
        .join(' · '),
      subtitleMono: true,
      href: `/hub/blocks?focusBlock=${encodeURIComponent(b.id)}`,
      statusBadge: {
        text: 'Emboss',
        className: 'bg-orange-800/70 text-orange-50 ring-1 ring-orange-400/30',
      },
    }
  })

  const shadeResults: CommandPaletteResult[] = shadeCards.map((s) => ({
    id: `shade-${s.id}`,
    title: s.shadeCode,
    titleMono: true,
    subtitle: [s.customer?.name, s.productMaster].filter(Boolean).join(' · ') || 'Shade card',
    href: `/hub/shade-card-hub?q=${encodeURIComponent(q)}`,
    statusBadge: {
      text: 'Shade',
      className: 'bg-violet-800/65 text-violet-50 ring-1 ring-violet-400/25',
    },
  }))

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
        ? { text: 'Inactive', className: 'bg-ds-elevated/80 text-ds-ink-muted ring-1 ring-ds-line/30' }
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
          id: 'biz-oee',
          title: 'Live production stages',
          subtitle: 'Production stage-wise job cards',
          href: '/production/stages',
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
        results: [...dieResults, ...embossResults, ...shadeResults],
      },
    ] satisfies CommandPaletteGroup[]
  ).filter((g) => g.results.length > 0)

  return NextResponse.json({ groups })
}
