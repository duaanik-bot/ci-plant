import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { getReport } from '@/lib/reports/registry'

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
    return NextResponse.json(result)
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
