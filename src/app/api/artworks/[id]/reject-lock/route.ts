import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { rejectArtworkLock } from '@/lib/artwork-logic'
import { z } from 'zod'

const bodySchema = z.object({
  lockNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  rejectionReason: z.string().min(1, 'Rejection reason is required'),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
      { status: 400 }
    )
  }

  const result = await rejectArtworkLock({
    artworkId: id,
    lockNumber: parsed.data.lockNumber,
    rejectedByUserId: user!.id,
    rejectionReason: parsed.data.rejectionReason,
  })

  return NextResponse.json(result)
}
