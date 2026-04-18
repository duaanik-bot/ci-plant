import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const machines = await db.machine.findMany({
    select: {
      id: true,
      machineCode: true,
      name: true,
      stdWastePct: true,
      capacityPerShift: true,
      specification: true,
    },
    orderBy: { machineCode: 'asc' },
  })
  return NextResponse.json(machines)
}
