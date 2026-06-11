import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/helpers', () => ({
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    carton: { findUnique: vi.fn() },
    poLineItem: { findMany: vi.fn() },
  },
}))

import { GET } from './route'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

const mockReq = { nextUrl: { searchParams: new URLSearchParams() } } as never
const mockReqWithCustomer = {
  nextUrl: { searchParams: new URLSearchParams({ customerId: 'cust1' }) },
} as never

beforeEach(() => {
  vi.mocked(requireAuth).mockReset()
  vi.mocked(db.carton.findUnique).mockReset()
  vi.mocked(db.poLineItem.findMany).mockReset()
  vi.mocked(db.poLineItem.findMany).mockResolvedValue([] as never)
})

describe('GET /api/cartons/[id]/spec-pack', () => {
  it('returns the error response when auth fails', async () => {
    const errResp = new Response('no', { status: 401 })
    vi.mocked(requireAuth).mockResolvedValue({ error: errResp } as never)
    const res = await GET(mockReq, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('404s when carton not found', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.carton.findUnique).mockResolvedValue(null as never)
    const res = await GET(mockReq, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('returns a v1 pack built from the carton row', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.carton.findUnique).mockResolvedValue({
      id: 'c1', cartonName: 'ACEBROBID',
      boardGrade: 'Saffire', gsm: 350, paperType: 'Ivory',
      coatingType: 'Full UV Coating', pastingStyle: 'BSO',
    } as never)
    const res = await GET(mockReq, { params: { id: 'c1' } })
    const json = await res.json()
    expect(json.pack.v).toBe(1)
    expect(json.pack.board.boardGrade).toBe('Saffire')
    expect(json.pack.board.gsm).toBe(350)
    expect(json.pack.tooling.pastingStyle).toBe('BSO')
    expect(json.lastPoPack).toBeNull()
  })

  it('returns lastPoPack resolved from the same-customer most recent PO line snapshot', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.carton.findUnique).mockResolvedValue({
      id: 'c1', cartonName: 'ACEBROBID',
    } as never)
    vi.mocked(db.poLineItem.findMany).mockResolvedValue([
      {
        specPack: { v: 1, print: { printingType: 'Offset', numberOfColours: 4 }, sheet: { ups: 6 } },
        specOverrides: null,
      },
    ] as never)
    const res = await GET(mockReqWithCustomer, { params: { id: 'c1' } })
    const json = await res.json()
    // Query is scoped to the supplied customer.
    expect(vi.mocked(db.poLineItem.findMany).mock.calls[0][0]).toMatchObject({
      where: { cartonId: 'c1', po: { customerId: 'cust1' } },
    })
    expect(json.lastPoPack.v).toBe(1)
    expect(json.lastPoPack.print.printingType).toBe('Offset')
    expect(json.lastPoPack.print.numberOfColours).toBe(4)
    expect(json.lastPoPack.sheet.ups).toBe(6)
  })

  it('skips backfill (lastPoPack null) when no customerId is supplied', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.carton.findUnique).mockResolvedValue({ id: 'c1', cartonName: 'ACEBROBID' } as never)
    const res = await GET(mockReq, { params: { id: 'c1' } })
    const json = await res.json()
    expect(json.lastPoPack).toBeNull()
    expect(db.poLineItem.findMany).not.toHaveBeenCalled()
  })
})
