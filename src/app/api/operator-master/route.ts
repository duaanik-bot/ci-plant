import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { isHubStaffAdmin } from '@/lib/hub-admin-gate'

export const dynamic = 'force-dynamic'

/** GET ?activeOnly=1 — list for comboboxes; omit for full list (settings). */
export async function GET(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const activeOnly = req.nextUrl.searchParams.get('activeOnly') === '1'
  const fullList = req.nextUrl.searchParams.get('all') === '1'

  if (fullList && !isHubStaffAdmin(user?.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const rows = await db.operatorMaster.findMany({
    where: activeOnly || !fullList ? { isActive: true } : undefined,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, isActive: true },
  })

  return NextResponse.json({ operators: rows })
}

const postSchema = z.object({
  name: z.string().min(1).max(120),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  if (!isHubStaffAdmin(user?.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = postSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const name = parsed.data.name.trim()

  try {
    const row = await db.operatorMaster.create({
      data: { name, isActive: true },
      select: { id: true, name: true, isActive: true },
    })
    return NextResponse.json({ operator: row })
  } catch {
    return NextResponse.json({ error: 'Name may already exist' }, { status: 409 })
  }
}
