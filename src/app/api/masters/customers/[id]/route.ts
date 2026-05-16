import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  gstin: z.string().optional(),
  active: z.boolean().optional(),
})

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const customer = await db.customer.findUnique({ where: { id } })
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })

  return NextResponse.json(customer)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.customer.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })

  const data = parsed.data
  const customer = await db.customer.update({
    where: { id },
    data: {
      ...(data.name != null && { name: data.name }),
      ...(data.email !== undefined && { email: data.email }),
      ...(data.phone !== undefined && { contactPhone: data.phone || null }),
      ...(data.address !== undefined && { address: data.address || null }),
      ...(data.gstin !== undefined && { gstNumber: data.gstin || null }),
      ...(data.active !== undefined && { active: data.active }),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'customers',
    recordId: id,
    oldValue: existing,
    newValue: customer,
  })

  return NextResponse.json(customer)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const existing = await db.customer.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })

  try {
    await db.customer.delete({ where: { id } })
  } catch {
    return NextResponse.json(
      { error: 'Customer cannot be deleted because it is linked to active records.' },
      { status: 409 },
    )
  }

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'customers',
    recordId: id,
    oldValue: existing,
  })

  return NextResponse.json({ ok: true })
}
