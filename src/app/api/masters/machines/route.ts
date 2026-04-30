import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  machineCode: z.string().min(1),
  name: z.string().min(1),
  make: z.string().optional().nullable(),
  specification: z.string().optional().nullable(),
  capacityPerShift: z.number().int().positive(),
  stdWastePct: z.number().min(0),
  status: z.enum(['active', 'under_maintenance', 'retired']).default('active'),
  lastPmDate: z.string().optional().nullable(),
  nextPmDue: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.machine.findMany({
    orderBy: { machineCode: 'asc' },
  })
  return NextResponse.json(list.map((m) => ({
    ...m,
    stdWastePct: Number(m.stdWastePct),
    lastPmDate: m.lastPmDate?.toISOString().slice(0, 10) ?? null,
    nextPmDue: m.nextPmDue?.toISOString().slice(0, 10) ?? null,
  })))
}

export async function POST(req: Request) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    capacityPerShift: Number(body.capacityPerShift),
    stdWastePct: Number(body.stdWastePct),
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
  const existing = await db.machine.findUnique({ where: { machineCode: data.machineCode.trim() } })
  if (existing) {
    return NextResponse.json(
      { error: 'Machine code already exists', fields: { machineCode: 'Machine code already exists' } },
      { status: 400 },
    )
  }

  const machine = await db.machine.create({
    data: {
      machineCode: data.machineCode.trim(),
      name: data.name.trim(),
      make: data.make?.trim() || null,
      specification: data.specification?.trim() || null,
      capacityPerShift: data.capacityPerShift,
      stdWastePct: data.stdWastePct,
      status: data.status,
      lastPmDate: data.lastPmDate ? new Date(data.lastPmDate) : null,
      nextPmDue: data.nextPmDue ? new Date(data.nextPmDue) : null,
      notes: data.notes?.trim() || null,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'machines',
    recordId: machine.id,
    newValue: machine,
  })

  return NextResponse.json(machine, { status: 201 })
}
