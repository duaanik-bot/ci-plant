import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { cityFromAddress } from '@/lib/customer-address'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { customerSchema } from '@/lib/validations'

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

function mapCustomerRow(c: {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  email: string | null
  address: string | null
  requiresArtworkApproval?: boolean
  active?: boolean
}) {
  return {
    id: c.id,
    name: c.name,
    city: cityFromAddress(c.address),
    gstNumber: c.gstNumber,
    contactName: c.contactName,
    contactPhone: c.contactPhone,
    email: c.email,
    address: c.address,
    requiresArtworkApproval: c.requiresArtworkApproval ?? true,
    active: c.active ?? true,
  }
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim() ?? ''
  const limit = Math.min(Number(searchParams.get('limit') || 20), 50)

  const where =
    q.length >= 2
      ? {
          active: true,
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { contactName: { contains: q, mode: 'insensitive' as const } },
            { contactPhone: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
            { gstNumber: { contains: q, mode: 'insensitive' as const } },
            { address: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : { active: true }

  try {
    const customers = await db.customer.findMany({
      where,
      select: {
        id: true,
        name: true,
        gstNumber: true,
        contactName: true,
        contactPhone: true,
        email: true,
        address: true,
        requiresArtworkApproval: true,
        active: true,
      },
      orderBy: { name: 'asc' },
      take: q.length >= 2 ? limit : 50,
    })
    return NextResponse.json(customers.map(mapCustomerRow))
  } catch (err) {
    console.error('[GET /api/customers]', err)
    const message = err instanceof Error ? err.message : 'Failed to load customers'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = createSchema.safeParse({
    ...body,
    email: body.email ?? '',
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
        contactName: data.contactName?.trim() ? data.contactName.trim() : null,
        contactPhone: data.contactPhone?.trim() ? data.contactPhone.trim() : null,
        email: data.email?.trim() ? data.email.trim() : null,
        address: data.address?.trim() ? data.address.trim() : null,
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
        city: cityFromAddress(customer.address),
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
    console.error('[POST /api/customers]', err)

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json(
        {
          error:
            err.code === 'P2002'
              ? 'A customer with the same unique value already exists'
              : 'Database rejected the customer record',
          code: err.code,
        },
        { status: 400 },
      )
    }

    if (err instanceof Prisma.PrismaClientInitializationError) {
      return NextResponse.json(
        { error: 'Database connection failed', code: 'DB_INIT_FAILED' },
        { status: 503 },
      )
    }

    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to create customer'
    return NextResponse.json({ error: message, code: 'CUSTOMER_CREATE_FAILED' }, { status: 500 })
  }
}
