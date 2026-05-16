import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().min(1, 'Customer name is required'),
  email: z.string().email('Enter a valid email address'),
  phone: z.string().optional(),
  address: z.string().optional(),
  gstin: z.string().optional(),
  active: z.boolean().default(true),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.customer.findMany({
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse(body)
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
      email: data.email,
      contactPhone: data.phone || null,
      address: data.address || null,
      gstNumber: data.gstin || null,
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
