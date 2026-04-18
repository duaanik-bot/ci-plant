import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { createShadeCardEvent, SHADE_CARD_ACTION } from '@/lib/shade-card-events'
import { COLOR_VERIFICATION_AUDIT } from '@/lib/shade-card-hub-audit'
import { SHADE_SUBSTRATE_VALUES } from '@/lib/shade-card-substrate'

export const dynamic = 'force-dynamic'

function addDaysUtc(d: Date, days: number): Date {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() + days)
  return x
}

const bodySchema = z.object({
  lastVerifiedAt: z.string().optional(),
  deltaEReading: z.number().min(0).max(20).optional(),
  approvalAttachmentUrl: z.string().max(600).optional().nullable(),
  inkRecipeLink: z.string().max(600).optional().nullable(),
  customerApprovalDoc: z.string().max(600).optional().nullable(),
  spectroReportSummary: z.string().max(4000).optional(),
  colorSwatchHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().or(z.literal('')),
  substrateType: z.enum(SHADE_SUBSTRATE_VALUES).optional().nullable(),
  labL: z.number().optional().nullable(),
  labA: z.number().optional().nullable(),
  labB: z.number().optional().nullable(),
  inkRecipeNotes: z.string().max(8000).optional().nullable(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const existing = await db.shadeCard.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const d = parsed.data
  const verifiedDate = d.lastVerifiedAt != null ? new Date(d.lastVerifiedAt) : null

  let nextSpectroLog: Prisma.InputJsonValue | undefined
  if (verifiedDate && !Number.isNaN(verifiedDate.getTime())) {
    const prevLogRaw = existing.spectroScanLog
    const logArr = Array.isArray(prevLogRaw) ? [...(prevLogRaw as unknown[])] : []
    logArr.push({
      scannedAt: new Date().toISOString(),
      ...(d.deltaEReading != null ? { deltaE: d.deltaEReading } : {}),
    })
    nextSpectroLog = logArr as Prisma.InputJsonValue
  }

  const shouldLogVerification =
    (verifiedDate != null && !Number.isNaN(verifiedDate.getTime())) || d.deltaEReading != null

  const updated = await db.shadeCard.update({
    where: { id },
    data: {
      ...(verifiedDate &&
        !Number.isNaN(verifiedDate.getTime()) && {
          lastVerifiedAt: verifiedDate,
          validUntil: addDaysUtc(verifiedDate, 180),
        }),
      ...(d.deltaEReading != null && {
        deltaEReading: new Prisma.Decimal(d.deltaEReading),
      }),
      ...(d.approvalAttachmentUrl !== undefined && {
        approvalAttachmentUrl: d.approvalAttachmentUrl?.trim() || null,
      }),
      ...(d.inkRecipeLink !== undefined && {
        inkRecipeLink: d.inkRecipeLink?.trim() || null,
      }),
      ...(d.customerApprovalDoc !== undefined && {
        customerApprovalDoc: d.customerApprovalDoc?.trim() || null,
      }),
      ...(d.spectroReportSummary !== undefined && {
        spectroReportSummary: d.spectroReportSummary || null,
      }),
      ...(d.colorSwatchHex !== undefined && {
        colorSwatchHex: d.colorSwatchHex || null,
      }),
      ...(d.substrateType !== undefined && {
        substrateType: d.substrateType,
      }),
      ...(d.labL !== undefined && {
        labL: d.labL != null ? new Prisma.Decimal(d.labL) : null,
      }),
      ...(d.labA !== undefined && {
        labA: d.labA != null ? new Prisma.Decimal(d.labA) : null,
      }),
      ...(d.labB !== undefined && {
        labB: d.labB != null ? new Prisma.Decimal(d.labB) : null,
      }),
      ...(d.inkRecipeNotes !== undefined && {
        inkRecipeNotes: d.inkRecipeNotes?.trim() || null,
      }),
      ...(nextSpectroLog !== undefined && { spectroScanLog: nextSpectroLog }),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'shade_cards',
    recordId: id,
    newValue: {
      colorVerification: COLOR_VERIFICATION_AUDIT,
      shadeCode: updated.shadeCode,
      at: new Date().toISOString(),
    },
  })

  if (shouldLogVerification) {
    await createShadeCardEvent(db, {
      shadeCardId: id,
      actionType: SHADE_CARD_ACTION.VERIFICATION_SCAN,
      details: {
        deltaE: d.deltaEReading ?? null,
        lastVerifiedAt:
          verifiedDate && !Number.isNaN(verifiedDate.getTime()) ? verifiedDate.toISOString() : null,
        performedByUserId: user!.id,
      },
    })
  }

  return NextResponse.json({ ok: true, message: COLOR_VERIFICATION_AUDIT })
}
