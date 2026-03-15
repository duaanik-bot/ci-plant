import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { submitArtworkLock } from '@/lib/artwork-logic'
import { z } from 'zod'

const bodySchema = z.object({
  lockNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  checklistData: z.record(z.boolean()).optional(),
  comments: z.string().optional(),
})

const lockRoles: Record<number, string[]> = {
  1: ['sales', 'md', 'operations_head'],
  2: ['qa_officer', 'qa_manager', 'md'],
  3: ['qa_manager', 'md'],
}

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
      { error: 'lockNumber (1-3) required', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { lockNumber, checklistData, comments } = parsed.data
  if (!lockRoles[lockNumber]?.includes(user!.role ?? '')) {
    return NextResponse.json(
      { error: `Your role cannot approve Lock ${lockNumber}` },
      { status: 403 }
    )
  }

  const result = await submitArtworkLock({
    artworkId: id,
    lockNumber,
    approvedByUserId: user!.id,
    checklistData,
    comments,
  })

  return NextResponse.json(result)
}
