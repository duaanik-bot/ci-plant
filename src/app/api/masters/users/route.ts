import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import bcrypt from 'bcryptjs'
import { z } from 'zod'

const pinSchema = z.string().length(6, 'PIN must be 6 digits').regex(/^\d+$/, 'PIN must be digits only')

const createSchema = z.object({
  name: z.string().min(1, 'Full name is required'),
  email: z.string().email('Valid email required'),
  pin: z.string().min(1, 'PIN is required').pipe(pinSchema),
  roleId: z.string().uuid('Select a role'),
  machineAccess: z.array(z.string()).default([]),
  whatsappNumber: z.string().optional(),
  active: z.boolean().default(true),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.user.findMany({
    include: { role: { select: { id: true, roleName: true } } },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(list.map((u) => ({
    ...u,
    pinHash: undefined,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  })))
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    machineAccess: Array.isArray(body.machineAccess) ? body.machineAccess : [],
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.user.findUnique({
    where: { email: parsed.data.email },
  })
  if (existing) {
    return NextResponse.json(
      { error: 'Email already registered', fields: { email: 'Email already in use' } },
      { status: 400 }
    )
  }

  const role = await db.role.findUnique({ where: { id: parsed.data.roleId } })
  if (!role) {
    return NextResponse.json({ error: 'Invalid role', fields: { roleId: 'Invalid role' } }, { status: 400 })
  }

  const pinHash = await bcrypt.hash(parsed.data.pin, 10)
  const newUser = await db.user.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      pinHash,
      roleId: parsed.data.roleId,
      machineAccess: parsed.data.machineAccess,
      whatsappNumber: parsed.data.whatsappNumber || null,
      active: parsed.data.active,
    },
    include: { role: { select: { id: true, roleName: true } } },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'users',
    recordId: newUser.id,
    newValue: { name: newUser.name, email: newUser.email },
  })

  const { pinHash: _, ...out } = newUser
  return NextResponse.json(out, { status: 201 })
}
