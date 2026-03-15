import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

const updateSchema = z.object({
  instrumentName: z.string().min(1).optional(),
  specification: z.string().optional(),
  range: z.string().optional(),
  frequency: z.string().optional(),
  purpose: z.string().optional(),
  lastCalibration: z.string().optional().nullable(),
  calibrationDue: z.string().optional().nullable(),
  calibrationFreqDays: z.number().int().min(0).optional(),
  certificateUrl: z.string().optional().nullable(),
  active: z.boolean().optional(),
})

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    calibrationFreqDays: body.calibrationFreqDays != null ? Number(body.calibrationFreqDays) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.qcInstrument.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Instrument not found' }, { status: 404 })

  const data = parsed.data
  const instrument = await db.qcInstrument.update({
    where: { id },
    data: {
      ...(data.instrumentName != null && { instrumentName: data.instrumentName }),
      ...(data.specification !== undefined && { specification: data.specification || null }),
      ...(data.range !== undefined && { range: data.range || null }),
      ...(data.frequency !== undefined && { frequency: data.frequency || null }),
      ...(data.purpose !== undefined && { purpose: data.purpose || null }),
      ...(data.lastCalibration !== undefined && {
        lastCalibration: data.lastCalibration ? new Date(data.lastCalibration) : null,
      }),
      ...(data.calibrationDue !== undefined && {
        calibrationDue: data.calibrationDue ? new Date(data.calibrationDue) : null,
      }),
      ...(data.calibrationFreqDays != null && { calibrationFreqDays: data.calibrationFreqDays }),
      ...(data.certificateUrl !== undefined && { certificateUrl: data.certificateUrl || null }),
      ...(data.active !== undefined && { active: data.active }),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'qc_instruments',
    recordId: id,
    oldValue: existing,
    newValue: instrument,
  })

  return NextResponse.json({
    ...instrument,
    lastCalibration: instrument.lastCalibration?.toISOString().slice(0, 10) ?? null,
    calibrationDue: instrument.calibrationDue?.toISOString().slice(0, 10) ?? null,
  })
}
