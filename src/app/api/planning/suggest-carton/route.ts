import { NextRequest, NextResponse } from 'next/server'
import { unstable_cache } from 'next/cache'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import {
  nameSimilarity,
  dimensionMatch,
  scoreSuggestion,
} from '@/lib/carton/match'

export const dynamic = 'force-dynamic'
const n = (v: unknown) => (v != null ? Number(v as number) : null)

const loadCartons = (clientId: string | null) =>
  unstable_cache(
    async () =>
      db.carton.findMany({
        where: { active: true, ...(clientId ? { customerId: clientId } : {}) },
        include: { customer: { select: { id: true, name: true } } },
        take: 3000,
      }),
    ['suggest-carton', clientId ?? 'all'],
    { revalidate: 300 },
  )()

export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const clientId = (body.client_id as string) ?? null
  const hint = (body.product_name_hint as string) ?? ''
  const dims = body.dimensions
    ? {
        l: n(body.dimensions.l),
        w: n(body.dimensions.w),
        h: n(body.dimensions.h),
      }
    : null

  const rows = await loadCartons(clientId)

  const scored = rows
    .map((c) => {
      const nameSim = hint ? nameSimilarity(hint, c.cartonName) : 0
      const cand = {
        l: n(c.finishedLength),
        w: n(c.finishedWidth),
        h: n(c.finishedHeight),
      }
      const dimWithinTol = dims
        ? dimensionMatch(dims, cand, 3) !== 'none'
        : false
      const specMatch =
        (body.gsm && c.gsm === Number(body.gsm) ? 0.5 : 0) +
        (body.board_grade && c.boardGrade === body.board_grade ? 0.5 : 0)
      const confidence_score = scoreSuggestion({
        clientMatch: !!clientId && c.customerId === clientId,
        nameSim,
        dimWithinTol,
        specMatch,
      })
      const basis: string[] = []
      if (clientId && c.customerId === clientId) basis.push('client')
      if (nameSim > 0.6) basis.push('name')
      if (dimWithinTol) basis.push('dimensions')
      if (specMatch > 0) basis.push('spec')
      return {
        carton: {
          id: c.id,
          carton_name: c.cartonName,
          client_name: c.customer.name,
        },
        confidence_score,
        match_basis: basis.join('+') || 'weak',
      }
    })
    .sort((a, b) => b.confidence_score - a.confidence_score)

  const top = scored[0]
  return NextResponse.json({
    top_suggestion: top ?? null,
    alternatives: scored.slice(1, 4),
    new_carton_required: !top || top.confidence_score < 40,
    missing_fields: [
      !clientId && 'client_id',
      !hint && 'product_name_hint',
      !dims && 'dimensions',
    ].filter(Boolean),
  })
}
