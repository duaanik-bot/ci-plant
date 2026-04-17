import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { PastingStyle } from '@prisma/client'
import { requireAuth } from '@/lib/helpers'
import { executeSyncPastingStyleToMaster } from '@/lib/sync-pasting-style-master-execute'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  pastingStyle: z.union([
    z.literal(PastingStyle.LOCK_BOTTOM),
    z.literal(PastingStyle.BSO),
  ]),
})

/** PATCH — one-click Product Master + linked Die pasting (LOCK_BOTTOM | BSO only). */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  if (!id?.trim()) {
    return NextResponse.json({ error: 'Carton id required' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Only Lock Bottom or BSO is allowed' }, { status: 400 })
  }

  const actorLabel = user?.name?.trim() || 'Anik Dua'
  const result = await executeSyncPastingStyleToMaster({
    cartonId: id,
    pastingStyle: parsed.data.pastingStyle,
    userId: user!.id,
    actorLabel,
  })

  if (result.ok === false) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status ?? 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    pastingStyle: parsed.data.pastingStyle,
    cartonName: result.cartonName,
  })
}
