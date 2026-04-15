import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

type ColourRow = { name: string; type?: string }

function defaultColoursFromCount(n: number): ColourRow[] {
  const base: ColourRow[] = [
    { name: 'C', type: 'process' },
    { name: 'M', type: 'process' },
    { name: 'Y', type: 'process' },
    { name: 'K', type: 'process' },
  ]
  if (n <= 0) return base
  if (n <= 4) return base.slice(0, n)
  const extra = n - 4
  const out = [...base]
  for (let i = 1; i <= extra; i++) out.push({ name: `P${i}`, type: 'pantone' })
  return out
}

/**
 * GET /api/plate-hub/plate-lookup?awCode=&customerId=
 * Safe lookup for rack / custody tabular entry. Never throws 500 for missing AW.
 */
export async function GET(req: NextRequest) {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const awCode = (req.nextUrl.searchParams.get('awCode') || '').trim()
    const customerId = (req.nextUrl.searchParams.get('customerId') || '').trim()

    if (!awCode) {
      return NextResponse.json(
        { found: false, error: 'awCode is required' },
        { status: 400 },
      )
    }

    const lineWhere =
      customerId.length > 0
        ? {
            artworkCode: { equals: awCode, mode: 'insensitive' as const },
            po: { customerId },
          }
        : {
            artworkCode: { equals: awCode, mode: 'insensitive' as const },
          }

    const line = await db.poLineItem.findFirst({
      where: lineWhere,
      orderBy: { updatedAt: 'desc' },
      include: {
        po: { select: { customerId: true } },
      },
    })

    const carton =
      line?.cartonId != null
        ? await db.carton.findUnique({
            where: { id: line.cartonId },
            select: { id: true, name: true },
          })
        : null

    const spec = (line?.specOverrides as Record<string, unknown> | null) || {}
    const designerCommand = spec.designerCommand as Record<string, unknown> | undefined
    const plateReq = designerCommand?.plateRequirement as Record<string, unknown> | undefined

    let colours: ColourRow[] = []
    if (plateReq) {
      const push = (name: string, on: boolean | undefined, type: string) => {
        if (on) colours.push({ name, type })
      }
      push('C', plateReq.standardC === true, 'process')
      push('M', plateReq.standardM === true, 'process')
      push('Y', plateReq.standardY === true, 'process')
      push('K', plateReq.standardK === true, 'process')
      if (plateReq.pantoneEnabled && Number(plateReq.numberOfPantones) > 0) {
        const n = Math.min(6, Math.max(0, Number(plateReq.numberOfPantones) || 0))
        for (let i = 1; i <= n; i++) {
          const code = String(plateReq[`pantone${i}`] || '').trim()
          colours.push({ name: code || `P${i}`, type: 'pantone' })
        }
      }
    }
    if (colours.length === 0) {
      const nColours =
        typeof spec.numberOfColours === 'number' && spec.numberOfColours > 0
          ? spec.numberOfColours
          : 4
      colours = defaultColoursFromCount(nColours)
    }

    const artwork = await db.artwork.findFirst({
      where: {
        filename: { equals: awCode, mode: 'insensitive' },
        ...(customerId ? { job: { customerId } } : {}),
      },
      select: { id: true, versionNumber: true, jobId: true },
    })

    if (!line && !artwork) {
      return NextResponse.json(
        { found: false, error: 'AW Code not found in Master.' },
        { status: 404 },
      )
    }

    const sheetSize =
      typeof spec.actualSheetSize === 'string' && spec.actualSheetSize.trim()
        ? spec.actualSheetSize.trim()
        : null
    const setNumber = line?.setNumber?.trim() || null
    const cartonName =
      carton?.name ||
      line?.cartonName ||
      (artwork
        ? (
            await db.job.findUnique({
              where: { id: artwork.jobId },
              select: { productName: true },
            })
          )?.productName
        : null) ||
      null

    return NextResponse.json({
      found: true,
      awCode,
      cartonName,
      cartonId: carton?.id ?? line?.cartonId ?? null,
      artworkId: (spec.artworkId as string | undefined)?.trim() || artwork?.id || null,
      artworkVersion: artwork ? String(artwork.versionNumber) : null,
      setNumber,
      sheetSize,
      colours,
      customerId: (line?.po.customerId ?? customerId) || null,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Lookup failed'
    return NextResponse.json({ found: false, error: msg }, { status: 500 })
  }
}
