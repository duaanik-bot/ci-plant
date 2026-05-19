import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { nameSimilarity } from '@/lib/carton/match'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim()
  const clientId = searchParams.get('client')

  const rows = await db.carton.findMany({
    where: {
      active: true,
      ...(clientId ? { customerId: clientId } : {}),
      ...(q
        ? {
            OR: [
              { cartonName: { contains: q, mode: 'insensitive' } },
              { artworkCode: { contains: q, mode: 'insensitive' } },
              { boardGrade: { contains: q, mode: 'insensitive' } },
              { coatingType: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: { customer: { select: { id: true, name: true } } },
    take: 200,
  })

  const ranked = rows
    .map((c) => {
      const nameSim = q ? nameSimilarity(q, c.cartonName) : 0
      let score = nameSim * 60
      let reason = q && nameSim > 0.8 ? 'name match' : 'partial match'
      if (clientId && c.customerId === clientId) {
        score += 25
        reason = 'client + ' + reason
      }
      if (q && c.artworkCode?.toLowerCase().includes(q.toLowerCase()))
        score += 15
      return {
        id: c.id,
        carton_name: c.cartonName,
        client_name: c.customer.name,
        artwork_code: c.artworkCode,
        match_score: Math.round(Math.min(100, score)),
        match_reason: reason,
      }
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 10)

  return NextResponse.json({ results: ranked })
}
