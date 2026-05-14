import { NextResponse } from 'next/server'
import { unstable_cache } from 'next/cache'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const fetchMachinesCached = unstable_cache(
  async () =>
    db.machine.findMany({
      select: {
        id: true,
        machineCode: true,
        name: true,
        stdWastePct: true,
        capacityPerShift: true,
        specification: true,
      },
      orderBy: { machineCode: 'asc' },
    }),
  ['machines-list-v1'],
  { revalidate: 300, tags: ['machines'] },
)

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error
  const machines = await fetchMachinesCached()
  return NextResponse.json(machines)
}
