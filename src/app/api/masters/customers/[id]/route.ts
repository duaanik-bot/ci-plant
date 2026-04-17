import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'
import { customerSchema } from '@/lib/validations'

export const dynamic = 'force-dynamic'

const updateSchema = customerSchema.partial().extend({
  gstNumber: z.string().trim().max(32, 'GST number is too long').optional().or(z.literal('')),
  contactPhone: z.string().trim().max(20, 'Phone number is too long').optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  creditLimit: z.number().min(0).optional(),
  requiresArtworkApproval: z.boolean().optional(),
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
    email: body.email ?? '',
    creditLimit: body.creditLimit != null ? Number(body.creditLimit) : undefined,
  })
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
      ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl?.trim() ? data.logoUrl.trim() : null }),
      ...(data.gstNumber !== undefined && { gstNumber: data.gstNumber || null }),
      ...(data.contactName !== undefined && { contactName: data.contactName || null }),
      ...(data.contactPhone !== undefined && { contactPhone: data.contactPhone || null }),
      ...(data.email !== undefined && { email: data.email || null }),
      ...(data.address !== undefined && { address: data.address || null }),
      ...(data.creditLimit != null && { creditLimit: data.creditLimit }),
      ...(data.requiresArtworkApproval !== undefined && { requiresArtworkApproval: data.requiresArtworkApproval }),
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

  return NextResponse.json({
    id: customer.id,
    name: customer.name,
    logoUrl: customer.logoUrl,
    gstNumber: customer.gstNumber,
    contactName: customer.contactName,
    contactPhone: customer.contactPhone,
    email: customer.email,
    address: customer.address,
    creditLimit: Number(customer.creditLimit),
    requiresArtworkApproval: customer.requiresArtworkApproval,
    active: customer.active,
  })
}
