import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  make: z.string().optional(),
  specification: z.string().optional(),
  capacityPerShift: z.number().int().positive().optional(),
  stdWastePct: z.number().min(0).optional(),
  status: z.enum(['active', 'under_maintenance', 'retired']).optional(),
  lastPmDate: z.string().optional().nullable(),
  nextPmDue: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
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
    capacityPerShift: toOptionalNumber(body.capacityPerShift),
    stdWastePct: toOptionalNumber(body.stdWastePct),
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.machine.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Machine not found' }, { status: 404 })

  const data = parsed.data
  const machine = await db.machine.update({
    where: { id },
    data: {
      ...(data.name != null && { name: data.name }),
      ...(data.make !== undefined && { make: data.make || null }),
      ...(data.specification !== undefined && { specification: data.specification || null }),
      ...(data.capacityPerShift != null && { capacityPerShift: data.capacityPerShift }),
      ...(data.stdWastePct != null && { stdWastePct: data.stdWastePct }),
      ...(data.status != null && { status: data.status }),
      ...(data.lastPmDate !== undefined && {
        lastPmDate: data.lastPmDate ? new Date(data.lastPmDate) : null,
      }),
      ...(data.nextPmDue !== undefined && {
        nextPmDue: data.nextPmDue ? new Date(data.nextPmDue) : null,
      }),
      ...(data.notes !== undefined && { notes: data.notes || null }),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'machines',
    recordId: id,
    oldValue: existing,
    newValue: machine,
  })

  return NextResponse.json({
    ...machine,
    stdWastePct: Number(machine.stdWastePct),
    lastPmDate: machine.lastPmDate?.toISOString().slice(0, 10) ?? null,
    nextPmDue: machine.nextPmDue?.toISOString().slice(0, 10) ?? null,
  })
}
