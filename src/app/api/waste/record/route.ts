import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  jobId: z.string().uuid(),
  stageId: z.string().uuid().optional(),
  wasteType: z.enum(['makeready', 'run_waste', 'substrate_trim']),
  qty: z.number().positive(),
  unit: z.string().min(1),
  materialId: z.string().uuid(),
  machineId: z.string().uuid().optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole(
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'press_operator',
    'md'
  )
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const data = parsed.data

  const record = await db.wasteRecord.create({
    data: {
      jobId: data.jobId,
      stageId: data.stageId ?? null,
      wasteType: data.wasteType,
      qty: data.qty,
      unit: data.unit,
      materialId: data.materialId,
      machineId: data.machineId ?? null,
      recordedBy: user!.id,
    },
  })

  return NextResponse.json({
    success: true,
    id: record.id,
    message: `Waste recorded: ${data.qty} ${data.unit} (${data.wasteType})`,
  })
}
