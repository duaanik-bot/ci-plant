import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  HUB_PRIORITY_DOMAINS,
  getOrderedIdsForDomain,
  persistOrderedIds,
  type HubPriorityDomain,
} from '@/lib/hub-priority-domain'
import { computeReorderedIds } from '@/lib/hub-priority-reorder-ids'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  domain: z.enum(
    [...HUB_PRIORITY_DOMAINS] as [HubPriorityDomain, ...HubPriorityDomain[]],
  ),
  entityId: z.string().uuid(),
  action: z.enum(['top', 'up', 'down', 'bottom']),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { domain, entityId, action } = parsed.data

  try {
    const current = await getOrderedIdsForDomain(db, domain)
    if (!current?.length) {
      return NextResponse.json({ error: 'No rows in this column' }, { status: 400 })
    }
    const res = computeReorderedIds(current, entityId, action)
    if (res.ok === false) {
      if (res.reason === 'not_found') {
        return NextResponse.json({ error: 'Record is not in this column' }, { status: 400 })
      }
      return NextResponse.json({ error: 'Cannot move: already at the boundary' }, { status: 400 })
    }
    const userName = user?.name?.trim() || user?.email?.trim() || 'System'
    await persistOrderedIds(db, domain, res.ids, { entityId, userName })
  } catch (e) {
    console.error('[hub/priority-sequence]', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
