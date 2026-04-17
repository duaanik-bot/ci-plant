import { NextRequest, NextResponse } from 'next/server'
import { PastingStyle } from '@prisma/client'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'
import { dyeSchema } from '@/lib/validations'
import { normalizeDieMake, prismaDimsFromParsed } from '@/lib/die-hub-dimensions'
import { coercePastingStyleInput, mapLegacyPastingToEnum } from '@/lib/pasting-style'

export const dynamic = 'force-dynamic'

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const createSchema = z.object({
  autoGenerate: z.boolean().default(true),
  dyeNumber: z.number().int().min(1).optional(),
  dyeType: z.string().min(1, 'Dye type is required'),
  ups: z.number().int().min(1),
  sheetLength: z.number().positive('Sheet length must be positive'),
  sheetWidth: z.number().positive('Sheet width must be positive'),
  cartonL: z.number().positive('Carton L must be positive'),
  cartonW: z.number().positive('Carton W must be positive'),
  cartonH: z.number().positive('Carton H must be positive'),
  location: z.string().optional(),
  conditionRating: z.string().optional(),
  pastingStyle: z.nativeEnum(PastingStyle).optional().nullable(),
  pastingType: z.string().max(64).optional().nullable(),
  dieMake: z.enum(['local', 'laser']).optional(),
})

function buildDieNumber(existingMax: number | null): number {
  const year = new Date().getFullYear()
  const base = year * 1000
  if (!existingMax || existingMax < base) return base + 1
  return existingMax + 1
}

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.dye.findMany({
    orderBy: { dyeNumber: 'asc' },
  })
  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    dyeNumber: toOptionalNumber(body.dyeNumber),
    ups: toOptionalNumber(body.ups),
    sheetLength: toOptionalNumber(body.sheetLength),
    sheetWidth: toOptionalNumber(body.sheetWidth),
    cartonL: toOptionalNumber(body.cartonL),
    cartonW: toOptionalNumber(body.cartonW),
    cartonH: toOptionalNumber(body.cartonH),
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

  let dyeNumber: number
  if (data.autoGenerate) {
    const lastDye = await db.dye.findFirst({
      orderBy: { dyeNumber: 'desc' },
      select: { dyeNumber: true },
    })
    dyeNumber = buildDieNumber(lastDye?.dyeNumber ?? null)
  } else {
    if (!data.dyeNumber) {
      return NextResponse.json(
        { error: 'Validation failed', fields: { dyeNumber: 'Die number is required when auto-generate is off' } },
        { status: 400 },
      )
    }
    const exists = await db.dye.findUnique({ where: { dyeNumber: data.dyeNumber } })
    if (exists) {
      return NextResponse.json(
        { error: 'Die number already exists', fields: { dyeNumber: 'Die number already exists' } },
        { status: 400 },
      )
    }
    dyeNumber = data.dyeNumber
  }

  const sheetSize = `${data.sheetLength}×${data.sheetWidth}`
  const cartonSize = `${data.cartonL}×${data.cartonW}×${data.cartonH}`
  const shared = dyeSchema.safeParse({
    dyeNumber: data.dyeNumber ?? 1,
    dyeType: data.dyeType,
    ups: data.ups,
    sheetSize,
    cartonSize,
  })
  if (!shared.success) {
    const fields: Record<string, string> = {}
    shared.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const dims = prismaDimsFromParsed({ l: data.cartonL, w: data.cartonW, h: data.cartonH })
  let resolvedPasting: PastingStyle | null = null
  if (data.pastingStyle !== undefined) {
    resolvedPasting = data.pastingStyle
  } else {
    resolvedPasting =
      coercePastingStyleInput(data.pastingType) ??
      mapLegacyPastingToEnum(data.pastingType) ??
      null
  }
  const dye = await db.dye.create({
    data: {
      dyeNumber,
      dyeType: data.dyeType,
      ups: data.ups,
      sheetSize,
      cartonSize,
      location: data.location || null,
      conditionRating: data.conditionRating || 'Good',
      pastingStyle: resolvedPasting,
      dieMake: normalizeDieMake(data.dieMake),
      ...(dims ?? {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'dyes',
    recordId: dye.id,
    newValue: { dyeNumber: dye.dyeNumber },
  })

  return NextResponse.json(dye, { status: 201 })
}
