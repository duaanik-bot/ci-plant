import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const rows = await db.embossBlock.findMany({
      where: { active: true },
      orderBy: { blockCode: 'asc' },
    })

    const payload = rows.map((b) => ({
      id: b.id,
      blockCode: b.blockCode,
      blockType: b.blockType,
      blockMaterial: b.blockMaterial,
      blockSize: b.blockSize,
      cartonName: b.cartonName,
      storageLocation: b.storageLocation,
      impressionCount: b.impressionCount,
      reuseCount: b.reuseCount,
      custodyStatus: b.custodyStatus,
      issuedMachineId: b.issuedMachineId,
      issuedOperator: b.issuedOperator,
      issuedAt: b.issuedAt?.toISOString() ?? null,
      createdAt: b.createdAt.toISOString(),
    }))

    return new NextResponse(safeJsonStringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[inventory-hub/emboss-blocks GET]', e)
    return NextResponse.json({ error: 'Failed to load emboss blocks' }, { status: 500 })
  }
}
