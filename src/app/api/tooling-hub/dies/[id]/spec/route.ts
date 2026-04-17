import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { normalizeDieMake } from '@/lib/die-hub-dimensions'

export const dynamic = 'force-dynamic'

const patchSchema = z
  .object({
    dieMake: z.enum(['local', 'laser']).optional(),
    pastingType: z.string().min(1).max(64).optional().nullable(),
  })
  .refine((b) => b.dieMake !== undefined || b.pastingType !== undefined, {
    message: 'No changes',
  })

/** PATCH /api/tooling-hub/dies/[id]/spec — hub floor: make / pasting. */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const { id } = await context.params
    if (!id?.trim()) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }

    const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const row = await db.dye.findFirst({ where: { id: id.trim(), active: true } })
    if (!row) {
      return NextResponse.json({ error: 'Die not found' }, { status: 404 })
    }

    const data: { dieMake?: string; pastingType?: string | null } = {}
    if (parsed.data.dieMake !== undefined) {
      data.dieMake = normalizeDieMake(parsed.data.dieMake)
    }
    if (parsed.data.pastingType !== undefined) {
      const t = parsed.data.pastingType?.trim()
      data.pastingType = t && t.length > 0 ? t : null
    }

    const updated = await db.dye.update({
      where: { id: row.id },
      data,
      select: { id: true, dieMake: true, pastingType: true },
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'dyes',
      recordId: row.id,
      newValue: { toolingHubSpecPatch: data },
    })

    return NextResponse.json({
      ok: true,
      id: updated.id,
      dieMake: normalizeDieMake(updated.dieMake),
      pastingType: updated.pastingType,
    })
  } catch (e) {
    console.error('[tooling-hub/dies/spec]', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }
}
