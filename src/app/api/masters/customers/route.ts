import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().min(1, 'Company name is required'),
  gstNumber: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  creditLimit: z.number().min(0).default(0),
  requiresArtworkApproval: z.boolean().default(true),
  active: z.boolean().default(true),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.customer.findMany({
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(list.map((c) => ({
    ...c,
    creditLimit: Number(c.creditLimit),
  })))
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    email: body.email || '',
    creditLimit: body.creditLimit != null ? Number(body.creditLimit) : 0,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data
  const customer = await db.customer.create({
    data: {
      name: data.name,
      gstNumber: data.gstNumber || null,
      contactName: data.contactName || null,
      contactPhone: data.contactPhone || null,
      email: data.email || null,
      address: data.address || null,
      creditLimit: data.creditLimit,
      requiresArtworkApproval: data.requiresArtworkApproval,
      active: data.active,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'customers',
    recordId: customer.id,
    newValue: { name: customer.name },
  })

  return NextResponse.json(customer, { status: 201 })
}
