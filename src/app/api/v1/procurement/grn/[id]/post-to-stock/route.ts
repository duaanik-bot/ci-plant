import { NextRequest } from 'next/server'
import { PATCH as patchGrn } from '@/app/api/procurement/grn/[id]/route'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => ({}))
  const nextReq = new NextRequest(req.url, {
    method: 'PATCH',
    headers: req.headers,
    body: JSON.stringify({ ...body, action: 'post_to_stock' }),
  })
  return patchGrn(nextReq, context)
}
