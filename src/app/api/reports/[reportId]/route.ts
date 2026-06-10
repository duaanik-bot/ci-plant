import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { getReport } from '@/lib/reports/registry'
import { clampListLimit } from '@/lib/api-list-params'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { reportId: string } }
) {
  const { error } = await requireAuth()
  if (error) return error

  const mod = getReport(params.reportId)
  if (!mod) return NextResponse.json({ error: 'Unknown report' }, { status: 404 })

  const raw = Object.fromEntries(req.nextUrl.searchParams.entries())
  try {
    const filters = mod.filterSchema.parse(raw)
    const result = await mod.query(filters as any)
    const preview = req.nextUrl.searchParams.get('preview') === '1'
    if (!preview) return NextResponse.json(result)

    const limit = clampListLimit(req.nextUrl.searchParams.get('limit'), { defaultLimit: 100, max: 500 })
    const includeChart = req.nextUrl.searchParams.get('includeChart') === '1'
    return NextResponse.json({
      ...result,
      rows: result.rows.slice(0, limit),
      chart: includeChart
        ? result.chart
          ? { ...result.chart, data: result.chart.data.slice(0, limit) }
          : undefined
        : undefined,
      meta: {
        ...result.meta,
        preview: 'true',
        previewLimit: String(limit),
        totalRows: String(result.rows.length),
        chartIncluded: includeChart ? 'true' : 'false',
      },
    })
  } catch (e) {
    if (e instanceof ZodError) {
      return NextResponse.json(
        { error: 'Invalid filters', issues: e.flatten().fieldErrors },
        { status: 400 }
      )
    }
    console.error(`[reports:${params.reportId}] query failed`, e)
    return NextResponse.json({ error: 'Report generation failed' }, { status: 500 })
  }
}
