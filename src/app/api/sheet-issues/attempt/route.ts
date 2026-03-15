import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { attemptSheetIssue } from '@/lib/sheet-issue-logic'
import { z } from 'zod'

const bodySchema = z.object({
  bomLineId: z.string().uuid(),
  qtyRequested: z.number().int().positive(),
  lotNumber: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole(
    'stores',
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'md'
  )
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bomLineId and qtyRequested are required', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { bomLineId, qtyRequested, lotNumber } = parsed.data

  const result = await attemptSheetIssue({
    bomLineId,
    qtyRequested,
    issuedByUserId: user!.id,
    lotNumber,
  })

  return NextResponse.json(result, { status: result.success ? 200 : 409 })
}
