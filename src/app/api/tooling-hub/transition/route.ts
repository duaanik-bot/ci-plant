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

export const dynamic = 'force-dynamic'

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
    action: z.literal('return_staging'),
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

/** POST /api/tooling-hub/transition */
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
        const row = await db.dye.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Die not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_AT_VENDOR) {
          return NextResponse.json({ error: 'Die must be at vendor to mark ready' }, { status: 409 })
        }
        await db.dye.update({
          where: { id: body.id },
          data: {
            custodyStatus: CUSTODY_HUB_CUSTODY_READY,
            hubPreviousCustody: row.custodyStatus,
            updatedAt: now,
          },
        })
      } else {
        const row = await db.embossBlock.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Block not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_HUB_ENGRAVING_QUEUE) {
          return NextResponse.json({ error: 'Block must be in engraving queue' }, { status: 409 })
        }
        await db.embossBlock.update({
          where: { id: body.id },
          data: {
            custodyStatus: CUSTODY_HUB_CUSTODY_READY,
            hubPreviousCustody: row.custodyStatus,
            updatedAt: now,
          },
        })
      }
    } else if (body.action === 'reverse_staging') {
      if (body.tool === 'die') {
        const row = await db.dye.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Die not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY || !row.hubPreviousCustody) {
          return NextResponse.json({ error: 'Nothing to reverse' }, { status: 409 })
        }
        await db.dye.update({
          where: { id: body.id },
          data: {
            custodyStatus: row.hubPreviousCustody,
            hubPreviousCustody: null,
            updatedAt: now,
          },
        })
      } else {
        const row = await db.embossBlock.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Block not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY || !row.hubPreviousCustody) {
          return NextResponse.json({ error: 'Nothing to reverse' }, { status: 409 })
        }
        await db.embossBlock.update({
          where: { id: body.id },
          data: {
            custodyStatus: row.hubPreviousCustody,
            hubPreviousCustody: null,
            updatedAt: now,
          },
        })
      }
    } else if (body.action === 'return_staging') {
      if (body.tool === 'die') {
        const row = await db.dye.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Die not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY) {
          return NextResponse.json({ error: 'Not on custody staging' }, { status: 409 })
        }
        await db.dye.update({
          where: { id: body.id },
          data: {
            custodyStatus: CUSTODY_IN_STOCK,
            hubPreviousCustody: null,
            reuseCount: { increment: 1 },
            issuedMachineId: null,
            issuedOperator: null,
            issuedAt: null,
            updatedAt: now,
          },
        })
        await db.dyeMaintenanceLog.create({
          data: {
            dyeId: body.id,
            actionType: 'hub_return_to_rack',
            performedBy: user?.id ?? 'system',
            notes: 'Tooling hub — return to live inventory (reuse cycle)',
          },
        })
      } else {
        const row = await db.embossBlock.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Block not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_HUB_CUSTODY_READY) {
          return NextResponse.json({ error: 'Not on custody staging' }, { status: 409 })
        }
        await db.embossBlock.update({
          where: { id: body.id },
          data: {
            custodyStatus: CUSTODY_IN_STOCK,
            hubPreviousCustody: null,
            reuseCount: { increment: 1 },
            issuedMachineId: null,
            issuedOperator: null,
            issuedAt: null,
            updatedAt: now,
          },
        })
        await db.embossBlockMaintenanceLog.create({
          data: {
            blockId: body.id,
            actionType: 'hub_return_to_rack',
            performedBy: user?.id ?? 'system',
            notes: 'Tooling hub — return to live inventory (reuse cycle)',
          },
        })
      }
    } else if (body.action === 'scrap') {
      if (body.tool === 'die') {
        const row = await db.dye.findUnique({ where: { id: body.id } })
        if (!row) return NextResponse.json({ error: 'Die not found' }, { status: 404 })
        await db.dye.update({
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
      } else {
        const row = await db.embossBlock.findUnique({ where: { id: body.id } })
        if (!row) return NextResponse.json({ error: 'Block not found' }, { status: 404 })
        await db.embossBlock.update({
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
      }
    } else if (body.action === 'push_to_triage') {
      if (body.tool === 'die') {
        const row = await db.dye.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Die not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_IN_STOCK) {
          return NextResponse.json({ error: 'Only live inventory can enter triage' }, { status: 409 })
        }
        await db.dye.update({
          where: { id: body.id },
          data: { custodyStatus: CUSTODY_HUB_TRIAGE, updatedAt: now },
        })
      } else {
        const row = await db.embossBlock.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Block not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_IN_STOCK) {
          return NextResponse.json({ error: 'Only live inventory can enter triage' }, { status: 409 })
        }
        await db.embossBlock.update({
          where: { id: body.id },
          data: { custodyStatus: CUSTODY_HUB_TRIAGE, updatedAt: now },
        })
      }
    } else if (body.action === 'triage_to_prep') {
      if (body.tool === 'die') {
        const row = await db.dye.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Die not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_HUB_TRIAGE) {
          return NextResponse.json({ error: 'Not in triage' }, { status: 409 })
        }
        await db.dye.update({
          where: { id: body.id },
          data: { custodyStatus: CUSTODY_AT_VENDOR, updatedAt: now },
        })
      } else {
        const row = await db.embossBlock.findUnique({ where: { id: body.id } })
        if (!row?.active) return NextResponse.json({ error: 'Block not found' }, { status: 404 })
        if (row.custodyStatus !== CUSTODY_HUB_TRIAGE) {
          return NextResponse.json({ error: 'Not in triage' }, { status: 409 })
        }
        await db.embossBlock.update({
          where: { id: body.id },
          data: { custodyStatus: CUSTODY_HUB_ENGRAVING_QUEUE, updatedAt: now },
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
  } catch (e) {
    console.error('[tooling-hub/transition]', e)
    return NextResponse.json({ error: 'Transition failed' }, { status: 500 })
  }
}
