import { NextRequest, NextResponse } from 'next/server'
import { POST as createPo } from '@/app/api/procurement/po/route'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  if (!body.supplierId) {
    return NextResponse.json({ error: 'supplierId is required to convert PR to PO' }, { status: 400 })
  }
  const nextReq = new NextRequest(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ ...body, prId: id }),
  })
  return createPo(nextReq)
}
