import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { createAuditLog } from '@/lib/audit'
import { getHubDeletePlanningBlockPoNumber } from '@/lib/hub-asset-planning-guard'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  asset: z.enum(['plate_requirement', 'plate_store', 'die', 'emboss', 'shade_card']),
  id: z.string().uuid(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { asset, id } = parsed.data
  const actor =
    (user?.name && String(user.name).trim()) ||
    (user?.email && String(user.email).trim()) ||
    (user as { id?: string } | null)?.id ||
    'unknown'
  const actorId = (user as { id?: string } | null)?.id
  const soft = { hubSoftDeletedAt: new Date(), hubSoftDeletedBy: actor.slice(0, 120) }

  const blockPo = await getHubDeletePlanningBlockPoNumber(db, asset, id)
  if (blockPo) {
    return NextResponse.json(
      { error: 'planning_block', poNumber: blockPo, message: `Cannot delete: Asset is reserved for ${blockPo}.` },
      { status: 409 },
    )
  }

  const tableName =
    asset === 'plate_requirement'
      ? 'plate_requirements'
      : asset === 'plate_store'
        ? 'plate_store'
        : asset === 'die'
          ? 'dyes'
          : asset === 'emboss'
            ? 'emboss_blocks'
            : 'shade_cards'

  try {
    if (asset === 'plate_requirement') {
      const row = await db.plateRequirement.findFirst({ where: { id, hubSoftDeletedAt: null } })
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      await db.plateRequirement.update({ where: { id }, data: soft })
    } else if (asset === 'plate_store') {
      const row = await db.plateStore.findFirst({ where: { id, hubSoftDeletedAt: null } })
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      await db.plateStore.update({ where: { id }, data: soft })
    } else if (asset === 'die') {
      const row = await db.dye.findFirst({ where: { id, hubSoftDeletedAt: null } })
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      await db.dye.update({ where: { id }, data: soft })
    } else if (asset === 'emboss') {
      const row = await db.embossBlock.findFirst({ where: { id, hubSoftDeletedAt: null } })
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      await db.embossBlock.update({ where: { id }, data: soft })
    } else {
      const row = await db.shadeCard.findFirst({ where: { id, hubSoftDeletedAt: null } })
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      await db.shadeCard.update({ where: { id }, data: soft })
    }
  } catch (e) {
    console.error('[hub/soft-delete]', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  await createAuditLog({
    userId: actorId,
    action: 'UPDATE',
    tableName,
    recordId: id,
    newValue: { hubSoftDelete: true, hubSoftDeletedBy: soft.hubSoftDeletedBy },
  })

  return NextResponse.json({ ok: true, asset, id })
}
