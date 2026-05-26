import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/helpers', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/material-readiness-service', () => ({
  adjustPlanningReservation: vi.fn(),
  generatePrForPlanningShortage: vi.fn(),
  getPlanningReservationSnapshot: vi.fn(),
  releasePlanningReservation: vi.fn(),
  getPlanningReservedByMaterial: vi.fn(),
}))

import { GET } from './route'
import { requireAuth } from '@/lib/helpers'
import { getPlanningReservedByMaterial } from '@/lib/material-readiness-service'

const params = Promise.resolve({ id: 'line-1' })

beforeEach(() => {
  vi.mocked(requireAuth).mockReset()
  vi.mocked(getPlanningReservedByMaterial).mockReset()
})

it('returns the per-line reservedByMaterial map when no materialId is given', async () => {
  vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
  vi.mocked(getPlanningReservedByMaterial).mockResolvedValue({ 'mat-001': 500, 'mat-002': 250 } as never)

  const req = new Request('http://localhost/api/planning/po-lines/line-1/reservation-control')
  const res = await GET(req as never, { params } as never)
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.success).toBe(true)
  expect(json.reservedByMaterial).toEqual({ 'mat-001': 500, 'mat-002': 250 })
  expect(vi.mocked(getPlanningReservedByMaterial)).toHaveBeenCalledWith('line-1')
})
