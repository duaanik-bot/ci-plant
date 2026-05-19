import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/helpers', () => ({
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: { carton: { findUnique: vi.fn() } },
}))

import { GET } from './route'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

const mockReq = {} as never

beforeEach(() => {
  vi.mocked(requireAuth).mockReset()
  vi.mocked(db.carton.findUnique).mockReset()
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
      boardGrade: 'SBS (Solid Bleached Sulphate)', gsm: 350, paperType: 'Ivory',
      coatingType: 'Full UV Coating', pastingStyle: 'BSO',
    } as never)
    const res = await GET(mockReq, { params: { id: 'c1' } })
    const json = await res.json()
    expect(json.pack.v).toBe(1)
    expect(json.pack.board.boardGrade).toBe('SBS (Solid Bleached Sulphate)')
    expect(json.pack.board.gsm).toBe(350)
    expect(json.pack.tooling.pastingStyle).toBe('BSO')
  })
})
