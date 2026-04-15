// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { checkEmbossBlockAvailability } from '@/lib/emboss-engine'
import { isEmbossingRequired } from '@/lib/emboss-conditions'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const sp = req.nextUrl.searchParams
  const cartonId = sp.get('cartonId') ?? ''
  const artworkCode = sp.get('artworkCode') ?? ''
  const blockType = sp.get('blockType') ?? ''
  let embossingLeafing = sp.get('embossingLeafing') ?? ''

  if (!embossingLeafing && cartonId) {
    const carton = await db.carton.findUnique({ where: { id: cartonId }, select: { embossingLeafing: true } })
    embossingLeafing = carton?.embossingLeafing ?? ''
  }

  if (!isEmbossingRequired(embossingLeafing || null)) {
    return NextResponse.json({
      required: false,
      skip: true,
      message: `Not required - ${embossingLeafing || 'No embossing specified'}`,
    })
  }

  const result = await checkEmbossBlockAvailability(cartonId, artworkCode, blockType)
  return NextResponse.json({ required: true, skip: false, ...result })
}
