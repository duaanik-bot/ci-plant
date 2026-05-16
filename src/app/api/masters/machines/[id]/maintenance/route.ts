import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const schema = z.object({
  lastPmDate: z.string().min(1, 'lastPmDate is required'),
  nextPmDue: z.string().min(1, 'nextPmDue is required'),
  notes: z.string().min(1, 'notes is required'),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
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

  const { lastPmDate, nextPmDue, notes } = parsed.data
  const timestamp = new Date().toISOString()
  const appendedEntry = `[${timestamp}] ${notes}`
  const nextNotes = existing.notes ? `${existing.notes}\n${appendedEntry}` : appendedEntry

  const machine = await db.machine.update({
    where: { id },
    data: {
      lastPmDate: new Date(lastPmDate),
      nextPmDue: new Date(nextPmDue),
      notes: nextNotes,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'machines',
    recordId: id,
    oldValue: { lastPmDate: existing.lastPmDate, nextPmDue: existing.nextPmDue, notes: existing.notes },
    newValue: { lastPmDate: machine.lastPmDate, nextPmDue: machine.nextPmDue, notes: machine.notes },
  })

  return NextResponse.json({
    ...machine,
    stdWastePct: Number(machine.stdWastePct),
    lastPmDate: machine.lastPmDate?.toISOString().slice(0, 10) ?? null,
    nextPmDue: machine.nextPmDue?.toISOString().slice(0, 10) ?? null,
  })
}
