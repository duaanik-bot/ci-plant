import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { isHubStaffAdmin } from '@/lib/hub-admin-gate'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  isActive: z.boolean(),
})

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error
  if (!isHubStaffAdmin(user?.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!id?.trim()) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    const row = await db.operatorMaster.update({
      where: { id },
      data: { isActive: parsed.data.isActive },
      select: { id: true, name: true, isActive: true },
    })
    return NextResponse.json({ operator: row })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
