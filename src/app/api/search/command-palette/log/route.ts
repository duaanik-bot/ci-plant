import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAuditLog, requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  href: z.string().min(1).max(500),
  title: z.string().min(1).max(300),
  category: z.string().min(1).max(40).optional(),
})

const COMMAND_PALETTE_ACTOR = 'Anik Dua'

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'command_palette',
    recordId: undefined,
    newValue: {
      actorLabel: COMMAND_PALETTE_ACTOR,
      href: parsed.data.href,
      title: parsed.data.title,
      category: parsed.data.category ?? null,
      source: 'global_search',
    },
  })

  return NextResponse.json({ ok: true })
}
