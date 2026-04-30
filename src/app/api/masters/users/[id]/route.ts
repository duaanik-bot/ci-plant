import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import bcrypt from 'bcryptjs'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const pinSchema = z.string().length(6).regex(/^\d+$/).optional()

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  pin: pinSchema,
  roleId: z.string().uuid().optional(),
  machineAccess: z.array(z.string()).optional(),
  whatsappNumber: z.string().optional(),
  active: z.boolean().optional(),
})

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    machineAccess: body.machineAccess ?? [],
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.user.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const data = parsed.data
  const updateData: Parameters<typeof db.user.update>[0]['data'] = {
    ...(data.name != null && { name: data.name }),
    ...(data.roleId != null && { roleId: data.roleId }),
    ...(data.machineAccess !== undefined && { machineAccess: data.machineAccess }),
    ...(data.whatsappNumber !== undefined && { whatsappNumber: data.whatsappNumber || null }),
    ...(data.active !== undefined && { active: data.active }),
  }
  if (data.pin != null && data.pin.length === 6) {
    updateData.pinHash = await bcrypt.hash(data.pin, 10)
  }

  const updated = await db.user.update({
    where: { id },
    data: updateData,
    include: { role: { select: { id: true, roleName: true } } },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'users',
    recordId: id,
    oldValue: { name: existing.name, roleId: existing.roleId, active: existing.active },
    newValue: { name: updated.name, roleId: updated.roleId, active: updated.active },
  })

  const { pinHash: _, ...out } = updated
  return NextResponse.json({
    ...out,
    lastLoginAt: out.lastLoginAt?.toISOString() ?? null,
  })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const existing = await db.user.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  try {
    await db.user.delete({ where: { id } })
  } catch {
    return NextResponse.json(
      { error: 'User cannot be deleted because it is linked to audit/transaction records.' },
      { status: 409 },
    )
  }

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'users',
    recordId: id,
    oldValue: { name: existing.name, roleId: existing.roleId, active: existing.active },
  })

  return NextResponse.json({ ok: true })
}
