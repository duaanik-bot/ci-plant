import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  instrumentName: z.string().min(1),
  specification: z.string().optional().nullable(),
  range: z.string().optional().nullable(),
  frequency: z.string().optional().nullable(),
  purpose: z.string().optional().nullable(),
  lastCalibration: z.string().optional().nullable(),
  calibrationDue: z.string().optional().nullable(),
  calibrationFreqDays: z.number().int().min(0).optional().nullable(),
  certificateUrl: z.string().optional().nullable(),
  active: z.boolean().default(true),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.qcInstrument.findMany({
    orderBy: { instrumentName: 'asc' },
  })
  return NextResponse.json(list.map((i) => ({
    ...i,
    lastCalibration: i.lastCalibration?.toISOString().slice(0, 10) ?? null,
    calibrationDue: i.calibrationDue?.toISOString().slice(0, 10) ?? null,
  })))
}

export async function POST(req: Request) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    calibrationFreqDays:
      body.calibrationFreqDays === '' || body.calibrationFreqDays == null
        ? null
        : Number(body.calibrationFreqDays),
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data
  const instrument = await db.qcInstrument.create({
    data: {
      instrumentName: data.instrumentName.trim(),
      specification: data.specification?.trim() || null,
      range: data.range?.trim() || null,
      frequency: data.frequency?.trim() || null,
      purpose: data.purpose?.trim() || null,
      lastCalibration: data.lastCalibration ? new Date(data.lastCalibration) : null,
      calibrationDue: data.calibrationDue ? new Date(data.calibrationDue) : null,
      calibrationFreqDays: data.calibrationFreqDays ?? 0,
      certificateUrl: data.certificateUrl?.trim() || null,
      active: data.active,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'qc_instruments',
    recordId: instrument.id,
    newValue: instrument,
  })

  return NextResponse.json(instrument, { status: 201 })
}
