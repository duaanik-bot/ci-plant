import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  CUSTODY_AT_VENDOR,
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_HUB_ENGRAVING_QUEUE,
  CUSTODY_HUB_TRIAGE,
  CUSTODY_IN_STOCK,
} from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { createEmbossHubEvent, EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import {
  dieHubZoneLabelFromCustody,
  embossHubZoneLabelFromCustody,
} from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

function httpError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number }
  e.status = status
  return e
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('mark_ready'),
    tool: z.enum(['die', 'emboss']),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.literal('reverse_staging'),
    tool: z.enum(['die', 'emboss']),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.literal('scrap'),
    tool: z.enum(['die', 'emboss']),
    id: z.string().uuid(),
    reason: z.string().min(3).max(500),
  }),
  z.object({
    action: z.literal('push_to_triage'),
    tool: z.enum(['die', 'emboss']),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.literal('triage_to_prep'),
    tool: z.enum(['die', 'emboss']),
    id: z.string().uuid(),
  }),
])

/** POST /api/tooling-hub/transition — zone moves + scrap (use /return-to-rack for staging → rack). */
export async function POST(req: NextRequest) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const raw = await req.json().catch(() => ({}))
    const parsed = bodySchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const body = parsed.data
    const now = new Date()

    if (body.action === 'mark_ready') {
      if (body.tool === 'die') {
        await db.$transaction(async (tx) => {
          const row = await tx.dye.findUnique({ where: { id: body.id } })
          if (!row?.active) throw httpError(404, 'Die not found')
          if (row.custodyStatus !== CUSTODY_AT_VENDOR) {
            throw httpError(409, 'Die must be at vendor to mark ready')
          }
          const fromZone = dieHubZoneLabelFromCustody(row.custodyStatus)
          await tx.dye.update({
            where: { id: body.id },
            data: {
              custodyStatus: CUSTODY_HUB_CUSTODY_READY,
              hubPreviousCustody: row.custodyStatus,
              updatedAt: now,
            },
          })
          const toZone = dieHubZoneLabelFromCustody(CUSTODY_HUB_CUSTODY_READY)
          await createDieHubEvent(tx, {
            dyeId: body.id,
            actionType: DIE_HUB_ACTION.MARKED_READY,
            fromZone,
            toZone,
            details: { displayCode: `DYE-${row.dyeNumber}` },
          })
        })
      } else {
        await db.$transaction(async (tx) => {
          const row = await tx.embossBlock.findUnique({ where: { id: body.id } })
          if (!row?.active) throw httpError(404, 'Block not found')
          if (row.custodyStatus !== CUSTODY_HUB_ENGRAVING_QUEUE) {
            throw httpError(409, 'Block must be in engraving queue')
          }
          const fromZone = embossHubZoneLabelFromCustody(row.custodyStatus)
          await tx.embossBlock.update({
            where: { id: body.id },
            data: {
              custodyStatus: CUSTODY_HUB_CUSTODY_READY,
              hubPreviousCustody: row.custodyStatus,
              updatedAt: now,
            },
          })
          const toZone = embossHubZoneLabelFromCustody(CUSTODY_HUB_CUSTODY_READY)
          await createEmbossHubEvent(tx, {
            blockId: body.id,
            actionType: EMBOSS_HUB_ACTION.MARKED_READY,
            fromZone,
            toZone,
            details: { displayCode: row.blockCode },
          })
        })
      }
    } else if (body.action === 'reverse_staging') {
      if (body.tool === 'die') {
        await db.$transaction(async (tx) => {
          const row = await tx.dye.findUnique({ where: { id: body.id } })
          if (!row?.active) throw httpError(404, 'Die not found')
          if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY || !row.hubPreviousCustody) {
            throw httpError(409, 'Nothing to reverse')
          }
          const fromZone = dieHubZoneLabelFromCustody(row.custodyStatus)
          const prev = row.hubPreviousCustody
          await tx.dye.update({
            where: { id: body.id },
            data: {
              custodyStatus: prev,
              hubPreviousCustody: null,
              updatedAt: now,
            },
          })
          const toZone = dieHubZoneLabelFromCustody(prev)
          await createDieHubEvent(tx, {
            dyeId: body.id,
            actionType: DIE_HUB_ACTION.REVERSE_STAGING,
            fromZone,
            toZone,
            details: { displayCode: `DYE-${row.dyeNumber}`, restoredStatus: prev },
          })
        })
      } else {
        await db.$transaction(async (tx) => {
          const row = await tx.embossBlock.findUnique({ where: { id: body.id } })
          if (!row?.active) throw httpError(404, 'Block not found')
          if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY || !row.hubPreviousCustody) {
            throw httpError(409, 'Nothing to reverse')
          }
          const fromZone = embossHubZoneLabelFromCustody(row.custodyStatus)
          const prev = row.hubPreviousCustody
          await tx.embossBlock.update({
            where: { id: body.id },
            data: {
              custodyStatus: prev,
              hubPreviousCustody: null,
              updatedAt: now,
            },
          })
          const toZone = embossHubZoneLabelFromCustody(prev)
          await createEmbossHubEvent(tx, {
            blockId: body.id,
            actionType: EMBOSS_HUB_ACTION.REVERSE_STAGING,
            fromZone,
            toZone,
            details: { displayCode: row.blockCode, restoredStatus: prev },
          })
        })
      }
    } else if (body.action === 'scrap') {
      if (body.tool === 'die') {
        await db.$transaction(async (tx) => {
          const row = await tx.dye.findUnique({ where: { id: body.id } })
          if (!row) throw httpError(404, 'Die not found')
          const fromZone = dieHubZoneLabelFromCustody(row.custodyStatus)
          await tx.dye.update({
            where: { id: body.id },
            data: {
              active: false,
              scrapReason: body.reason.trim(),
              scrappedBy: user?.id ?? null,
              scrappedAt: now,
              custodyStatus: CUSTODY_IN_STOCK,
              hubPreviousCustody: null,
              updatedAt: now,
            },
          })
          await createDieHubEvent(tx, {
            dyeId: body.id,
            actionType: DIE_HUB_ACTION.SCRAP,
            fromZone,
            toZone: 'Scrapped',
            details: { reason: body.reason.trim(), displayCode: `DYE-${row.dyeNumber}` },
          })
        })
      } else {
        await db.$transaction(async (tx) => {
          const row = await tx.embossBlock.findUnique({ where: { id: body.id } })
          if (!row) throw httpError(404, 'Block not found')
          const fromZone = embossHubZoneLabelFromCustody(row.custodyStatus)
          await tx.embossBlock.update({
            where: { id: body.id },
            data: {
              active: false,
              scrapReason: body.reason.trim(),
              scrappedBy: user?.id ?? null,
              scrappedAt: now,
              custodyStatus: CUSTODY_IN_STOCK,
              hubPreviousCustody: null,
              updatedAt: now,
            },
          })
          await createEmbossHubEvent(tx, {
            blockId: body.id,
            actionType: EMBOSS_HUB_ACTION.SCRAP,
            fromZone,
            toZone: 'Scrapped',
            details: { reason: body.reason.trim(), displayCode: row.blockCode },
          })
        })
      }
    } else if (body.action === 'push_to_triage') {
      if (body.tool === 'die') {
        await db.$transaction(async (tx) => {
          const row = await tx.dye.findUnique({ where: { id: body.id } })
          if (!row?.active) throw httpError(404, 'Die not found')
          if (row.custodyStatus !== CUSTODY_IN_STOCK) {
            throw httpError(409, 'Only live inventory can enter triage')
          }
          const fromZone = dieHubZoneLabelFromCustody(row.custodyStatus)
          await tx.dye.update({
            where: { id: body.id },
            data: { custodyStatus: CUSTODY_HUB_TRIAGE, updatedAt: now },
          })
          const toZone = dieHubZoneLabelFromCustody(CUSTODY_HUB_TRIAGE)
          await createDieHubEvent(tx, {
            dyeId: body.id,
            actionType: DIE_HUB_ACTION.PUSH_TO_TRIAGE,
            fromZone,
            toZone,
            details: { displayCode: `DYE-${row.dyeNumber}` },
          })
        })
      } else {
        await db.$transaction(async (tx) => {
          const row = await tx.embossBlock.findUnique({ where: { id: body.id } })
          if (!row?.active) throw httpError(404, 'Block not found')
          if (row.custodyStatus !== CUSTODY_IN_STOCK) {
            throw httpError(409, 'Only live inventory can enter triage')
          }
          const fromZone = embossHubZoneLabelFromCustody(row.custodyStatus)
          await tx.embossBlock.update({
            where: { id: body.id },
            data: { custodyStatus: CUSTODY_HUB_TRIAGE, updatedAt: now },
          })
          const toZone = embossHubZoneLabelFromCustody(CUSTODY_HUB_TRIAGE)
          await createEmbossHubEvent(tx, {
            blockId: body.id,
            actionType: EMBOSS_HUB_ACTION.PUSH_TO_TRIAGE,
            fromZone,
            toZone,
            details: { displayCode: row.blockCode },
          })
        })
      }
    } else if (body.action === 'triage_to_prep') {
      if (body.tool === 'die') {
        await db.$transaction(async (tx) => {
          const row = await tx.dye.findUnique({ where: { id: body.id } })
          if (!row?.active) throw httpError(404, 'Die not found')
          if (row.custodyStatus !== CUSTODY_HUB_TRIAGE) {
            throw httpError(409, 'Not in triage')
          }
          const fromZone = dieHubZoneLabelFromCustody(row.custodyStatus)
          await tx.dye.update({
            where: { id: body.id },
            data: { custodyStatus: CUSTODY_AT_VENDOR, updatedAt: now },
          })
          const toZone = dieHubZoneLabelFromCustody(CUSTODY_AT_VENDOR)
          await createDieHubEvent(tx, {
            dyeId: body.id,
            actionType: DIE_HUB_ACTION.TRIAGE_TO_VENDOR,
            fromZone,
            toZone,
            details: { displayCode: `DYE-${row.dyeNumber}` },
          })
        })
      } else {
        await db.$transaction(async (tx) => {
          const row = await tx.embossBlock.findUnique({ where: { id: body.id } })
          if (!row?.active) throw httpError(404, 'Block not found')
          if (row.custodyStatus !== CUSTODY_HUB_TRIAGE) {
            throw httpError(409, 'Not in triage')
          }
          const fromZone = embossHubZoneLabelFromCustody(row.custodyStatus)
          await tx.embossBlock.update({
            where: { id: body.id },
            data: { custodyStatus: CUSTODY_HUB_ENGRAVING_QUEUE, updatedAt: now },
          })
          const toZone = embossHubZoneLabelFromCustody(CUSTODY_HUB_ENGRAVING_QUEUE)
          await createEmbossHubEvent(tx, {
            blockId: body.id,
            actionType: EMBOSS_HUB_ACTION.TRIAGE_TO_ENGRAVING,
            fromZone,
            toZone,
            details: { displayCode: row.blockCode },
          })
        })
      }
    }

    const id = 'id' in body ? body.id : ''
    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: body.tool === 'die' ? 'dyes' : 'emboss_blocks',
      recordId: id,
      newValue: { toolingHubAction: body.action, ...body } as unknown as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    if (e instanceof Error && 'status' in e && typeof (e as Error & { status: number }).status === 'number') {
      const ex = e as Error & { status: number }
      return NextResponse.json({ error: ex.message }, { status: ex.status })
    }
    console.error('[tooling-hub/transition]', e)
    return NextResponse.json({ error: 'Transition failed' }, { status: 500 })
  }
}
