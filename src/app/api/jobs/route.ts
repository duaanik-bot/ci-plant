import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { generateJobNumber } from '@/lib/helpers'
import { explodeBOM } from '@/lib/sheet-issue-logic'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

const createJobSchema = z.object({
  customerId: z.string().min(1, 'Customer is required'),
  productName: z.string().min(1, 'Product name is required'),
  qtyOrdered: z.number().int().positive('Qty ordered must be a positive number'),
  imposition: z.number().int().positive('Imposition must be a positive number'),
  machineSequence: z
    .array(z.string().min(1, 'Invalid machine ID'))
    .min(1, 'Select at least one machine'),
  dueDate: z.string().min(1, 'Due date is required'),
  specialInstructions: z.string().optional(),
  boardMaterialId: z
    .union([z.string().uuid(), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
})

export async function GET(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const customerId = searchParams.get('customerId')

  const pressMachines = await db.machine.findMany({
    where: { machineCode: { in: ['CI-01', 'CI-02', 'CI-03'] } },
    select: { id: true },
  })
  const pressIds = new Set(pressMachines.map((m) => m.id))

  const jobs = await db.job.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      ...(user!.role === 'press_operator' && user!.machineAccess?.length
        ? { machineSequence: { hasSome: user!.machineAccess } }
        : {}),
    },
    include: {
      customer: { select: { name: true } },
      artwork: { select: { versionNumber: true, status: true, locksCompleted: true } },
    },
    orderBy: { dueDate: 'asc' },
  })

  return NextResponse.json(jobs)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', fieldErrors: {}, formErrors: ['Invalid request body'] },
      { status: 400 }
    )
  }

  const bodyObj = body as Record<string, unknown>
  const input = {
    ...bodyObj,
    qtyOrdered: bodyObj.qtyOrdered != null ? Number(bodyObj.qtyOrdered) : undefined,
    imposition: bodyObj.imposition != null ? Number(bodyObj.imposition) : undefined,
    dueDate: bodyObj.dueDate,
  }

  console.log('[POST /api/jobs] Request body:', JSON.stringify(bodyObj, null, 2))

  const parsed = createJobSchema.safeParse(input)
  if (!parsed.success) {
    const flattened = parsed.error.flatten()
    const fields: Record<string, string> = {}
    for (const [key, arr] of Object.entries(flattened.fieldErrors)) {
      const msg = Array.isArray(arr) && arr[0] ? String(arr[0]) : 'Invalid'
      fields[key] = msg
    }
    console.log('[POST /api/jobs] Zod validation failed:', {
      fieldErrors: flattened.fieldErrors,
      formErrors: flattened.formErrors,
      issues: parsed.error.issues,
    })
    return NextResponse.json(
      {
        error: 'Validation failed',
        fields,
        fieldErrors: flattened.fieldErrors as Record<string, string[]>,
        formErrors: flattened.formErrors,
      },
      { status: 400 }
    )
  }

  const {
    customerId,
    productName,
    qtyOrdered,
    imposition,
    machineSequence,
    dueDate,
    specialInstructions,
    boardMaterialId,
  } = parsed.data

  const jobNumber = await generateJobNumber()

  const job = await db.job.create({
    data: {
      jobNumber,
      customerId,
      productName,
      qtyOrdered,
      imposition,
      machineSequence,
      dueDate: new Date(dueDate),
      specialInstructions,
      status: 'pending_artwork',
      createdBy: user!.id,
    },
  })

  const pressMachines = await db.machine.findMany({
    where: { machineCode: { in: ['CI-01', 'CI-02', 'CI-03'] } },
    select: { id: true },
  })
  const pressIds = new Set(pressMachines.map((m) => m.id))
  const pressMachineId = machineSequence.find((id: string) => pressIds.has(id))

  if (boardMaterialId && pressMachineId) {
    await explodeBOM({
      jobId: job.id,
      qtyOrdered,
      imposition,
      machineId: pressMachineId,
      boardMaterialId,
    })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'jobs',
    recordId: job.id,
    newValue: { jobNumber, customerId, qtyOrdered },
  })

  return NextResponse.json(job, { status: 201 })
}
