import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

const createSchema = z.object({
  name: z.string().min(1, 'Supplier name is required'),
  gstNumber: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  materialTypes: z.array(z.string()).default([]),
  leadTimeDays: z.number().int().min(0).default(7),
  paymentTerms: z.string().optional(),
  active: z.boolean().default(true),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.supplier.findMany({
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    email: body.email || '',
    materialTypes: Array.isArray(body.materialTypes) ? body.materialTypes : [],
    leadTimeDays: body.leadTimeDays != null ? Number(body.leadTimeDays) : 7,
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
  const supplier = await db.supplier.create({
    data: {
      name: data.name,
      gstNumber: data.gstNumber || null,
      contactName: data.contactName || null,
      contactPhone: data.contactPhone || null,
      email: data.email || null,
      address: data.address || null,
      materialTypes: data.materialTypes,
      leadTimeDays: data.leadTimeDays,
      paymentTerms: data.paymentTerms || null,
      active: data.active,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'suppliers',
    recordId: supplier.id,
    newValue: { name: supplier.name },
  })

  return NextResponse.json(supplier, { status: 201 })
}
