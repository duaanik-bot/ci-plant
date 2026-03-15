import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'

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
