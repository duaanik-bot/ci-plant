import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/**
 * The standalone Artwork table was retired together with the 4-lock workflow.
 * Artwork identity now lives on the PO line itself (artworkCode + spec). This
 * endpoint is kept as a no-op so existing UI fetches don't 404; callers should
 * treat `artworkId: null` as "no preview available".
 */
export async function GET(_req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  return NextResponse.json({ artworkId: null })
}
