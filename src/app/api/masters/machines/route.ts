import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.machine.findMany({
    orderBy: { machineCode: 'asc' },
  })
  return NextResponse.json(list.map((m) => ({
    ...m,
    stdWastePct: Number(m.stdWastePct),
    lastPmDate: m.lastPmDate?.toISOString().slice(0, 10) ?? null,
    nextPmDue: m.nextPmDue?.toISOString().slice(0, 10) ?? null,
  })))
}
