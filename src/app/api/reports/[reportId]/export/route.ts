import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { getReport } from '@/lib/reports/registry'
import { reportToXlsx } from '@/lib/reports/export/to-xlsx'
import { reportToPdf } from '@/lib/reports/export/to-pdf'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { reportId: string } }
) {
  const { error } = await requireAuth()
  if (error) return error

  const mod = getReport(params.reportId)
  if (!mod) return NextResponse.json({ error: 'Unknown report' }, { status: 404 })

  const sp = req.nextUrl.searchParams
  const format = sp.get('format') === 'pdf' ? 'pdf' : 'xlsx'
  const raw = Object.fromEntries(sp.entries())

  try {
    const filters = mod.filterSchema.parse(raw)
    const result = await mod.query(filters as any)
    const from = result.meta.filtersApplied.from ?? 'all'
    const to = result.meta.filtersApplied.to ?? 'all'
    const fname = `${mod.id}_${from}_${to}.${format}`

    if (format === 'pdf') {
      const buf = await reportToPdf(mod.title, result)
      return new NextResponse(buf as unknown as BodyInit, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${fname}"`,
        },
      })
    }
    const buf = reportToXlsx(mod.id, result)
    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fname}"`,
      },
    })
  } catch (e) {
    if (e instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid filters' }, { status: 400 })
    }
    console.error(`[reports:${params.reportId}:export] failed`, e)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}
