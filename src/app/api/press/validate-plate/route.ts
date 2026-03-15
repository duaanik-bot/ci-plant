import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { validatePlateAtPress } from '@/lib/artwork-logic'
import { z } from 'zod'

const bodySchema = z.object({
  plateBarcode: z.string().min(1),
  jobId: z.string().uuid(),
  machineCode: z.string().min(1),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole(
    'press_operator',
    'shift_supervisor',
    'production_manager',
    'md'
  )
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'plateBarcode, jobId and machineCode required' },
      { status: 400 }
    )
  }

  const result = await validatePlateAtPress({
    plateBarcode: parsed.data.plateBarcode,
    jobId: parsed.data.jobId,
    machineCode: parsed.data.machineCode,
    operatorUserId: user!.id,
  })

  return NextResponse.json(result, { status: result.valid ? 200 : 400 })
}
