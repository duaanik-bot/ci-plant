import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { createPurchaseRequestFromShortage } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  if (!id) return NextResponse.json({ error: 'Shortage id is required' }, { status: 400 })

  try {
    const pr = await createPurchaseRequestFromShortage(id)
    return NextResponse.json({ success: true, shortageId: id, purchaseRequestId: pr.id })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to create PR for shortage' },
      { status: 400 },
    )
  }
}

