import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  setNumber: z.string().optional().nullable(),
  artworkCode: z.string().optional().nullable(),
  planningStatus: z.string().optional(),
  specOverrides: z.any().optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const li = await db.poLineItem.findUnique({
    where: { id },
    include: {
      po: { include: { customer: true } },
    },
  })
  if (!li) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })
  return NextResponse.json(li)
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.poLineItem.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data

  const updated = await db.poLineItem.update({
    where: { id },
    data: {
      ...(data.setNumber !== undefined ? { setNumber: data.setNumber || null } : {}),
      ...(data.artworkCode !== undefined ? { artworkCode: data.artworkCode || null } : {}),
      ...(data.planningStatus !== undefined ? { planningStatus: data.planningStatus } : {}),
      ...(data.specOverrides !== undefined ? { specOverrides: data.specOverrides as any } : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: id,
    newValue: data,
  })

  return NextResponse.json(updated)
}

