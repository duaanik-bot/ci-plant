import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const rows = await db.dye.findMany({
      where: { active: true },
      orderBy: { dyeNumber: 'asc' },
      include: { cartons: { take: 1, select: { cartonName: true } } },
    })

    const payload = rows.map((d) => ({
      id: d.id,
      dyeNumber: d.dyeNumber,
      cartonName: d.cartons[0]?.cartonName ?? null,
      cartonSize: d.cartonSize,
      sheetSize: d.sheetSize,
      dieMaterial: d.dieMaterial,
      ups: d.ups,
      location: d.location,
      knifeHeightMm: d.creaseDepthMm != null ? Number(d.creaseDepthMm) : null,
      impressionCount: d.impressionCount,
      reuseCount: d.reuseCount,
      custodyStatus: d.custodyStatus,
      issuedMachineId: d.issuedMachineId,
      issuedOperator: d.issuedOperator,
      issuedAt: d.issuedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    }))

    return new NextResponse(safeJsonStringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[inventory-hub/dies GET]', e)
    return NextResponse.json({ error: 'Failed to load dies' }, { status: 500 })
  }
}
