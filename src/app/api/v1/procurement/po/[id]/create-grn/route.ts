import { NextRequest, NextResponse } from 'next/server'
import { POST as createGrn } from '@/app/api/procurement/grn/route'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  if (!body.vehicleNumber || !body.receivedDate || !body.receivingQty) {
    return NextResponse.json({ error: 'vehicleNumber, receivedDate, and receivingQty are required to create GRN' }, { status: 400 })
  }
  const nextReq = new NextRequest(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ ...body, poId: id }),
  })
  return createGrn(nextReq)
}
