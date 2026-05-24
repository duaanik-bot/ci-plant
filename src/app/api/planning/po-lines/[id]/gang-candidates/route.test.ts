import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/helpers', () => ({
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: { poLineItem: { findMany: vi.fn() } },
}))

import { GET } from './route'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

const mockReq = {} as never

beforeEach(() => {
  vi.mocked(requireAuth).mockReset()
  vi.mocked(db.poLineItem.findMany).mockReset()
})

describe('GET /api/planning/po-lines/[id]/gang-candidates', () => {
  it('returns the error response when auth fails', async () => {
    const errResp = new Response('no', { status: 401 })
    vi.mocked(requireAuth).mockResolvedValue({ error: errResp } as never)
    const res = await GET(mockReq, { params: Promise.resolve({ id: 'line-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns candidates array with a sibling line', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    const sibling = {
      id: 'line-2',
      quantity: 5000,
      cartonName: 'TEST-BOX',
      coatingType: 'Full UV Coating',
      gsm: 350,
      paperType: 'Ivory',
      specOverrides: null,
      po: { poNumber: 'PO-001', deliveryRequiredBy: new Date('2026-06-30') },
    }
    vi.mocked(db.poLineItem.findMany).mockResolvedValue([sibling] as never)
    const res = await GET(mockReq, { params: Promise.resolve({ id: 'line-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.candidates).toHaveLength(1)
    expect(json.candidates[0].id).toBe('line-2')
    expect(json.candidates[0].po.poNumber).toBe('PO-001')
  })

  it('excludes the anchor line from results', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.poLineItem.findMany).mockResolvedValue([] as never)
    const res = await GET(mockReq, { params: Promise.resolve({ id: 'anchor-id' }) })
    const json = await res.json()
    // findMany was called with id: { not: 'anchor-id' }
    expect(vi.mocked(db.poLineItem.findMany).mock.calls[0][0]).toMatchObject({
      where: { planningStatus: 'pending', id: { not: 'anchor-id' } },
    })
    expect(json.candidates).toHaveLength(0)
  })

  it('returns 400 on db error', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.poLineItem.findMany).mockRejectedValue(new Error('db down'))
    const res = await GET(mockReq, { params: Promise.resolve({ id: 'line-1' }) })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('db down')
  })
})
