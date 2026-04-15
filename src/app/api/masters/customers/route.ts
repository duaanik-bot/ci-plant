import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { customerSchema } from '@/lib/validations'
import { cityFromAddress } from '@/lib/customer-address'

export const dynamic = 'force-dynamic'

const createSchema = customerSchema.extend({
  gstNumber: z.string().trim().max(32, 'GST number is too long').optional().or(z.literal('')),
  contactPhone: z.string().trim().max(20, 'Phone number is too long').optional().or(z.literal('')),
  email: z.string().email('Enter valid email address').optional().or(z.literal('')),
  address: z.string().optional(),
  creditLimit: z.number().min(0).default(0),
  requiresArtworkApproval: z.boolean().default(true),
  active: z.boolean().default(true),
})

export async function GET(req: NextRequest) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim() || ''
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') || 20), 50)

  const list = await db.customer.findMany({
    where: q.length >= 2 ? {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { address: { contains: q, mode: 'insensitive' } },
        { contactName: { contains: q, mode: 'insensitive' } },
        { contactPhone: { contains: q, mode: 'insensitive' } },
        { gstNumber: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ],
    } : undefined,
    orderBy: { name: 'asc' },
    take: limit,
  })
  return NextResponse.json(
    list.map((c) => ({
      id: c.id,
      name: c.name,
      city: cityFromAddress(c.address),
      gstNumber: c.gstNumber,
      contactName: c.contactName,
      contactPhone: c.contactPhone,
      email: c.email,
      address: c.address,
      creditLimit: Number(c.creditLimit),
      requiresArtworkApproval: c.requiresArtworkApproval,
      active: c.active,
    })),
  )
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
  try {
    const customer = await db.customer.create({
      data: {
        name: data.name,
        gstNumber: data.gstNumber?.trim() ? data.gstNumber.trim() : null,
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

    return NextResponse.json(
      {
        id: customer.id,
        name: customer.name,
        gstNumber: customer.gstNumber,
        contactName: customer.contactName,
        contactPhone: customer.contactPhone,
        email: customer.email,
        address: customer.address,
        creditLimit: Number(customer.creditLimit),
        requiresArtworkApproval: customer.requiresArtworkApproval,
        active: customer.active,
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[POST /api/masters/customers] Failed to create customer:', err)

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json(
        {
          error:
            err.code === 'P2002'
              ? 'A customer with the same unique value already exists'
              : 'Database rejected the customer record',
          code: err.code,
        },
        { status: 400 }
      )
    }

    if (err instanceof Prisma.PrismaClientInitializationError) {
      return NextResponse.json(
        {
          error: 'Database connection failed',
          code: 'DB_INIT_FAILED',
        },
        { status: 503 }
      )
    }

    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to create customer'
    return NextResponse.json(
      {
        error: message,
        code: 'CUSTOMER_CREATE_FAILED',
      },
      { status: 500 }
    )
  }
}
